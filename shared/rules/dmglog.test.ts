// Golden values for mob_log_damage / mob_dead EXP + loot sharing, hand-computed from rAthena mob.cpp + status.cpp
// (conf/battle/exp.conf defaults: exp_calc_type 0, exp_bonus_attacker 25, exp_bonus_max_attacker 12, rates 100).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOB_BY_ID } from "./data.ts";
import { EXP_CONF } from "./exp.ts";
import { DAMAGELOG_SIZE, loggedDamage, lootOwners, mobDbExp, mobDeadExp, mobLogDamage, type DmgLog, type Receiver } from "./dmglog.ts";

const tumhog = MOB_BY_ID.get(1063)!; // Lv3, HP 48, 150 base / 50 job
const A = 1, B = 2, C = 3;
const alive = (lv = 1): Receiver => ({ baseLevel: lv, dead: false });
const who = (m: Record<number, Receiver | undefined>) => (id: number) => m[id];

/** Replays hits on a monster the way the server does: each hit logs loggedDamage(dmg, hp before), then HP drops. */
function fight(hits: [number, number][], hp: number, conf = EXP_CONF) {
  const log: DmgLog = [];
  for (const [id, dmg] of hits) { mobLogDamage(log, id, loggedDamage(dmg, hp, conf)); hp = Math.max(0, hp - dmg); }
  return log;
}

test("Tumhog shared kill (critic probe): A 29 dmg, B 28 dmg incl. the killing hit on 19 HP left", () => {
  // exp_calc_type 0: the log keeps the raw damage (status.cpp:1620 only swaps in the real damage for type 1) -> total 57
  // count 2 -> per *= 1.25.  A: 29/57*1.25 = 0.63596 -> 150*per = 95.39 -> 95, 50*per = 31.80 -> 31
  //                          B: 28/57*1.25 = 0.61404 -> 92.11 -> 92, 30.70 -> 30
  const log = fight([[A, 10], [B, 10], [A, 19], [B, 18]], 48);
  assert.deepEqual(log.map((e) => e.dmg), [29, 28]);
  assert.deepEqual(mobDeadExp(log, tumhog, who({ [A]: alive(), [B]: alive() })), [{ id: A, base: 95, job: 31 }, { id: B, base: 92, job: 30 }]);
  // exp_calc_type 1: real damage logged (B capped at the 19 HP left), per = dmg / max_hp.
  //   A: 29/48*1.25 = 0.75521 -> 113.28 -> 113, 37.76 -> 37;  B: 19/48*1.25 = 0.49479 -> 74.22 -> 74, 24.74 -> 24
  const t1 = { ...EXP_CONF, exp_calc_type: 1 as const };
  const log1 = fight([[A, 10], [B, 10], [A, 19], [B, 18]], 48, t1);
  assert.deepEqual(log1.map((e) => e.dmg), [29, 19]);
  assert.deepEqual(mobDeadExp(log1, tumhog, who({ [A]: alive(), [B]: alive() }), t1), [{ id: A, base: 113, job: 37 }, { id: B, base: 74, job: 24 }]);
  // exp_calc_type 2: first entry's damage doubled and added to the total: A 58/86, B 28/86, both x1.25
  //   A: 0.84302 -> 126.45 -> 126, 42.15 -> 42;  B: 0.40698 -> 61.05 -> 61, 20.35 -> 20
  const t2 = { ...EXP_CONF, exp_calc_type: 2 as const };
  assert.deepEqual(mobDeadExp(fight([[A, 29], [B, 28]], 48), tumhog, who({ [A]: alive(), [B]: alive() }), t2),
    [{ id: A, base: 126, job: 42 }, { id: B, base: 61, job: 20 }]);
});

test("mob_dead: solo kill, overkill, dead / offline attackers, tankers", () => {
  const solo = fight([[A, 30], [A, 30]], 48); // overkill logged (60): per 60/60 = 1, count 1 -> full EXP
  assert.deepEqual(mobDeadExp(solo, tumhog, who({ [A]: alive() })), [{ id: A, base: 150, job: 50 }]);
  const log = fight([[A, 29], [B, 28]], 48);
  // dead B: still counted (bonus x1.25 for A) but not paid
  assert.deepEqual(mobDeadExp(log, tumhog, who({ [A]: alive(), [B]: { baseLevel: 1, dead: true } })), [{ id: A, base: 95, job: 31 }]);
  // offline / left B: its damage stays in the total, but it is not counted: A 29/57 = 0.50877 -> 76.32 -> 76, 25.44 -> 25
  assert.deepEqual(mobDeadExp(log, tumhog, who({ [A]: alive() })), [{ id: A, base: 76, job: 25 }]);
  // C only tanked a normal attack (status.cpp:1672 logs it with 0 damage): count 2, A per = min(48/48, 1) * 1.25 -> 187, 62;
  // C per 0 -> cap_value(0, 1, MAX_EXP) = 1 each
  const tank: DmgLog = [];
  mobLogDamage(tank, C, 0, 12);
  mobLogDamage(tank, A, 48);
  assert.deepEqual(mobDeadExp(tank, tumhog, who({ [A]: alive(), [C]: alive() })), [{ id: C, base: 1, job: 1 }, { id: A, base: 187, job: 62 }]);
});

test("mob_dead: exp_bonus_max_attacker caps the attacker bonus at 12", () => {
  // 14 attackers x 10 dmg, mob 1000/500 EXP: per = 10/140 = 0.0714286, + per*(11*25)/100 -> 0.267857
  //   base 267.86 -> 267, job 133.93 -> 133
  const log: DmgLog = [];
  const r: Record<number, Receiver> = {};
  for (let id = 1; id <= 14; id++) { mobLogDamage(log, id, 10); r[id] = alive(); }
  const out = mobDeadExp(log, { level: 1, baseExp: 1000, jobExp: 500, hp: 140 }, who(r));
  assert.equal(out.length, 14);
  for (const s of out) assert.deepEqual([s.base, s.job], [267, 133]);
});

test("mob_dead: Renewal level penalty per receiver, conf rates, map flags", () => {
  const log = fight([[A, 29], [B, 28]], 48);
  // A at base Lv9 vs Tumhog Lv3: diff -6 -> 95%: 95*95/100 = 90.25 -> 90, 31*95/100 = 29.45 -> 29. B (Lv1, diff +2) stays 100%.
  assert.deepEqual(mobDeadExp(log, tumhog, who({ [A]: alive(9), [B]: alive(1) })), [{ id: A, base: 90, job: 29 }, { id: B, base: 92, job: 30 }]);
  // base_exp_rate 200 / job_exp_rate 50 (mob db 300 / 25), A alone online: per 29/57 = 0.50877 -> 152.63 -> 152, 12.72 -> 12
  const rates = { ...EXP_CONF, base_exp_rate: 200, job_exp_rate: 50 };
  assert.deepEqual(mobDeadExp(log, tumhog, who({ [A]: alive() }), rates), [{ id: A, base: 152, job: 12 }]);
  assert.equal(mobDbExp(150, 150), 225);
  assert.equal(mobDbExp(149, 33), 49); // 49.17
  // MF_NOJOBEXP: job 0, base still paid; MF_BEXP 150: 95.39 * 1.5 = 143.08 -> 143
  assert.deepEqual(mobDeadExp(log, tumhog, who({ [A]: alive(), [B]: alive() }), EXP_CONF, { noJobExp: true, bexp: 150 })[0], { id: A, base: 143, job: 0 });
});

test("mob_log_damage: per-character accumulation, DAMAGELOG_SIZE FIFO", () => {
  const log: DmgLog = [];
  mobLogDamage(log, A, 5);
  mobLogDamage(log, A, 7, 3);
  mobLogDamage(log, A, -4); // absorbed: ignored
  assert.deepEqual(log, [{ id: A, flag: "normal", dmg: 12, dmgTanked: 3 }]);
  for (let id = 100; id < 100 + DAMAGELOG_SIZE; id++) mobLogDamage(log, id, 1);
  assert.equal(log.length, DAMAGELOG_SIZE);
  assert.equal(log[0].id, 100); // A, the oldest, was pushed out
  assert.equal(log.at(-1)!.id, 100 + DAMAGELOG_SIZE - 1);
});

test("mob_dead loot priority: first_attack_loot_bonus 30% of total to the first entry, top 3", () => {
  // A 29 (first) + 57*30/100 = 29 + 17 = 46 vs B 28
  assert.deepEqual(lootOwners(fight([[A, 29], [B, 28]], 48), who({ [A]: alive(), [B]: alive() })), [A, B]);
  // A 10 (first) + 50*30/100 = 25 < B 40
  const log = fight([[A, 10], [B, 40]], 48);
  assert.deepEqual(lootOwners(log, who({ [A]: alive(), [B]: alive() })), [B, A]);
  assert.deepEqual(lootOwners(log, who({ [A]: alive(), [B]: { baseLevel: 1, dead: true } })), [A]); // dead: no loot
  assert.deepEqual(lootOwners(log, who({})), []);
});
