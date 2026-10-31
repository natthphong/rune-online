// 2.5.0: the room side of the 2nd-job skill kinds (shared/rules/skills2.ts): splash around the target, magic around the caster or a
// cell, ground units acting in waves (skill_unit_onplace / skill_unit_timer_sub: Storm Gust, Lord of Vermilion, Meteor Storm, Magnus,
// Sanctuary, Grand Cross, Demonstration, Hammer Fall), traps (skill_unit_onplace HT_*: fire on the first enemy that steps beside
// them), Blitz Beat (battle_calc_misc_attack), party buffs (party_foreachsamemap / map_foreachinallrange BL_PC), spirit spheres
// (pc_addspiritball / pc_delspiritball) and Turn Undead. Called from SkillSystem.fire (server/src/skills.ts) for these kinds only.
import { Msg, type SkillUseEvent } from "../../shared/protocol.ts";
import { ATK, BF, type AttackResult } from "../../shared/rules/battle.ts";
import { inSplash, skillLv, type Skill } from "../../shared/rules/skill.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { MAX_SPHERES, PITCHER_POTION, SPHERE_COST, pitcherHeal, resurrectPercent, blitzDamage, sanctuaryHeal, trapDamage, turnUndeadChance, turnUndeadDamage, type SkillUse2 } from "../../shared/rules/skills2.ts";
import { SKILL_SC } from "../../shared/rules/status_change.ts";
import { MD } from "../../shared/rules/mode.ts";
import * as party from "./party.ts";
import type { MapRoom } from "./rooms/MapRoom.ts";

type Cell = { x: number; y: number };
export type Fire2 = {
  sid: string; sk: Skill; lv: number; target?: string; at: Cell; here: Cell; now: number; charId: number;
  learned: (key: string) => number;
  enemies: (c: Cell, r: number) => string[];
  weaponHit: (tid: string, ctx?: Record<string, unknown>) => void;
  magicHit: (tid: string) => void;
};
const miscResult = (dmg: number): AttackResult => ({ dmg, crit: false, miss: dmg <= 0, lucky: false, dmgLv: dmg > 0 ? ATK.DEF : ATK.MISS, flag: BF.MISC | BF.SKILL });

/** A placed trap (skill_unit with UNT_*): fires once on the first monster within 1 cell, or vanishes after Duration1. */
type Trap = { id: number; owner: string; sk: Skill; lv: number; x: number; y: number; until: number; radius: number; effect: "damage" | "ankle" };

export class Skills2 {
  private room: MapRoom;
  private spheres = new Map<string, number>(); // sd->spiritball
  private traps: Trap[] = [];
  private seq = 0;
  constructor(room: MapRoom) { this.room = room; }

  spheresOf(sid: string) { return this.spheres.get(sid) ?? 0; }
  leave(sid: string) { this.spheres.delete(sid); this.traps = this.traps.filter((t) => t.owner !== sid); }
  /** skill_check_condition_castbegin: SpiritSphereCost (Fury needs 5; Asura Strike needs Fury running). null = ok. */
  sphereBlock(sid: string, sk: Skill): string | null {
    const need = SPHERE_COST[sk.key];
    if (need && this.spheresOf(sid) < need) return "failed";
    if (sk.key === "MO_EXTREMITYFIST" && !this.room.status.has(sid, "ExplosionSpirits")) return "failed";
    return null;
  }
  private useSpheres(sid: string, n: number) { this.spheres.set(sid, Math.max(0, this.spheresOf(sid) - n)); this.room.notice(this.room.clients.getById(sid)!, `Spirit spheres: ${this.spheresOf(sid)}`); }

  /** The weapon skills that spend spheres (castend): Throw Spirit Sphere throws min(lv, spheres) (one hit each), Occult Impaction 1,
   *  Asura Strike all of them and every SP point (asurastrike.cpp: the SP is read before it is spent). Returns the hit count to use. */
  spendForHit(sid: string, sk: Skill, lv: number): number | undefined {
    if (sk.key === "MO_FINGEROFFENSIVE") { const n = Math.max(1, Math.min(lv, this.spheresOf(sid))); this.useSpheres(sid, n); return n; }
    if (sk.key === "MO_INVESTIGATE") { this.useSpheres(sid, 1); return undefined; }
    if (sk.key === "MO_EXTREMITYFIST") { this.useSpheres(sid, this.spheresOf(sid)); return undefined; }
    if (sk.key === "MO_EXPLOSIONSPIRITS") { this.useSpheres(sid, 5); return undefined; }
    return undefined;
  }

  fire(use: SkillUse2, f: Fire2) {
    const { sid, sk, lv } = f, room = this.room;
    const ev: SkillUseEvent = { src: sid, id: sk.id, lv, target: f.target, x: f.at.x, y: f.at.y };
    switch (use.kind) {
      case "targetSplash": { // the target + every enemy around it (SplashArea)
        room.sendArea("AREA", sid, Msg.skillUse, ev);
        const ids = new Set([f.target!, ...f.enemies(f.at, Math.max(1, skillLv(sk.splash, lv)))]);
        for (const id of ids) use.magic ? f.magicHit(id) : f.weaponHit(id);
        break;
      }
      case "selfMagic": room.sendArea("AREA", sid, Msg.skillUse, ev); for (const id of f.enemies(f.here, Math.max(1, skillLv(sk.splash, lv)))) f.magicHit(id); break;
      case "groundMagic": room.sendArea("AREA", sid, Msg.skillUse, ev); for (const id of f.enemies(f.at, Math.max(2, skillLv(sk.splash, lv)))) f.magicHit(id); break;
      case "unit": this.unit(use, f, ev); break;
      case "trap": {
        room.sendArea("AREA", sid, Msg.skillUse, ev);
        this.traps.push({ id: ++this.seq, owner: sid, sk, lv, x: f.at.x, y: f.at.y, until: f.now + Math.max(5000, skillLv(sk.duration1, lv)), radius: use.radius, effect: use.effect });
        break;
      }
      case "misc": { // HT_BLITZBEAT: the falcon hits the target and the cells around it, lv hits (SplashSplit: each target its share)
        room.sendArea("AREA", sid, Msg.skillUse, ev);
        const b = room.brains.get(sid)!, st = b.status.stats;
        const ids = [...new Set([f.target!, ...f.enemies(f.at, use.radius)])];
        const per = Math.max(1, Math.trunc(blitzDamage(lv, f.learned("HT_STEELCROW"), st) / ids.length));
        for (const id of ids) room.delayDamage(sid, id, miscResult(per * Math.max(1, Math.abs(skillLv(sk.hitCount, lv)))), f.now, f.now, { skill: sk.id, div: Math.abs(skillLv(sk.hitCount, lv)) || 1 });
        break;
      }
      case "aura": { // a self / party buff: the caster, then the party members within the splash range (-1: anyone of the party on screen)
        room.sendArea("AREA", sid, Msg.skillUse, ev);
        const def = SKILL_SC[sk.key];
        if (!def) break;
        const r = skillLv(sk.splash, lv) < 0 ? 14 : Math.max(1, skillLv(sk.splash, lv));
        const pid = party.partyIdOf(f.charId);
        const dur = def.time === "dur1" ? skillLv(sk.duration1, lv) : skillLv(sk.duration2, lv);
        const mates = pid === undefined ? [] : party.aliveMembersIn(room, pid).filter((m) => m !== sid);
        room.status.start(sid, sid, def.sc, { rate: 10000, val1: lv, val2: 1, duration: dur });
        for (const m of mates) {
          const p = room.state.players.get(m);
          if (p && inSplash(f.here.x, f.here.y, r, Math.round(p.x), Math.round(p.y))) room.status.start(sid, m, def.sc, { rate: 10000, val1: lv, val2: 0, duration: dur });
        }
        break;
      }
      case "spheres": { // pc_addspiritball: one per cast, at most the skill level (MAX_SPIRITBALL 5 for Monks)
        room.sendArea("AREA", sid, Msg.skillUse, ev);
        this.spheres.set(sid, Math.min(Math.min(lv, MAX_SPHERES), this.spheresOf(sid) + 1));
        const c = room.clients.getById(sid);
        if (c) room.notice(c, `Spirit spheres: ${this.spheresOf(sid)}`);
        break;
      }
      case "resurrect": { // resurrection.cpp castendNoDamageId: status_revive(target, per, 0) on a dead player
        const q = room.state.players.get(f.target!);
        if (!q || !q.dead) { room.skills.fail(sid, sk.id, "target"); break; }
        q.dead = false;
        q.hp = Math.max(1, Math.trunc((q.maxHp * resurrectPercent(lv)) / 100));
        room.sendArea("AREA", sid, Msg.skillUse, { ...ev, heal: q.hp });
        room.flushStatus(f.target!);
        break;
      }
      case "pitcher": { // aidpotion.cpp: the potion of the skill level is spent, the target healed by its roll x the bonuses
        const b = room.brains.get(sid)!, q = room.state.players.get(f.target!), qb = room.brains.get(f.target!);
        const potion = PITCHER_POTION[Math.min(5, lv) - 1], item = ITEMS.get(potion);
        const st = b.inv ? [...b.inv.items.values()].find((x) => x.itemId === potion && x.amount > 0) : undefined;
        const heal = item?.effect && "heal" in item.effect ? (item.effect.heal as number[]) : undefined;
        if (!q || !qb || !st || !heal || q.dead) { room.skills.fail(sid, sk.id, "failed"); break; }
        b.inv!.remove(st.uid, 1);
        const c = room.clients.getById(sid);
        if (c) room.sendInv(c, room.state.players.get(sid)!);
        const roll = heal[0] + Math.floor(Math.random() * (heal[1] - heal[0] + 1));
        const add = Math.min(q.maxHp - q.hp, pitcherHeal(roll, lv, f.learned("AM_LEARNINGPOTION"), qb.status.stats.vit, room.skills.level(f.target!, "SM_RECOVERY")));
        q.hp += Math.max(0, add);
        room.sendArea("AREA", sid, Msg.skillUse, { ...ev, heal: Math.max(0, add) });
        room.flushStatus(f.target!);
        break;
      }
      case "turnUndead": { // only an Undead-element target; chance of an instant kill, else holy damage
        room.sendArea("AREA", sid, Msg.skillUse, ev);
        const t = room.actor(f.target!), tb = room.brains.get(f.target!), b = room.brains.get(sid)!;
        if (!t || !tb || tb.status.element !== "Undead") { room.skills.fail(sid, sk.id, "target"); break; }
        const st = { luk: b.status.stats.luk, int: b.status.stats.int, baseLv: room.state.players.get(sid)?.level ?? 1 };
        const kill = !(tb.status.mode & MD.STATUSIMMUNE) && Math.floor(Math.random() * 1000) < turnUndeadChance(lv, st, t.hp, this.maxHp(f.target!));
        room.delayDamage(sid, f.target!, miscResult(kill ? t.hp : turnUndeadDamage(lv, st)), f.now, f.now, { skill: sk.id, div: 1 });
        break;
      }
    }
  }
  private maxHp(id: string) { return this.room.state.players.get(id)?.maxHp ?? this.room.state.monsters.get(id)?.maxHp ?? 1; }

  /** A ground unit (skill_unitsetting + skill_unit_timer): `waves` times every `interval` ms on the cell (or the caster's cell); Storm
   *  Gust / Vermilion / Magnus / Demonstration / Grand Cross hit every enemy inside, Meteor Storm drops a meteor on a random cell of
   *  its area, Sanctuary heals players (and hurts Undead monsters). Stops when the caster is gone or dead. */
  private unit(use: Extract<SkillUse2, { kind: "unit" }>, f: Fire2, ev: SkillUseEvent) {
    const room = this.room, centre = use.self ? f.here : f.at;
    room.sendArea("AREA", f.sid, Msg.skillUse, ev);
    for (let w = 0; w < use.waves; w++) {
      room.timeline.add(f.now + w * use.interval + 1, (at) => {
        const p = room.state.players.get(f.sid);
        if (!p || p.dead) return;
        if (w > 0) room.sendArea("AREA", f.sid, Msg.skillUse, { ...ev, x: centre.x, y: centre.y });
        if (use.hit === "heal") {
          const amount = sanctuaryHeal(f.lv);
          for (const [id, q] of room.state.players) {
            if (q.dead || !inSplash(centre.x, centre.y, use.radius, Math.round(q.x), Math.round(q.y))) continue;
            const add = Math.min(amount, q.maxHp - q.hp);
            if (add > 0) { q.hp += add; room.sendArea("AREA", id, Msg.skillUse, { src: f.sid, id: f.sk.id, lv: f.lv, target: id, heal: add }); room.flushStatus(id); }
          }
          for (const id of f.enemies(centre, use.radius)) if (room.brains.get(id)?.status.element === "Undead") room.delayDamage(f.sid, id, miscResult(Math.trunc(amount / 2)), at, at, { skill: f.sk.id, div: 1 });
          return;
        }
        if (use.hit === "meteor") {
          const c = { x: centre.x + Math.floor(Math.random() * (2 * use.radius + 1)) - use.radius, y: centre.y + Math.floor(Math.random() * (2 * use.radius + 1)) - use.radius };
          room.sendArea("AREA", f.sid, Msg.skillUse, { ...ev, x: c.x, y: c.y });
          for (const id of f.enemies(c, Math.max(1, skillLv(f.sk.splash, f.lv)))) f.magicHit(id);
          return;
        }
        for (const id of f.enemies(centre, use.radius)) use.hit === "magic" ? f.magicHit(id) : f.weaponHit(id);
      });
    }
  }

  /** Every tick: traps whose time ran out vanish; a trap with a monster beside it fires (skill_unit_onplace -> skill_attack BF_MISC / Ankle). */
  tick(now: number) {
    if (!this.traps.length) return;
    const room = this.room;
    this.traps = this.traps.filter((t) => {
      if (now > t.until || !room.state.players.has(t.owner)) return false;
      const victim = [...room.state.monsters].find(([, m]) => !m.dead && inSplash(t.x, t.y, 1, Math.round(m.x), Math.round(m.y)));
      if (!victim) return true;
      const b = room.brains.get(t.owner), p = room.state.players.get(t.owner);
      if (!b || !p) return false;
      room.sendArea("AREA", t.owner, Msg.skillUse, { src: t.owner, id: t.sk.id, lv: t.lv, x: t.x, y: t.y });
      if (t.effect === "ankle") { room.status.start(t.owner, victim[0], "Ankle", { rate: 10000, val1: t.lv, duration: skillLv(t.sk.duration2, t.lv) || 5000 }); return false; }
      const dmg = trapDamage(t.lv, { dex: b.status.stats.dex, int: b.status.stats.int, baseLv: p.level });
      const hit = t.radius > 0 ? [...room.state.monsters].filter(([, m]) => !m.dead && inSplash(t.x, t.y, t.radius, Math.round(m.x), Math.round(m.y))).map(([id]) => id) : [victim[0]];
      for (const id of hit) room.delayDamage(t.owner, id, miscResult(dmg), now, now, { skill: t.sk.id, div: 1 });
      return false;
    });
  }
}
