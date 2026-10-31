// NPC script engine: runs the NPC scripts of shared/content for one player at a time, on the server, with rAthena's
// script-session rules (behaviour re-implemented, not code):
//   npc.cpp    npc_click (one script per player: sd->npc_id), npc_scriptcont (Next / menu / Close answers), npc_checknear,
//              npc_touch_area_allnpc / npc_touch_areanpc / npc_event / npc_event_sub / npc_event_dequeue (OnTouch areas: sd->areanpc,
//              the MAX_EVENTQUEUE event queue of a busy player, the area re-check when a queued event runs)
//   script.cpp run_script / script_attach_state (sd->st, sd->npc_id), buildin_mes / next / close / close2 / close3 / clear /
//              select / prompt / cutin / getitem / delitem / countitem / checkweight / getexp / set / setquest /
//              completequest / erasequest / changequest / checkquest / isbegin_quest / showevent / emotion / npctalk /
//              playerattached / heal / percentheal / isequipped / callshop; script_detach_state (dequeues the next event)
//   pc.cpp     pc_close_npc (death: flag 2, idle timeout: flag 1), pc_setparam SP_ZENY, pc_show_questinfo, pc_percentheal
//   quest.cpp  quest_update_objective on the killer (mob_dead), quest_update_status (CZ_ACTIVE_QUEST)
//   secure.hpp SECURE_NPCTIMEOUT: Next / menu left unanswered for 60 s close the dialog
// The client only renders (npcMes / npcNextBtn / npcCloseBtn / npcMenuList / cutin / emotion / npcTalk) and answers (npcNext /
// npcMenu / npcClose); while a script runs the character can't act (shared/rules/msgguard.ts lock "talking").
import {
  Msg, type CutinEvent, type ItemGetEvent, type NpcButtonEvent, type NpcMenuEvent, type NpcMesEvent, type QuestLogEvent, type QuestMarkEvent, type ZenyEvent,
} from "../../shared/protocol.ts";
import type { Mob } from "../../shared/rules/data.ts";
import { ITEMS, maxWeight, type EquipSlot, type Item } from "../../shared/rules/items.ts";
import type { JobKey } from "../../shared/rules/data.ts";
import { REFINE_COST, MAX_REFINE, refineCost, refinePercent } from "../../shared/rules/refine.ts";
import { itemDisplayName } from "../../shared/rules/cards.ts";
import { MAPID } from "../../shared/rules/status.ts";
import { SKILL_CONF } from "../../shared/rules/skill.ts";
import { checkAddItem, inventoryBlank, slotsNeeded } from "../../shared/rules/shop.ts";
import {
  Q_ACTIVE, Q_COMPLETE, Q_INACTIVE, isbeginQuest, itemNamed, questAdd, questChange, questCheck, questDelete, questKillOf,
  questUpdateObjective, questUpdateStatus, type QuestCheckType,
} from "../../shared/rules/quest.ts";
import {
  CHAT_SIZE_MAX, CUTIN, EVENTQUEUE_DELAY, MAX_EVENTQUEUE, MENU_CANCEL, NPCTALK_COLOR, NPC_SECURE_TIMEOUT_MENU, NPC_SECURE_TIMEOUT_NEXT, QMARK, QTYPE,
  SECURE_NPCTIMEOUT_INTERVAL, callshopOption, cutinNameValid, emotionValid, inTouchArea, isequippedIds, menuBuild, menuChoiceValid, menuSelect,
  npctalkTarget, percentHeal, scriptCont, scriptHeal, showeventArgs, touchAreas, varScope, type CallshopOption, type HpSpChange, type ScriptState,
  type TouchArea,
} from "../../shared/rules/script.ts";
import type { ItemRef, NpcDef, NpcScript, QuestInfoView, Script } from "../../shared/content/api.ts";
import { QUEST_DB } from "../../shared/content/quest_db.ts";
import { NPC_BY_ID } from "../../shared/content/npcs.ts";
import { QuestStore } from "./quests.ts";
import type { Inventory } from "./inventory.ts";

/** Thrown into a script to unwind it: close / close3 clicked, end, a cancelled select, or the session ended (death, logout,
 *  idle timeout, a forged answer). Scripts must not catch it. */
export class ScriptEnd extends Error {}

/** conf/battle/exp.conf quest_exp_rate: getexp is scaled by this percentage (buildin_getexp). */
export const QUEST_EXP_RATE = 100;

/** The character as the engine reads it. */
export type PcView = {
  name: string; job: string; level: number; jobLevel: number; exp: number; jobExp: number; statPoints: number; skillPoints: number;
  hp: number; maxHp: number; sp: number; maxSp: number; str: number; dead: boolean;
  gender?: string; // 2.5.0: "M" / "F" (the Sex param)
};

/** What the engine needs from its room (MapRoom implements it). */
export interface ScriptHost {
  readonly mapName: string;
  /** 2.4.0 buildin_getitem on a pet egg -> pet_create_egg: a new pet row + its egg (server/src/pets.ts). False = no room. */
  makeEgg?(sid: string, itemId: number): boolean;
  /** Room clock (ms), for the idle timeout. */
  now(): number;
  send(sid: string, type: string, msg: unknown): void;
  /** npc_checknear for the player's current cell. */
  near(sid: string, npcId: string): boolean;
  pc(sid: string): PcView | undefined;
  inv(sid: string): Inventory | undefined;
  /** pc_gainexp(sd, NULL, base, job, 1): quest EXP (level ups, shown as a quest reward). */
  gainExp(sid: string, base: number, job: number): void;
  /** After an inventory / zeny change: send the snapshot (the room also re-checks questinfo there). */
  invChanged(sid: string): void;
  /** After a worn piece was removed (delitem on equipment): status + look + snapshot. */
  gearChanged(sid: string): void;
  notice(sid: string, text: string): void;
  setInterval(fn: () => void, ms: number): void;
  /** A one-shot timer on the room clock (pc_addeventtimer: the dequeued OnTouch event). */
  setTimeout(fn: () => void, ms: number): void;
  /** clif_emotion: an emotion bubble over a unit (a player session id or an NPC id), sent to the AREA around it. */
  emotion(unitId: string, type: number): void;
  /** ZC_NPC_CHAT (npctalk): the NPC's line to `target` ("self" = only player `sid`). */
  npcTalk(npcId: string, text: string, color: number, target: "all" | "map" | "area" | "self", sid: string): void;
  /** A script's HP / SP change (status_heal / status_damage without an attacker): `show` = clif_heal numbers for what was healed
   *  (heal); a change that kills runs the character's death. */
  changeHpSp(sid: string, change: HpSpChange, show: boolean): void;
  /** npc_buysellsel / clif_npcbuysell for the player: sd->npc_shopid = the shop, and its window (CALLSHOP option). */
  openShop(sid: string, shop: NpcDef, option: CallshopOption): void;
  /** pc_checkskill by skill key (getskilllv). */
  skillLv(sid: string, key: string): number;
  /** pc_jobchange (jobchange): false = refused (same job / unknown). */
  jobChange(sid: string, job: JobKey): boolean;
  /** 2.5.0 pc_resetlvl(type 1) (resetlvl 1): the rebirth reset. */
  resetLevel(sid: string): void;
  /** pc_setpos (buildin_warp): same map = a warp on this map, another map = save + clif_changemap. */
  warp(sid: string, map: string, x: number, y: number): void;
  /** pc_setsavepoint (buildin_savepoint). */
  savepoint(sid: string, map: string, x: number, y: number): void;
}

type Reply = { kind: "next" | "close" | "menu"; choice?: number };
/** One running script: rAthena's script_state attached to the player. */
type Session = {
  npc: NpcDef;
  state: ScriptState;
  mesActive: boolean; // st->mes_active: a dialog window with text is open
  windowOpen: boolean; // what the client shows (dialog or menu), so an abnormal end can close it
  npcMenu: number; // sd->npc_menu: options of the pending menu
  clearCutin: boolean; // close3
  idleAt: number; // sd->npc_idle_tick
  waiting?: { resolve: (r: Reply) => void; reject: (e: unknown) => void };
  ended: boolean;
};
/** Per-player state: quests + variables, temporary @vars, questinfo display, the running script, the OnTouch areas the player
 *  stands in (sd->areanpc) and its queued OnTouch events (sd->eventqueue). */
type Pc = {
  store: QuestStore; temp: Map<string, number>; qi: Map<string, { icon: number; color: number }>; st?: Session;
  areanpc: Set<string>; queue: string[]; at?: { x: number; y: number };
};

const PARAMS = ["Zeny", "BaseLevel", "JobLevel", "BaseExp", "JobExp", "StatusPoint", "SkillPoint", "Hp", "MaxHp", "Sp", "MaxSp", "Weight", "MaxWeight", "Class", "BaseJob", "Sex"] as const;
const BUSY_LIST = "You can't carry any more items."; // clif_additem fail (ADDITEM_OVERITEM / OVERWEIGHT): the item is not given
const nowSec = () => Math.floor(Date.now() / 1000);

export class ScriptEngine {
  private readonly pcs = new Map<string, Pc>();
  private readonly host: ScriptHost;
  /** The NPCs of this map (questinfo is evaluated over them, OnTouch areas are theirs). */
  private readonly npcs: readonly NpcDef[];
  /** The trigger areas of this map's NPCs (npc_parse_script xs / ys). */
  private readonly areas: (TouchArea & { id: string })[];
  /** Every NPC by id, for callshop and other "<NPC name>" arguments (floating shops are on no map). */
  private readonly byId: ReadonlyMap<string, NpcDef>;

  constructor(host: ScriptHost, npcs: readonly NpcDef[], byId: ReadonlyMap<string, NpcDef> = NPC_BY_ID) {
    this.host = host;
    this.npcs = npcs;
    this.byId = byId;
    this.areas = npcs.filter((n) => n.trigger).map((n) => ({ id: n.id, x: n.x, y: n.y, xs: n.trigger!.x, ys: n.trigger!.y }));
    host.setInterval(() => this.idleCheck(), SECURE_NPCTIMEOUT_INTERVAL);
  }

  // ---------- login / logout ----------
  /** Load the character's quests and variables (before it enters the room state). `store` = an already built one (tests). */
  /** 2.5.0: a permanent character variable outside a script (pc_readglobalreg / pc_setglobalreg), e.g. jobchange_level. */
  charVar(sid: string, key: string) { return this.pcs.get(sid)?.store.vars.get(key) ?? 0; }
  setCharVar(sid: string, key: string, value: number) { this.pcs.get(sid)?.store.setVar(key, value); }
  async load(sid: string, inv: Inventory, store?: QuestStore) {
    this.pcs.set(sid, { store: store ?? await QuestStore.load(inv), temp: new Map(), qi: new Map(), areanpc: new Set(), queue: [] });
  }
  /** Map entry (clif_parse_LoadEndAck): the quest list (quest_pc_login) and the questinfo icons from scratch. */
  enter(sid: string) {
    const pc = this.pcs.get(sid);
    if (!pc) return;
    this.sendQuests(sid);
    pc.qi.clear(); // pc_show_questinfo_reinit
    this.questinfo(sid);
  }
  /** The session is gone (logout / eviction): the script is freed without telling anyone. */
  leave(sid: string) {
    this.end(sid, "logout");
    this.pcs.delete(sid);
  }
  /** sd->npc_id != 0 */
  talking(sid: string) { return !!this.pcs.get(sid)?.st; }

  // ---------- npc_click / npc_scriptcont / pc_close_npc ----------
  /** npc_click for a script NPC (range and the npc_id / shop lock were checked by the caller). */
  click(sid: string, npc: NpcDef) {
    if (npc.script) this.run(sid, npc, npc.script);
  }

  /** run_script with the player attached (script_attach_state: sd->npc_id = the NPC): one script per player at a time. */
  private run(sid: string, npc: NpcDef, entry: NpcScript): boolean {
    const pc = this.pcs.get(sid);
    if (!pc || pc.st) return false;
    const st: Session = { npc, state: "RUN", mesActive: false, windowOpen: false, npcMenu: 0, clearCutin: false, idleAt: this.host.now(), ended: false };
    pc.st = st;
    let api: Script;
    try { api = this.api(sid, pc, st); } catch { pc.st = undefined; return false; }
    entry(api).then(
      () => this.finish(sid, st),
      (e) => {
        if (!(e instanceof ScriptEnd)) console.error(`[script ${npc.id}]`, e);
        this.finish(sid, st);
      });
    return true;
  }

  // ---------- OnTouch areas (npc_touch_area_allnpc, npc_event, npc_event_sub, npc_event_dequeue) ----------
  /** The player stands on (x, y) now: after every completed step (unit_walktoxy_timer), on map entry (clif_parse_LoadEndAck) and
   *  after a warp. Areas left behind are forgotten (sd->areanpc); each area entered fires once: its OnTouch event, or a click on
   *  the NPC when it has no OnTouch label and the player is free (npc_touch_areanpc). */
  touch(sid: string, x: number, y: number) {
    const pc = this.pcs.get(sid);
    if (!pc) return;
    pc.at = { x, y };
    for (const id of touchAreas(this.areas, pc.areanpc, x, y)) {
      const npc = this.npcs.find((n) => n.id === id)!;
      if (npc.onTouch) this.event(sid, pc, npc);
      else if (!pc.st && npc.script) this.run(sid, npc, npc.script);
    }
  }

  /** npc_event_sub: a player running another script (sd->npc_id) gets the event queued (MAX_EVENTQUEUE, more are dropped with a
   *  warning); otherwise it runs at once. */
  private event(sid: string, pc: Pc, npc: NpcDef) {
    if (pc.st) {
      if (pc.queue.length < MAX_EVENTQUEUE) pc.queue.push(npc.id);
      else console.warn(`[script] event queue of ${sid} is full, ${npc.id}::OnTouch dropped`);
      return;
    }
    this.runEvent(sid, pc, npc);
  }

  /** npc_event_sub's re-check for a (queued) OnTouch event: it only runs while the player still stands in the area; a dropped one
   *  makes the next queued event run (npc_event_dequeue). */
  private runEvent(sid: string, pc: Pc, npc: NpcDef) {
    const a = this.areas.find((n) => n.id === npc.id);
    if (!a || !pc.at || !inTouchArea(a, pc.at.x, pc.at.y)) return this.dequeue(sid);
    const entry = npc.onTouch ?? npc.script;
    if (entry) this.run(sid, npc, entry);
  }

  /** npc_event_dequeue (script_detach_state, on the end of a script): the next queued event runs EVENTQUEUE_DELAY ms later. */
  private dequeue(sid: string) {
    const pc = this.pcs.get(sid);
    if (!pc?.queue.length) return;
    this.host.setTimeout(() => {
      const p = this.pcs.get(sid);
      if (!p || p !== pc) return;
      if (p.st) return; // the running script dequeues again when it ends
      const id = p.queue.shift(), npc = id === undefined ? undefined : this.npcs.find((n) => n.id === id);
      if (npc) this.event(sid, p, npc);
    }, EVENTQUEUE_DELAY);
  }

  /** CZ_REQ_NEXT_SCRIPT / CZ_CHOOSE_MENU / CZ_CLOSE_DIALOG -> npc_scriptcont. Answers for another NPC, from out of range
   *  (npc_checknear) or after the idle timeout are ignored; a forged menu choice ends the session (rAthena kicks). */
  reply(sid: string, npcId: string, r: Reply) {
    const st = this.pcs.get(sid)?.st;
    if (!st || st.ended || npcId !== st.npc.id) return;
    if (!this.host.near(sid, npcId)) return;
    if (r.kind === "menu" && !menuChoiceValid(r.choice, st.state === "RERUNLINE" ? st.npcMenu : 0)) {
      console.warn(`[script ${st.npc.id}] invalid menu choice ${String(r.choice)} (${st.npcMenu} options)`);
      return this.end(sid, "forged");
    }
    const closing = r.kind === "close";
    if (!closing) st.idleAt = this.host.now();
    const next = scriptCont(st.state, closing);
    if (next === "END") {
      if (st.state === "CLOSE" && closing) return this.resume(st, r); // the Close click of close / close3
      return this.end(sid, "unexpected");
    }
    if (st.state === "RERUNLINE" && r.kind !== "menu") return; // a menu waits for its choice (rAthena would re-run the line)
    this.resume(st, r);
  }

  private resume(st: Session, r: Reply) {
    const w = st.waiting;
    st.waiting = undefined;
    w?.resolve(r);
  }

  /** pc_close_npc + script end. flag "death" = pc_close_npc(sd,2): the dialog just goes; "timeout" = (sd,1): a Close
   *  button replaces Next / the menu and the cutin is cleared; "logout": nothing is sent. Also used for forged answers. */
  end(sid: string, why: "death" | "timeout" | "logout" | "forged" | "unexpected") {
    const pc = this.pcs.get(sid), st = pc?.st;
    if (!pc || !st) return;
    st.ended = true;
    st.state = "END";
    pc.st = undefined;
    if (why === "timeout") {
      this.host.send(sid, Msg.npcCloseBtn, { npc: st.npc.id } satisfies NpcButtonEvent);
      this.host.send(sid, Msg.cutin, { image: "", type: CUTIN.CLEAR } satisfies CutinEvent);
    } else if (why !== "logout" && st.windowOpen) {
      this.host.send(sid, Msg.npcEnd, { npc: st.npc.id } satisfies NpcButtonEvent);
    }
    st.windowOpen = false;
    const w = st.waiting;
    st.waiting = undefined;
    w?.reject(new ScriptEnd(why));
    if (why === "death") pc.queue.length = 0; // pc_dead: the character is out of every area's business
    else if (why !== "logout") this.dequeue(sid);
  }

  /** The script function returned or unwound: free the session (script_detach_state). A dialog left open without a close
   *  button is closed for the player (rAthena would leave it stuck and warn). */
  private finish(sid: string, st: Session) {
    const pc = this.pcs.get(sid);
    if (st.ended) return;
    st.ended = true;
    st.state = "END";
    if (pc?.st === st) pc.st = undefined;
    if (st.windowOpen) {
      if (st.mesActive) console.warn(`[script ${st.npc.id}] ended with the dialog open (no close)`);
      this.host.send(sid, Msg.npcEnd, { npc: st.npc.id } satisfies NpcButtonEvent);
    }
    this.dequeue(sid); // script_detach_state(st, true) -> npc_event_dequeue
  }

  /** SECURE_NPCTIMEOUT (npc_secure_timeout_timer): a Next or a menu unanswered for too long ends the dialog. */
  private idleCheck() {
    const now = this.host.now();
    for (const [sid, pc] of this.pcs) {
      const st = pc.st;
      if (!st || (st.state !== "STOP" && st.state !== "RERUNLINE")) continue;
      if (now - st.idleAt > (st.state === "RERUNLINE" ? NPC_SECURE_TIMEOUT_MENU : NPC_SECURE_TIMEOUT_NEXT)) this.end(sid, "timeout");
    }
  }

  // ---------- kills, quest toggle ----------
  /** mob_dead -> quest_update_objective for the killer (solo path). Party sharing (quest_update_objective_sub over the
   *  killer's party members within AREA_SIZE of the monster) belongs here once parties exist (C09). */
  mobDead(killerSid: string, mob: Mob) {
    const pc = this.pcs.get(killerSid);
    if (!pc || !pc.store.log.avail) return; // not a player of this room, or sd->avail_quests == 0
    const { updated, drops } = questUpdateObjective(pc.store.log, QUEST_DB, questKillOf(mob), this.host.mapName);
    for (const id of updated) pc.store.save(pc.store.log.entries.find((e) => e.questId === id)!);
    let got = false;
    for (const d of drops) got = this.giveItem(killerSid, ITEMS.get(d.itemId)!, d.count) || got; // pc_additem(LOG_TYPE_QUEST)
    if (got) this.host.invChanged(killerSid);
    if (updated.length) this.sendQuests(killerSid);
    this.questinfo(killerSid);
  }

  /** CZ_ACTIVE_QUEST -> quest_update_status(Q_ACTIVE / Q_INACTIVE): show / hide a quest in the tracker. */
  setActive(sid: string, questId: number, active: boolean) {
    const pc = this.pcs.get(sid);
    if (!pc || !Number.isInteger(questId)) return;
    if (!questUpdateStatus(pc.store.log, questId, active ? Q_ACTIVE : Q_INACTIVE)) return;
    pc.store.save(pc.store.log.entries.find((e) => e.questId === questId)!);
    this.sendQuests(sid);
  }

  // ---------- questinfo (pc_show_questinfo) ----------
  /** Re-check every questinfo NPC of the map for the player and send only the icons that changed. */
  questinfo(sid: string) {
    const pc = this.pcs.get(sid);
    if (!pc) return;
    const view = this.reader(sid, pc);
    for (const n of this.npcs) {
      if (!n.questinfo?.length) continue;
      const hit = n.questinfo.find((q) => {
        try { return !q.condition || q.condition(view); } catch (e) { console.error(`[questinfo ${n.id}]`, e); return false; }
      });
      const cur = pc.qi.get(n.id);
      if (hit) {
        const color = hit.color ?? QMARK.NONE;
        if (cur && cur.icon === hit.icon && cur.color === color) continue;
        pc.qi.set(n.id, { icon: hit.icon, color });
        this.host.send(sid, Msg.questMark, { npc: n.id, icon: hit.icon, color } satisfies QuestMarkEvent);
      } else if (cur) {
        pc.qi.delete(n.id);
        this.host.send(sid, Msg.questMark, { npc: n.id, icon: QTYPE.NONE, color: QMARK.NONE } satisfies QuestMarkEvent);
      }
    }
  }

  private sendQuests(sid: string) {
    const pc = this.pcs.get(sid);
    if (!pc) return;
    const quests = pc.store.log.entries.slice(0, pc.store.log.avail).map((e) => ({ id: e.questId, state: e.state, time: e.time, count: [...e.count] }));
    const done = pc.store.log.entries.slice(pc.store.log.avail).map((e) => e.questId);
    this.host.send(sid, Msg.quests, { quests, done } satisfies QuestLogEvent);
  }

  // ---------- the commands ----------
  /** Read-only part shared by scripts and questinfo conditions. */
  private reader(sid: string, pc: Pc): QuestInfoView {
    const host = this.host;
    return {
      strcharinfo: () => host.pc(sid)?.name ?? "",
      get: (name: string) => {
        const p = host.pc(sid), inv = host.inv(sid);
        if ((PARAMS as readonly string[]).includes(name)) {
          if (!p) return 0;
          switch (name as (typeof PARAMS)[number]) {
            case "Zeny": return inv?.zeny ?? 0;
            case "BaseLevel": return p.level;
            case "JobLevel": return p.jobLevel;
            case "BaseExp": return p.exp;
            case "JobExp": return p.jobExp;
            case "StatusPoint": return p.statPoints;
            case "SkillPoint": return p.skillPoints;
            case "Hp": return p.hp;
            case "MaxHp": return p.maxHp;
            case "Sp": return p.sp;
            case "MaxSp": return p.maxSp;
            case "Weight": return inv?.weight() ?? 0;
            case "MaxWeight": return maxWeight(p.job as JobKey, p.str);
            // pc_readparam SP_CLASS / SP_BASEJOB: the job id (e_job: first jobs' ids equal their MAPID, shared/rules/status.ts)
            // 2.5.0: BaseJob = pc_mapid2jobid(class_ & MAPID_BASEMASK): the first job of the line (Knight / Lord Knight -> Swordman)
            case "Class": return MAPID[p.job as JobKey] ?? 0;
            case "BaseJob": return (MAPID[p.job as JobKey] ?? 0) & 0xff;
            case "Sex": return p.gender === "F" ? 0 : 1; // SEX_FEMALE 0 / SEX_MALE 1
          }
        }
        const scope = varScope(name);
        if (!scope) throw new Error(`bad variable name "${name}"`);
        return (scope === "temp" ? pc.temp.get(name) : pc.store.vars.get(name)) ?? 0;
      },
      countitem: (item: ItemRef) => {
        const it = resolveItem(item), inv = host.inv(sid);
        let n = 0;
        if (inv) for (const s of inv.items.values()) if (s.itemId === it.id) n += s.amount;
        return n;
      },
      checkquest: (id: number, type: QuestCheckType = "HAVEQUEST") => questCheck(pc.store.log, QUEST_DB, id, type, nowSec()),
      isbegin_quest: (id: number) => isbeginQuest(pc.store.log, QUEST_DB, id, nowSec()),
      getskilllv: (skill: string) => host.skillLv(sid, skill),
      isequipped: (...items: ItemRef[]) => {
        const inv = host.inv(sid);
        const worn = inv ? [...inv.items.values()].filter((s) => s.equip).map((s) => s.itemId) : [];
        return isequippedIds(worn, items.map((i) => resolveItem(i).id));
      },
    };
  }

  private api(sid: string, pc: Pc, st: Session): Script {
    const host = this.host, engine = this;
    const npcId = st.npc.id;
    const alive = () => { if (st.ended) throw new ScriptEnd("session ended"); };
    const send = (type: string, msg: unknown) => host.send(sid, type, msg);
    const wait = (state: ScriptState) => {
      st.state = state;
      return new Promise<Reply>((resolve, reject) => { st.waiting = { resolve, reject }; });
    };
    const read = this.reader(sid, pc);
    const questChanged = () => { engine.sendQuests(sid); engine.questinfo(sid); };
    const menu = async (args: string[], prompt: boolean) => {
      alive();
      const m = menuBuild(args);
      st.npcMenu = m.npcMenu;
      st.idleAt = host.now();
      st.windowOpen = true;
      send(Msg.npcMenuList, { npc: npcId, options: m.shown } satisfies NpcMenuEvent);
      const r = await wait("RERUNLINE");
      alive();
      st.state = "RUN";
      if (r.choice === MENU_CANCEL) {
        st.windowOpen = false; // the client closes its windows on Cancel
        pc.temp.set("@menu", MENU_CANCEL);
        if (!prompt) throw new ScriptEnd("cancel"); // buildin_select: Cancel -> END
        return MENU_CANCEL;
      }
      const index = menuSelect(args, r.choice!);
      pc.temp.set("@menu", index);
      return index;
    };
    const closeBtn = async (cutin: boolean): Promise<never> => {
      alive();
      if (!st.mesActive) { // buildin_close without a dialog: "Incorrect use", the script just ends
        console.warn(`[script ${npcId}] close without an open dialog`);
        send(Msg.npcCloseBtn, { npc: npcId } satisfies NpcButtonEvent);
        st.windowOpen = false;
        throw new ScriptEnd("close");
      }
      st.mesActive = false;
      st.clearCutin = cutin;
      send(Msg.npcCloseBtn, { npc: npcId } satisfies NpcButtonEvent);
      await wait("CLOSE");
      st.windowOpen = false; // the client closed it on the click
      if (st.clearCutin) send(Msg.cutin, { image: "", type: CUTIN.CLEAR } satisfies CutinEvent);
      throw new ScriptEnd("close");
    };

    const s: Script = {
      npc: { id: npcId, name: st.npc.name },
      mes(...lines) {
        alive();
        for (const line of lines) send(Msg.npcMes, { npc: npcId, text: String(line) } satisfies NpcMesEvent);
        st.mesActive = true;
        st.windowOpen = true;
      },
      async next() {
        alive();
        if (!st.mesActive) { console.warn(`[script ${npcId}] next without an open dialog`); return; }
        st.idleAt = host.now();
        send(Msg.npcNextBtn, { npc: npcId } satisfies NpcButtonEvent);
        await wait("STOP");
        alive();
        st.state = "RUN";
      },
      close: () => closeBtn(false),
      close3: () => closeBtn(true),
      async close2() {
        alive();
        st.mesActive = false;
        st.idleAt = host.now();
        send(Msg.npcCloseBtn, { npc: npcId } satisfies NpcButtonEvent);
        await wait("STOP");
        alive();
        st.windowOpen = false;
        st.state = "RUN";
      },
      clear() {
        alive();
        if (!st.mesActive) { console.warn(`[script ${npcId}] clear without an open dialog`); return; }
        send(Msg.npcClear, { npc: npcId } satisfies NpcButtonEvent);
      },
      end() { alive(); throw new ScriptEnd("end"); },
      select: (...options) => menu(options, false),
      prompt: (...options) => menu(options, true),
      cutin(image, type) {
        alive();
        if (!cutinNameValid(image) || ![0, 1, 2, 3, 4, 255].includes(type)) throw new Error(`bad cutin ${image}, ${type}`);
        send(Msg.cutin, { image, type } satisfies CutinEvent);
      },
      strcharinfo(type) { alive(); return type === 0 ? read.strcharinfo(0) : ""; },
      get(name) { alive(); return read.get(name); },
      set(name, value) {
        alive();
        const v = Math.trunc(Number(value));
        if (!Number.isSafeInteger(v)) throw new Error(`set ${name}: not an integer (${String(value)})`);
        if (name === "Zeny") return engine.setZeny(sid, v);
        if ((PARAMS as readonly string[]).includes(name)) throw new Error(`set ${name}: read-only here`);
        const scope = varScope(name);
        if (!scope) throw new Error(`bad variable name "${name}"`);
        if (scope === "temp") { if (v === 0) pc.temp.delete(name); else pc.temp.set(name, v); }
        else pc.store.setVar(name, v);
      },
      countitem(item) { alive(); return read.countitem(item); },
      checkweight(item, amount, ...more) { alive(); return engine.checkWeight(sid, [item, amount, ...more]); },
      getitem(item, amount) {
        alive();
        const it = resolveItem(item), n = Math.trunc(Number(amount));
        if (!(n > 0)) return true; // buildin_getitem: amount <= 0 does nothing
        const ok = engine.giveItem(sid, it, n);
        if (ok) host.invChanged(sid);
        return ok;
      },
      delitem(item, amount) {
        alive();
        const it = resolveItem(item), n = Math.trunc(Number(amount));
        if (!(n > 0)) return;
        if (!engine.takeItem(sid, it, n)) { // buildin_delitem: not enough -> END + close the dialog
          console.warn(`[script ${npcId}] delitem ${it.id} x${n}: not enough`);
          st.mesActive = false;
          send(Msg.npcCloseBtn, { npc: npcId } satisfies NpcButtonEvent);
          st.windowOpen = false;
          throw new ScriptEnd("delitem");
        }
      },
      getexp(base, job) {
        alive();
        const b = Math.trunc(Number(base)), j = Math.trunc(Number(job));
        if (!(b >= 0) || !(j >= 0) || (b === 0 && j === 0)) { console.warn(`[script ${npcId}] getexp ${base}, ${job} ignored`); return; }
        host.gainExp(sid, Math.trunc((b * QUEST_EXP_RATE) / 100), Math.trunc((j * QUEST_EXP_RATE) / 100));
      },
      setquest(id) {
        alive();
        const e = questAdd(pc.store.log, QUEST_DB, id, nowSec());
        if (e === -1) console.warn(`[script ${npcId}] setquest ${id}: unknown or already held`);
        else pc.store.save(e);
        questChanged();
      },
      completequest(id) {
        alive();
        if (questUpdateStatus(pc.store.log, id, Q_COMPLETE)) pc.store.save(pc.store.log.entries.find((e) => e.questId === id)!);
        else console.warn(`[script ${npcId}] completequest ${id}: not held`);
        questChanged();
      },
      erasequest(id) {
        alive();
        if (questDelete(pc.store.log, id)) pc.store.remove(id);
        else console.warn(`[script ${npcId}] erasequest ${id}: not held`);
        questChanged();
      },
      changequest(id, id2) {
        alive();
        const e = questChange(pc.store.log, QUEST_DB, id, id2, nowSec());
        if (e === -1) console.warn(`[script ${npcId}] changequest ${id} -> ${id2} refused`);
        else { pc.store.remove(id); pc.store.save(e); }
        questChanged();
      },
      checkquest(id, type = "HAVEQUEST") { alive(); return read.checkquest(id, type); },
      isbegin_quest(id) { alive(); return read.isbegin_quest(id); },
      showevent(icon, color = QMARK.NONE) {
        alive();
        const a = showeventArgs(icon, color);
        send(Msg.questMark, { npc: npcId, icon: a.icon, color: a.color } satisfies QuestMarkEvent);
      },
      emotion(type, target) {
        alive();
        if (!emotionValid(type)) { console.warn(`[script ${npcId}] emotion ${String(type)}: unknown emotion`); return; }
        const unit = target === undefined ? npcId : String(target);
        // script_rid2bl: the target must be a unit that exists (the attached player, another player here, an NPC of this map)
        if (unit !== sid && !engine.npcs.some((n) => n.id === unit) && !host.pc(unit)) { console.warn(`[script ${npcId}] emotion: unknown target ${unit}`); return; }
        host.emotion(unit, type);
      },
      npctalk(message, npc = "", flag, color = NPCTALK_COLOR) {
        alive();
        const id = npc || npcId; // npc_name2id, or the NPC running the script
        if (!engine.npcs.some((n) => n.id === id)) { console.warn(`[script ${npcId}] npctalk: no NPC ${id} on this map`); return; }
        const c = Math.trunc(Number(color));
        host.npcTalk(id, String(message).slice(0, CHAT_SIZE_MAX - 1), Number.isFinite(c) ? c & 0xffffff : NPCTALK_COLOR, npctalkTarget(flag), sid);
      },
      playerattached() { alive(); return sid; },
      heal(hp, sp) {
        alive();
        const p = host.pc(sid);
        if (p) host.changeHpSp(sid, scriptHeal(p, Math.trunc(Number(hp)) || 0, Math.trunc(Number(sp)) || 0), true);
      },
      percentheal(hp, sp) {
        alive();
        const p = host.pc(sid);
        if (p) host.changeHpSp(sid, percentHeal(p, Number(hp) || 0, Number(sp) || 0), false);
      },
      isequipped(...items) { alive(); return read.isequipped(...items); },
      // ---- refining (script.cpp getequip* , buildin_successrefitem / buildin_failedrefitem) ----
      getequipisequiped(part) { alive(); return !!engine.worn(sid, part); },
      getequipisenableref(part) { alive(); const w = engine.worn(sid, part); return !!w && ITEMS.get(w.itemId)!.refineable; },
      getequiprefinerycnt(part) { alive(); return engine.worn(sid, part)?.refine ?? 0; },
      getequipweaponlv(part) { alive(); const w = engine.worn(sid, part); return w && ITEMS.get(w.itemId)!.type === "Weapon" ? ITEMS.get(w.itemId)!.weaponLevel : 0; },
      getequiparmorlv(part) { alive(); const w = engine.worn(sid, part); return w && ITEMS.get(w.itemId)!.type === "Armor" ? ITEMS.get(w.itemId)!.armorLevel : 0; },
      getequipid(part) { alive(); return engine.worn(sid, part)?.itemId ?? 0; },
      getequipname(part) { alive(); const w = engine.worn(sid, part); return w ? itemDisplayName(ITEMS.get(w.itemId)!, w.cards, w.refine) : ""; },
      getequippercentrefinery(part) { alive(); const w = engine.worn(sid, part); return w ? refinePercent(ITEMS.get(w.itemId)!, w.refine) : 0; },
      getequiprefinecost(part, info) {
        alive();
        const w = engine.worn(sid, part), c = w && refineCost(ITEMS.get(w.itemId)!, w.refine);
        return !c ? 0 : info === REFINE_COST.MATERIAL_ID ? c.material : c.price;
      },
      successrefitem(part) {
        alive();
        const inv = host.inv(sid), w = engine.worn(sid, part);
        if (!inv || !w) return -1;
        if (w.refine < MAX_REFINE) inv.setRefine(w.uid, w.refine + 1);
        host.gearChanged(sid); // status_calc_pc via pc_equipitem: the new +N reaches ATK / DEF and the look
        return w.refine;
      },
      failedrefitem(part) {
        alive();
        const inv = host.inv(sid), w = engine.worn(sid, part);
        if (!inv || !w) return;
        inv.unequip(w.uid);
        inv.remove(w.uid, 1); // pc_delitem: the piece and its cards are gone
        host.gearChanged(sid);
      },
      getskilllv(skill) { alive(); return read.getskilllv(skill); },
      basicskillcheck() { alive(); return SKILL_CONF.basic_skill_check; },
      jobchange(job) { alive(); return host.jobChange(sid, job); },
      resetlvl(type) { alive(); if (type === 1) host.resetLevel(sid); },
      // buildin_warp (script.cpp): pc_setpos(sd, map, x, y, CLR_TELEPORT); the player leaves the NPC, so the script is over
      warp(map, x, y) { alive(); host.warp(sid, String(map), Number(x), Number(y)); throw new ScriptEnd("warp"); },
      // buildin_savepoint (script.cpp) -> pc_setsavepoint: sd->status.save_point = map, x, y
      savepoint(map, x, y) { alive(); host.savepoint(sid, String(map), Number(x), Number(y)); },
      callshop(name, option) {
        alive();
        const shop = engine.byId.get(String(name));
        if (!shop || shop.kind !== "shop") { console.warn(`[script ${npcId}] callshop: shop ${String(name)} not found (or not a shop)`); return false; }
        host.openShop(sid, shop, callshopOption(option));
        return true;
      },
    };
    return s;
  }

  /** The row worn in `part` (pc_checkequip(sd, equip_bitmask[part])). */
  private worn(sid: string, part: string) {
    return this.host.inv(sid)?.equipped(part as EquipSlot);
  }

  // ---------- inventory helpers (pc_additem / pc_delitem / buildin_checkweight / pc_setparam SP_ZENY) ----------
  /** pc_additem: false + the fail message when it doesn't fit (the item is not given, like clif_additem's fail). */
  private giveItem(sid: string, it: Item, amount: number): boolean {
    const p = this.host.pc(sid), inv = this.host.inv(sid);
    if (!p || !inv) return false;
    const why = inv.canAdd(it, amount, p.job as JobKey, p.str);
    if (why) { this.host.notice(sid, `${BUSY_LIST} (${it.name}: ${why})`); return false; }
    if (/^petegg$/i.test(it.type) && this.host.makeEgg) { // buildin_getitem: IT_PETEGG -> pet_create_egg per egg
      let ok = false;
      for (let i = 0; i < amount; i++) ok = this.host.makeEgg(sid, it.id) || ok;
      return ok;
    }
    inv.add(it.id, amount);
    this.host.send(sid, Msg.itemGet, { itemId: it.id, amount, quest: true } satisfies ItemGetEvent);
    return true;
  }

  /** buildin_delitem_search: all or nothing, unworn stacks first (equip 0 / refine 0 matches), worn ones after. */
  private takeItem(sid: string, it: Item, amount: number): boolean {
    const inv = this.host.inv(sid);
    if (!inv) return false;
    const stacks = [...inv.items.values()].filter((s) => s.itemId === it.id).sort((a, b) => Number(!!a.equip) - Number(!!b.equip) || a.refine - b.refine);
    if (stacks.reduce((n, s) => n + s.amount, 0) < amount) return false;
    let left = amount, worn = false;
    for (const s of stacks) {
      if (!left) break;
      const n = Math.min(left, s.amount);
      if (s.equip) { inv.unequip(s.uid); worn = true; }
      inv.remove(s.uid, n);
      left -= n;
    }
    if (worn) this.host.gearChanged(sid);
    else this.host.invChanged(sid);
    return true;
  }

  /** buildin_checkweight (script.cpp:7480) over item / amount pairs: the running total weight must stay within max weight, no
   *  stack may pass MAX_AMOUNT, and the new rows (1 per new stackable item, 1 per piece otherwise) must fit the free rows.
   *  Each pair is checked against the current inventory (pc_checkadditem), like the C++. */
  private checkWeight(sid: string, args: readonly (ItemRef | number)[]): boolean {
    const p = this.host.pc(sid), inv = this.host.inv(sid);
    if (!p || !inv || args.length % 2) return false;
    const held = inv.rows(), slots = inventoryBlank(held), max = maxWeight(p.job as JobKey, p.str);
    let weight = inv.weight(), rows = 0;
    for (let i = 0; i < args.length; i += 2) {
      const it = resolveItem(args[i]), n = Math.trunc(Number(args[i + 1]));
      if (!(n >= 1)) return false;
      weight += it.weight * n;
      if (weight > max) return false;
      const chk = checkAddItem(held, it, n);
      if (chk === "overamount") return false;
      if (chk === "new" && slots < (rows += slotsNeeded(it, n))) return false;
    }
    return true;
  }

  /** pc_setparam(SP_ZENY): a negative value is refused; the purse is set (capped at MAX_ZENY); a gain is shown. */
  private setZeny(sid: string, value: number) {
    const inv = this.host.inv(sid);
    if (!inv || value < 0) return;
    const before = inv.zeny;
    if (value > before) inv.gainZeny(value - before);
    else if (value < before) inv.payZeny(before - value);
    if (inv.zeny === before) return;
    if (inv.zeny > before) this.host.send(sid, Msg.zenyGet, { amount: inv.zeny - before } satisfies ZenyEvent);
    this.host.invChanged(sid);
  }
}

/** An item reference of a script: id or our name; an unknown one is a script bug (buildin_getitem "Nonexistant item"). */
function resolveItem(ref: ItemRef): Item {
  const it = itemNamed(ref);
  if (!it) throw new Error(`unknown item ${String(ref)}`);
  return it;
}
