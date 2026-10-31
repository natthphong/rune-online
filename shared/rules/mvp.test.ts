// Golden tests for the boss rules (shared/rules/mvp.ts), values worked out by hand from rAthena mob.cpp (get_mvp_player, mob_dead MVP
// reward, mob_drop_ratio_adjust, mob_summonslave, mobskill_use / mobskill_delay, mvptomb_*), npc.cpp (run_tomb) and the shipped conf/battle.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMap } from "../map.ts";
import { MOB_BY_ID } from "./data.ts";
import type { DmgLog, Receiver } from "./dmglog.ts";
import { MD } from "./mobai.ts";
import {
  FREECELL_TRIES, MVP_CONF, SLAVE_MODE, attackerCount, skillCheckDue, mvpDbExp, mvpDropTable, mvpExpReward, mvpPlayer, pickSlaveSkill, rareDropAnnounced, rollMvpPrizes, skillDelayAfter,
  skillRateRoll, skillStateMatches, slaveCondition, summonList, tombKiller, tombLines, tombWanted, type SlaveSkill,
} from "./mvp.ts";
import { SPAWN_CONF, parseSpawnLine, respawnDelay } from "./spawn.ts";

const A = 1, B = 2, C = 3;
const alive = (lv = 1): Receiver => ({ baseLevel: lv, dead: false });
const who = (m: Record<number, Receiver | undefined>) => (id: number) => m[id];
const e = (id: number, dmg: number, dmgTanked = 0) => ({ id, flag: "normal" as const, dmg, dmgTanked });

test("get_mvp_player: most damage dealt + taken wins, ties go to the older log entry, dead / offline entries are skipped", () => {
  const log: DmgLog = [e(A, 100), e(B, 60, 50), e(C, 110)];
  const all = who({ [A]: alive(), [B]: alive(), [C]: alive() });
  // B = 60 + 50 = 110 reaches 110 first; C ties it (110) and does not replace it (`mvp_damage >= dmg + tanked` continues)
  assert.equal(mvpPlayer(log, "Mvp", all), B);
  assert.equal(mvpPlayer(log, "Mvp", who({ [A]: alive(), [B]: { baseLevel: 1, dead: true }, [C]: alive() })), C); // dead B skipped
  assert.equal(mvpPlayer(log, "Mvp", who({ [A]: alive() })), A); // B, C left the map
  assert.equal(mvpPlayer(log, "Mvp", who({})), undefined); // nobody here
  // only an MVP (MD_MVP) has an MVP: a mini boss or an ordinary monster has none
  assert.equal(mvpPlayer(log, "Boss", all), undefined);
  assert.equal(mvpPlayer(log, "None", all), undefined);
  // mvp_to_loot_priority: the loot-priority player, whatever the damage
  assert.equal(mvpPlayer(log, "Mvp", all, A, { ...MVP_CONF, mvp_to_loot_priority: true }), A);
  // an entry with 0 damage never beats the initial 0 (a pure tanker is not an MVP)
  assert.equal(mvpPlayer([e(A, 0, 0)], "Mvp", all), undefined);
});

test("mob_dead MVP EXP: MvpExp, +25 % per extra attacker (at most 12 counted), at least 1, mvp_exp_rate, no base EXP maps", () => {
  const mob = { level: 20, mvpExp: 1000 };
  assert.equal(mvpExpReward(mob, 30, 1), 1000);
  assert.equal(mvpExpReward(mob, 30, 3), 1500); // 1000 + 1000 * (25 * 2) / 100
  assert.equal(mvpExpReward(mob, 30, 20), 3750); // count capped at exp_bonus_max_attacker 12: 1000 + 1000 * (25 * 11) / 100
  assert.equal(mvpExpReward({ level: 20, mvpExp: 0 }, 30, 5), 0);
  assert.equal(mvpExpReward({ level: 20 }, 30, 5), 0);
  assert.equal(mvpExpReward(mob, 30, 3, { noBaseExp: true }), 0); // MF_NOBASEEXP
  assert.equal(mvpExpReward({ level: 20, mvpExp: 1 }, 30, 1), 1);
  // MobDatabase::parseBodyNode: MvpExp * mvp_exp_rate / 100
  assert.equal(mvpDbExp(1000, { ...MVP_CONF, mvp_exp_rate: 250 }), 2500);
  assert.equal(mvpExpReward(mob, 30, 1, {}, { ...MVP_CONF, mvp_exp_rate: 200 }), 2000);
  // count comes from the log: online attackers on this map, dead ones included, offline ones not
  const log: DmgLog = [e(A, 5), e(B, 5), e(C, 5)];
  assert.equal(attackerCount(log, who({ [A]: alive(), [B]: { baseLevel: 1, dead: true } })), 2);
});

test("mob_drop_ratio_adjust: MvpDrops rate * item_rate_mvp / 100 clamped to 1..10000, unknown items / rate 0 removed", () => {
  assert.deepEqual(mvpDropTable([{ item: 909, rate: 3000 }, { item: 608, rate: 5000 }]), [{ item: 909, rate: 3000 }, { item: 608, rate: 5000 }]);
  assert.deepEqual(mvpDropTable([{ item: 909, rate: 3000 }, { item: 99999, rate: 5000 }, { item: 608, rate: 0 }]), [{ item: 909, rate: 3000 }]);
  const x2 = { ...MVP_CONF, item_rate_mvp: 200 };
  assert.deepEqual(mvpDropTable([{ item: 909, rate: 3000 }, { item: 608, rate: 6000 }], x2), [{ item: 909, rate: 6000 }, { item: 608, rate: 10000 }]);
  assert.deepEqual(mvpDropTable([{ item: 909, rate: 3000 }], { ...MVP_CONF, item_rate_mvp: 0 }), []); // item_rate_mvp 0 = no MVP prizes
  assert.deepEqual(mvpDropTable(undefined), []);
});

test("mob_dead MVP prize: first successful roll in db order, only one (mode 0); mode 2 gives all; 10000 needs no roll", () => {
  const table = [{ item: 909, rate: 3000 }, { item: 608, rate: 5000 }];
  const seq = (...v: number[]) => () => v.shift()!;
  // roll 0.2 -> 2000 < 3000: the first entry wins and the loop stops
  assert.deepEqual(rollMvpPrizes(table, 30, { level: 20 }, seq(0.2)), [{ item: 909, rate: 3000 }]);
  // 0.35 -> 3500 >= 3000 skip; 0.4 -> 4000 < 5000: the second
  assert.deepEqual(rollMvpPrizes(table, 30, { level: 20 }, seq(0.35, 0.4)), [{ item: 608, rate: 5000 }]);
  // both miss: no prize
  assert.deepEqual(rollMvpPrizes(table, 30, { level: 20 }, seq(0.31, 0.51)), []);
  // mode 2: every successful roll
  assert.deepEqual(rollMvpPrizes(table, 30, { level: 20 }, seq(0.1, 0.1), { ...MVP_CONF, item_drop_mvp_mode: 2 }).map((p) => p.item), [909, 608]);
  // mode 1: random order (r = 0 swaps the last to the front) -> 608 first, and it wins
  assert.deepEqual(rollMvpPrizes(table, 30, { level: 20 }, () => 0, { ...MVP_CONF, item_drop_mvp_mode: 1 }).map((p) => p.item), [608]);
  // rate 10000: no random number is drawn
  assert.deepEqual(rollMvpPrizes([{ item: 909, rate: 10000 }], 30, { level: 20 }, () => { throw new Error("rolled"); }), [{ item: 909, rate: 10000 }]);
  // an entry whose item is gone is skipped
  assert.deepEqual(rollMvpPrizes([{ item: 99999, rate: 10000 }], 30, { level: 20 }, () => 0), []);
});

test("rare_drop_announce: off at 0, on for a prize at or under the setting", () => {
  assert.equal(rareDropAnnounced(1), false);
  assert.equal(rareDropAnnounced(100, { ...MVP_CONF, rare_drop_announce: 500 }), true);
  assert.equal(rareDropAnnounced(501, { ...MVP_CONF, rare_drop_announce: 500 }), false);
});

test("MVP tomb: made for boss_monster lines (mvp_tomb_enabled), names the MVP, else the loot-priority player, else Unknown", () => {
  assert.equal(tombWanted(true), true);
  assert.equal(tombWanted(false), false); // a plain `monster` line
  assert.equal(tombWanted(true, { ...MVP_CONF, mvp_tomb_enabled: false }), false);
  assert.equal(tombWanted(true, MVP_CONF, true), false); // MF_NOTOMB
  assert.equal(tombKiller("Ann", "Bob"), "Ann");
  assert.equal(tombKiller(undefined, "Bob"), "Bob");
  assert.equal(tombKiller(undefined, undefined), "");
  assert.equal(MVP_CONF.mvp_tomb_delay, 9000);
  // run_tomb: name, "Has met its demise", time of death HH:MM, "Defeated by", [killer]
  assert.deepEqual(tombLines("Gloopking", new Date(2026, 9, 23, 3, 7), "Ann"), [
    "[ ^EE0000Gloopking^000000 ]", "Has met its demise", "Time of death : ^EE000003:07^000000", "Defeated by", "[^EE0000Ann^000000]",
  ]);
  assert.equal(tombLines("X", new Date(2026, 0, 1, 23, 59), "")[4], "[^EE0000Unknown^000000]");
});

test("boss respawn: a boss_monster line keeps delay2, delay1 + rnd % delay2, bosses (MD_STATUSIMMUNE) use boss_spawn_delay", () => {
  const m: GameMap = { w: 40, h: 40, height: new Float32Array(1600), kind: new Uint8Array(1600), blocked: new Uint8Array(1600), props: [] };
  const exists = (id: number) => MOB_BY_ID.has(id);
  // mini boss: 30 min + up to 10 min; MVP: 2 h + up to 1 h
  const mini = parseSpawnLine("f1,20,20\tboss_monster\tMoonwhisker\t1093,1,1800000,600000", m, exists);
  assert.deepEqual([mini.boss, mini.delay1, mini.delay2], [true, 1800000, 600000]);
  const mvp = parseSpawnLine("f1,20,20\tboss_monster\tGloopking\t3810,1,7200000,3600000", m, exists);
  assert.deepEqual([mvp.boss, mvp.delay1, mvp.delay2], [true, 7200000, 3600000]);
  // the same numbers on a monster line lose the variance
  assert.equal(parseSpawnLine("f1,20,20\tmonster\tMoonwhisker\t1093,1,1800000,600000", m, exists).delay2, 0);
  const bossMode = MOB_BY_ID.get(1093)!.mode;
  assert.ok(bossMode & MD.STATUSIMMUNE);
  assert.equal(respawnDelay(mini, bossMode, 0), 1800000); // rnd() % 600000 = 0
  assert.equal(respawnDelay(mini, bossMode, 600000 * 7 + 123456), 1800000 + 123456);
  assert.equal(respawnDelay(mvp, MOB_BY_ID.get(3810)!.mode, 3600000 * 3 + 5), 7200000 + 5);
  // boss_spawn_delay 50 % halves it (the C++ divides by 100 first); never under 1000 ms
  const half = { ...SPAWN_CONF, boss_spawn_delay: 50 };
  assert.equal(respawnDelay(mini, bossMode, 123456, half), Math.trunc((1800000 + 123456) / 100) * 50);
  assert.equal(respawnDelay({ delay1: 1000, delay2: 0 }, bossMode, 0, { ...SPAWN_CONF, boss_spawn_delay: 10 }), 1000);
});

const row = (o: Partial<SlaveSkill>): SlaveSkill => ({ state: "idle", amount: 5, rate: 10000, castTime: 0, delay: 0, cancelable: false, cond: "onspawn", condValue: 0, ids: [1002, 1113], ...o });

test("mob_summonslave: round-robin over the ids; an amount below the id count starts at a random id", () => {
  assert.deepEqual(summonList([1, 2, 3], 5, () => 0), [1, 2, 3, 1, 2]);
  assert.deepEqual(summonList([1, 2, 3], 2, () => 2), [3, 1]); // k = 2, amount 2 + 2 = 4: ids[2], ids[0]
  assert.deepEqual(summonList([7], 4, () => 0), [7, 7, 7, 7]);
  assert.deepEqual(summonList([], 4, () => 0), []);
  assert.deepEqual(summonList([1, 2], 0, () => 0), []);
});

test("mobskill_use for NPC_SUMMONSLAVE: onspawn at spawn, slavele N when few slaves are left, delay, rate roll, state", () => {
  // the shape of a mini boss: summon 6 on spawn (idle), re-summon 5 in attack when at most 3 slaves are alive (delay 60 s)
  const rows = [row({ state: "attack", cond: "slavele", condValue: 3, castTime: 2000, delay: 60000 }), row({ state: "idle", cond: "onspawn", amount: 6 })];
  const o = { mobState: "idle", hasTarget: false, slaves: 0, event: "spawn" as const, now: 1000, readyAt: 0, roll: () => 0 };
  assert.equal(pickSlaveSkill(rows, o), rows[1]);
  assert.equal(pickSlaveSkill(rows, { ...o, event: "check" }), undefined); // onspawn never fires from the periodic check; the other row is attack-state
  assert.equal(pickSlaveSkill(rows, { ...o, mobState: "berserk", hasTarget: true, event: "check" }), rows[0]);
  assert.equal(pickSlaveSkill(rows, { ...o, mobState: "berserk", hasTarget: true, event: "check", slaves: 4 }), undefined); // 4 > 3
  assert.equal(pickSlaveSkill(rows, { ...o, mobState: "berserk", hasTarget: true, event: "check", slaves: 3 }), rows[0]); // slavele = at most 3
  assert.equal(pickSlaveSkill(rows, { ...o, mobState: "berserk", hasTarget: true, event: "check", now: 999, readyAt: 1000 }), undefined); // skill delay
  // rate 5000: `rnd() % 10000 > 5000` skips
  assert.equal(pickSlaveSkill([row({ rate: 5000 })], { ...o, roll: () => 5001 }), undefined);
  assert.equal(pickSlaveSkill([row({ rate: 5000 })], { ...o, roll: () => 5000 }) !== undefined, true);
  assert.equal(skillRateRoll(10000, 9999), true);
  // conditions
  assert.equal(slaveCondition("slavelt", 3, 3, "check"), false);
  assert.equal(slaveCondition("slavelt", 3, 2, "check"), true);
  assert.equal(slaveCondition("always", 0, 99, "check"), true);
  assert.equal(slaveCondition("myhpltmaxrate", 50, 0, "check"), false); // not a slave condition
  // states
  assert.equal(skillStateMatches("any", "walk", false), true);
  assert.equal(skillStateMatches("anytarget", "rush", true), true);
  assert.equal(skillStateMatches("anytarget", "loot", true), false);
  assert.equal(skillStateMatches("anytarget", "rush", false), false);
  assert.equal(skillStateMatches("attack", "berserk", true), true);
  assert.equal(skillStateMatches("attack", "idle", false), false);
  assert.equal(skillStateMatches("chase", "rush", true), true);
  assert.equal(skillStateMatches("follow", "rush", true), false); // MSS_FOLLOW / MSS_ANGRY are not modelled: no accidental firing
  assert.equal(skillStateMatches("angry", "berserk", true), false);
  // mobskill_delay: the delay of the first row of the skill that fits the current state
  assert.equal(skillDelayAfter(rows, "berserk", true), 60000);
  assert.equal(skillDelayAfter(rows, "idle", false), 0);
  assert.equal(skillDelayAfter(rows, "walk", false), 0);
});

test("the importer's boss rows: the roster's bosses carry their MVP / slave data", () => {
  const bosses = [...MOB_BY_ID.values()].filter((m) => m.bossType !== "None");
  for (const b of bosses) {
    assert.ok(b.mode & MD.STATUSIMMUNE, `${b.name}: Class Boss has MD_STATUSIMMUNE`);
    assert.ok(b.mode & MD.KNOCKBACKIMMUNE, `${b.name}: Class Boss has MD_KNOCKBACKIMMUNE`);
    assert.equal(b.bossType === "Mvp", (b.mode & MD.MVP) !== 0);
    for (const s of b.slaves) for (const id of s.ids) assert.ok(MOB_BY_ID.has(id), `${b.name}: slave ${id} is in the roster`);
  }
});

test("slave mode (slaves_inherit_mode 4): exactly CANMOVE | NORANDOMWALK | CANATTACK, nothing else; 50 free-cell tries", () => {
  assert.equal(SLAVE_MODE, MD.CANMOVE | MD.NORANDOMWALK | MD.CANATTACK);
  for (const m of MOB_BY_ID.values()) for (const s of m.slaves) for (const id of s.ids) {
    const mode = SLAVE_MODE; // what the room puts in the slave's brain, whatever mob_db says
    assert.equal(mode & (MD.LOOTER | MD.AGGRESSIVE | MD.ASSIST), 0, `slave ${id} of ${m.name}`);
  }
  assert.equal(FREECELL_TRIES, 50);
});

test("mob_ai_sub_hard skill check: not while walking; attack state when its attack delay is over, else every second", () => {
  const o = { walking: false, mobState: "idle", now: 5000, attackableAt: 9000, lastCheck: 4001 };
  assert.equal(skillCheckDue(o), false);
  assert.equal(skillCheckDue({ ...o, lastCheck: 4000 }), true);
  assert.equal(skillCheckDue({ ...o, lastCheck: 0, walking: true }), false);
  assert.equal(skillCheckDue({ ...o, mobState: "berserk", lastCheck: 5000 }), false); // attackabletime not reached, the 1 s rule does not apply
  assert.equal(skillCheckDue({ ...o, mobState: "berserk", attackableAt: 5000, lastCheck: 5000 }), true);
});
