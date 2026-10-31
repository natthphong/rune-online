// Golden tests for quest.ts, worked out by hand from rAthena src/map/quest.cpp (parseBodyNode, quest_time, quest_add,
// quest_change, quest_delete, quest_update_objective, quest_update_status, quest_check), script.cpp buildin_isbegin_quest,
// intif.cpp intif_parse_questlog and common/timer.cpp solve_time. Monsters are our renamed mob_db rows:
// 1002 Puddlebloom Lv1 Plant/Medium/Water, 1063 Tumhog Lv3 Brute/Small/Neutral, 1010 Loambloom Lv8 Plant/Medium/Earth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOB_BY_ID } from "./data.ts";
import {
  MAX_QUEST_OBJECTIVES, Q_ACTIVE, Q_COMPLETE, Q_INACTIVE, isbeginQuest, parseQuestDb, questAdd, questChange, questCheck,
  questDelete, questKillOf, questLoad, questTime, questUpdateObjective, questUpdateStatus, solveTime, splitExactQuestTime,
  type LocalClock, type QuestDbRow, type QuestLog,
} from "./quest.ts";

const kill = (id: number) => questKillOf(MOB_BY_ID.get(id)!);
const PUDDLE = kill(1002), TUMHOG = kill(1063), LOAM = kill(1010);
const MAP = "f1_field01";
const T0 = 1_800_000_000; // a unix time (2027-01-15)

const ROWS: QuestDbRow[] = [
  { Id: 1, Title: "five blooms", Targets: [{ Mob: "Puddlebloom", Count: 5 }] },
  { Id: 2, Title: "two kinds", Targets: [{ Mob: "Puddlebloom", Count: 2 }, { Mob: "Tumhog", Count: 1 }] },
  { Id: 3, Title: "talk only" },
  { Id: 4, Title: "plants of the field", Targets: [{ Id: 1, Race: "Plant", Size: "Medium", MaxLevel: 5, Location: MAP, Count: 3 }] },
  { Id: 5, Title: "with drops", Targets: [{ Mob: "Puddlebloom", Count: 1 }], Drops: [{ Mob: "Puddlebloom", Item: "Gel Bead", Rate: 5000 }, { Item: "Clover", Count: 2, Rate: 10000 }] },
  { Id: 6, Title: "one hour", TimeLimit: "+1h", Targets: [{ Mob: "Puddlebloom", Count: 1 }] },
  { Id: 7, Title: "listed mobs", Targets: [{ Id: 1, MapMobTargets: { Tumhog: true, Loambloom: true }, Count: 9 }] },
];
const { db: DB, warnings } = parseQuestDb(ROWS, new Date(2027, 0, 15, 12));
const fresh = (): QuestLog => ({ entries: [], avail: 0 });

test("quest_db rows parse like QuestDatabase::parseBodyNode", () => {
  assert.deepEqual(warnings, []);
  assert.equal(DB.get(1)!.objectives[0].mobId, 1002);
  assert.equal(DB.get(1)!.objectives[0].count, 5);
  const f = DB.get(4)!.objectives[0];
  // MaxLevel without MinLevel -> min_level 1 ("if max_level is set, min_level is 1")
  assert.deepEqual([f.mobId, f.index, f.minLevel, f.maxLevel, f.race, f.size, f.element, f.map], [0, 1, 1, 5, "Plant", "Medium", "All", MAP]);
  // Drops: Count defaults to 1, Mob omitted = any monster (mob_id 0)
  assert.deepEqual(DB.get(5)!.drops, [{ mobId: 1002, itemId: 909, count: 1, rate: 5000 }, { mobId: 0, itemId: 705, count: 2, rate: 10000 }]);
  assert.deepEqual(DB.get(7)!.objectives[0].mobsAllowed, [1063, 1010]);
});

test("quest_db rows rAthena skips: >3 targets, no Count, unknown names, bad filters; MinLevel > MaxLevel -> MAX_LEVEL", () => {
  const { db, warnings: w } = parseQuestDb([
    { Id: 10, Title: "x", Targets: [1, 2, 3, 4].map(() => ({ Mob: "Puddlebloom", Count: 1 })) }, // a 4th Puddlebloom target
    { Id: 11, Title: "x", Targets: [{ Mob: "Puddlebloom" }] },
    { Id: 12, Title: "x", Targets: [{ Mob: "Nobody", Count: 1 }] },
    { Id: 13, Title: "x", Targets: [{ Id: 1, Race: "Player_Human", Count: 1 }] },
    { Id: 14, Title: "x", Targets: [{ Id: 1, MinLevel: 10, MaxLevel: 5, Count: 1 }] },
    { Id: 15, Title: "x", Drops: [{ Item: "Knife", Count: 3, Rate: 100 }, { Item: "No Such Thing", Rate: 1 }] },
    { Id: 16, Title: "x", Targets: [{ Id: 0, Count: 1 }] },
  ]);
  assert.equal(MAX_QUEST_OBJECTIVES, 3);
  assert.deepEqual([...db.keys()], [14, 15]);
  assert.equal(db.get(14)!.objectives[0].maxLevel, 275); // MAX_LEVEL (RENEWAL)
  assert.deepEqual(db.get(15)!.drops, [{ mobId: 0, itemId: 1201, count: 1, rate: 100 }]); // non-stackable capped to 1, unknown item skipped
  assert.equal(w.length, 8); // incl. the MinLevel > MaxLevel warning (row kept)
});

test("TimeLimit: '+' = solve_time seconds, otherwise split_exact_quest_time", () => {
  const at = new Date(2027, 0, 15, 12);
  assert.equal(solveTime("+1h", at), 3600);
  assert.equal(solveTime("+1d2h30mn", at), 86400 + 7200 + 1800);
  assert.equal(solveTime("+0d", at), 0); // atoi == 0 parts are skipped -> invalid limit
  assert.deepEqual(splitExactQuestTime("4h"), { week: -1, day: 0, hour: 4, minute: 0, second: 0 });
  assert.deepEqual(splitExactQuestTime("Monday 4h30mn"), { week: 1, day: 0, hour: 4, minute: 30, second: 0 });
  assert.equal(splitExactQuestTime("25h"), null); // hour 0..23 required
  assert.equal(splitExactQuestTime("4h60mn"), null);
  assert.equal(splitExactQuestTime("30mn"), null); // no hour
  const { db, warnings: w } = parseQuestDb([
    { Id: 1, Title: "daily", TimeLimit: "4h" }, { Id: 2, Title: "weekly", TimeLimit: "Monday 4h30mn" },
    { Id: 3, Title: "sunday", TimeLimit: "Sunday 4h" }, { Id: 4, Title: "days", TimeLimit: "2d 4h" }, { Id: 5, Title: "bad", TimeLimit: "+0d" },
  ], at);
  assert.deepEqual([...db.values()].map((q) => [q.time, q.timeAt, q.timeWeek]), [
    [14400, true, -1], [16200, true, 1], [14400, true, 0], [2 * 86400 + 14400, true, -1],
  ]);
  assert.equal(w.length, 1);
});

test("quest_time: relative from now; fixed reset rolls to tomorrow / the weekday", () => {
  assert.equal(questTime(DB.get(6), T0), T0 + 3600);
  assert.equal(questTime(DB.get(1), T0), 0); // no limit
  const clock = (hour: number, wday: number): LocalClock => () => ({ hour, minute: 0, second: 0, wday });
  const { db } = parseQuestDb([{ Id: 1, Title: "daily", TimeLimit: "4h" }, { Id: 2, Title: "weekly", TimeLimit: "Monday 4h" }]);
  // daily 04:00: at 03:00 -> today 04:00 (+1 h); at 05:00 -> tomorrow 04:00 (+23 h)
  assert.equal(questTime(db.get(1), T0, clock(3, 3)), T0 + 3600);
  assert.equal(questTime(db.get(1), T0, clock(5, 3)), T0 + 23 * 3600);
  // weekly Monday 04:00: Wednesday 10:00 -> shift 1, then 1 < 3+1 -> 1+7-3 = 5 days: next Monday 04:00
  assert.equal(questTime(db.get(2), T0, clock(10, 3)), T0 + 5 * 86400 + 14400 - 36000);
  assert.equal(questTime(db.get(2), T0, clock(3, 1)), T0 + 3600); // Monday 03:00 -> today
  assert.equal(questTime(db.get(2), T0, clock(5, 1)), T0 + 7 * 86400 + 14400 - 18000); // Monday 05:00 -> next Monday
});

test("quest_add / quest_update_status / quest_delete keep completed entries behind the available block", () => {
  const log = fresh();
  for (const id of [1, 2, 3]) assert.notEqual(questAdd(log, DB, id, T0), -1);
  assert.equal(questAdd(log, DB, 1, T0), -1); // already held
  assert.equal(questAdd(log, DB, 999, T0), -1); // not in the db
  assert.deepEqual(log.entries[0], { questId: 1, time: 0, count: [0, 0, 0], state: Q_ACTIVE });
  assert.equal(questUpdateStatus(log, 1, Q_COMPLETE), true); // swapped with the last available entry
  assert.deepEqual([log.entries.map((e) => e.questId), log.avail], [[3, 2, 1], 2]);
  assert.equal(questAdd(log, DB, 1, T0), -1); // a completed quest is still held
  assert.equal(questUpdateStatus(log, 1, Q_ACTIVE), false); // completed: not in the available block any more
  assert.notEqual(questAdd(log, DB, 4, T0), -1); // inserted at the end of the available block, before the completed one
  assert.deepEqual([log.entries.map((e) => e.questId), log.avail], [[3, 2, 4, 1], 3]);
  assert.equal(questDelete(log, 1), true); // completed: avail unchanged
  assert.equal(questDelete(log, 2), true);
  assert.deepEqual([log.entries.map((e) => e.questId), log.avail], [[3, 4], 2]);
  assert.equal(questDelete(log, 2), false);
});

test("quest_change replaces an available quest in place with fresh counters", () => {
  const log = fresh();
  questAdd(log, DB, 1, T0); questAdd(log, DB, 3, T0);
  log.entries[0].count[0] = 4;
  assert.equal(questChange(log, DB, 1, 3, T0), -1); // 3 already held
  assert.equal(questChange(log, DB, 2, 6, T0), -1); // 2 not held
  const e = questChange(log, DB, 1, 6, T0);
  assert.notEqual(e, -1);
  assert.deepEqual(log.entries[0], { questId: 6, time: T0 + 3600, count: [0, 0, 0], state: Q_ACTIVE });
  questUpdateStatus(log, 6, Q_COMPLETE);
  assert.equal(questChange(log, DB, 6, 1, T0), -1); // a completed quest can't be changed
});

test("quest_check HAVEQUEST / PLAYTIME / HUNTING and isbegin_quest, with rAthena's time-0 quirks", () => {
  const log = fresh();
  assert.deepEqual(["HAVEQUEST", "PLAYTIME", "HUNTING"].map((t) => questCheck(log, DB, 1, t as never, T0)), [-1, -1, -1]);
  questAdd(log, DB, 1, T0); questAdd(log, DB, 3, T0); questAdd(log, DB, 6, T0);
  assert.equal(questCheck(log, DB, 1, "HAVEQUEST", T0), Q_ACTIVE);
  questUpdateStatus(log, 1, Q_INACTIVE);
  assert.equal(questCheck(log, DB, 1, "HAVEQUEST", T0), 1); // Q_INACTIVE is reported as active
  // HUNTING, no limit (time 0 < now): not done -> 1 ("time limit reached"), done -> 2
  assert.equal(questCheck(log, DB, 1, "HUNTING", T0), 1);
  log.entries[0].count[0] = 5;
  assert.equal(questCheck(log, DB, 1, "HUNTING", T0), 2);
  assert.equal(questCheck(log, DB, 3, "HUNTING", T0), 2); // no objectives
  // a real limit: before it 0, after it 1
  assert.equal(questCheck(log, DB, 6, "HUNTING", T0), 0);
  assert.equal(questCheck(log, DB, 6, "HUNTING", T0 + 3601), 1);
  // PLAYTIME: time 0 always counts as expired (2); with a limit 0 before / 2 after; completed before the limit -> 1
  assert.equal(questCheck(log, DB, 1, "PLAYTIME", T0), 2);
  assert.equal(questCheck(log, DB, 6, "PLAYTIME", T0), 0);
  questUpdateStatus(log, 6, Q_COMPLETE);
  assert.equal(questCheck(log, DB, 6, "PLAYTIME", T0), 1);
  assert.equal(questCheck(log, DB, 6, "PLAYTIME", T0 + 3601), 2);
  assert.equal(questCheck(log, DB, 6, "HUNTING", T0), 0); // completed
  assert.equal(questCheck(log, DB, 6, "HAVEQUEST", T0), Q_COMPLETE);
  // isbegin_quest = i + (i < 1): 0 none, 1 held, 2 completed
  assert.deepEqual([99, 1, 3, 6].map((id) => isbeginQuest(log, DB, id, T0)), [0, 1, 1, 2]);
});

test("quest_update_objective: matching Mob targets count up to Count, in every available quest", () => {
  const log = fresh();
  questAdd(log, DB, 1, T0); questAdd(log, DB, 2, T0); questAdd(log, DB, 3, T0);
  for (let i = 0; i < 7; i++) questUpdateObjective(log, DB, PUDDLE, MAP);
  assert.deepEqual(log.entries.map((e) => e.count), [[5, 0, 0], [2, 0, 0], [0, 0, 0]]);
  const r = questUpdateObjective(log, DB, TUMHOG, MAP);
  assert.deepEqual(r.updated, [2]);
  assert.deepEqual(log.entries[1].count, [2, 1, 0]);
  assert.deepEqual(questUpdateObjective(log, DB, PUDDLE, MAP).updated, []); // all full
  // inactive quests still count (only Q_COMPLETE is skipped), completed ones don't
  const l2 = fresh();
  questAdd(l2, DB, 1, T0); questAdd(l2, DB, 6, T0);
  questUpdateStatus(l2, 1, Q_INACTIVE); questUpdateStatus(l2, 6, Q_COMPLETE);
  questUpdateObjective(l2, DB, PUDDLE, MAP);
  assert.deepEqual(l2.entries.map((e) => [e.questId, e.count[0]]), [[1, 1], [6, 0]]);
});

test("quest_update_objective: Id targets need all seven checks", () => {
  const log = fresh();
  questAdd(log, DB, 4, T0); // Plant, Medium, MaxLevel 5 (MinLevel 1), Location f1_field01
  questUpdateObjective(log, DB, PUDDLE, MAP); // Plant / Medium / Lv1: counts
  questUpdateObjective(log, DB, PUDDLE, "f1_field02"); // other map: no
  questUpdateObjective(log, DB, LOAM, MAP); // Lv8 > MaxLevel 5: no
  questUpdateObjective(log, DB, TUMHOG, MAP); // Brute / Small: no
  assert.deepEqual(log.entries[0].count, [1, 0, 0]);
  const l2 = fresh();
  questAdd(l2, DB, 7, T0); // MapMobTargets Tumhog + Loambloom only
  for (const k of [PUDDLE, TUMHOG, LOAM]) questUpdateObjective(l2, DB, k, MAP);
  assert.deepEqual(l2.entries[0].count, [2, 0, 0]);
});

test("quest-only Drops roll rnd_chance(Rate, 10000) while the quest is held, done or not", () => {
  const log = fresh();
  questAdd(log, DB, 5, T0);
  // rnd_value(1,10000) = 1 + floor(r * 10000): r 0.4999 -> 5000 <= 5000 drops, r 0.5 -> 5001 doesn't
  assert.deepEqual(questUpdateObjective(log, DB, PUDDLE, MAP, () => 0.4999).drops, [{ itemId: 909, count: 1, questId: 5 }, { itemId: 705, count: 2, questId: 5 }]);
  assert.deepEqual(questUpdateObjective(log, DB, PUDDLE, MAP, () => 0.5).drops, [{ itemId: 705, count: 2, questId: 5 }]); // objective already full, drops go on
  assert.deepEqual(questUpdateObjective(log, DB, TUMHOG, MAP, () => 0).drops, [{ itemId: 705, count: 2, questId: 5 }]); // Mob-less drop: any monster
  questUpdateStatus(log, 5, Q_COMPLETE);
  assert.deepEqual(questUpdateObjective(log, DB, PUDDLE, MAP, () => 0).drops, []);
});

test("intif_parse_questlog: unknown quests dropped, completed ones at the end in reverse order", () => {
  const row = (questId: number, state: 0 | 1 | 2) => ({ questId, state, time: 0, count: [1] });
  const log = questLoad([row(1, Q_COMPLETE), row(2, Q_ACTIVE), row(999, Q_ACTIVE), row(3, Q_COMPLETE), row(4, Q_INACTIVE)], DB);
  assert.deepEqual(log.entries.map((e) => e.questId), [2, 4, 3, 1]);
  assert.equal(log.avail, 2);
  assert.deepEqual(log.entries[0].count, [1, 0, 0]);
});
