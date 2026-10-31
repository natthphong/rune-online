// Auto-play (C12, RO3's auto quest / auto battle): drives the tracked quest hands-free with nothing but the intents a player's
// clicks send — move (through the navigation planner, navi.ts), attack, pickup, npc click and Next / Close on plain dialog pages.
// The server sees an ordinary player; every rule it enforces (pc_cant_act while a dialog is open, the cell stack limit, the
// sit / stand toggle, weight) applies unchanged. Menus: only an option that takes quest work is answered here (QUEST_ANSWER,
// "Any work for me?", "Leave it to me!", "I'll gather them."...); anything else (shops, job change, hearth, "not now") waits
// for the player, and an option that sounds like spending or committing (NEVER_ANSWER) is never picked.
//
// Each tick picks ONE step, in this order: safety (death / weight / low HP: rest), the open dialog (Next / Close after a reading
// pause, wait at a menu), the tracked quests ([Main] first, then log order: kill -> hunt the monsters the objective counts,
// collect -> hunt the droppers and pick the item up, Visit -> walk there, done / talk-only -> walk to the Report NPC and click
// it), an NPC with work on offer ("!" / "?" marks), and finally auto-hunt: monsters of the character's level band plus loot.
// No DOM here: the browser UI (auto.ts) and the test bot (scripts/auto.ts) share this module.
// W01: quest places, Report NPCs and hunting grounds may be on another map: navigation walks the warps on the way (navi.ts), and
// a map change keeps auto on (main.ts / the bot re-bind and call setAuto(true, true)). With nothing to do, the auto-hunt heads for
// the field whose level band suits the character (shared/maps.ts fieldForLevel).
import type { Room } from "@colyseus/sdk";
import { Msg, type InvEvent, type QuestLogEvent, type QuestMarkEvent, type StatusEvent } from "../../shared/protocol.ts";
import { QUEST_DB, QUEST_INFO } from "../../shared/content/quest_db.ts";
import { taskProgress, type TaskView } from "../../shared/content/tasks.ts";
import { MOBS, MOB_BY_ID } from "../../shared/rules/data.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { itemNamed, objectiveMatches, questKillOf, type QuestObjective } from "../../shared/rules/quest.ts";
import { QTYPE } from "../../shared/rules/script.ts";
import { FIELD_MOBS, NPC_HOMES, fieldForLevel, huntPlaceFor, mapOfState } from "../../shared/maps.ts";
import { SEAL } from "../../shared/content/f1/stair.ts";
import { naviRoute } from "../../shared/navi.ts";
import { naviActive, startNavi, stopNavi } from "./navi.ts";

type Entry = QuestLogEvent["quests"][number];
type Cell = { x: number; y: number };
type Place = Cell & { map?: string };
export type AutoStep =
  | { do: "npc"; id: string; why: string }
  | { do: "hunt"; mobIds: number[]; loot: number[] | "any"; fallback?: Place; why: string }
  | { do: "cell"; x: number; y: number; map?: string; why: string }
  | { do: "rest"; why: string }
  | { do: "idle"; why: string };
export type AutoOptions = {
  /** The character can't act right now (an NPC window is open: pc_cant_act). Default: tracked from the dialog messages. */
  locked?: () => boolean;
  /** Answer a plain dialog page like the player's button would (the browser clicks the window's own Next / Close). */
  press?: (what: "next" | "close", npc: string) => void;
  /** Answer a menu like a click on option `choice` (1-based) of the open menu window. Default: send the request. */
  choose?: (choice: number, npc: string) => void;
  /** Learned skill levels for Skill tasks (the skill window's list); 0 when unknown. */
  skillLv?: (key: string) => number;
  /** Reading pause before Next / Close on a plain page. */
  pageMs?: number;
  /** Where "Auto stopped: ..." lines go (the chat log). */
  log?: (text: string) => void;
};

const TICK_MS = 250;
const REST_BELOW = 0.3; // stop and recover under 30 % HP...
const REST_UNTIL = 0.9; // ...until 90 %
const WEIGHT_STOP = 0.5; // 50 % weight: natural regen stops (pc_is50overweight) — auto stops before it hunts on with no regen
const ATTACK_MS = 1500; // re-send the attack request this often while the target lives (a click on the same monster)
const ATTACK_RANGE = 12; // attack from here (the server walks into range); farther = navigate first
const LOOT_RANGE = 10;
const TALK_COOLDOWN_MS = 20_000; // after talking to an NPC without the quest log changing, don't click it again for a while
const BAND = 2; // auto-hunt: monsters up to this many levels above the character
const POTION_MS = 1000; // one healing item per second at most while HP is low
const FIGHT_BACK_MS = 2500; // a monster that hit us this recently is fought, not sat in front of
const OFFER = new Set<number>([QTYPE.QUEST, QTYPE.QUEST2, QTYPE.JOB, QTYPE.JOB2, QTYPE.EVENT, QTYPE.EVENT2, QTYPE.EVENT3, QTYPE.DAILYQUEST, QTYPE.JOBQUEST]);
// Menu answers auto may give: the options that take on or hand in quest work (guide / ranger / herbalist / merchant scripts). Job
// change, buy / sell, the hearth, quiz answers and every refusal are the player's.
const QUEST_ANSWER = /^(any work\b|leave it\b|consider it done|i'll (gather|do it|tell|take|protect)\b|i will\b|accept\b|report\b|deliver\b)/i;
const NEVER_ANSWER = /\b(buy|sell|shop|trade|pay|refine|upgrade|become|job|hearth|rest|ready|zeny|cancel|goodbye|not|maybe|later|nothing|think)\b/i;
/** The 1-based option to answer, or 0 when the player has to (exported for tests). */
export function menuAnswer(options: string[]): number {
  const i = options.findIndex((o) => QUEST_ANSWER.test(o.trim()) && !NEVER_ANSWER.test(o));
  return i + 1;
}
const cheb = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

let room: Room | undefined;
let opts: AutoOptions = {};
let on = false, task = "";
let quests: Entry[] = [], inv: InvEvent | undefined, own: StatusEvent | undefined;
const marks = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | undefined;
const offs: (() => void)[] = [];
// dialog
let menuPick: { npc: string; choice: number; at: number } | undefined;
let dlgOpen = false, dlgNpc = "", menuOpen = false, pending: { what: "next" | "close"; npc: string; at: number } | undefined;
// execution memory
let goalKey = "", target: string | undefined, attackAt = 0, sitAt = 0, resting = false, potionAt = 0;
let hitBy: string | undefined, hitAt = 0; // the last monster that hurt us
let talkingTo = ""; // the NPC this auto walked to / clicked (its dialog is ours; any other window = the player's)
const talkedAt = new Map<string, number>(), lootTried = new Map<string, number>();
const listeners = new Set<(on: boolean, task: string) => void>();
const emit = () => { for (const f of listeners) f(on, task); };
const setTask = (t: string) => { if (t !== task) { task = t; emit(); } };

const S = () => room?.state as any;
const meOf = () => S()?.players?.get(room!.sessionId);
const here = (p: any): Cell => ({ x: Math.round(p.x), y: Math.round(p.y) });
const invCount = (itemId: number) => inv?.items.filter((s) => s.itemId === itemId).reduce((n, s) => n + s.amount, 0) ?? 0;
const locked = () => (opts.locked ? opts.locked() : dlgOpen);
const npcName = (id: string) => String(S()?.npcs?.get(id)?.name ?? NPC_HOMES[id]?.name ?? id);

export function onAuto(f: (on: boolean, task: string) => void) { listeners.add(f); }
export const autoOn = () => on;
export const autoTask = () => task;

/** Listen to a room's messages (call once per room; `undefined` = left the world). */
export function bindAuto(r: Room | undefined, o: AutoOptions = {}) {
  stopAuto();
  for (const off of offs.splice(0)) off();
  if (timer) clearInterval(timer);
  timer = undefined;
  room = r; opts = o; quests = []; inv = undefined; own = undefined; marks.clear(); talkedAt.clear(); lootTried.clear();
  dlgOpen = false; menuOpen = false; pending = undefined; menuPick = undefined;
  if (!r) return;
  const sub = (type: string, f: (m: any) => void) => { const off = r.onMessage(type, f); if (typeof off === "function") offs.push(off); };
  sub(Msg.quests, (m: QuestLogEvent) => { const changed = JSON.stringify(m.quests) !== JSON.stringify(quests); quests = m.quests; if (changed) talkedAt.clear(); });
  sub(Msg.questMark, (m: QuestMarkEvent) => { marks.set(m.npc, m.icon); });
  sub(Msg.inv, (m: InvEvent) => { inv = m; });
  sub(Msg.status, (m: StatusEvent) => { own = m; });
  const opened = (npc: string) => {
    dlgOpen = true; dlgNpc = npc;
    if (on && npc !== talkingTo) stopAuto("Auto stopped: you are talking to someone."); // the player opened it, not auto
  };
  sub(Msg.npcMes, (m: { npc: string }) => { opened(m.npc); menuOpen = false; });
  sub(Msg.npcNextBtn, (m: { npc: string }) => { opened(m.npc); pending = { what: "next", npc: m.npc, at: Date.now() + (opts.pageMs ?? 1500) }; });
  sub(Msg.npcCloseBtn, (m: { npc: string }) => { opened(m.npc); pending = { what: "close", npc: m.npc, at: Date.now() + (opts.pageMs ?? 1500) }; });
  sub(Msg.npcMenuList, (m: { npc: string; options: string[] }) => {
    opened(m.npc); pending = undefined; menuOpen = true;
    const choice = on && m.npc === talkingTo ? menuAnswer(m.options ?? []) : 0;
    menuPick = choice ? { npc: m.npc, choice, at: Date.now() + (opts.pageMs ?? 1500) } : undefined;
  });
  sub(Msg.npcEnd, () => dialogOver());
  sub(Msg.hit, (m: { from: string; to: string; miss: boolean }) => { if (m.to === r.sessionId && !m.miss && S()?.monsters?.has(m.from)) { hitBy = m.from; hitAt = Date.now(); } });
  sub(Msg.shop, () => { if (on) stopAuto("Auto stopped: a shop window is open."); });
  sub(Msg.die, (m: { id: string }) => { if (m.id === r.sessionId && on) stopAuto("Auto stopped: you were knocked out."); else if (m.id === target) target = undefined; });
  timer = setInterval(tick, TICK_MS);
}
function dialogOver() {
  if (dlgNpc) talkedAt.set(dlgNpc, Date.now());
  dlgOpen = false; menuOpen = false; pending = undefined; menuPick = undefined; talkingTo = "";
}

/** `quiet`: no chat line (auto goes on after a map change). */
export function setAuto(v: boolean, quiet = false) {
  if (v === on) return;
  if (!v) return stopAuto();
  if (!room) return;
  on = true; goalKey = ""; target = undefined; resting = false; task = "Starting…";
  if (!quiet) opts.log?.("Auto on: the character plays the tracked quest. Click anywhere to take over.");
  emit();
}
export function toggleAuto() { setAuto(!on); }
/** Stop (a manual click, death, a window the player opened...). `why` goes to the chat log. */
export function stopAuto(why?: string) {
  if (!on) return;
  on = false; task = ""; goalKey = ""; target = undefined; resting = false;
  if (naviActive()) stopNavi();
  if (why) opts.log?.(why);
  emit();
}

// ---------- planning ----------
/** Monsters an objective counts: its Mob, or every monster passing the Id target's filters (quest_objective_check). */
function targetMobs(o: QuestObjective): number[] {
  if (o.mobId) return [o.mobId];
  return MOBS.filter((m) => objectiveMatches(o, questKillOf(m), "")).map((m) => m.id);
}
function taskView(): TaskView {
  const idOf = (ref: string | number) => itemNamed(ref)?.id;
  return {
    statusPoint: own?.statPoints ?? 0, baseLevel: own?.level ?? 0, hp: own?.hp ?? 0, maxHp: own?.maxHp ?? 0, jobLevel: own?.jobLevel ?? 0,
    skillLv: opts.skillLv ?? (() => 0),
    countitem: (ref) => invCount(idOf(ref) ?? -1),
    isequipped: (ref) => { const id = idOf(ref); return !!inv?.items.some((s) => s.itemId === id && !!s.equip); },
  };
}
/** An NPC we can walk to and click: in this room, or on another map we know (NPC_HOMES: navigation crosses the warps). */
const talkable = (id: string) => (!!S()?.npcs?.get(id) || (!!NPC_HOMES[id] && NPC_HOMES[id].map !== S()?.map)) && Date.now() - (talkedAt.get(id) ?? 0) > TALK_COOLDOWN_MS;

/** The next thing to do for one quest, or a reason it can't be automated (`idle`), or undefined (nothing here). */
function questStep(e: Entry): AutoStep | undefined {
  const def = QUEST_DB.get(e.id), info = QUEST_INFO.get(e.id), title = def?.title ?? `Quest ${e.id}`;
  const navi = info?.Navi ? { x: info.Navi.x, y: info.Navi.y, map: info.Navi.map } : undefined;
  const items = (info?.Items ?? []).map((it) => ({ item: itemNamed(it.Item), need: it.Count })).filter((x) => !!x.item);
  const questLoot = [...items.map((x) => x.item!.id), ...(def?.drops ?? []).map((d) => d.itemId)];
  for (const [j, o] of (def?.objectives ?? []).entries()) {
    if ((e.count[j] ?? 0) >= o.count) continue;
    const name = o.mobId ? MOB_BY_ID.get(o.mobId)?.name ?? "monsters" : "monsters";
    const mobIds = targetMobs(o);
    return { do: "hunt", mobIds, loot: questLoot, fallback: huntPlaceFor(mobIds, navi, S()?.map ?? ""), why: `${title}: defeat ${name} ${e.count[j] ?? 0}/${o.count}` };
  }
  for (const { item, need } of items) {
    const have = invCount(item!.id);
    if (have >= need) continue;
    const from = new Set([...MOBS.filter((m) => m.drops?.some((d) => d.item === item!.id)).map((m) => m.id),
      ...(def?.drops ?? []).filter((d) => d.itemId === item!.id && d.mobId).map((d) => d.mobId)]);
    if (!from.size) return { do: "idle", why: `${title}: bring ${item!.name} (${have}/${need})` };
    return { do: "hunt", mobIds: [...from], loot: questLoot, fallback: huntPlaceFor([...from], navi, S()?.map ?? ""), why: `${title}: collect ${item!.name} ${have}/${need}` };
  }
  for (const t of info?.Tasks ?? []) {
    if (taskProgress(t, taskView()).done) continue;
    if ("Visit" in t) return { do: "cell", x: t.Visit.X, y: t.Visit.Y, map: t.Visit.Map, why: `${title}: ${t.Text}` };
    if ("HpFull" in t) return { do: "rest", why: `${title}: ${t.Text}` };
    return { do: "idle", why: `${title}: ${t.Text} (do this yourself)` }; // windows the player works in: stat points, equip, skills
  }
  if (info?.Report && talkable(info.Report)) return { do: "npc", id: info.Report, why: `${title}: report to ${npcName(info.Report)}` };
  return undefined;
}

/** The step for this tick (exported for tests / the bot's log). */
export function plan(): AutoStep {
  const main = (q: Entry) => (QUEST_INFO.get(q.id)?.Type === "Main" ? 0 : 1);
  let manual: AutoStep | undefined;
  for (const e of quests.filter((q) => q.state === 1).sort((a, b) => main(a) - main(b))) {
    const s = questStep(e);
    if (!s) continue;
    if (s.do === "idle") { manual ??= s; continue; }
    return s;
  }
  for (const [id, icon] of marks) if (OFFER.has(icon) && talkable(id)) return { do: "npc", id, why: `Talk to ${npcName(id)}` };
  if (manual) return manual;
  const lv = own?.level ?? S()?.players?.get(room!.sessionId)?.level ?? 1;
  const band = MOBS.filter((m) => m.level <= lv + BAND && m.level >= Math.max(1, lv - 10 - BAND)).map((m) => m.id);
  // the field for this level (W01): its species count too, and its hunting ground is where to go when nothing is in sight;
  // W03: the catacombs below the Mire once Warden Orrin has opened the stair for this character ("The Wardens' Seal" done)
  const field = fieldForLevel(lv, quests.some((q) => q.id === SEAL && q.state === 2)), home = FIELD_MOBS[field];
  return { do: "hunt", mobIds: [...new Set([...band, ...home.mobs])], loot: "any", fallback: { ...home.hunt, map: field }, why: "Hunting nearby monsters" };
}

// ---------- execution ----------
function tick() {
  if (!on || !room) return;
  const me = meOf(), now = Date.now();
  if (!me) return;
  if (me.dead) return stopAuto("Auto stopped: you were knocked out.");
  if (own && own.maxWeight && own.weight >= own.maxWeight * WEIGHT_STOP) return stopAuto("Auto stopped: you are carrying 50% of your weight limit or more.");
  // an open dialog: plain pages are answered after a reading pause, a menu waits for the player
  if (!locked() && dlgOpen && opts.locked) dialogOver(); // the browser's window closed (Close / Cancel by hand)
  if (locked() || pending) {
    if (menuPick && menuOpen && now >= menuPick.at) {
      const p = menuPick; menuPick = undefined;
      (opts.choose ?? ((c, npc) => room!.send(Msg.npcMenu, { npc, choice: c })))(p.choice, p.npc);
      menuOpen = false;
    }
    if (pending && now >= pending.at) {
      const p = pending; pending = undefined;
      (opts.press ?? ((w, npc) => room!.send(w === "next" ? Msg.npcNext : Msg.npcClose, { npc })))(p.what, p.npc);
      if (p.what === "close" && !opts.locked) dialogOver();
    }
    setTask(menuOpen ? "Choose an answer in the dialog" : `Talking to ${npcName(dlgNpc)}`);
    return;
  }
  // low HP: sit and recover (natural regen twice as fast while sitting), then go on
  const hp = own?.hp ?? 1, maxHp = own?.maxHp ?? 1;
  if (!resting && hp < maxHp * REST_BELOW) { resting = true; target = undefined; if (naviActive()) stopNavi(); goalKey = ""; }
  if (resting) {
    const pct = `HP ${Math.floor((100 * hp) / Math.max(1, maxHp))}%`;
    if (hp >= maxHp * REST_UNTIL) resting = false;
    else {
      // a healing item from the bag first (what a player's F-key would do), then fight off whatever is still hitting us,
      // and only sit (2x natural regen) once nothing is
      const pot = hp < maxHp * REST_BELOW && inv?.items.find((it) => !it.equip && ITEMS.get(it.itemId)?.type === "Healing");
      if (pot && now >= potionAt) { potionAt = now + POTION_MS; room.send(Msg.useItem, { uid: pot.uid }); }
      const foe = hitBy && now - hitAt < FIGHT_BACK_MS ? S()?.monsters?.get(hitBy) : undefined;
      if (foe && !foe.dead) {
        setTask(`Fighting back (${pct})`);
        if (me.sitting) { if (now >= sitAt) { room.send(Msg.sit); sitAt = now + 1200; } return; }
        if (now >= attackAt) { room.send(Msg.attack, { id: hitBy }); attackAt = now + ATTACK_MS; }
        return;
      }
      return rest(me, now, `Resting: ${pct}`);
    }
  }
  const step = plan();
  setTask(step.why);
  if (step.do === "rest") return rest(me, now, step.why);
  if (step.do === "idle") { if (naviActive() && goalKey) { stopNavi(); goalKey = ""; } return; }
  if (me.sitting) { // stand up first (the sit request toggles); navigation does this itself for walks
    if (now >= sitAt) { room.send(Msg.sit); sitAt = now + 1200; }
    return;
  }
  if (step.do === "npc") {
    target = undefined;
    const key = `npc:${step.id}`;
    if (naviActive() && goalKey === key) return;
    if (goalKey === key && !naviActive()) { goalKey = ""; talkedAt.set(step.id, now); return; } // arrived and clicked: wait for the window
    talkingTo = step.id; goalKey = key;
    startNavi({ kind: "npc", id: step.id }, npcName(step.id));
    return;
  }
  if (step.do === "cell") {
    const key = `cell:${step.map ?? ""}:${step.x},${step.y}`, away = !!step.map && step.map !== S()?.map;
    if ((!away && cheb(here(me), step) <= 1) || (naviActive() && goalKey === key)) return;
    goalKey = key;
    startNavi({ kind: "cell", x: step.x, y: step.y, within: 1, map: step.map }, step.why);
    return;
  }
  hunt(step, me, now);
}

function rest(me: any, now: number, why: string) {
  setTask(why);
  if (naviActive()) stopNavi();
  goalKey = ""; target = undefined;
  if (!me.sitting && !me.moving && now >= sitAt) { room!.send(Msg.sit); sitAt = now + 1200; }
}

function hunt(step: Extract<AutoStep, { do: "hunt" }>, me: any, now: number) {
  const st = S(), at = here(me), map = mapOfState(st);
  // loot first: the quest's items (or anything, when just hunting) lying close by
  let item: [string, any] | undefined, bd = Infinity;
  st.floor?.forEach((f: any, id: string) => {
    if (step.loot !== "any" && !step.loot.includes(f.itemId)) return;
    if (now - (lootTried.get(id) ?? 0) < 5000) return;
    const d = cheb(at, here(f));
    if (d <= LOOT_RANGE && d < bd) { bd = d; item = [id, f]; }
  });
  if (item) {
    lootTried.set(item[0], now);
    if (naviActive()) stopNavi();
    goalKey = ""; target = undefined;
    room!.send(Msg.pickup, { id: item[0] }); // the server walks there and picks it up (pc_takeitem)
    setTask(`Picking up ${ITEMS.get(item[1].itemId)?.name ?? "an item"}`);
    return;
  }
  // keep hitting the current target while it lives and counts
  const cur = target ? st.monsters?.get(target) : undefined;
  if (cur && !cur.dead && step.mobIds.includes(cur.mobId) && cheb(at, here(cur)) <= ATTACK_RANGE + 2) {
    if (now >= attackAt) { room!.send(Msg.attack, { id: target }); attackAt = now + ATTACK_MS; }
    return;
  }
  target = undefined;
  // the nearest live monster that counts and that a walk can reach (a spawn walled in by trees is skipped)
  const live: { id: string; m: any; d: number }[] = [];
  st.monsters?.forEach((m: any, id: string) => { if (!m.dead && step.mobIds.includes(m.mobId)) live.push({ id, m, d: cheb(at, here(m)) }); });
  live.sort((a, b) => a.d - b.d);
  const pick = live.slice(0, 4).find((c) => c.d < 2 || naviRoute(map, at.x, at.y, Math.round(c.m.x), Math.round(c.m.y)).length > 0);
  if (pick && pick.d <= ATTACK_RANGE) {
    if (naviActive()) stopNavi();
    goalKey = ""; target = pick.id; attackAt = now + ATTACK_MS;
    room!.send(Msg.attack, { id: pick.id });
    return;
  }
  if (pick) {
    const key = `mob:${pick.m.mobId}`;
    if (naviActive() && goalKey === key) return;
    goalKey = key;
    startNavi({ kind: "mob", mobIds: [pick.m.mobId], fallback: step.fallback }, MOB_BY_ID.get(pick.m.mobId)?.name ?? "");
    return;
  }
  const away = !!step.fallback?.map && step.fallback.map !== st.map;
  if (step.fallback && (away || cheb(at, step.fallback) > 3)) {
    const key = `area:${step.fallback.map ?? ""}:${step.fallback.x},${step.fallback.y}`;
    if (naviActive() && goalKey === key) return;
    goalKey = key;
    startNavi({ kind: "cell", x: step.fallback.x, y: step.fallback.y, within: 3, map: step.fallback.map }, "hunting ground");
    return;
  }
  setTask(`${step.why} (waiting for monsters)`);
}
