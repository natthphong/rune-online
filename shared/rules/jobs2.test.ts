// 2.5.0: the 2nd jobs + transcendent line (db/re/job_stats.yml + job_aspd + job_exp + skill_tree.yml via tools/rathena/import.ts) and a
// few of their skills' formulas (shared/rules/skills2.ts, status_change.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOBS, type JobKey } from "./data.ts";
import { MAPID, firstJobOf, isSecondJob, isTrans, jobOfMapid, pcMaxHpSp, playerStatus } from "./status.ts";
import { SKILL_ID, SKILL_USE, normalizeJob, skillReady, skillRatio, treeRows, type Learned } from "./skill.ts";
import { blitzDamage, defend, doubleRate, pitcherHeal, resurrectPercent, masteryAtk2, ratio2, sanctuaryHeal, trapDamage, turnUndeadChance } from "./skills2.ts";
import { ScData, scApply, scAspdBonus, scStats, startSc } from "./status_change.ts";
import { outfitOf, outfitParts } from "../look.ts";

const SECOND = ["Knight", "Crusader", "Wizard", "Sage", "Hunter", "Bard", "Dancer", "Priest", "Monk", "Blacksmith", "Alchemist", "Assassin", "Rogue"] as JobKey[];
const TRANS2 = ["Lord_Knight", "Paladin", "High_Wizard", "Professor", "Sniper", "Clown", "Gypsy", "High_Priest", "Champion", "Whitesmith", "Creator", "Assassin_Cross", "Stalker"] as JobKey[];

test("jobs: 40 imported (7 + 13 second + 20 transcendent), our names, max job levels 50 / 70 / High Novice 10", () => {
  assert.equal(Object.keys(JOBS).length, 40);
  for (const j of SECOND) { assert.equal(JOBS[j].maxJobLevel, 50, j); assert.equal(JOBS[j].jobExp.length, 50, j); assert.equal(isSecondJob(j), true); assert.equal(isTrans(j), false); }
  for (const j of TRANS2) { assert.equal(JOBS[j].maxJobLevel, 70, j); assert.equal(JOBS[j].jobExp.length, 70, j); assert.equal(isTrans(j), true); }
  assert.equal(JOBS.Novice_High.maxJobLevel, 10);
  assert.equal(JOBS.Knight.name, "Lancer");
  assert.equal(JOBS.Lord_Knight.name, "Dragoon");
  for (const j of Object.keys(JOBS) as JobKey[]) assert.equal(JOBS[j].baseHp.length, 99, `${j} base HP per level`);
});

test("jobs: e_mapid ids, the first job of every line, Bard / Dancer share MAPID_BARDDANCER", () => {
  assert.equal(MAPID.Knight, 0x101); assert.equal(MAPID.Rogue, 0x206); assert.equal(MAPID.Lord_Knight, 0x100101); assert.equal(MAPID.Stalker, 0x100206);
  assert.equal(MAPID.Bard, MAPID.Dancer);
  assert.equal(jobOfMapid(0x203, true), "Dancer"); assert.equal(jobOfMapid(0x203, false), "Bard");
  for (const [j, f] of [["Knight", "Swordman"], ["Crusader", "Swordman"], ["Lord_Knight", "Swordman"], ["Gypsy", "Archer"], ["Creator", "Merchant"], ["Stalker", "Thief"]] as const) assert.equal(firstJobOf(j), f);
});

test("job_aspd: the 2nd-job weapon types are in the tables (Katar, Knuckle, Book, Musical, Whip)", () => {
  assert.equal(JOBS.Assassin.aspdBase.Katar, 42);
  assert.ok(JOBS.Monk.aspdBase.Knuckle > 0);
  assert.ok(JOBS.Sage.aspdBase.Book > 0);
  assert.ok(JOBS.Bard.aspdBase.Musical > 0);
  assert.ok(JOBS.Dancer.aspdBase.Whip > 0);
  assert.equal(JOBS.Lord_Knight.aspdBase["2hSpear"], JOBS.Knight.aspdBase["2hSpear"]);
});

test("status_calc_maxhp_pc: a transcendent job x1.25 after the VIT factor (JOBL_UPPER)", () => {
  assert.equal(Math.trunc(pcMaxHpSp(1000, 50, 0, 0, 100, true)), Math.trunc(1000 * 1.5 * 1.25));
  const s = { str: 50, agi: 50, vit: 50, int: 30, dex: 40, luk: 10 };
  const k = playerStatus({ job: "Knight", level: 99, jobLevel: 50, stats: s }), lk = playerStatus({ job: "Lord_Knight", level: 99, jobLevel: 50, stats: s });
  assert.ok(lk.maxHp > k.maxHp * 1.2, `${lk.maxHp} vs ${k.maxHp}`);
});

test("skill trees: 2nd jobs inherit their first job, trans jobs their 2nd job; normalize keeps the 1st tree until change_level_2nd - 1 points", () => {
  const ids = (j: JobKey) => new Set(treeRows(j).map((r) => r.id));
  assert.ok(ids("Knight").has(SKILL_ID.SM_BASH) && ids("Knight").has(SKILL_ID.KN_BOWLINGBASH));
  assert.ok(ids("Lord_Knight").has(SKILL_ID.KN_BOWLINGBASH) && ids("Lord_Knight").has(SKILL_ID.LK_SPIRALPIERCE));
  const basic: Learned = { [SKILL_ID.NV_BASIC]: 9 };
  const firstPts = (n: number): Learned => ({ ...basic, [SKILL_ID.SM_SWORD]: Math.min(10, n), [SKILL_ID.SM_TWOHAND]: Math.min(10, Math.max(0, n - 10)), [SKILL_ID.SM_BASH]: Math.max(0, n - 20) });
  assert.equal(normalizeJob("Knight", firstPts(30), undefined, 40), "Swordman"); // 30 < 39
  assert.equal(normalizeJob("Knight", firstPts(30)), "Swordman"); // unset: the 1st job's max job level (50) -> 49 needed
  assert.equal(normalizeJob("Knight", { ...firstPts(30), [SKILL_ID.SM_PROVOKE]: 9 }, undefined, 40), "Knight"); // 39 points past the Novice's
  assert.equal(normalizeJob("Knight", {}), "Novice");
});

test("skills2 ratios (Renewal skill classes): Bowling Bash, Sonic Blow under 50 % HP, Storm Gust, Vermilion, Spiral Pierce x base level", () => {
  assert.equal(skillRatio("KN_BOWLINGBASH", 10), 500); // 100 + 40 x lv
  assert.equal(ratio2("AS_SONICBLOW", 10), 1200);
  assert.equal(ratio2("AS_SONICBLOW", 10, { tgtHpHalf: true }), 1800);
  assert.equal(ratio2("WZ_STORMGUST", 10), 570); // 100 - 30 + 50 x lv
  assert.equal(ratio2("WZ_VERMILION", 10), 1400);
  assert.equal(ratio2("LK_SPIRALPIERCE", 5, { baseLv: 99 }), Math.trunc((150 + 250) * 99 / 100));
  assert.equal(ratio2("KN_BRANDISHSPEAR", 10, { str: 80 }), 400 + 1000 + 240);
  assert.equal(ratio2("MO_EXTREMITYFIST", 5, { sp: 300 }), 800 + 3000);
  assert.equal(ratio2("SM_BASH", 1), undefined); // not one of ours: skill.ts keeps its own
});

test("skills2 misc: traps, Blitz Beat, Turn Undead, Sanctuary; masteries", () => {
  assert.equal(trapDamage(5, { dex: 50, int: 35, baseLv: 100 }, () => 0.5), Math.trunc(5 * 50 * 4 * 2)); // rnd 10 - 10 = +0 %
  assert.equal(blitzDamage(5, 10, { agi: 41, dex: 55 }), 100 + 60 + 40 + 10);
  assert.equal(turnUndeadChance(10, { luk: 30, int: 50, baseLv: 80 }, 0, 100), 560);
  assert.equal(turnUndeadChance(10, { luk: 120, int: 120, baseLv: 99 }, 0, 100), 700); // capped
  assert.equal(sanctuaryHeal(5), 500); assert.equal(sanctuaryHeal(7), 777);
  assert.equal(masteryAtk2("1hSpear", (k) => (k === "KN_SPEARMASTERY" ? 10 : 0)), 40);
  assert.equal(masteryAtk2("Katar", (k) => (k === "AS_KATAR" ? 10 : k === "BS_WEAPONRESEARCH" ? 5 : 0)), 40);
});

test("2nd-job statuses: Two-Hand Quicken fixed ASPD +7 / crit / hit, Gloria LUK +30, Aspersio holy weapon, Overthrust ATK %", () => {
  const sc = new ScData();
  const tgt = { stats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 }, mdef: 0, mode: 0, race: "Player_Human", element: "Neutral", isPlayer: true, level: 50, sc } as const;
  const go = (type: Parameters<typeof startSc>[0]["type"], lv: number, val2?: number) => startSc({ type, tgt: tgt as never, srcLevel: 50, rate: 10000, val1: lv, val2, duration: 60000, now: 0, r: () => 0 });
  go("TwoHandQuicken", 10); go("Gloria", 5); go("Aspersio", 5); go("Overthrust", 5, 1);
  assert.equal(scAspdBonus(sc), 7);
  assert.equal(scStats(tgt.stats, sc).luk, 31);
  const st = playerStatus({ job: "Knight", level: 50, jobLevel: 10, stats: tgt.stats });
  const o = scApply(st, sc, true);
  assert.equal(o.rhw.ele, "Holy");
  assert.equal(o.cri, st.cri + 120);
  assert.equal(o.hit, st.hit + 20);
  assert.equal(o.atkPercent, 125);
  go("FireWeapon", 1); // the endows end each other
  assert.equal(sc.has("Aspersio"), false);
});

test("battle_calc_damage statuses: Kyrie absorbs weapon damage until its HP / hits end, Lex Aeterna doubles once, Guard blocks", () => {
  const k = { val2: 300, val3: 6 };
  assert.deepEqual(defend(200, true, { kyrie: k }, 99), { dmg: 0, blocked: false, ended: [] });
  assert.deepEqual(defend(200, true, { kyrie: k }, 99), { dmg: 100, blocked: false, ended: ["Kyrie"] }); // 100 HP left -> 100 gets through
  assert.deepEqual(defend(100, false, { aeterna: true }, 99), { dmg: 200, blocked: false, ended: ["Aeterna"] });
  assert.equal(defend(100, true, { guard: 30 }, 10).blocked, true);
  assert.equal(defend(100, false, { guard: 30 }, 10).blocked, false); // magic isn't guarded
  assert.equal(doubleRate(10), 70);
  assert.deepEqual([1, 2, 3, 4].map(resurrectPercent), [10, 30, 50, 80]); // resurrection.cpp
  assert.equal(pitcherHeal(50, 5, 0, 50, 0), Math.trunc(Math.trunc(50 * 150 / 100) * 200 / 100)); // aidpotion.cpp: 75 -> x (100 + VIT x 2)
});

test("skills in SKILL_USE are ready and in some job's tree; 2nd-job outfits are tinted 1st-job bodies (trans brighter)", () => {
  const inTree = new Set(Object.keys(JOBS).flatMap((j) => treeRows(j as JobKey).map((r) => r.id)));
  for (const key of Object.keys(SKILL_USE)) { assert.ok(SKILL_ID[key] !== undefined, key); assert.ok(skillReady(SKILL_ID[key]), key); assert.ok(inTree.has(SKILL_ID[key]), `${key} in a tree`); }
  assert.equal(outfitOf("Knight"), "swordman@210");
  assert.equal(outfitOf("Lord_Knight"), "swordman@210b");
  assert.equal(outfitOf("Wizard"), "novice@260");
  assert.deepEqual(outfitParts("swordman@210b"), { body: "swordman", hue: 210, bright: true });
  assert.deepEqual(outfitParts("novice"), { body: "novice", hue: 0, bright: false });
});
