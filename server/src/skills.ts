// The skill side of a map room: learning skills with points (pc_skillup), using them (clif_parse_UseSkillToId / ToPos ->
// unit_skilluse_id2 / unit_skilluse_pos2 -> skill_castend_id / skill_castend_pos -> skill_castend_damage_id / _nodamage_id), the
// cast bar and its interruption, SP / zeny / ammo costs, after-cast delay and cooldowns, and the job change (pc_jobchange). The
// numbers are shared/rules/skill.ts + battle.ts; this file only sequences them on the room's clock, like unit.cpp / skill.cpp do.
import type { Client } from "@colyseus/core";
import {
  Msg, dirFromDelta,
  type LevelUpEvent, type SkillCancelEvent, type SkillCastEvent, type SkillDelayEvent, type SkillFailEvent, type SkillsEvent, type SkillUseEvent,
  type UseSkillMsg,
} from "../../shared/protocol.ts";
import { JOBS, type JobKey } from "../../shared/rules/data.ts";
import {
  SKILLS, SKILL_FAIL, SKILL_ID, afterCastDelay, castEndCanact, castStartCanact, castTime, checkSkill, healAmount, passivesOf, refundUnready, inSplash, isUndead,
  magicSkillHit, skillCondition, skillCooldown, skillCost, skillList, skillLv, skillRange, skillUpBlock, skillUse, skillWalkDelay,
  weaponSkillHit, BASIC_SKILL_NEED, basicSkillOk, type Learned, type Skill, type SkillFail,
} from "../../shared/rules/skill.ts";
import { BL, magicAttack, playerAttack } from "../../shared/rules/battle.ts";
import { battleCheckRange } from "../../shared/rules/mobai.ts";
import { ITEMS, maxWeight } from "../../shared/rules/items.ts";
import { blocksSkillCast } from "../../shared/rules/weight.ts";
import { equipSweep } from "../../shared/rules/equipsweep.ts";
import { USW, searchPath } from "../../shared/rules/walk.ts";
import { FISTS, isSecondJob, type Status } from "../../shared/rules/status.ts";
import { distance, walkable } from "../../shared/map.ts";
import { db } from "./db.ts";
import * as duel from "./duel.ts";
import type { MapRoom, Player } from "./rooms/MapRoom.ts";
import { Skills2 } from "./skills2.ts";
import { NEEDS_SC, TRIPLE_RATE, defend, doubleRate, type SkillUse2 } from "../../shared/rules/skills2.ts";
import type { ScKey } from "../../shared/rules/status_change.ts";

type Cell = { x: number; y: number };
/** A skill request waiting for the caster to be in range (the game client walks there first) or a cast running (ud->skilltimer). */
type Req = { id: number; lv: number; target?: string; x?: number; y?: number };
type Cast = Req & { token: number; castMs: number };
/** Per character: learned levels (sd->status.skill), canact_tick, the skill cooldowns (sd->scd), the running cast, the pending walk-in. */
type PcSkills = { charId: number; learned: Learned; canact: number; cooldown: Map<number, number>; cast?: Cast; goal?: Req; repathAt: number };

/** A skill without a target type (skill_get_inf == 0): learning it recalculates status. */
const sk_isPassive = (id: number) => SKILLS.get(id)?.target === "Passive";

export class SkillSystem {
  private pcs = new Map<string, PcSkills>();
  private seq = 0;
  private room: MapRoom;
  /** 2.5.0: the 2nd-job skill kinds, spirit spheres and traps (server/src/skills2.ts). */
  readonly s2: Skills2;
  constructor(room: MapRoom) { this.room = room; this.s2 = new Skills2(room); }

  // ---------- session ----------
  /** At map entry (chrif / pc_authok loads sd->status.skill from the `skill` table), then clif_skillinfoblock. */
  async load(sid: string, charId: number): Promise<number> {
    const { rows } = await db.query("SELECT id, lv FROM skill WHERE char_id = $1", [charId]);
    const learned: Learned = {};
    for (const r of rows) if (SKILLS.has(r.id)) learned[r.id] = r.lv;
    // points sunk into skills that do nothing yet go back to the character (pc_resetskill for those ids only), written before the
    // player joins; the caller adds the returned amount to the loaded character's skill points
    let refund = 0;
    const gone: number[] = [];
    for (const [id, lv] of Object.entries(refundUnready(learned))) { refund += lv; gone.push(Number(id)); delete learned[Number(id)]; }
    if (refund > 0) {
      await db.query("DELETE FROM skill WHERE char_id = $1 AND id = ANY($2::int[])", [charId, gone]);
      await db.query("UPDATE characters SET skill_points = skill_points + $2 WHERE id = $1", [charId, refund]);
    }
    this.pcs.set(sid, { charId, learned, canact: 0, cooldown: new Map(), repathAt: 0 });
    return refund;
  }
  leave(sid: string) { this.pcs.delete(sid); this.s2.leave(sid); }
  learned(sid: string): Learned { return this.pcs.get(sid)?.learned ?? {}; }
  /** pc_checkskill for scripts (getskilllv) and gates. */
  level(sid: string, key: string) {
    const p = this.room.state.players.get(sid), s = this.pcs.get(sid), id = SKILL_ID[key];
    if (!p || !s || id === undefined) return 0;
    return checkSkill(p.job as JobKey, s.learned, p.level, p.jobLevel, id, this.change2nd(sid));
  }
  /** JOBCHANGE2ND_VAR "jobchange_level" (sd->change_level_2nd): the job level the character left its 1st job at (0 = unset). */
  change2nd(sid: string) { return this.room.npcEngine?.charVar(sid, "jobchange_level") ?? 0; }
  /** basic_skill_check: Basic Training at least `need` (clif.cpp gates). */
  basicOk(sid: string, need: number) { return basicSkillOk(this.level(sid, "NV_BASIC"), need); }
  casting(sid: string) { return this.pcs.get(sid)?.cast !== undefined; }
  /** The passive levels status_calc_pc reads (pc_checkskill): Keen Eye, Far Sight, Evasion (shared/rules/status.ts Passives). */
  passives(sid: string) { return passivesOf((k) => this.level(sid, k)); }

  /** clif_skillinfoblock: the whole list + points, to the owner. */
  send(sid: string) {
    const p = this.room.state.players.get(sid), s = this.pcs.get(sid), c = this.room.clients.getById(sid);
    if (!p || !s || !c) return;
    c.send(Msg.skills, { list: skillList(p.job as JobKey, s.learned, p.level, p.jobLevel, p.skillPoints, this.change2nd(sid)), points: p.skillPoints } satisfies SkillsEvent);
  }
  fail(sid: string, id: number, why: SkillFail) {
    this.room.clients.getById(sid)?.send(Msg.skillFail, { id, why, text: SKILL_FAIL[why] } satisfies SkillFailEvent);
  }

  // ---------- pc_skillup ----------
  skillUp(client: Client, id: number) {
    const sid = client.sessionId, p = this.room.state.players.get(sid), s = this.pcs.get(sid), b = this.room.brains.get(sid);
    if (!p || !s || !b?.inv || !Number.isInteger(id)) return;
    const why = skillUpBlock(p.job as JobKey, s.learned, p.level, p.jobLevel, p.skillPoints, id, this.change2nd(sid));
    if (why) { this.room.notice(client, `Can't raise that skill: ${why}.`); return this.send(sid); }
    const lv = (s.learned[id] ?? 0) + 1;
    s.learned[id] = lv;
    p.skillPoints--;
    b.inv.persist("INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, $3) ON CONFLICT (char_id, id) DO UPDATE SET lv = EXCLUDED.lv", [s.charId, id, lv]).catch(() => {});
    b.inv.persist("UPDATE characters SET skill_points = $2 WHERE id = $1", [s.charId, p.skillPoints]).catch(() => {});
    if (sk_isPassive(id)) this.room.refreshStatus(sid, p); // pc_skillup: status_calc_pc for a passive skill (!skill_get_inf)
    this.room.flushStatus(sid); // clif_updatestatus(SP_SKILLPOINT)
    this.send(sid); // clif_skillup + clif_skillinfoblock (new rows may have unlocked)
    this.room.npcEngine.questinfo(sid);
  }

  // ---------- using a skill ----------
  /** clif_parse_UseSkillToId / ToPos: checks that answer at once (learned, canact, cooldown, a cast running), then the walk-in or
   *  the cast. The game client walks a far target into range itself; here the server does it for it (like the attack walk-in). */
  use(client: Client, m: UseSkillMsg) {
    const sid = client.sessionId, p = this.room.state.players.get(sid), s = this.pcs.get(sid), b = this.room.brains.get(sid);
    const sk = SKILLS.get(Number(m?.id));
    if (!p || !s || !b || !sk || p.dead) return;
    const have = checkSkill(p.job as JobKey, s.learned, p.level, p.jobLevel, sk.id, this.change2nd(sid));
    if (have <= 0) return this.fail(sid, sk.id, "level");
    if (!skillUse(sk)) { this.room.notice(client, `${sk.name} can't be used yet.`); return; }
    if (this.room.status.cant(sid, "cast")) return this.fail(sid, sk.id, "status"); // status_check_skilluse: sc->cant.cast
    const lv = Math.min(have, Math.max(1, Number.isInteger(m.lv) ? m.lv! : have));
    if (s.cast) return; // ud->skilltimer != INVALID_TIMER
    const now = this.room.exactNow();
    if (now < s.canact) return this.fail(sid, sk.id, "delay"); // USESKILL_FAIL_SKILLINTERVAL (clif_parse_UseSkillToId)
    if (now < (s.cooldown.get(sk.id) ?? 0)) return this.fail(sid, sk.id, "cooldown");
    const req: Req = { id: sk.id, lv };
    if (sk.target === "Ground") {
      if (!Number.isInteger(m.x) || !Number.isInteger(m.y) || !walkable(this.room.map, m.x!, m.y!)) return this.fail(sid, sk.id, "target");
      req.x = m.x; req.y = m.y;
    } else if (sk.target === "Self") req.target = sid;
    else {
      const tid = m.target ? String(m.target) : sk.target === "Support" ? sid : undefined;
      const t = tid ? this.room.actor(tid) : undefined;
      const res = sk.key === "ALL_RESURRECTION"; // 2.5.0: Resurrection aims at a dead player (and only at one)
      if (!tid || !t || (res ? !t.dead || !this.room.state.players.has(tid) : t.dead)) return this.fail(sid, sk.id, "target");
      if (sk.target === "Attack" && !(duel.dueling(this.room, sid) ? duel.canTarget(this.room, sid, tid) : this.room.state.monsters.has(tid))) return this.fail(sid, sk.id, "target"); // battle_check_target: PvP only against the duel mate, a duelist hits nothing else
      if (skillUse(sk)?.kind === "status" && sk.target === "Support" && !this.room.state.players.has(tid)) return this.fail(sid, sk.id, "target"); // buffs and cures go to players
      req.target = tid;
    }
    const why = this.condition(sid, p, sk, lv);
    if (why) return this.fail(sid, sk.id, why); // skill_check_condition_castbegin
    p.sitting = false;
    this.room.newIntent(b); // a skill request replaces the attack / pickup the player was doing (unit_stop_attack)
    s.goal = req;
    s.repathAt = 0;
    this.pursue(sid, p, s, now);
  }

  /** skill_check_condition_castbegin / _castend for this character. */
  condition(sid: string, p: Player, sk: Skill, lv: number): SkillFail | null {
    const b = this.room.brains.get(sid)!;
    if (this.s2.sphereBlock(sid, sk)) return "failed"; // 2.5.0 SpiritSphereCost / Asura Strike needs Fury
    const needSc = NEEDS_SC[sk.key];
    if (needSc && !this.room.status.has(sid, needSc as ScKey)) return "failed"; // sightrasher.cpp: needs Sight running
    const ammo = b.inv?.equipped("ammo");
    return skillCondition(sk, lv, {
      hp: p.hp, sp: p.sp, zeny: b.inv?.zeny ?? 0, weaponType: (b.weapon ?? FISTS).type,
      ammo: ammo ? { subType: ITEMS.get(ammo.itemId)!.subType, amount: ammo.amount } : null,
      overweight: !!b.inv && blocksSkillCast(b.inv.weight(), maxWeight(p.job as JobKey, p.str)),
    });
  }

  /** Where the skill is aimed: the target unit's cell or the ground cell. */
  private aim(r: Req): Cell | undefined {
    if (r.x !== undefined && r.y !== undefined) return { x: r.x, y: r.y };
    const t = r.target ? this.room.actor(r.target) : undefined;
    return t && (!t.dead || SKILLS.get(r.id)?.key === "ALL_RESURRECTION") ? this.room.cell(t) : undefined;
  }

  /** The walk-in: in range (battle_check_range: distance + clear line, unit.cpp:2212) and standing -> cast; else walk toward it,
   *  checked again every tick (a cell within range stops the walk). */
  private pursue(sid: string, p: Player, s: PcSkills, now: number) {
    const r = s.goal!, sk = SKILLS.get(r.id)!, b = this.room.brains.get(sid)!;
    const to = this.aim(r);
    if (!to) { s.goal = undefined; return; }
    const from = this.room.cell(p), range = skillRange(sk, r.lv, s.learned);
    const inRange = r.target === sid || battleCheckRange(this.room.map, from, to, range);
    if (inRange) {
      if (this.room.walking(b)) this.room.stopWalking(sid, p, b, USW.FIXPOS | USW.FORCE_STOP, now); // unit_stop_walking(USW_FIXPOS)
      s.goal = undefined;
      return this.begin(sid, p, s, r, now);
    }
    if (now < s.repathAt) return;
    const w = this.room.walkOf(b, p);
    if (!(this.room.walking(b) && w.to.x === to.x && w.to.y === to.y)) this.room.walkToXY(sid, p, b, to.x, to.y, 0, now, searchPath);
    s.repathAt = now + 400;
  }

  /** unit_skilluse_id2 / unit_skilluse_pos2 from the cast's start: castbegin condition, the cast time (skill_vfcastfix), the
   *  caster stops (USW_FIXPOS) and faces the target, clif_skillcasting to the area, unit_set_castdelay; no cast time = the skill
   *  goes off now (skill_castend_id called directly). */
  private begin(sid: string, p: Player, s: PcSkills, r: Req, now: number) {
    const sk = SKILLS.get(r.id)!, b = this.room.brains.get(sid)!;
    const why = this.condition(sid, p, sk, r.lv);
    if (why) return this.fail(sid, sk.id, why);
    if (this.room.status.cant(sid, "cast")) return this.fail(sid, sk.id, "status");
    const to = this.aim(r)!, from = this.room.cell(p);
    if (to.x !== from.x || to.y !== from.y) p.dir = dirFromDelta(Math.sign(to.x - from.x), Math.sign(to.y - from.y));
    const castMs = castTime(sk, r.lv, b.status.stats);
    s.canact = castStartCanact(s.canact, now, skillLv(sk.castTime, r.lv) !== 0 ? castMs : 0);
    const cast: Cast = { ...r, token: ++this.seq, castMs };
    this.room.sendArea("AREA", sid, Msg.skillCast, { src: sid, id: sk.id, lv: r.lv, target: r.target, x: r.x, y: r.y, castMs } satisfies SkillCastEvent);
    if (castMs <= 0) return this.end(sid, cast, now);
    s.cast = cast;
    this.room.timeline.add(now + castMs, (at) => this.end(sid, cast, at));
  }

  /** unit_skillcastcancel (unit.cpp): the cast stops (damage with CastCancel, death, leaving); clif_skillcastcancel to the area. */
  cancel(sid: string, why: "damage" | "death" | "other" = "other") {
    const s = this.pcs.get(sid);
    if (!s) return;
    s.goal = undefined;
    if (!s.cast) return;
    if (why === "damage" && !SKILLS.get(s.cast.id)!.castCancel) return; // CastCancel: false -> damage doesn't interrupt
    s.cast = undefined;
    s.canact = Math.max(0, s.canact - 100); // the SECURITY_CASTTIME part goes away with the cast
    this.room.sendArea("AREA", sid, Msg.skillCancel, { src: sid } satisfies SkillCancelEvent);
  }

  /**
   * skill_castend_id / skill_castend_pos when the cast ends: the caster and target are checked again (alive, the target in range + 1
   * for a walking target), then skill_check_condition_castend + skill_consume_requirement (SP, HP, zeny, ammo), canact_tick = after-
   * cast delay (skill_delayfix), the cooldown (skill_blockpc_start), the walk delay (AfterCastWalkDelay), and the skill itself.
   */
  private end(sid: string, cast: Cast, now: number) {
    const s = this.pcs.get(sid), p = this.room.state.players.get(sid), b = this.room.brains.get(sid);
    if (!s || !p || !b) return;
    if (s.cast && s.cast.token !== cast.token) return;
    s.cast = undefined;
    if (p.dead) return;
    const sk = SKILLS.get(cast.id)!, lv = cast.lv;
    const to = this.aim(cast);
    if (!to) return this.fail(sid, sk.id, "target");
    if (sk.target === "Attack" && cast.target && this.room.state.players.has(cast.target) && !duel.canTarget(this.room, sid, cast.target)) return this.fail(sid, sk.id, "target"); // the duel ended during the cast
    if (cast.target !== sid && !battleCheckRange(this.room.map, this.room.cell(p), to, skillRange(sk, lv, s.learned) + 1)) return this.fail(sid, sk.id, "range");
    const why = this.condition(sid, p, sk, lv);
    if (why) return this.fail(sid, sk.id, why);
    if (this.room.status.cant(sid, "cast")) return this.fail(sid, sk.id, "status");
    // skill_consume_requirement
    const cost = skillCost(sk, lv);
    p.sp -= cost.sp;
    if (cost.hp) p.hp = Math.max(1, p.hp - cost.hp);
    if (cost.zeny && b.inv) b.inv.payZeny(cost.zeny);
    if (cost.ammo && b.inv) { const a = b.inv.equipped("ammo"); if (a) b.inv.remove(a.uid, cost.ammo); if (!b.inv.items.has(a?.uid ?? -1)) this.room.refreshStatus(sid, p); }
    if ((cost.zeny || cost.ammo) && b.inv) { const c = this.room.clients.getById(sid); if (c) this.room.sendInv(c, p); }
    const amotion = this.room.motions(sid).amotion;
    const delay = afterCastDelay(sk, lv, amotion), cd = skillCooldown(sk, lv);
    s.canact = castEndCanact(s.canact, now, delay);
    if (cd > 0) s.cooldown.set(sk.id, now + cd);
    const wd = skillWalkDelay(sk, lv);
    if (wd > 0) { const w = this.room.walkOf(b, p); w.canmoveTick = Math.max(w.canmoveTick, now + wd); }
    this.room.clients.getById(sid)?.send(Msg.skillDelay, { id: sk.id, delayMs: s.canact - now, cooldownMs: cd } satisfies SkillDelayEvent);
    const asuraSp = sk.key === "MO_EXTREMITYFIST" ? p.sp : 0; // asurastrike.cpp: the ratio reads the SP left, then all of it is spent
    if (asuraSp) p.sp = 0;
    const hitsOverride = this.s2.spendForHit(sid, sk, lv); // 2.5.0: spirit spheres (pc_delspiritball)
    if (NEEDS_SC[sk.key]) this.room.status.end(sid, NEEDS_SC[sk.key] as ScKey); // Sight Rasher ends Sight
    this.fire(sid, p, s, sk, lv, cast, to, now, { sp: asuraSp, div: hitsOverride });
    this.room.flushStatus(sid);
  }

  /** skill_castend_damage_id / _nodamage_id / _pos: what the skill does (shared/rules/skill.ts SKILL_USE). */
  private fire(sid: string, p: Player, s: PcSkills, sk: Skill, lv: number, r: Req, at: Cell, now: number, extra: { sp?: number; div?: number } = {}) {
    const use = skillUse(sk)!, b = this.room.brains.get(sid)!;
    const ev: SkillUseEvent = { src: sid, id: sk.id, lv, target: r.target, x: r.x, y: r.y };
    const mate = duel.foe(this.room, sid), mp = mate ? this.room.state.players.get(mate) : undefined;
    const enemies = (c: Cell, rad: number): string[] => mate ? (mp && !mp.dead && inSplash(c.x, c.y, rad, Math.round(mp.x), Math.round(mp.y)) ? [mate] : []) // a duelist's splash hits only its duel mate
      : [...this.room.state.monsters].filter(([, m]) => !m.dead && inSplash(c.x, c.y, rad, Math.round(m.x), Math.round(m.y))).map(([id]) => id);
    const here = this.room.cell(p);
    switch (use.kind) {
      case "weapon": {
        this.room.sendArea("AREA", sid, Msg.skillUse, ev);
        this.weaponHit(sid, b.status, sk, lv, r.target!, s.learned, now, { sp: extra.sp, div: extra.div });
        break;
      }
      case "magic": {
        this.room.sendArea("AREA", sid, Msg.skillUse, ev);
        this.magicHit(sid, b.status, sk, lv, r.target!, s.learned, now);
        break;
      }
      case "selfSplash": { // SM_MAGNUM castendNoDamageId: every enemy in splash range of the caster, ratio by distance (magnum.cpp)
        this.room.sendArea("AREA", sid, Msg.skillUse, ev);
        for (const id of enemies(here, skillLv(sk.splash, lv))) {
          const c = this.room.cell(this.room.actor(id)!);
          this.weaponHit(sid, b.status, sk, lv, id, s.learned, now, { inner: distance(c.x - here.x, c.y - here.y) === 1 });
        }
        break;
      }
      case "groundSplash": { // AC_SHOWER: SkillImplRecursiveDamageSplash on the cell
        this.room.sendArea("AREA", sid, Msg.skillUse, ev);
        for (const id of enemies(at, skillLv(sk.splash, lv))) this.weaponHit(sid, b.status, sk, lv, id, s.learned, now);
        break;
      }
      case "status": { // skill_castend_nodamage_id: the status goes on (or comes off) the target; a resisted one says "failed"
        this.room.sendArea("AREA", sid, Msg.skillUse, ev);
        if (!this.room.status.skillStatus(sid, r.target!, sk, lv)) this.fail(sid, sk.id, "failed");
        break;
      }
      case "targetSplash": case "selfMagic": case "groundMagic": case "unit": case "trap": case "misc": case "aura": case "spheres": case "turnUndead": case "resurrect": case "pitcher": {
        const charId = s.charId, lvOf = (k: string) => this.level(sid, k);
        this.s2.fire(use as SkillUse2, {
          sid, sk, lv, target: r.target, at, here, now, charId, learned: lvOf, enemies,
          weaponHit: (tid, ctx) => this.weaponHit(sid, b.status, sk, lv, tid, s.learned, now, ctx ?? {}),
          magicHit: (tid) => this.magicHit(sid, b.status, sk, lv, tid, s.learned, now),
        });
        break;
      }
      case "heal": { // AL_HEAL: skill_castend_id -> an Undead-element target takes damage (castendDamageId), anyone else is healed
        const t = this.room.actor(r.target!)!, tb = this.room.brains.get(r.target!)!;
        const src = { level: p.level, int: b.status.stats.int, matkStatus: b.status.matkStatus, rhw: b.status.rhw, overrefine: b.status.overrefine };
        if (this.room.state.monsters.has(r.target!) && isUndead(tb.status)) {
          this.room.sendArea("AREA", sid, Msg.skillUse, ev);
          const res = magicAttack(b.status, tb.status, { ...magicSkillHit(sk, lv, s.learned), base: healAmount(lv, src, false), ignoreDefense: true });
          this.room.delayDamage(sid, r.target!, res, now, now, { skill: sk.id, div: 1 });
          break;
        }
        const amount = Math.min(healAmount(lv, src, true), Math.max(0, t.hp >= 0 ? this.maxHpOf(r.target!) - t.hp : 0)); // status_heal clamps
        t.hp += amount;
        this.room.sendArea("AREA", sid, Msg.skillUse, { ...ev, heal: amount });
        if (this.room.state.players.has(r.target!)) this.room.flushStatus(r.target!);
        break;
      }
    }
  }
  private maxHpOf(id: string) {
    const p = this.room.state.players.get(id);
    if (p) return p.maxHp;
    return this.room.state.monsters.get(id)?.maxHp ?? 0;
  }

  /** skill_attack(BF_WEAPON) -> battle_calc_weapon_attack with the skill, clif_skill_damage + battle_delay_damage. */
  private weaponHit(sid: string, att: Status, sk: Skill, lv: number, tid: string, learned: Learned, now: number, ctx: { inner?: boolean; sp?: number; div?: number } = {}) {
    const tb = this.room.brains.get(tid), b = this.room.brains.get(sid)!;
    if (!tb || !this.room.actor(tid) || this.room.actor(tid)!.dead) return;
    const t = { type: this.room.state.players.has(tid) ? BL.PC : BL.MOB, targeted: this.room.targetedCount(tid) };
    const tu = this.room.actor(tid)!, wt = (b.weapon ?? FISTS).type, p = this.room.state.players.get(sid);
    const hit = weaponSkillHit(sk, lv, learned, { ...ctx, undead: isUndead(tb.status), demon: tb.status.race === "Demon", size: tb.status.size, tgtHpHalf: tu.hp < this.maxHpOf(tid) / 2,
      baseLv: p?.level, str: att.stats.str, int: att.stats.int, weaponType: wt, learned: (k) => this.level(sid, k) }); // 2.5.0 ratio context (skills2.ts ratio2)
    if (ctx.div) hit.div = ctx.div; // Throw Spirit Sphere: one hit per sphere thrown
    const res = playerAttack(att, b.weapon ?? FISTS, tb.status, t, Math.random, hit);
    this.room.delayDamage(sid, tid, res, now, now, { skill: sk.id, div: hit.div });
    this.room.status.afterHit(sid, tid, res, sk, lv, this.room.status.landAt(sid, now)); // bAddEff cards + Envenom's Poison
  }
  /** skill_attack(BF_MAGIC) -> battle_calc_magic_attack. */
  private magicHit(sid: string, att: Status, sk: Skill, lv: number, tid: string, learned: Learned, now: number) {
    const tb = this.room.brains.get(tid);
    if (!tb || !this.room.actor(tid) || this.room.actor(tid)!.dead) return;
    const p = this.room.state.players.get(sid);
    const m = magicSkillHit(sk, lv, learned, { undead: isUndead(tb.status), demon: tb.status.race === "Demon", baseLv: p?.level, str: att.stats.str, int: att.stats.int });
    const res = magicAttack(att, tb.status, m);
    this.room.delayDamage(sid, tid, res, now, now, { skill: sk.id, div: m.div });
    this.room.status.afterHit(sid, tid, res, sk, lv, this.room.status.landAt(sid, now)); // Frost Diver's Freeze
  }

  /**
   * 2.5.0, battle_weapon_attack's passive skills on a player's normal attack: Triple Attack (battle.cpp:7267, Renewal 30 %) replaces the
   * swing with a skill_attack(MO_TRIPLEATTACK) and sets canact (skill_delayfix); Double Attack (4311, Renewal 7 % x lv with a dagger) hits
   * twice (div 2, the damage doubled). Returns "replaced", or the multi-hit info for the normal hit (undefined = a plain swing).
   */
  normalAttack(sid: string, tid: string, res: { dmg: number; dmgLv: number }, weaponType: string, now: number): "replaced" | { skill: number; div: number } | undefined {
    const s = this.pcs.get(sid), b = this.room.brains.get(sid);
    if (!s || !b) return undefined;
    const tri = this.level(sid, "MO_TRIPLEATTACK");
    if (tri > 0 && Math.random() * 100 < TRIPLE_RATE && this.room.state.monsters.has(tid)) {
      const sk = SKILLS.get(SKILL_ID.MO_TRIPLEATTACK)!;
      s.canact = Math.max(s.canact, now + afterCastDelay(sk, tri, this.room.motions(sid).amotion));
      this.room.sendArea("AREA", sid, Msg.skillUse, { src: sid, id: sk.id, lv: tri, target: tid } satisfies SkillUseEvent);
      this.weaponHit(sid, b.status, sk, tri, tid, s.learned, now);
      return "replaced";
    }
    const dbl = this.level(sid, "TF_DOUBLE");
    if (dbl > 0 && weaponType === "Dagger" && res.dmgLv > 4 && Math.random() * 100 < doubleRate(dbl)) { res.dmg *= 2; return { skill: SKILL_ID.TF_DOUBLE, div: 2 }; }
    return undefined;
  }
  /** 2.5.0, battle_calc_damage's statuses on the target (Kyrie Eleison, Lex Aeterna, Guard) before the hit is shown and lands. */
  defend(tid: string, res: { dmg: number; dmgLv: number; miss: boolean; flag: number }) {
    const st = this.room.status, k = st.entry(tid, "Kyrie"), a = st.has(tid, "Aeterna"), g = st.entry(tid, "AutoGuard"), as = st.has(tid, "Assumptio");
    if (!k && !a && !g && !as) return;
    const out = defend(res.dmg, (res.flag & 0x1) !== 0, { kyrie: k, aeterna: a, guard: g?.val2, assumptio: as }, Math.random() * 100);
    for (const e of out.ended) st.end(tid, e as ScKey);
    if (out.blocked) { res.dmg = 0; res.miss = true; res.dmgLv = 4; return; } // ATK_BLOCK
    res.dmg = out.dmg;
  }

  /** Every tick: walk-ins in progress. */
  tick(now: number) {
    this.s2.tick(now); // 2.5.0 traps
    for (const [sid, s] of this.pcs) {
      if (!s.goal || s.cast) continue;
      const p = this.room.state.players.get(sid);
      if (!p || p.dead) { s.goal = undefined; continue; }
      this.pursue(sid, p, s, now);
    }
  }
  /** A new walk / attack / pickup request replaces a pending skill walk-in. */
  dropGoal(sid: string) { const s = this.pcs.get(sid); if (s) s.goal = undefined; }

  // ---------- equipment sweep + job change ----------
  /** The pc_isequip sweep (shared/rules/equipsweep.ts): map_quit / pc_jobchange take off what can't be worn any more; a base level
   *  change only the EquipLevelMax failures (pc_baselevelchanged). Status, look and the bag are refreshed once when anything came off. */
  sweep(sid: string, levelMaxOnly = false) {
    const p = this.room.state.players.get(sid), b = this.room.brains.get(sid);
    if (!p || !b?.inv) return false;
    const off = equipSweep([...b.inv.items.values()], p.job as JobKey, p.level, levelMaxOnly);
    for (const uid of off) b.inv.unequip(uid);
    if (!off.length) return false;
    const c = this.room.clients.getById(sid);
    if (c) this.room.afterGearChange(c, p); else { this.room.refreshStatus(sid, p); this.room.applyLook(p, b.inv); }
    return true;
  }

  /**
   * pc_jobchange (pc.cpp:10846) for a first job: refused for the same job; class set, job level 1 and job EXP 0 (skills and skill points
   * are kept), the equipment sweep (10986-10991), the look (status_set_viewdata + clif_changelook), pc_calc_skilltree +
   * clif_skillinfoblock, status_calc_pc. The job-change light (the script's specialeffect2) goes to the area.
   */
  jobChange(sid: string, job: JobKey) {
    const p = this.room.state.players.get(sid), b = this.room.brains.get(sid);
    if (!p || !b || !(job in JOBS) || p.job === job) return false;
    this.cancel(sid);
    // pc_jobchange (pc.cpp): leaving a 1st job for a 2nd one stores the job level it left at (change_level_2nd, JOBCHANGE2ND_VAR)
    if (isSecondJob(job) && !isSecondJob(p.job as JobKey)) this.room.npcEngine?.setCharVar(sid, "jobchange_level", p.jobLevel);
    p.job = job;
    p.jobLevel = 1;
    p.jobExp = 0;
    this.sweep(sid);
    this.room.refreshStatus(sid, p);
    this.room.applyLook(p, b.inv);
    const c = this.room.clients.getById(sid);
    if (c) this.room.sendInv(c, p);
    this.room.flushStatus(sid);
    this.send(sid);
    this.room.sendArea("AREA", sid, Msg.levelUp, { id: sid, kind: "job" } satisfies LevelUpEvent);
    this.room.save(p).catch((e) => console.error("[save]", e));
    return true;
  }
  /**
   * 2.5.0, pc_resetlvl(sd, 1) (pc.cpp): pc_resetskill (every skill gone), skill points 0, base / job level 1, both EXP 0, every stat 1;
   * a High Novice gets 100 status points ("not 88"). Then the level-dependent equipment comes off (pc_isequip sweep), status, look,
   * the skill list and the save.
   */
  resetLevel(sid: string) {
    const p = this.room.state.players.get(sid), b = this.room.brains.get(sid), s = this.pcs.get(sid);
    if (!p || !b || !s) return;
    this.cancel(sid);
    s.learned = {};
    b.inv?.persist("DELETE FROM skill WHERE char_id = $1", [s.charId]).catch(() => {});
    p.skillPoints = 0; p.level = 1; p.jobLevel = 1; p.exp = 0; p.jobExp = 0;
    p.str = 1; p.agi = 1; p.vit = 1; p.int = 1; p.dex = 1; p.luk = 1;
    p.statPoints = p.job === "Novice_High" ? 100 : p.statPoints;
    this.sweep(sid);
    this.room.refreshStatus(sid, p);
    p.hp = p.maxHp; p.sp = p.maxSp;
    this.room.flushStatus(sid);
    this.send(sid);
    this.room.save(p).catch((e) => console.error("[save]", e));
  }
  /** Basic Training needed for the job change (F_CanChangeJob: basicskillcheck off, or Basic Skill > 8). */
  canChangeJob(sid: string) { return this.basicOk(sid, BASIC_SKILL_NEED.jobChange); }
}
