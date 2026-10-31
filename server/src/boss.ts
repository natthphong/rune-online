// The boss side of a map room (rules in shared/rules/mvp.ts, spawn lines in shared/rules/spawn.ts): what happens when a boss
// spawns, summons its slaves, dies and leaves a tomb. MapRoom calls in at a few places (spawn, AI tick, death, NPC click):
//   mob.cpp  mob_spawn          mvptomb_destroy (the tomb is removed when the boss is back), MSC_SPAWN skills (the first summon)
//   mob.cpp  mob_dead           get_mvp_player, clif_mvp_effect, MvpExp (pc_gainexp), MvpDrops (pc_additem, else map_addflooritem),
//                               rare_drop_announce (intif_broadcast), mob_deleteslave, mvptomb_create (boss_monster lines)
//   mob.cpp  mob_ai_sub_hard_slavemob  (a slave dies with a missing master, follows it, takes the master's target)
//   mob.cpp  mobskill_use / mob_summonslave / mobskill_delay  (NPC_SUMMONSLAVE: onspawn, then re-summon when the slaves are gone)
//   npc.cpp  run_tomb           (the tomb's dialog: who, when, killed by)
import { Msg, type AnnounceEvent, type BossChargeEvent, type BossSlamEvent, type BossSpitEvent, type BossSplitEvent, type DevBossMsg, type HitEvent, type ItemGetEvent, type MvpEvent, type MvpRewardEvent } from "../../shared/protocol.ts";
import type { Client, Delayed } from "@colyseus/core";
import { MOB_BY_ID, type Mob } from "../../shared/rules/data.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { lootOwners } from "../../shared/rules/dmglog.ts";
import { floorLoot, mobDeadLootOwners } from "../../shared/rules/drops.ts";
import { ATK, BL, mobAttack } from "../../shared/rules/battle.ts";
import type { MobStatus } from "../../shared/rules/status.ts";
import {
  BOSS_MOVES, chargeCooldown, chargeDue, chargeLane, headbuttDue, inLaneReach, isEnraged, knockbackCell, rateDamage, spitDamage, spitDue, spitFlightMs, splitsDue,
  type BossMoves,
} from "../../shared/rules/bossmoves.ts";
import { SCSTART } from "../../shared/rules/status_change.ts";
import { MD, hasMode } from "../../shared/rules/mobai.ts";
import { searchFreeCell, type SpawnData } from "../../shared/rules/spawn.ts";
import { distance, pathSearchLong, walkable } from "../../shared/map.ts";
import {
  FREECELL_TRIES, MOB_SLAVEDISTANCE, MVP_CONF, SLAVE_MODE, attackerCount, skillCheckDue, mvpDropTable, mvpExpReward, mvpPlayer, pickSlaveSkill, rareDropAnnounced,
  rollMvpPrizes, skillDelayAfter, summonList, tombKiller, tombLines, tombWanted, type SlaveSkill,
} from "../../shared/rules/mvp.ts";
import type { JobKey } from "../../shared/rules/data.ts";
import { Npc, type Monster, type MapRoom, type Player } from "./rooms/MapRoom.ts";
import { BOSS_KIND, TOMB_NAME, TOMB_SPRITE, Tombs, bossKindOf } from "./tombs.ts";

export { BOSS_KIND, TOMB_NAME, TOMB_SPRITE, Tombs, bossKindOf };
export type { Tomb } from "./tombs.ts";

/** Per boss monster: mob skill timers (md->skilldelay of its summon rows, md->last_skillcheck) and a running cast (ud->skilltimer). */
type SkillClock = { readyAt: number; checkAt: number; casting: boolean };
/** Per boss with our own floor-boss moves (shared/rules/bossmoves.ts): the next spit and the split rows already used. */
type MoveClock = { moves: BossMoves; spitAt: number; fired: Set<number>; shouted: Set<number>; chargeAt: number; headAt: number; busyUntil: number };

export class BossSystem {
  readonly tombs: Tombs;
  /** slave id -> master id (md->master_id); only monsters summoned by NPC_SUMMONSLAVE are in here. */
  private masterOf = new Map<string, string>();
  /** Monsters with a summon skill, alive: id -> clock. */
  private casters = new Map<string, SkillClock>();
  /** Bosses with floor-boss moves (spit / split), alive: id -> clock. */
  private movers = new Map<string, MoveClock>();
  private nextSlave = 1;
  private mvpTables = new Map<number, ReturnType<typeof mvpDropTable>>();

  private room: MapRoom;
  constructor(room: MapRoom) {
    this.room = room;
    this.tombs = new Tombs({
      show: (t) => this.room.state.npcs.set(t.id, new Npc({ name: TOMB_NAME, sprite: TOMB_SPRITE, x: t.x, y: t.y, kind: "tomb" })),
      hide: (t) => { this.room.state.npcs.delete(t.id); },
      later: (fn, ms): Delayed => this.room.clock.setTimeout(fn, ms),
    });
  }

  // ---------- spawn ----------
  /** mob_spawn's tail (mob.cpp:1215, 1222): the monster is on the map. Its tomb goes (mvptomb_destroy), the wire flag is set, and
   *  the MSC_SPAWN skills run (the first slaves). */
  spawned(id: string, mon: Monster) {
    const def = MOB_BY_ID.get(mon.mobId)!;
    mon.boss = bossKindOf(def);
    this.tombs.destroy(id);
    this.casters.delete(id);
    this.movers.delete(id);
    const moves = BOSS_MOVES.get(mon.mobId);
    if (moves) this.movers.set(id, { moves, spitAt: this.room.clock.currentTime + 1000, fired: new Set(), shouted: new Set(), chargeAt: this.room.exactNow() + 3000, headAt: this.room.exactNow() + 2000, busyUntil: 0 });
    if (def.slaves.length) {
      this.casters.set(id, { readyAt: 0, checkAt: this.room.clock.currentTime, casting: false });
      this.useSummon(id, "spawn");
    }
  }

  // ---------- NPC_SUMMONSLAVE ----------
  /** mob_countslave (mob.cpp:3946): slaves of `masterId` on the map. */
  countSlaves(masterId: string) {
    let n = 0;
    for (const [sid, mid] of this.masterOf) if (mid === masterId && this.room.state.monsters.get(sid)?.dead === false) n++;
    return n;
  }

  /** Every second a boss with a summon skill looks at its rows again (mobskill_use with event -1, once per MIN_MOBLINKTIME-ish). */
  tick(now: number) {
    for (const [id, c] of this.casters) {
      const m = this.room.state.monsters.get(id), b = this.room.brains.get(id);
      if (!m || m.dead || !b) { this.casters.delete(id); continue; }
      // mob_ai_sub_hard (mob.cpp:1869-1887): no check while walking; attack state = once its attack delay is over, else every second
      if (!skillCheckDue({ walking: this.room.walking(b), mobState: b.mobState ?? "idle", now, attackableAt: b.nextAttack, lastCheck: c.checkAt })) continue;
      c.checkAt = now; // md->last_skillcheck
      this.useSummon(id, "check");
    }
    for (const [id, c] of this.movers) {
      const m = this.room.state.monsters.get(id), b = this.room.brains.get(id);
      if (!m || m.dead || !b) { this.movers.delete(id); continue; }
      this.split(id, m, c);
      this.shout(id, m, c);
      if (this.busy(id, c)) continue;
      this.headbutt(id, m, b, c);
      if (!this.busy(id, c)) this.charge(id, m, b, c);
      if (!this.busy(id, c)) this.spit(id, m, b, c, now);
    }
  }

  // ---------- floor-boss moves (shared/rules/bossmoves.ts; our own, not rAthena) ----------
  /** Below each HP threshold once: the cue to the area, then the slaves through mob_summonslave (they follow and die with it). */
  private split(id: string, m: Monster, c: MoveClock) {
    const rows = c.moves.split;
    if (!rows) return;
    for (const i of splitsDue(rows, m.hp, m.maxHp, c.fired)) {
      c.fired.add(i);
      const r = rows[i];
      this.room.sendArea("AREA", id, Msg.bossSplit, { id, text: r.text, key: r.key, kind: r.kind } satisfies BossSplitEvent);
      this.summon(id, m, { state: "any", amount: r.amount, rate: 10000, castTime: 0, delay: 0, cancelable: false, cond: "always", condValue: 0, ids: r.ids });
    }
  }

  /** A glob at the boss's player target when it is beyond melee reach, in range and in sight: the normal attack's damage (mobAttack)
   *  lands after the flight, plus a short Decrease AGI. Not while the boss casts, can't attack, or the target is gone / protected. */
  private spit(id: string, m: Monster, b: NonNullable<ReturnType<MapRoom["brains"]["get"]>>, c: MoveClock, now: number) {
    const s = c.moves.spit, tid = b.target;
    if (!s || !tid || now < c.spitAt || this.casting(id) || this.room.status.cant(id, "attack")) return;
    const tgt = this.room.state.players.get(tid), tb = this.room.brains.get(tid);
    if (!tgt || tgt.dead || !tb || this.room.invincible(tid, now)) return;
    const a = this.room.cell(m), t = this.room.cell(tgt), dist = distance(t.x - a.x, t.y - a.y);
    if (!spitDue(s, { now, readyAt: c.spitAt, dist, clearLine: pathSearchLong(this.room.map, a.x, a.y, t.x, t.y) })) return;
    c.spitAt = now + s.cooldownMs + this.rnd() % (s.jitterMs + 1);
    const ms = spitFlightMs(s, dist);
    this.room.sendArea("AREA", id, Msg.bossSpit, { from: id, to: tid, ms } satisfies BossSpitEvent);
    const res = mobAttack(b.status as MobStatus, tb.status, { type: BL.PC, targeted: this.room.targetedCount(tid) });
    this.room.timeline.add(now + ms, (at) => {
      const p = this.room.state.players.get(tid);
      if (p !== tgt || p.dead || this.room.state.monsters.get(id) !== m || m.dead || this.room.invincible(tid, at)) return;
      const dmg = spitDamage(s, res.dmg);
      this.room.sendArea("AREA", tid, Msg.hit, { from: id, to: tid, dmg, crit: false, miss: res.miss, lucky: res.lucky, amotion: 0, dmotion: res.miss ? 0 : this.room.motions(tid).dmotion } satisfies HitEvent);
      this.room.applyDamage(id, tid, dmg, at, res.dmgLv);
      if (s.slowMs > 0 && res.dmgLv > ATK.BLOCK && !p.dead) this.room.status.start(id, tid, "DecreaseAgi", { rate: 10000, val1: s.slowLv, duration: s.slowMs });
    });
  }

  /** The boss is winding up or dashing (a charge / headbutt in progress): the AI leaves it alone (casting()). */
  private busy(id: string, c: MoveClock) { return this.room.exactNow() < c.busyUntil; }

  /** A chat line + cue once per HP threshold (the enrage shout). */
  private shout(id: string, m: Monster, c: MoveClock) {
    const rows = c.moves.shouts;
    if (!rows) return;
    for (const i of splitsDue(rows, m.hp, m.maxHp, c.shouted)) {
      c.shouted.add(i);
      const r = rows[i];
      this.room.sendArea("AREA", id, Msg.bossSplit, { id, text: r.text, key: r.key, kind: r.kind } satisfies BossSplitEvent);
    }
  }

  /** The boss's player target and the distance to it, if it may act now (not stunned / casting, target alive and not protected). */
  private targetOf(id: string, b: NonNullable<ReturnType<MapRoom["brains"]["get"]>>, now: number) {
    const tid = b.target;
    if (!tid || this.casting(id) || this.room.status.cant(id, "attack")) return undefined;
    const tgt = this.room.state.players.get(tid), tb = this.room.brains.get(tid);
    if (!tgt || tgt.dead || !tb || this.room.invincible(tid, now)) return undefined;
    return { tid, tgt, tb };
  }

  /** One hit of a charge / headbutt on a player: the normal attack's damage x rate, then the knockback and the stun. */
  private slam(id: string, m: Monster, b: NonNullable<ReturnType<MapRoom["brains"]["get"]>>, tid: string, kind: "charge" | "head", ratePct: number, knock: number, stunMs: number, at: number) {
    const p = this.room.state.players.get(tid), pb = this.room.brains.get(tid);
    if (!p || !pb || p.dead || this.room.invincible(tid, at)) return;
    const res = mobAttack(b.status as MobStatus, pb.status, { type: BL.PC, targeted: this.room.targetedCount(tid) });
    const dmg = rateDamage(ratePct, res.dmg);
    this.room.sendArea("AREA", tid, Msg.hit, { from: id, to: tid, dmg, crit: false, miss: res.miss, lucky: res.lucky, amotion: 0, dmotion: res.miss ? 0 : this.room.motions(tid).dmotion } satisfies HitEvent);
    this.room.applyDamage(id, tid, dmg, at, res.dmgLv);
    if (p.dead || res.dmgLv <= ATK.BLOCK) return;
    const land = knockbackCell((x, y) => walkable(this.room.map, x, y), this.room.cell(m), this.room.cell(p), knock);
    this.room.warpUnit(p, pb, land.x, land.y); // unit_movepos: thrown, any walk is over
    if (stunMs > 0) this.room.status.start(id, tid, "Stun", { rate: 10000, val1: 1, duration: stunMs, flag: SCSTART.NOAVOID });
    this.room.sendArea("AREA", tid, Msg.bossSlam, { from: id, to: tid, kind, kx: land.x, ky: land.y, stunMs } satisfies BossSlamEvent);
  }

  /** Melee headbutt every few seconds on an adjacent target: a short wind-up, then a heavy hit and a knockback. */
  private headbutt(id: string, m: Monster, b: NonNullable<ReturnType<MapRoom["brains"]["get"]>>, c: MoveClock) {
    const h = c.moves.headbutt, now = this.room.exactNow();
    if (!h || now < c.headAt) return;
    const t = this.targetOf(id, b, now);
    if (!t) return;
    const a = this.room.cell(m), cell = this.room.cell(t.tgt);
    if (!headbuttDue(h, { now, readyAt: c.headAt, dist: distance(cell.x - a.x, cell.y - a.y) })) return;
    c.headAt = now + h.cooldownMs;
    c.busyUntil = now + h.windMs;
    this.room.haltWalk(m, this.room.walkOf(b, m));
    this.room.sendArea("AREA", id, Msg.bossCharge, { id, kind: "head", ex: a.x, ey: a.y, windMs: h.windMs, dashMs: 0 } satisfies BossChargeEvent);
    const tid = t.tid;
    this.room.timeline.add(now + h.windMs, (at) => {
      if (this.room.state.monsters.get(id) !== m || m.dead) return;
      const p = this.room.state.players.get(tid);
      if (p && !p.dead) {
        const q = this.room.cell(p), me = this.room.cell(m);
        if (distance(q.x - me.x, q.y - me.y) <= 2) this.slam(id, m, b, tid, "head", h.dmgRate, h.knockback, 0, at); // a step away in the wind-up is still caught at 2
      }
    });
  }

  /** The charge: a locked lane shown for windMs, then a straight dash along it; every player the boss passes is slammed once. */
  private charge(id: string, m: Monster, b: NonNullable<ReturnType<MapRoom["brains"]["get"]>>, c: MoveClock) {
    const ch = c.moves.charge, now = this.room.exactNow();
    if (!ch || now < c.chargeAt) return;
    const t = this.targetOf(id, b, now);
    if (!t) return;
    const a = this.room.cell(m), cell = this.room.cell(t.tgt), dist = distance(cell.x - a.x, cell.y - a.y);
    const ok = (x: number, y: number) => walkable(this.room.map, x, y);
    const clear = pathSearchLong(this.room.map, a.x, a.y, cell.x, cell.y);
    if (dist < ch.minRange && dist >= 1 && clear) { // too close for a run-up (a tank in melee): the goat backs off first, then charges
      const land = knockbackCell(ok, cell, a, ch.minRange + 1 - dist), back = chargeLane(ok, a, land, 0);
      if (back.length === 0 || distance(land.x - cell.x, land.y - cell.y) < ch.minRange) { c.chargeAt = now + 2000; return; }
      c.busyUntil = now + back.length * 40 + 150;
      this.room.stopAttack(id, b);
      this.room.haltWalk(m, this.room.walkOf(b, m));
      this.room.sendArea("AREA", id, Msg.bossCharge, { id, kind: "head", ex: a.x, ey: a.y, windMs: 300, dashMs: 0 } satisfies BossChargeEvent);
      back.forEach((step, i) => this.room.timeline.add(now + 100 + i * 40, () => { if (this.room.state.monsters.get(id) === m && !m.dead) this.room.warpUnit(m, b, step.x, step.y); }));
      return;
    }
    if (!chargeDue(ch, { now, readyAt: c.chargeAt, dist, clearLine: clear })) return;
    const lane = chargeLane(ok, a, cell, 0); // ends on the target's cell: whoever is hit is thrown past it, never under the goat
    if (lane.length < 2) { c.chargeAt = now + 1500; return; }
    const end = lane[lane.length - 1], dashMs = lane.length * ch.dashMsPerCell;
    c.chargeAt = now + ch.windMs + dashMs + chargeCooldown(ch, this.rnd() % (ch.jitterMs + 1), isEnraged(c.moves, m.hp, m.maxHp));
    c.busyUntil = now + ch.windMs + dashMs + 250;
    this.room.stopAttack(id, b);
    this.room.haltWalk(m, this.room.walkOf(b, m));
    this.room.sendArea("AREA", id, Msg.bossCharge, { id, kind: "charge", ex: end.x, ey: end.y, windMs: ch.windMs, dashMs } satisfies BossChargeEvent);
    const hit = new Set<string>(), t0 = now + ch.windMs;
    lane.forEach((step, i) => this.room.timeline.add(t0 + i * ch.dashMsPerCell, (at) => {
      if (this.room.state.monsters.get(id) !== m || m.dead) return;
      this.room.warpUnit(m, b, step.x, step.y);
      for (const [sid, p] of this.room.state.players) {
        if (hit.has(sid) || p.dead || !inLaneReach(step, this.room.cell(p))) continue;
        hit.add(sid);
        this.slam(id, m, b, sid, "charge", ch.dmgRate, ch.knockback, ch.stunMs, at);
      }
    }));
  }

  /** ud->skilltimer is set: the summon is being cast (the boss neither walks nor thinks). */
  casting(id: string) { const c = this.movers.get(id); return this.casters.get(id)?.casting === true || (!!c && this.room.exactNow() < c.busyUntil); }

  /** mobskill_use for the summon rows: pick a row, cast it (castTime ms), then mob_summonslave and the skill delay (mobskill_delay). */
  private useSummon(id: string, event: "spawn" | "check") {
    const m = this.room.state.monsters.get(id), b = this.room.brains.get(id), c = this.casters.get(id);
    if (!m || m.dead || !b || !c || c.casting) return;
    const def = MOB_BY_ID.get(m.mobId)!, rows = def.slaves as unknown as SlaveSkill[], now = this.room.clock.currentTime;
    const state = b.mobState ?? "idle", hasTarget = !!b.target;
    const skill = pickSlaveSkill(rows, { mobState: state, hasTarget, slaves: this.countSlaves(id), event, now, readyAt: c.readyAt, roll: () => this.rnd() % 10000 });
    if (!skill) return;
    const finish = () => {
      c.casting = false;
      if (this.room.state.monsters.get(id) !== m || m.dead) return;
      this.summon(id, m, skill);
      c.readyAt = this.room.clock.currentTime + skillDelayAfter(rows, b.mobState ?? "idle", !!b.target);
    };
    if (skill.castTime > 0) { c.casting = true; this.room.clock.setTimeout(finish, skill.castTime); } else finish();
  }

  /** mob_summonslave (mob.cpp:3981): `amount` slaves round-robin over the row's ids, each on a free cell within MOB_SLAVEDISTANCE of
   *  the master (map_search_freecell, else the master's own cell), with master_id set. */
  private summon(masterId: string, master: Monster, skill: SlaveSkill) {
    const at = this.room.cell(master);
    for (const mobId of summonList(skill.ids, skill.amount, (n) => this.rnd() % n)) {
      if (!MOB_BY_ID.has(mobId)) continue;
      const cell = searchFreeCell(this.room.map, at.x, at.y, MOB_SLAVEDISTANCE, MOB_SLAVEDISTANCE, FREECELL_TRIES, this.rndValue) ?? at;
      const sid = `b${this.nextSlave++}`;
      this.masterOf.set(sid, masterId);
      this.room.addMonster(sid, mobId, cell.x, cell.y);
      // slaves_inherit_mode 4 (status_calc_slave_mode): the mode is exactly CANMOVE | NORANDOMWALK | CANATTACK; slaves_inherit_speed 3: the master's walk speed
      const sb = this.room.brains.get(sid)!, mb = this.room.brains.get(masterId);
      sb.mode = SLAVE_MODE;
      if (mb) sb.status = { ...sb.status, walkMs: mb.status.walkMs } as typeof sb.status;
    }
  }

  /** A monster that is somebody's slave (it has no spawn line: it is removed after dying instead of respawning). */
  isSlave(id: string) { return this.masterOf.has(id); }

  /**
   * mob_ai_sub_hard_slavemob (mob.cpp:1526-1623) for a slave, at the top of its AI step: a missing or dead master kills the slave
   * (status_kill); otherwise it walks back to within MOB_SLAVEDISTANCE of the master when it has no target of its own, and takes the
   * master's target. True = this step is done (the C++ returns 1).
   */
  slaveAi(id: string, m: Monster, now: number): boolean {
    const mid = this.masterOf.get(id);
    if (!mid) return false;
    const master = this.room.state.monsters.get(mid), b = this.room.brains.get(id)!;
    if (!master || master.dead) { this.killSlave(id); return true; }
    const mb = this.room.brains.get(mid);
    if (hasMode(b.mode ?? MOB_BY_ID.get(m.mobId)!.mode, MD.CANMOVE)) {
      if (b.target) return false; // busy with a target (a monster master never calls it back)
      const here = this.room.cell(m), mc = this.room.cell(master), dist = distance(mc.x - here.x, mc.y - here.y);
      if ((dist > MOB_SLAVEDISTANCE || dist === 0) && this.room.canMove(id, m, b, now)) {
        const to = searchFreeCell(this.room.map, mc.x, mc.y, MOB_SLAVEDISTANCE, MOB_SLAVEDISTANCE, FREECELL_TRIES, this.rndValue);
        if (to && this.room.walkToXY(id, m, b, to.x, to.y, 0, now)) { this.room.stopAttack(id, b); b.mobState = "walk"; return true; }
      }
    }
    // lock the master's target (not more than once per MIN_MOBLINKTIME)
    if (!b.target && mb?.target && now - (b.lastLink ?? -Infinity) >= 1000) {
      const t = this.room.actor(mb.target);
      if (t && !t.dead) { b.lastLink = now; b.target = mb.target; return true; }
    }
    return false;
  }

  /** status_kill (type 3: no drops, no EXP): the slave dies where it stands and leaves the map a moment later (md->spawn == null). */
  private killSlave(id: string) {
    const m = this.room.state.monsters.get(id), b = this.room.brains.get(id);
    if (!m || !b || m.dead) return;
    m.dead = true; m.hp = 0;
    this.room.haltWalk(m, this.room.walkOf(b, m));
    b.target = undefined;
    for (const o of this.room.brains.values()) if (o.target === id) o.target = undefined;
    this.room.sendArea("AREA", id, Msg.die, { id });
    this.removeSlaveLater(id, m);
  }
  /** A slave never respawns: its corpse goes after the death animation. */
  removeSlaveLater(id: string, m: Monster) {
    this.room.clock.setTimeout(() => {
      if (this.room.state.monsters.get(id) !== m) return;
      this.room.state.monsters.delete(id);
      this.room.brains.delete(id);
      this.masterOf.delete(id);
    }, 2000);
  }

  // ---------- death ----------
  /**
   * mob_dead's boss part, after the EXP share and the drops: the MVP reward, the slaves going with their master, the tomb. `lineBoss`
   * = the spawn line was `boss_monster` (md->spawn->state.boss); `killer` = the killing unit's id.
   */
  dead(id: string, mon: Monster, killer: string | undefined, lineBoss: boolean) {
    const def = MOB_BY_ID.get(mon.mobId)!, room = this.room;
    this.casters.delete(id);
    this.movers.delete(id);
    for (const [sid, mid] of this.masterOf) if (mid === id) this.killSlave(sid); // mob_deleteslave
    const log = room.dmgLogOf(id);
    const owners = mobDeadLootOwners(lootOwners(log, room.receiver), killer === undefined ? undefined : room.charIdOf(killer));
    const mvpChar = mvpPlayer(log, def.bossType, room.receiver, owners[0]);
    const mvpSid = mvpChar === undefined ? undefined : room.sessionOfChar(mvpChar);
    const mvp = mvpSid === undefined ? undefined : room.state.players.get(mvpSid);
    if (mvp && mvpSid !== undefined) this.reward(id, def, mvpSid, mvp, mvpChar!, owners, attackerCount(log, room.receiver));

    if (tombWanted(lineBoss)) {
      const nameOf = (c: number | undefined) => { const s = c === undefined ? undefined : room.sessionOfChar(c); return s ? room.state.players.get(s)?.name : undefined; };
      const at = room.cell(mon);
      this.tombs.create(id, { mobName: def.name, x: at.x, y: at.y, killedAt: new Date(), killer: tombKiller(mvp?.name, nameOf(owners[0])) });
    }
  }

  /** The MVP's reward (mob.cpp:3437-3537): the effect to the area, MvpExp, one prize from MvpDrops (inventory, else the floor). */
  private reward(monsterId: string, def: Mob, sid: string, p: Player, charId: number, owners: number[], attackers: number) {
    const room = this.room, b = room.brains.get(sid)!, client = room.clients.getById(sid);
    room.sendArea("AREA", sid, Msg.mvp, { id: sid, boss: def.name } satisfies MvpEvent); // clif_mvp_effect
    const exp = mvpExpReward(def, p.level, attackers);
    if (exp > 0) room.reward(sid, p, exp, 0); // clif_mvp_exp then pc_gainexp(sd, md, exp, 0, 0)
    let itemId = 0, onFloor = false;
    let table = this.mvpTables.get(def.id);
    if (!table) this.mvpTables.set(def.id, table = mvpDropTable(def.mvpDrops));
    for (const prize of rollMvpPrizes(table, p.level, def)) {
      const item = ITEMS.get(prize.item)!;
      itemId = item.id;
      if (rareDropAnnounced(prize.rate)) room.announce(`'${p.name}' won ${def.name}'s ${item.name} (chance: ${(prize.rate / 100).toFixed(2)}%)`); // msg 541
      const why = b.inv?.canAdd(item, 1, p.job as JobKey, p.str);
      if (b.inv && !why) {
        b.inv.add(item.id, 1);
        client?.send(Msg.itemGet, { itemId: item.id, amount: 1 } satisfies ItemGetEvent);
        room.sendInv(client!, p);
      } else {
        // pc_additem failed: map_addflooritem under the MVP, owned by the MVP, then the 2nd and 3rd of the loot ranking
        onFloor = true;
        room.addFloorItem(item.id, 1, room.cell(p), null, floorLoot(room.clock.currentTime, [charId, owners[1] ?? 0, owners[2] ?? 0].filter((c, i) => i === 0 || c), "Mvp", true));
      }
    }
    client?.send(Msg.mvpReward, { boss: def.name, exp, itemId, floor: onFloor } satisfies MvpRewardEvent);
  }

  // ---------- tomb dialog ----------
  /** The tomb the player clicked (npc_click -> run_tomb), if `id` is one on this map. */
  clickTomb(client: Client, id: string): boolean {
    const t = this.tombs.visible(id);
    if (!t) return false;
    const room = this.room, p = room.state.players.get(client.sessionId);
    if (!p || !room.nearNpc(p, id)) return true; // npc_checknear
    // run_tomb (npc.cpp:2184): clif_scriptmes lines + clif_scriptclose, no script session (sd->npc_id stays 0): the player is not locked
    for (const text of tombLines(t.mobName, t.killedAt, t.killer)) client.send(Msg.npcMes, { npc: t.id, text });
    client.send(Msg.npcCloseBtn, { npc: t.id });
    return true;
  }

  // ---------- dev shortcuts (never in production) ----------
  /** The boss bot's GM shortcut: spawn a boss line, hurt / kill a monster as the sender, remove a test boss. NODE_ENV=production refuses. */
  register() {
    if (process.env.NODE_ENV === "production") return;
    const room = this.room;
    room.onMessage(Msg.devBoss, (client: Client, m: DevBossMsg) => {
      const p = room.state.players.get(client.sessionId);
      if (!p || p.dead || !m) return;
      const id = String(m.id), mon = room.state.monsters.get(id);
      switch (m.op) {
        case "spawn": { // a `boss_monster` line with this mob at (x, y), respawn 15-20 s
          const mobId = Number(m.mobId);
          const def = MOB_BY_ID.get(mobId);
          if (!def) return;
          const c = room.cell(p), x = Number.isInteger(m.x) ? Number(m.x) : c.x, y = Number.isInteger(m.y) ? Number(m.y) : c.y + 2;
          // xs/ys 1: on that very cell (0 would be mob_spawn's "anywhere on the map" and land the test monster out of reach)
          const sd: SpawnData = { map: room.mapName, x, y, xs: 1, ys: 1, boss: true, name: def.name, mobId, num: 1, delay1: 15000, delay2: 5000 };
          const sidm = `m${room.nextMonsterId++}`;
          room.mobSpawns.set(sidm, { sd, center: { x, y } });
          room.spawnMonster(sidm);
          client.send(Msg.notice, { text: `[dev] spawned ${def.name} as ${sidm}` });
          return;
        }
        case "hurt": case "kill": {
          if (!mon || mon.dead) return;
          const dmg = m.op === "kill" ? mon.hp : Math.max(0, Math.min(mon.hp - 1, Number(m.dmg ?? mon.hp - 1)));
          if (dmg > 0) room.applyDamage(client.sessionId, id, dmg, room.exactNow(), ATK.DEF);
          return;
        }
        case "remove": { // a test boss and everything of it
          const slot = room.mobSpawns.get(id);
          if (!slot) return;
          room.mobSpawns.delete(id);
          for (const [sid, mid] of this.masterOf) if (mid === id) { room.state.monsters.delete(sid); room.brains.delete(sid); this.masterOf.delete(sid); }
          room.state.monsters.delete(id); room.brains.delete(id);
          this.casters.delete(id);
          this.movers.delete(id);
          this.tombs.destroy(id);
          return;
        }
      }
    });
  }

  private rnd = () => Math.floor(Math.random() * 0x80000000);
  private rndValue = (min: number, max: number) => { if (min > max) [min, max] = [max, min]; return min + Math.floor(Math.random() * (max - min + 1)); };
}

export type { AnnounceEvent };
