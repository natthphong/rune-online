// The status-change side of a map room (rules in shared/rules/status_change.ts): every unit's sc_data, the timers that run on the
// 20 Hz tick (no timer per effect), the effects a status has on the unit (stopped walking / attacking / casting, recalculated
// stats, HP drain), the statuses that skills, cards and monster skills apply, what the owner and the others are shown.
//   status.cpp  status_change_start / status_change_end / status_change_timer / status_calc_state / status_damage (RemoveOnDamaged,
//               Endure) / status_isendure / status_calc_regen_rate (poison and bleeding stop regeneration)
//   skill.cpp   skill_additional_effect (bAddEff cards, the skills' own additional effects), skill_castend_nodamage_id (buffs, cures)
//   mob.cpp     mobskill_use for the NPC_* attack skills (poison, blind, silence, sleep ... in mob_skill_db)
// Statuses stay with a character across map changes (the room hands the list to the next one, in memory) and end with death (except Endure).
import type { Client } from "@colyseus/core";
import { Msg, type DevStatusMsg, type ScListEvent } from "../../shared/protocol.ts";
import { MOB_BY_ID, type Mob, type Stats } from "../../shared/rules/data.ts";
import { ATK, BL, mobAttack, damageDelay, type AttackResult } from "../../shared/rules/battle.ts";
import { MD } from "../../shared/rules/mobai.ts";
import { battleCheckRange } from "../../shared/rules/mobai.ts";
import { skillCheckDue, skillRateRoll, skillStateMatches } from "../../shared/rules/mvp.ts";
import { USW } from "../../shared/rules/walk.ts";
import { mobStatus, type MobStatus, type Status } from "../../shared/rules/status.ts";
import {
  NPC_SC_SKILLS, SKILL_ON_HIT, SC_DB, SC_INTERVAL, SC_KEYS, SCSTART, SKILL_CURE, SKILL_SC, ScData, bleedingDamage, endureHit, intervalNext, isEndure, isScKey, npcSkillRate,
  poisonDamage, scApply, scAspdBonus, scOption, scRemaining, scStats, startSc, stoneDamage, undeadFlag, type ScEntry, type ScKey, type ScUnit,
} from "../../shared/rules/status_change.ts";
import { skillLv, type Skill } from "../../shared/rules/skill.ts";
import type { MapRoom } from "./rooms/MapRoom.ts";

type Brain = NonNullable<ReturnType<MapRoom["brains"]["get"]>>;
/** A monster's row clock for its status skills (md->skilldelay of the skill, md->last_skillcheck) and a cast that is running. */
type MobClock = { mon: object; readyAt: number; checkAt: number; casting: boolean };
/** Statuses a character carries to its next map: remaining ms per status (rAthena saves sc_data with the remaining tick; NoSave ones are dropped). */
type Carried = { type: ScKey; val1: number; val2: number; val3: number; val4: number; left: number }[];
const carried = new Map<number, Carried>();
const NO_SAVE = new Set<ScKey>(["DecreaseAgi", "Bleeding"]);

/** MD_STATUSIMMUNE on the unit's mode. */
const statusImmune = (u: Pick<ScUnit, "mode">) => (u.mode & MD.STATUSIMMUNE) !== 0;

export class StatusSystem {
  private scs = new Map<string, ScData>();
  private base = new Map<string, Status>(); // a monster's status before its first status change (restored when the last one ends)
  private clocks = new Map<string, MobClock>();
  private room: MapRoom;
  private rng = Math.random;
  constructor(room: MapRoom) { this.room = room; }

  // ---------- containers ----------
  private of(id: string) { let s = this.scs.get(id); if (!s) this.scs.set(id, s = new ScData()); return s; }
  peek(id: string): ScData | undefined { return this.scs.get(id); }
  has(id: string, t: ScKey) { return this.scs.get(id)?.has(t) ?? false; }
  /** 2.5.0: a running status entry (Kyrie's HP / hits, Guard's chance) for battle_calc_damage (server/src/skills.ts defend). */
  entry(id: string, t: ScKey) { return this.scs.get(id)?.get(t); }
  /** sc->cant: what the unit's statuses forbid (NoMove / NoCast / NoAttack). */
  cant(id: string, what: "move" | "cast" | "attack") { const s = this.scs.get(id); return !!s && s.size > 0 && s.cant()[what]; }
  /** status_calc_regen_rate: Poison and Bleeding switch natural HP / SP regeneration off. */
  noRegen(id: string) { const s = this.scs.get(id); return !!s && (s.has("Poison") || s.has("Bleeding")); }
  /** status_isendure(bl, tick, visible = false): Endure, and in Renewal a Class Boss monster, are not stopped by a hit. */
  isEndure(id: string) {
    if (isEndure(this.scs.get(id))) return true;
    const m = this.room.state.monsters.get(id);
    return !!m && MOB_BY_ID.get(m.mobId)!.class === "Boss";
  }

  private level(id: string) {
    const p = this.room.state.players.get(id);
    if (p) return p.level;
    const m = this.room.state.monsters.get(id);
    return m ? MOB_BY_ID.get(m.mobId)!.level : 1;
  }
  /** The unit as status_get_sc_def / status_change_start read it (the effective status, so Curse's LUK 0 and a Blessing count). */
  private unit(id: string): ScUnit | undefined {
    const b = this.room.brains.get(id), a = this.room.actor(id);
    if (!b || !a) return undefined;
    const s = b.status;
    return { stats: s.stats, mdef: s.mdef, mode: b.mode ?? s.mode, race: s.race, element: s.element, isPlayer: this.room.state.players.has(id), level: this.level(id), sc: this.of(id), resEff: s.resEff };
  }

  // ---------- hooks for the room's status calculation ----------
  /** playerStatus' `sc` input (status_calc_str ... and status_calc_aspd) for this character. */
  hooks(id: string) {
    const sc = this.scs.get(id);
    return sc && sc.size ? { stats: (s: Stats) => scStats(s, sc), aspd: scAspdBonus(sc) } : undefined;
  }
  /** The calc flags that are not stats (hit, flee, DEF, MDEF, speed, element, max HP, ATK percent) on a player's status. */
  apply<S extends Status>(id: string, s: S): S { return scApply(s, this.scs.get(id), true); }
  /** Recompute a unit's status after its statuses changed (status_calc_bl). */
  private recalc(id: string) {
    const p = this.room.state.players.get(id);
    if (p) { this.room.refreshStatus(id, p); return; }
    const m = this.room.state.monsters.get(id), b = this.room.brains.get(id);
    if (!m || !b) return;
    const sc = this.scs.get(id);
    if (!sc || sc.size === 0) {
      const base = this.base.get(id);
      if (base) { b.status = base; this.base.delete(id); }
      return;
    }
    let base = this.base.get(id);
    if (!base) this.base.set(id, base = b.status);
    const def = MOB_BY_ID.get(m.mobId)!, st = scStats({ str: def.str, agi: def.agi, vit: def.vit, int: def.int, dex: def.dex, luk: def.luk }, sc);
    const next = mobStatus({ ...def, ...st } as Mob);
    next.walkMs = base.walkMs; // a slave keeps the speed it inherited from its master
    b.status = scApply(next, sc, false);
  }

  // ---------- start / end ----------
  /**
   * status_change_start with the room around it. `rate` is 0..10000 (sc_start's 1..100 x 100; a card's bAddEff value as it is). Returns
   * "started", "nochange" (rAthena's `true` without a new status) or "failed" (resisted, immune, a Fail status runs).
   */
  start(src: string | undefined, id: string, type: ScKey, o: { rate: number; val1: number; duration: number; val2?: number; flag?: number; delay?: number }): "started" | "nochange" | "failed" {
    const a = this.room.actor(id), b = this.room.brains.get(id), u = this.unit(id);
    if (!a || !b || !u || a.dead) return "failed";
    const now = this.room.exactNow();
    const pb = type === "Concentrate" ? b.inv?.gear().equip?.param : undefined; // the equipment / card stats that do not count in the percentage
    const res = startSc({
      type, tgt: u, srcLevel: src ? this.level(src) : u.level, rate: o.rate, val1: o.val1, val2: o.val2, duration: o.duration, flag: o.flag, delay: o.delay,
      now, r: this.rng, src, paramBonus: pb,
    });
    for (const k of res.ended) this.ended(id, k, false);
    if (res.kind === "started") this.effects(id, a, b, type, now);
    if (res.ended.length || res.kind === "started") this.changed(id);
    return res.kind;
  }
  /** What a status that just began does to the unit at once: StopAttacking, StopCasting, NoMove (unit_stop_walking(USW_FIXPOS)). */
  private effects(id: string, a: { x: number; y: number; sx: number; sy: number; dir: number; moving: boolean; hp: number; dead: boolean }, b: Brain, type: ScKey, now: number) {
    const d = SC_DB[type];
    if (d.stopAttacking) this.room.stopAttack(id, b);
    if (d.stopCasting && this.room.state.players.has(id)) this.room.skills.cancel(id, "other");
    if (d.noMove && (this.room.walking(b) || a.moving)) this.room.stopWalking(id, a, b, USW.FIXPOS, now);
  }
  /** status_change_end. `natural` = its timer ran out (StoneWait then turns into Stone). */
  end(id: string, type: ScKey, natural = false): boolean {
    const sc = this.scs.get(id), e = sc?.get(type);
    if (!sc || !e) return false;
    sc.map.delete(type);
    this.ended(id, type, natural, e);
    this.changed(id);
    return true;
  }
  private ended(id: string, type: ScKey, natural: boolean, e = this.scs.get(id)?.get(type)) {
    // status_change_end's tail: a StoneWait that ran out starts Stone (val3 = the petrify time), forced
    if (type === "StoneWait" && natural && e) this.start(e.src, id, "Stone", { rate: 10000, val1: e.val1, val2: e.val2, duration: e.val3, flag: SCSTART.NOAVOID });
  }
  /** Everything a change of the status list updates: stats, the visible option, the owner's icons. */
  private changed(id: string) {
    this.recalc(id);
    const sc = this.scs.get(id), opt = scOption(sc), p = this.room.state.players.get(id), m = this.room.state.monsters.get(id);
    if (p && p.opt !== opt) p.opt = opt;
    if (m && m.opt !== opt) m.opt = opt;
    this.sendList(id);
  }
  /** clif_status_change for the owner: the whole list with the time left. */
  sendList(id: string) {
    if (!this.room.state.players.has(id)) return;
    const c = this.room.clients.getById(id), sc = this.scs.get(id);
    if (!c) return;
    const now = this.room.exactNow();
    const list = [...(sc?.map.values() ?? [])].map((e) => ({ sc: e.type, lv: e.val1, ms: e.due === Infinity ? -1 : Math.round(scRemaining(e, now)) }));
    c.send(Msg.scList, { list } satisfies ScListEvent);
  }

  // ---------- the tick ----------
  /** status_change_timer for every unit: the interval statuses act (Poison drains, Stone chips, Bleeding cuts) and the finished ones end. */
  tick(now: number) {
    for (const [id, sc] of this.scs) {
      const a = this.room.actor(id);
      if (!a || a.dead) { if (!a) { this.scs.delete(id); this.base.delete(id); } continue; }
      if (sc.size === 0) continue;
      for (const e of [...sc.map.values()]) {
        if (e.due > now || sc.get(e.type) !== e) continue;
        if (SC_INTERVAL[e.type]) this.interval(id, a, sc, e, now);
        else this.end(id, e.type, true);
      }
    }
    this.mobSkills(now);
  }
  private interval(id: string, a: { hp: number; dead: boolean }, sc: ScData, e: ScEntry, now: number) {
    const p = this.room.state.players.has(id), maxHp = this.maxHp(id);
    if (e.val4 >= 0) {
      let dmg = 0;
      if (e.type === "Poison") dmg = poisonDamage(p, a.hp, maxHp);
      else if (e.type === "Stone") dmg = stoneDamage(a.hp, maxHp);
      else if (e.type === "Bleeding") dmg = bleedingDamage(p, a.hp, this.rng);
      if (dmg > 0) this.zap(id, a, dmg);
    }
    if (a.dead) return;
    if (intervalNext(e, now)) this.end(id, e.type, true);
  }
  private maxHp(id: string) { return this.room.state.players.get(id)?.maxHp ?? this.room.state.monsters.get(id)?.maxHp ?? 1; }
  /** status_zap: HP lost with no attacker (no damage number, no flinch); a player at 0 dies. */
  private zap(id: string, a: { hp: number; dead: boolean }, dmg: number) {
    a.hp = Math.max(0, a.hp - dmg);
    if (a.hp > 0) return;
    const b = this.room.brains.get(id);
    if (b) this.room.unitDied(id, a as never, b, undefined);
  }

  // ---------- events from the combat code ----------
  /** status_damage's status part (status.cpp:1565-1590): RemoveOnDamaged statuses end (Freeze, Stone, Sleep), and a monster's hit uses one
   *  of Endure's 7. */
  damaged(id: string, fromPlayer: boolean) {
    const sc = this.scs.get(id);
    if (!sc || sc.size === 0) return;
    let changed = false;
    for (const e of [...sc.map.values()]) if (SC_DB[e.type].removeOnDamaged) { sc.map.delete(e.type); changed = true; }
    if (!fromPlayer && endureHit(sc)) { sc.map.delete("Endure"); changed = true; }
    if (changed) this.changed(id);
  }
  /** pc_dead / mob_dead: status_change_clear keeps only Endure (NoRemoveOnDead). */
  died(id: string) {
    const sc = this.scs.get(id);
    if (!sc) return;
    for (const k of [...sc.map.keys()]) if (k !== "Endure") sc.map.delete(k);
    this.clocks.delete(id);
    if (this.room.state.players.has(id)) this.changed(id);
    else { this.scs.delete(id); this.base.delete(id); }
  }

  // ---------- login / logout ----------
  /** At map entry: the statuses the character left the last map with (remaining time), before the first status calc. */
  enter(id: string, charId: number) {
    const saved = carried.get(charId);
    carried.delete(charId);
    if (!saved?.length) return;
    const sc = this.of(id), now = this.room.exactNow();
    for (const s of saved) {
      const interval = SC_INTERVAL[s.type];
      sc.map.set(s.type, { type: s.type, val1: s.val1, val2: s.val2, val3: s.val3, val4: s.val4, due: s.left < 0 ? Infinity : now + (interval ? Math.min(s.left, interval) : s.left) });
    }
    const p = this.room.state.players.get(id);
    if (p) p.opt = scOption(sc);
  }
  /** At map exit: remember what is running. */
  leave(id: string, charId: number | undefined) {
    const sc = this.scs.get(id);
    this.scs.delete(id); this.clocks.delete(id); this.base.delete(id);
    if (!sc || charId === undefined) return;
    const now = this.room.exactNow(), out: Carried = [];
    for (const e of sc.map.values()) {
      if (NO_SAVE.has(e.type)) continue;
      const left = e.due === Infinity ? -1 : Math.round(scRemaining(e, now)), interval = SC_INTERVAL[e.type];
      // an interval status resumes with its remainder in val4 and the time to its next step in `left`
      out.push({ type: e.type, val1: e.val1, val2: e.val2, val3: e.val3, val4: interval ? Math.max(e.val4, 0) : e.val4, left: interval ? Math.max(1, e.due - now) : left });
    }
    if (out.length) carried.set(charId, out);
  }

  // ---------- skills ----------
  /**
   * A skill that applies a status (shared/rules/status_change.ts SKILL_SC) or cures one (SKILL_CURE), on `tid`, cast by `sid`.
   * Returns false when it failed (resisted / immune): the caller says so to the caster. The skill's own damage is the caller's.
   */
  skillStatus(sid: string, tid: string, sk: Skill, lv: number): boolean {
    const cure = SKILL_CURE[sk.key];
    if (cure) { // AL_CURE (status_isimmune aside) / TF_DETOXIFY
      for (const k of cure) this.end(tid, k);
      return true;
    }
    const def = SKILL_SC[sk.key], u = this.unit(tid), sb = this.room.brains.get(sid);
    if (!def || !u || !sb) return false;
    const isMob = this.room.state.monsters.has(tid);
    if (sk.key === "SM_PROVOKE" && (statusImmune(u) || undeadFlag(u))) return false; // provoke.cpp: boss and undead are immune
    if (sk.key === "MG_STONECURSE" && statusImmune(u)) return false;
    const pct = Math.max(0, def.rate(lv, { srcLv: this.level(sid), tgtLv: u.level, srcInt: sb.status.stats.int, srcDex: sb.status.stats.dex, tgtDex: u.stats.dex }));
    const dur1 = skillLv(sk.duration1, lv), dur2 = skillLv(sk.duration2, lv);
    const duration = def.time === "dur1" ? dur1 : dur2;
    // Kyrie: val2 = the HP it absorbs, MaxHP x (lv x 2 + 10) % of the target (status.cpp SC_KYRIE)
    const val2 = def.sc === "StoneWait" ? this.srcNum(sid) : def.sc === "Kyrie" ? Math.trunc(((this.room.state.players.get(tid)?.maxHp ?? 0) * (lv * 2 + 10)) / 100) : undefined;
    const r = this.start(sid, tid, def.sc, { rate: pct * 100, val1: lv, val2, duration, delay: def.delay ? dur1 : undefined });
    if (r === "failed") return false;
    if (r === "started" && sk.key === "SM_PROVOKE" && isMob) { // mob_target(dstmd, src): the provoked monster turns on the caster
      const tb = this.room.brains.get(tid);
      if (tb) { tb.target = sid; tb.lootTarget = undefined; tb.chaseTo = undefined; }
    }
    return true;
  }
  private srcNum(id: string) { return Number(id.replace(/\D/g, "")) || 0; }

  /**
   * skill_additional_effect for an attack that connected (dmg_lv >= ATK_BLOCK): the attacker's bAddEff effects (cards) and, for a weapon
   * skill, the skill's own (Envenom's Poison, Frost Diver's Freeze). Applied right after the damage lands, so a status broken by damage
   * (Freeze) is not broken by the very hit that gave it. `at` = when the damage lands.
   */
  afterHit(src: string, tgt: string, res: AttackResult, sk: Skill | undefined, lv: number, at: number) {
    if (res.dmgLv < ATK.BLOCK) return;
    const sb = this.room.brains.get(src), tb = this.room.brains.get(tgt);
    if (!sb || !tb) return;
    const tunit = this.room.actor(tgt);
    const todo: { sc: ScKey; rate: number; val1: number; duration: number; delay?: number; skill?: boolean }[] = [];
    // bAddEff: pc_bonus_addeff defaults (weapon attacks of either range at the enemy), the rate is the card's value (1/10000)
    const addEff = (sb.status as Status).addEff;
    if (addEff && (!sk || sk.type === "Weapon")) for (const [k, rate] of Object.entries(addEff)) if (rate && isScKey(k)) todo.push({ sc: k, rate, val1: 7, duration: SC_DB[k].lookup, delay: k === "StoneWait" ? 100 : undefined });
    const sdef = sk ? SKILL_SC[sk.key] : undefined;
    if (sk && sdef && SKILL_ON_HIT.has(sk.key)) { // Envenom, Frost Diver + the 2.5.0 on-hit statuses (status_change.ts SKILL_ON_HIT)
      const sctx = { srcLv: this.level(src), tgtLv: this.level(tgt), srcInt: sb.status.stats.int };
      todo.push({ sc: sdef.sc, rate: sdef.rate(lv, sctx) * 100, val1: lv, duration: skillLv(sk.duration2, lv), skill: true });
    }
    if (!todo.length) return;
    this.room.timeline.add(at + 1, () => {
      if (this.room.actor(tgt) !== tunit || tunit?.dead || this.room.brains.get(tgt) !== tb) return;
      for (const t of todo) this.start(src, tgt, t.sc, { rate: t.rate, val1: t.val1, duration: t.duration, delay: t.delay });
    });
  }
  /** When a swing's damage lands (battle_delay_damage): the swing time plus the attacker's damage delay. */
  landAt(src: string, swingAt: number) {
    const m = this.room.motions(src);
    return swingAt + damageDelay(m.amotion, m.type);
  }

  // ---------- monster skills (mobskill_use) ----------
  /** ud->skilltimer of a monster casting one of its status skills: its AI stands still. */
  mobCasting(id: string) { return this.clocks.get(id)?.casting === true; }

  private mobSkills(now: number) {
    for (const [id, m] of this.room.state.monsters) {
      if (m.dead) continue;
      const def = MOB_BY_ID.get(m.mobId)!;
      if (!def.statusSkills.length) continue;
      const b = this.room.brains.get(id);
      if (!b) continue;
      let c = this.clocks.get(id);
      if (!c || c.mon !== m) this.clocks.set(id, c = { mon: m, readyAt: 0, checkAt: now, casting: false });
      if (c.casting || !b.target || this.cant(id, "cast") || this.cant(id, "attack")) continue;
      const t = this.room.actor(b.target);
      if (!t || t.dead) continue;
      // mob_ai_sub_hard (mob.cpp:1869-1887): no check while walking; attacking = as soon as the attack delay is over, else once a second
      if (!skillCheckDue({ walking: this.room.walking(b), mobState: b.mobState ?? "idle", now, attackableAt: b.nextAttack, lastCheck: c.checkAt })) continue;
      c.checkAt = now;
      if (now < c.readyAt) continue;
      const state = b.mobState ?? "idle", here = this.room.cell(m), tc = this.room.cell(t);
      const row = def.statusSkills.find((r) =>
        skillStateMatches(r.state, state, true) && skillRateRoll(r.rate, Math.floor(this.rng() * 10000)) && r.cond === "always"
        && battleCheckRange(this.room.map, here, tc, 7)); // skill_get_range2 of an NPC attack skill (Range -7 -> 7 cells)
      if (!row) continue;
      const tid = b.target;
      const cast = () => this.mobCast(id, m, def, b, c!, row, tid, this.room.exactNow());
      if (row.castTime > 0) {
        c.casting = true;
        if (this.room.walking(b)) this.room.stopWalking(id, m, b, USW.FIXPOS, now);
        this.room.timeline.add(now + row.castTime, () => { c!.casting = false; cast(); });
      } else cast();
    }
  }
  /** The cast ended: the weapon attack of NPC_POISON / NPC_BLINDATTACK ... (+20 % hit) on the target if it is still there, then the delay. */
  private mobCast(id: string, m: object, def: Mob, b: Brain, c: MobClock, row: Mob["statusSkills"][number], tid: string, now: number) {
    if (this.room.state.monsters.get(id) !== m || (m as { dead: boolean }).dead || this.cant(id, "cast") || this.cant(id, "attack")) return;
    const t = this.room.actor(tid), tb = this.room.brains.get(tid), mon = m as { x: number; y: number; dir: number };
    if (!t || t.dead || !tb || b.target !== tid) return;
    if (!battleCheckRange(this.room.map, this.room.cell(mon), this.room.cell(t), 7)) return;
    const npc = NPC_SC_SKILLS[row.skill];
    const tgt = { type: this.room.state.players.has(tid) ? BL.PC : BL.MOB, targeted: this.room.targetedCount(tid) };
    const res = mobAttack(b.status as MobStatus, tb.status, tgt, Math.random, (h) => h + Math.trunc((h * 20) / 100)); // modifyHitRate: +20 %
    b.nextAttack = now + b.status.attackDelayMs;
    b.thinkAt = Math.max(b.thinkAt ?? 0, now + def.attackMotion);
    this.room.delayDamage(id, tid, res, now, now);
    c.readyAt = now + row.delay; // mobskill_delay
    if (!npc || res.dmgLv < ATK.BLOCK) return;
    const tunit = t, at = this.landAt(id, now) + 1;
    this.room.timeline.add(at, () => {
      if (this.room.actor(tid) !== tunit || tunit.dead || this.room.brains.get(tid) !== tb) return;
      this.start(id, tid, npc.sc, { rate: npcSkillRate(row.lv) * 100, val1: row.lv, duration: SC_DB[npc.sc].lookup, delay: npc.sc === "StoneWait" ? 100 : undefined });
    });
  }

  // ---------- dev shortcut (never in production) ----------
  /** The status bot's GM shortcut: give / take statuses on the sender or a monster. NODE_ENV=production refuses. */
  register() {
    if (process.env.NODE_ENV === "production") return;
    const room = this.room;
    room.onMessage(Msg.devStatus, (client: Client, m: DevStatusMsg) => {
      const p = room.state.players.get(client.sessionId);
      if (!p || p.dead || !m) return;
      const id = m.target && room.state.monsters.has(String(m.target)) ? String(m.target) : client.sessionId;
      if (m.op === "dump") {
        const b = room.brains.get(id);
        if (!b) return;
        const s = b.status, sc = this.scs.get(id);
        client.send(Msg.notice, { text: `[dev-status] ${JSON.stringify({ id, walkMs: s.walkMs, hit: s.hit, flee: s.flee, def: s.def, def2: s.def2, mdef: s.mdef, aspd: s.aspd, attackDelayMs: s.attackDelayMs,
          maxHp: s.maxHp, atkPercent: s.atkPercent ?? 100, element: s.element, stats: s.stats, sc: [...(sc?.map.keys() ?? [])], opt: scOption(sc), cant: sc?.cant() })}` });
        return;
      }
      if (m.op === "mobskill") {
        const mon = room.state.monsters.get(id), b = room.brains.get(id);
        const def = mon ? MOB_BY_ID.get(mon.mobId) : undefined, row = def?.statusSkills[0];
        if (!mon || !b || !def || !row) return;
        let c = this.clocks.get(id);
        if (!c || c.mon !== mon) this.clocks.set(id, c = { mon, readyAt: 0, checkAt: 0, casting: false });
        b.target = client.sessionId;
        this.mobCast(id, mon, def, b, c, row, client.sessionId, room.exactNow());
        return;
      }
      if (m.op === "clear") { for (const k of SC_KEYS) this.end(id, k); return; }
      if (!m.sc || !isScKey(m.sc)) return;
      if (m.op === "end") { this.end(id, m.sc); return; }
      const lv = Number.isInteger(m.lv) ? Math.max(1, Math.min(10, m.lv!)) : 1, ms = Number.isFinite(m.ms) ? Number(m.ms) : SC_DB[m.sc].lookup || 60000;
      this.start(client.sessionId === id ? undefined : client.sessionId, id, m.sc, { rate: 10000, val1: lv, duration: ms, flag: m.force ? SCSTART.NOAVOID : SCSTART.NONE });
    });
  }
}
