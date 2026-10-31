// Golden values hand-computed from the rAthena Renewal source (see comments in status.ts / battle.ts / exp.ts).
//   cd ro && pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOBS, MOB_BY_ID, MOBS, type Stats } from "./data.ts";
import { FISTS, STARTER_WEAPON, aspdToDelay, statusDisplay, hpRegen, hpRegenBlockedByWalk, mobStatus, playerStatus, spRegen } from "./status.ts";
import { ATK, BATTLE_CONF, BF, BL, agiPenaltyFlee, attrFix, critDamage, defenseReduce, hitChance, mobAttack, playerAttack, sizeFix, vitPenaltyDef, weaponAtkRange, type Target } from "./battle.ts";
import { canRaise, planStatUp, gainExp, nextBaseExp, nextJobExp, displayedGain, MAX_LEVEL_BASE_EXP, MAX_LEVEL_JOB_EXP, statCost, statPointsAt, type Progress } from "./exp.ts";
import { capExpGain } from "./exp.ts";
import { MAPID_NOVICE, MAPID_SECONDMASK, isNoviceClass, ownerHp } from "./status.ts";

const ones: Stats = { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 };
const fixed = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };
const vsMob: Target = { type: BL.MOB, targeted: 1 };
const vsPc = (targeted = 1): Target => ({ type: BL.PC, targeted });
/** initialize_weapon_data flag of a melee normal attack (battle.cpp:5294-5319): BF_WEAPON | BF_NORMAL | BF_SHORT */
const MELEE = BF.WEAPON | BF.NORMAL | BF.SHORT;

test("fresh Novice Lv1 (all stats 1)", () => {
  const s = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  assert.equal(s.maxHp, 40); // 40 * 1.01
  assert.equal(s.maxSp, 11);
  assert.equal(s.batk, 1); // (10 + 2 + 3 + 2) / 10
  assert.equal(s.matkMin, 1);
  assert.equal(s.hit, 177); // 1 + 1 + 0 + 175
  assert.equal(s.flee, 102); // 1 + 1 + 0 + 100
  assert.equal(s.flee2, 11);
  assert.equal(s.cri, 13); // 10 + 1*3 + 0
  assert.equal(s.def2, 1); // floor((1+1)/2 + 1/5)
  assert.equal(s.mdef2, 1); // floor(1 + 0.25 + 0.4)
  assert.equal(s.aspd, 141); // trunc(196.209) - Novice Dagger penalty 55 (starter knife)
  assert.equal(s.attackDelayMs, 1180); // 2 * (2000 - 1410)
});

test("Novice job bonus applies by job level", () => {
  const s = playerStatus({ job: "Novice", level: 1, jobLevel: 10, stats: ones });
  assert.deepEqual(s.bonus, { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 }); // job_stats.yml Novice Lv2..9
});

test("stat-heavy Lv10 Novice", () => {
  const s = playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats: { str: 20, agi: 15, vit: 10, int: 1, dex: 15, luk: 5 } });
  assert.equal(s.maxHp, Math.floor(85 * 1.1)); // 93
  assert.equal(s.batk, 27); // (200 + 30 + 16 + 25) / 10
});

test("ASPD conversion: (200 - aspd) * 20 ms", () => {
  assert.equal(aspdToDelay(156), 880);
  assert.equal(aspdToDelay(190), 200);
});

test("monster status from mob_db (id 1002, renamed)", () => {
  const m = mobStatus(MOB_BY_ID.get(1002)!);
  assert.equal(m.batk, 7); // str 6 + level 1
  assert.deepEqual([m.atkMin, m.atkMax], [0, 1]); // atk 1 * 80% / 120%
  assert.equal(m.hit, 157);
  assert.equal(m.flee, 102);
  assert.equal(m.def2, 1);
});

test("element table: water vs fire L1 = 150%, neutral vs ghost L1 = 90%", () => {
  assert.equal(attrFix(100, "Water", "Fire", 1), 150);
  assert.equal(attrFix(100, "Neutral", "Ghost", 1), 90);
  // Renewal rounding (battle.cpp:708-712): reductions round the damage down by trunc, increases add trunc
  assert.equal(attrFix(7, "Neutral", "Ghost", 1), 7); // 7 - trunc(0.7)
  assert.equal(attrFix(101, "Water", "Water", 1), 26); // 101 - trunc(75.75)
  assert.equal(attrFix(33, "Fire", "Water", 1), 30); // 33 - trunc(3.3)
  assert.equal(attrFix(13, "Earth", "Fire", 1), 12);
  assert.equal(attrFix(7, "Fire", "Earth", 1), 10); // 7 + trunc(3.5)
  assert.equal(attrFix(9, "Water", "Fire", 1), 13); // 9 + trunc(4.5)
  assert.equal(attrFix(5, "Neutral", "Ghost", 4), 0); // ratio 0 stays 0
});

test("renewal DEF reduction", () => {
  const def = { ...mobStatus(MOB_BY_ID.get(1002)!) }; // def 2, def2 1
  assert.equal(defenseReduce(100, def), Math.trunc((100 * 4002) / 4020) - 1); // 98
});

test("hit chance clamps to [5, 100]", () => {
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  const m = mobStatus(MOB_BY_ID.get(1002)!);
  assert.equal(hitChance(p, m), 75); // 177 - 102
  assert.equal(hitChance(m, p), 55); // 157 - 102
});

test("player normal attack: no crit, hits, fixed rolls", () => {
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  const m = mobStatus(MOB_BY_ID.get(1002)!); // Water 1, Medium, def 2 / def2 1, luk 5
  // battle_calc_base_weapon_attack: variance 5*17*1/100 = 0.85, STR bonus 17*1/200 = 0.085
  // -> [trunc(17 - 0.85 + 0.085), trunc(17 + 0.85 + 0.085)] = [16, 17] inclusive
  assert.deepEqual(weaponAtkRange(p, STARTER_WEAPON), [16, 17]);
  // rolls: crit 999 (cri 13 - 5*2 = 3: no), hit 0 (75%: hits), weapon rnd_value(16,17) with 0.5 -> 16 + 1 = 17
  // battle_calc_sizefix: Knife = Dagger vs Medium 75 (db/size_fix.yml base row; db/re/size_fix.yml only overrides
  // Knuckle/Whip Large) -> trunc(17*75/100) = 12. statusAtk 1*2 = 2 (Neutral vs Water 100%); total 14
  // DEF: trunc(14*4002/4020) = 13 - 1 = 12
  assert.deepEqual(playerAttack(p, STARTER_WEAPON, m, vsMob, fixed(0.999, 0, 0.5)), { dmg: 12, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  // weapon roll 0 -> 16 -> trunc(16*75/100) = 12: same 12 after DEF
  assert.deepEqual(playerAttack(p, STARTER_WEAPON, m, vsMob, fixed(0.999, 0, 0)), { dmg: 12, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
});

test("player crit: top of weapon range, x1.4 after DEF", () => {
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  const m = mobStatus(MOB_BY_ID.get(1002)!);
  // crit roll 0 < 3; weapon = max 17 -> size fix Dagger/Medium 75 -> 12; 2 + 12 = 14 -> DEF 12
  // -> floor((float)(12 * 1.4f)) = floor(16.7999992..) = 16
  assert.deepEqual(playerAttack(p, STARTER_WEAPON, m, vsMob, fixed(0)), { dmg: 16, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
});

test("Swordman Lv30 STR40 Falchion vs 1167: STR bonus and inclusive range", () => {
  const falchion = weaponOf(ITEMS.get(1104)); // atk 39, wlv 1, 1hSword
  const p = playerStatus({ job: "Swordman", level: 30, jobLevel: 1, stats: { ...ones, str: 40, dex: 20 }, weapon: falchion });
  assert.equal(p.batk, 51); // (400 + 40 + 3 + 75) / 10
  // variance 5*39/100 = 1.95, bonus 39*40/200 = 7.8 -> [trunc(44.85), trunc(48.75)] = [44, 48]
  assert.deepEqual(weaponAtkRange(p, falchion), [44, 48]);
  const m = mobStatus(MOB_BY_ID.get(1167)!); // Earth 1, Small, def 22, def2 floor((14+9)/2) = 11, luk 18
  // cri 16 - 36 < 0: never crits; hit 225 - 122 -> 100%. statusAtk 51*2 = 102. Size fix 1hSword vs Small 75 (db/size_fix.yml).
  // min: 44 -> trunc(44*75/100) = 33; 102 + 33 = 135 -> trunc(135*4022/4220) = 128 - 11 = 117
  // max: 48 -> 36; 138 -> trunc(138*4022/4220) = 131 - 11 = 120
  assert.equal(playerAttack(p, falchion, m, vsMob, fixed(0.999, 0, 0)).dmg, 117);
  assert.equal(playerAttack(p, falchion, m, vsMob, fixed(0.999, 0, 0.999)).dmg, 120); // 44 + floor(0.999*5) = 48
  // crit (target LUK 0 so cri 16 > 0): max 48 -> 36 -> 138 -> 120 -> floor((float)(120 * 1.4f)) = floor(168.0f) = 168
  const m0 = { ...m, stats: { ...m.stats, luk: 0 } };
  assert.deepEqual(playerAttack(p, falchion, m0, vsMob, fixed(0)), { dmg: 168, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
});

test("size_fix: Renewal = db/size_fix.yml base rows + db/re/size_fix.yml overlay (per field)", () => {
  // SizeFixDatabase::parseBodyNode (status.cpp:521-578) keeps the base values of sizes an overlay row doesn't name.
  const row = (w: string) => [sizeFix(w, "Small"), sizeFix(w, "Medium"), sizeFix(w, "Large")];
  assert.deepEqual(row("Dagger"), [100, 75, 50]); // base only
  assert.deepEqual(row("1hSword"), [75, 100, 75]);
  assert.deepEqual(row("2hSword"), [75, 75, 100]);
  assert.deepEqual(row("1hSpear"), [75, 75, 100]);
  assert.deepEqual(row("1hAxe"), [50, 75, 100]);
  assert.deepEqual(row("2hAxe"), [50, 75, 100]);
  assert.deepEqual(row("Mace"), [75, 100, 100]);
  assert.deepEqual(row("Bow"), [100, 100, 75]);
  assert.deepEqual(row("Musical"), [75, 100, 75]);
  assert.deepEqual(row("Book"), [100, 100, 50]);
  assert.deepEqual(row("Katar"), [75, 100, 75]);
  assert.deepEqual(row("Staff"), [100, 100, 100]);
  assert.deepEqual(row("Whip"), [75, 100, 75]); // base Small 75 + Renewal Large 75
  assert.deepEqual(row("Knuckle"), [100, 100, 75]); // Renewal-only row: unnamed sizes default to 100
  assert.deepEqual(row("Fist"), [100, 100, 100]);
});

test("bow weapon ATK bonus uses DEX", () => {
  const bow = weaponOf(ITEMS.get(1702)); // atk 15, wlv 1, Bow
  const p = playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats: { ...ones, dex: 30 }, weapon: bow });
  assert.equal(p.batk, 33); // ranged: str<->dex swap -> (300 + 2 + 3 + 25) / 10
  // variance 0.75, DEX bonus 15*30/200 = 2.25 -> [trunc(16.5), trunc(18)] = [16, 18]
  assert.deepEqual(weaponAtkRange(p, bow), [16, 18]);
  const m = mobStatus(MOB_BY_ID.get(1002)!);
  // statusAtk 66; 66 + 18 = 84 -> trunc(84*4002/4020) = 83 - 1 = 82 (cri 14 - 10 = 4: roll 999 no crit)
  assert.equal(playerAttack(p, bow, m, vsMob, fixed(0.999, 0, 0.999)).dmg, 82);
});

test("bare hands: no variance, crit after DEF", () => {
  const p = playerStatus({ job: "Novice", level: 5, jobLevel: 1, stats: { ...ones, str: 5, dex: 5 } });
  assert.deepEqual(weaponAtkRange(p, FISTS), [0, 0]);
  const m = mobStatus(MOB_BY_ID.get(1063)!); // Neutral 3, def 18, def2 3, luk 5
  // batk (50 + 10 + 3 + 12) / 10 = 7 -> statusAtk 14; DEF trunc(14*4018/4180) = 13 - 3 = 10; crit floor((float)(10 * 1.4f)) = 14
  // (x1.4 before DEF, as before this fix, gives 19 -> 18 - 3 = 15)
  assert.deepEqual(playerAttack(p, FISTS, m, vsMob, fixed(0)), { dmg: 14, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  assert.equal(critDamage(10), 14);
  assert.equal(critDamage(17), 23);
});

test("lucky dodge is rolled before crit (PvP)", () => {
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: { ...ones, luk: 50 }, weapon: STARTER_WEAPON });
  const t = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  assert.equal(playerAttack(p, STARTER_WEAPON, t, vsPc(), fixed(0)).lucky, true); // roll 0 < flee2 11, crit never rolled
});

test("monster attack + perfect dodge", () => {
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  const m = mobStatus(MOB_BY_ID.get(1002)!);
  assert.equal(mobAttack(m, p, vsPc(), fixed(0)).lucky, true); // roll 0 < flee2 11
  // no lucky (999), hit (0), weapon roll -> atkMin 0, + batk 7 (not doubled for monsters) = 7; DEF 0 hard, soft 1 -> 6
  assert.deepEqual(mobAttack(m, p, vsPc(), fixed(0.999, 0, 0)), { dmg: 6, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  // attack_attr_none: monster normal attacks ignore the armor element (Neutral vs Ghost 1 would be 90% -> 5)
  const ghost = { ...p, element: "Ghost" as const };
  assert.deepEqual(mobAttack(m, ghost, vsPc(), fixed(0.999, 0, 0)), { dmg: 6, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
});

test("agi_penalty: FLEE drops 10% per attacker from the 3rd (is_attack_hitting)", () => {
  // battle.conf defaults: type 1 (percent), target BL_PC, count 3, num 10; k = n - (3 - 1)
  assert.equal(agiPenaltyFlee(102, vsPc(2)), 102); // below agi_penalty_count
  assert.equal(agiPenaltyFlee(102, vsPc(3)), 91); // trunc(102 * 90 / 100) = trunc(91.8)
  assert.equal(agiPenaltyFlee(102, vsPc(4)), 81); // trunc(102 * 80 / 100) = trunc(81.6)
  assert.equal(agiPenaltyFlee(102, vsPc(12)), 1); // 102 * 0 / 100 = 0 -> min 1
  assert.equal(agiPenaltyFlee(102, vsPc(13)), 1); // trunc(102 * -10 / 100) = -10 -> min 1
  assert.equal(agiPenaltyFlee(102, { type: BL.MOB, targeted: 5 }), 102); // agi_penalty_target 1: players only
  assert.equal(agiPenaltyFlee(102, vsPc(4), { ...BATTLE_CONF, agi_penalty_type: 2 }), 82); // type 2: 102 - 2 * 10
  assert.equal(agiPenaltyFlee(102, vsPc(4), { ...BATTLE_CONF, agi_penalty_type: 0 }), 102); // disabled

  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON }); // flee 102, flee2 11
  const m = mobStatus(MOB_BY_ID.get(1002)!); // hit 157
  assert.equal(hitChance(m, p, vsPc(1)), 55); // 157 - 102
  assert.equal(hitChance(m, p, vsPc(3)), 66); // 157 - 91
  assert.equal(hitChance(m, p, vsPc(4)), 76); // 157 - 81
  // rolls: lucky 999 (no), hit rnd(100) with 0.6 -> 60: misses at 55%, connects at 76%; then dmg 7 - def2 1 = 6
  assert.deepEqual(mobAttack(m, p, vsPc(1), fixed(0.999, 0.6, 0)), { dmg: 0, crit: false, miss: true, lucky: false, dmgLv: ATK.FLEE, flag: MELEE });
  assert.deepEqual(mobAttack(m, p, vsPc(4), fixed(0.999, 0.6, 0)), { dmg: 6, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
});

test("vit_penalty: DEF and soft DEF drop 5% per attacker from the 3rd, count capped at 22 (battle_calc_defense_reduction)", () => {
  // k = min(n, 100 / 5 + 2 = 22) - 2; def1/def2 * (100 - 5k) / 100; def2 >= 1 for BL_PC regardless of n
  assert.deepEqual(vitPenaltyDef(45, 30, vsPc(2)), [45, 30]);
  assert.deepEqual(vitPenaltyDef(45, 30, vsPc(3)), [42, 28]); // trunc(42.75), trunc(28.5)
  assert.deepEqual(vitPenaltyDef(45, 30, vsPc(22)), [0, 1]); // 100 - 5 * 20 = 0 -> def2 floored to 1
  assert.deepEqual(vitPenaltyDef(45, 30, vsPc(30)), [0, 1]); // capped at 22 (uncapped would be trunc(45 * -40 / 100) = -18)
  assert.deepEqual(vitPenaltyDef(45, 0, vsPc(0)), [45, 1]); // def2 floor applies to players even with no attackers
  assert.deepEqual(vitPenaltyDef(45, 0, { type: BL.MOB, targeted: 6 }), [45, 0]); // vit_penalty_target 1: players only
  assert.deepEqual(vitPenaltyDef(45, 30, vsPc(4), { ...BATTLE_CONF, vit_penalty_type: 2 }), [35, 20]); // type 2: -2 * 5

  const p = playerStatus({ job: "Swordman", level: 30, jobLevel: 1, stats: { ...ones, agi: 20, vit: 30 }, equip: { def: 45 } });
  assert.equal(p.def, 45);
  assert.equal(p.def2, 34); // floor((30 + 30) / 2 + 20 / 5)
  assert.equal(defenseReduce(200, p, vsPc(1)), 147); // trunc(200 * 4045 / 4450) = 181 - 34
  assert.equal(defenseReduce(200, p, vsPc(6)), 158); // k 4: def1 36, def2 27 -> trunc(200 * 4036 / 4360) = 185 - 27
  assert.equal(defenseReduce(200, p, vsPc(22)), 199); // def1 0, def2 1 -> 200 - 1
  assert.equal(defenseReduce(200, { ...p, def2: 0 }, { type: BL.MOB, targeted: 9 }), 181); // monsters: no penalty, no floor
});

test("stat point costs (RENEWAL_STAT)", () => {
  assert.equal(statCost(1), 2);
  assert.equal(statCost(10), 2);
  assert.equal(statCost(11), 3);
  assert.equal(statCost(99), 11);
  assert.equal(canRaise("Novice", "str", 99, 999), false);
  assert.equal(canRaise("Swordman", "luk", 98, 11), true);
  assert.equal(canRaise("Swordman", "luk", 98, 10), false);
  assert.equal(JOBS.Mage.maxStats.int, 99); // max_parameter default (player.conf:114)
  assert.equal(statPointsAt(1), 48);
});

import { needStatusPoint } from "./exp.ts";
test("needStatusPoint: the Status window's cost beside a stat (pc_need_status_point(sd, type, 1))", () => {
  // RENEWAL_STAT PC_STATUS_POINT_COST(low) = low < 100 ? 2 + (low - 1) / 10 : ... (pc.cpp:8800)
  assert.equal(needStatusPoint("Novice", "str", 1), 2); // 2 + 0 / 10
  assert.equal(needStatusPoint("Novice", "dex", 20), 3); // 2 + 19 / 10
  assert.equal(needStatusPoint("Novice", "luk", 98), 11); // 2 + 97 / 10
  assert.equal(needStatusPoint("Novice", "luk", 99), 0); // at pc_maxparameter (99): "Official servers show '0' when max is reached"
  assert.equal(needStatusPoint("Swordman", "vit", 120), 0); // above the cap still 0 (low >= max)
});

test("EXP: Novice Lv1 needs 548 base EXP; level-up grants stat points", () => {
  const p: Progress = { job: "Novice", level: 1, exp: 0, jobLevel: 1, jobExp: 0, statPoints: 0, skillPoints: 0 };
  const r = gainExp(p, 600, 30);
  assert.deepEqual(r, { baseUps: 1, jobUps: 1 }); // multi_level_up: no -> job 30-10=20 capped to 18-1... see below
  assert.equal(p.level, 2);
  assert.equal(p.exp, 52);
  assert.equal(p.statPoints, statPointsAt(2) - statPointsAt(1)); // 3
  assert.equal(p.jobLevel, 2);
  assert.equal(p.jobExp, 9); // job lv1 needs 10: remainder 20 capped to 10-1 (pc.cpp:8329-8331), 9 < 18
});

test("EXP: multi_level_up off caps overflow; on lets it carry; max level keeps EXP", () => {
  const mk = (): Progress => ({ job: "Novice", level: 1, exp: 0, jobLevel: 1, jobExp: 0, statPoints: 0, skillPoints: 0 });
  const a = mk();
  gainExp(a, 3000, 0); // lv1 needs 548: 2452 -> capped 547
  assert.equal(a.level, 2);
  assert.equal(a.exp, 547);
  const b = mk();
  gainExp(b, 3000, 0, { multi_level_up: true, multi_level_up_base: 0, multi_level_up_job: 0 });
  assert.ok(b.level > 2);
  const c = mk();
  c.jobLevel = 10; // Novice max job level
  gainExp(c, 0, 40);
  assert.equal(c.jobExp, 40);
});

test("regen", () => {
  const s = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  assert.equal(hpRegen(s), 1);
  assert.equal(spRegen(s), 1);
  // status_natural_heal 15526-15530: walking blocks HP regen unless regen->state.walk (SC_GT_REVITALIZE)
  assert.equal(hpRegenBlockedByWalk(true), true);
  assert.equal(hpRegenBlockedByWalk(false), false);
  assert.equal(hpRegenBlockedByWalk(true, true), false);
});

import { ITEMS, STARTER_KIT, equipBlock, maxWeight, itemHealAmount, rollHeal, slotsOf, weaponOf } from "./items.ts";

test("items: starter kit, slots, equip rules", () => {
  assert.deepEqual(STARTER_KIT.map((k) => k.id).sort(), [1201, 2301, 569].sort());
  assert.deepEqual(slotsOf(ITEMS.get(1201)!), ["weapon"]);
  assert.deepEqual(slotsOf(ITEMS.get(2101)!), ["shield"]);
  assert.equal(equipBlock(ITEMS.get(1201)!, "Novice", 1), null); // Novice can use a Knife
  assert.match(equipBlock(ITEMS.get(2403)!, "Novice", 1) ?? "", /can't use/); // Shoes: not for Novice (item_db Jobs)
  assert.equal(equipBlock(ITEMS.get(1101)!, "Novice", 1), "requires base level 2"); // Sword: EquipLevelMin 2
  assert.deepEqual(weaponOf(ITEMS.get(1201)), STARTER_WEAPON);
});

test("weight: job base + STR*300 (0.1 units)", () => {
  assert.equal(maxWeight("Novice", 1), 20300);
});

test("healing rolls within range", () => { // drop rolls: drops.test.ts
  const h = rollHeal(ITEMS.get(501)!, () => 0)!;
  assert.deepEqual(h, { hp: 45, sp: 0 });
});

test("pc_itemheal stat bonus", () => {
  assert.equal(itemHealAmount(45, 20), 63); // 45*140/100
  assert.equal(itemHealAmount(65, 20), 91);
  assert.equal(itemHealAmount(66, 1), 67); // 66*102/100 = 67.32
  assert.equal(itemHealAmount(0, 50), 0);
  assert.equal(itemHealAmount(10, 0, 10), 11); // +10% skill hook
});

test("armor DEF feeds hard DEF", () => {
  const s = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, equip: { def: 10 } });
  assert.equal(s.def, 10);
});

import { applyExpPenalty, applyRate, levelPenaltyMod, penaltyLoadingFinished, MAX_LEVEL } from "./penalty.ts";

// level_penalty.yml + PenaltyDatabase::loadingFinished + pc_level_penalty_mod (diff = mob level - player base level)
test("level penalty: Exp table incl. filled gaps", () => {
  const exp = (mobLv: number, pcLv: number) => levelPenaltyMod("Exp", { baseLevel: pcLv }, { level: mobLv });
  const cases: [number, number][] = [ // [difference, rate]
    [100, 40], [16, 40], [15, 115], [13, 125], [10, 140], [4, 110], [3, 105], [2, 100], [0, 100], [-5, 100],
    [-6, 95], [-10, 95], [-11, 90], [-19, 85], [-21, 60], [-30, 35], [-31, 10], [-274, 10],
  ];
  for (const [d, r] of cases) assert.equal(exp(275 + d, 275), r, `diff ${d}`);
});

test("level penalty: Drop table incl. filled gaps", () => {
  const drop = (d: number) => levelPenaltyMod("Drop", { baseLevel: 200 }, { level: 200 + d });
  const cases: [number, number][] = [[20, 50], [16, 50], [14, 60], [13, 60], [9, 80], [7, 80], [4, 90], [3, 100], [0, 100],
    [-3, 100], [-4, 90], [-6, 90], [-7, 80], [-9, 80], [-10, 70], [-13, 60], [-16, 50], [-19, 50], [-70, 50]];
  for (const [d, r] of cases) assert.equal(drop(d), r, `diff ${d}`);
});

test("level penalty: exemptions and loadingFinished seeding", () => {
  assert.equal(levelPenaltyMod("Exp", undefined, { level: 50 }), 100); // no player attached
  assert.equal(levelPenaltyMod("MvpExp", { baseLevel: 1 }, { level: 50 }), 100); // no MvpExp table in level_penalty.yml
  assert.equal(levelPenaltyMod("Drop", { baseLevel: 1 }, { level: 50, fixedItemDrop: true }), 100); // MD_FIXEDITEMDROP
  assert.equal(levelPenaltyMod("Exp", { baseLevel: 1 }, { level: 50, fixedItemDrop: true }), 40); // only drops are exempt
  assert.equal(levelPenaltyMod("Exp", { baseLevel: 1 }, { level: 50 }, { noRenewalExpPenalty: true }), 100);
  assert.equal(levelPenaltyMod("Drop", { baseLevel: 1 }, { level: 50 }, { noRenewalExpPenalty: true }), 50);
  // gaps above 0 start at 100; diff 0 (filled first) seeds the downward walk
  const t = penaltyLoadingFinished([[2, 50], [0, 70], [-3, 20]]);
  const at = (d: number) => t[d + MAX_LEVEL - 1];
  assert.deepEqual([at(5), at(2), at(1), at(0), at(-1), at(-2), at(-3), at(-200)], [50, 50, 70, 70, 70, 70, 20, 20]);
  assert.deepEqual([penaltyLoadingFinished([[2, 50]])[MAX_LEVEL], penaltyLoadingFinished([[2, 50]])[MAX_LEVEL - 5]], [100, 100]);
});

test("mob_dead RENEWAL_EXP: penalised kill EXP (apply_rate, floor 1)", () => {
  const kill = (mobId: number, pcLv: number) => {
    const m = MOB_BY_ID.get(mobId)!;
    const r = applyExpPenalty(m.baseExp, m.jobExp, levelPenaltyMod("Exp", { baseLevel: pcLv }, m));
    return [r.base, r.job];
  };
  const id = (name: string) => MOBS.find((m) => m.name === name)!.id;
  assert.deepEqual(kill(id("Mosspaw"), 1), [215, 131]); // lv14 - 1 = 13 -> 125%: 172*125/100, 105*125/100
  assert.deepEqual(kill(id("Mistfin"), 10), [170, 105]); // lv13 - 10 = 3 -> 105%
  assert.deepEqual(kill(id("Puddlebloom"), 10), [142, 38]); // -9 -> 95%
  assert.deepEqual(kill(id("Puddlebloom"), 30), [52, 14]); // -29 -> 35%
  assert.deepEqual(kill(id("Puddlebloom"), 50), [15, 4]); // -49 -> 10%
  assert.deepEqual(kill(id("Cinderpaw"), 10), [154, 80]); // lv9 - 10 = -1 -> 100%: untouched (real Picky row, not the event META_PICKY with 2/1 exp)
  assert.deepEqual(kill(id("Cinderpaw"), 40), [15, 8]); // -31 -> 10%
  assert.deepEqual(kill(id("Loambloom"), 8), [160, 75]); // diff 0 -> untouched
  assert.deepEqual(applyExpPenalty(0, 7, 10), { base: 0, job: 1 }); // a zero share stays zero
  assert.equal(applyRate(123456, 125), 154250); // > 100000: (val / 100) * rate
  assert.equal(applyRate(9000, 80), 7200); // drop rate 90% -> 72% (Loambloom vs Lv1)
});

test("shield adds the job Shield ASPD penalty; unknown weapon type costs 200 (status_base_amotion_pc)", () => {
  const base = { job: "Novice" as const, level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON };
  assert.equal(playerStatus(base).aspd, 141);
  assert.equal(playerStatus({ ...base, shield: true }).aspd, 131); // 141 - Novice Shield 10 (job_aspd.yml)
  assert.equal(playerStatus({ ...base, weapon: { ...STARTER_WEAPON, type: "NoSuchType" } }).aspd, -4); // trunc(196.209) - 200
});

import { DEATH_CONF as DEATH, deathPenalty, restartBase, restartValues } from "./death.ts";

// status_calc_pc RESPAWN HP/SP + pc_setrestartvalue(3) with restart_hp_rate 0 / restart_sp_rate 0
test("respawn HP/SP: Novice half, others 2 HP, SP never lowered", () => {
  assert.deepEqual(restartBase("Novice", 40, 11), { hp: 20, sp: 1 }); // 40/2; sp 0 -> min 1
  assert.deepEqual(restartValues("Novice", 40, 11, 11), { hp: 21, sp: 11 }); // 1 + 20 via status_heal; SP kept
  assert.deepEqual(restartValues("Swordman", 500, 50, 3), { hp: 2, sp: 3 }); // hp 0 -> 1, +1
  assert.deepEqual(restartValues("Swordman", 500, 50, 0), { hp: 2, sp: 1 }); // SP raised to the minimum 1
  assert.deepEqual(restartValues("Novice", 40, 11, 0, { ...DEATH, restart_hp_rate: 60 }), { hp: 25, sp: 1 }); // 40*60/100 +1
});
// pc_dead penalty: type 1 = trunc(next * 100/10000.) capped at current, Novice exempt, none at max level
test("death EXP penalty", () => {
  // Swordman Lv20 (exp 1000) JobLv10 (jobExp 500): trunc(nextBase*0.01)=91, trunc(nextJob*0.01)=22 (regression: MapRoom once spread a schema -> 0/0)
  assert.deepEqual(deathPenalty({ job: "Swordman", level: 20, exp: 1000, jobLevel: 10, jobExp: 500 }), { base: 91, job: 22 });
  const sw = { job: "Swordman" as const, level: 10, exp: 300, jobLevel: 5, jobExp: 100 };
  assert.deepEqual(deathPenalty(sw), { base: 53, job: 7 }); // 5337 -> 53, 780 -> 7
  assert.deepEqual(deathPenalty({ ...sw, exp: 20, jobExp: 3 }), { base: 20, job: 3 }); // capped at current EXP
  assert.deepEqual(deathPenalty({ ...sw, job: "Novice" as const, level: 1, jobLevel: 1 }), { base: 0, job: 0 });
  assert.deepEqual(deathPenalty({ ...sw, level: 99 }), { base: 0, job: 7 }); // max base level: no base loss
});

import { damageDelay, delayedDamageReach, pcAmotion, pcDmotion, walkDelay } from "./battle.ts";
import { distance, distanceClient } from "../map.ts";

test("normal attack damage lands amotion after the swing (battle_delay_damage, delay_battle_damage: yes)", () => {
  // Novice agi1/dex1 + Knife: ASPD 141 -> amotion 2000 - 1410 = 590 (adelay 1180)
  assert.equal(pcAmotion(141), 590);
  assert.equal(damageDelay(pcAmotion(141), BL.PC), 590);
  assert.equal(damageDelay(1200, BL.PC), 1200); // players are never capped
  assert.equal(damageDelay(MOB_BY_ID.get(1002)!.attackMotion, BL.MOB), 672); // AttackMotion 672 < 1000
  assert.equal(damageDelay(MOB_BY_ID.get(1049)!.attackMotion, BL.MOB), 288);
  assert.equal(damageDelay(1500, BL.MOB), 1000); // Aegis cap for non-players
  assert.equal(damageDelay(1500, BL.MOB, false, 900, { ...BATTLE_CONF, synchronize_damage: true }), 900);
  assert.equal(damageDelay(590, BL.PC, false, 590, { ...BATTLE_CONF, delay_battle_damage: false }), 1); // 1 = no timer
  assert.equal(delayedDamageReach(1), 15); // distance_bl + AREA_SIZE 14
  assert.equal(delayedDamageReach(1, { ...BATTLE_CONF, snap_dodge: true }), 11);
});

test("dmotion and hit walk delay (status_calc_bl_ dmotion, battle_calc_walkdelay)", () => {
  assert.equal(pcDmotion(1), 796); // 800 - 4
  assert.equal(pcDmotion(150), 400); // capped low
  assert.equal(MOB_BY_ID.get(1002)!.damageMotion, 480);
  assert.equal(walkDelay(480, BL.MOB, 5), 480); // damage_walk_delay_rate 100
  assert.equal(walkDelay(796, BL.PC, 5), 159); // pc_damage_walk_delay_rate 20: 796 * 20 / 100
  assert.equal(walkDelay(480, BL.MOB, 0), 0); // no damage, no delay
  assert.equal(walkDelay(480, BL.MOB, 5, 0), 0); // div 0
  assert.equal(walkDelay(480, BL.MOB, 5, 3), 880); // + multihit_delay 200 * 2
  assert.equal(walkDelay(480, BL.MOB, 5, 12), 680); // >10 hits count as 2
  assert.equal(walkDelay(2, BL.PC, 5), 1); // 2 * 20 / 100 = 0 -> 1 (stop without noticeable delay)
});

test("cell distances (path.cpp distance / distance_client)", () => {
  assert.equal(distance(2, -1), 2);
  assert.equal(distanceClient(1, 1), 1); // 1.414 - 0.1
  assert.equal(distanceClient(2, 0), 1); // 1.9: a straight line reads one cell shorter
  assert.equal(distanceClient(2, 1), 2); // 2.136
  assert.equal(distanceClient(2, 2), 2); // 2.728
  assert.equal(distanceClient(3, 0), 2);
  assert.equal(distanceClient(0, 0), 0);
});

// ---------- worn equipment -> status (status_calc_pc_sub equipment loop + pc_bonus + SCB_MATK), hand-computed ----------
import { EQI, eqiOf, gearOf, type GearItem } from "./items.ts";
import { isSupportedBonus, isSupportedBonus2, noBonus, pcBonus, type ItemBonus } from "./bonus.ts";
import { aspdBase, pcCalcAmotion } from "./status.ts";

/** An rAthena item_db_equip.yml row as status sees it (only formula inputs; ids cite the source row). loc = its Locations, which
 *  set the equip_index position its script runs at (a Both_Accessory row: the accessory position it was equipped to). */
const raItem =(type: string, o: { subType?: string; atk?: number; matk?: number; def?: number; wlv?: number; alv?: number; loc?: string[] }, bonuses: ItemBonus[]): GearItem =>
  ({ type, subType: o.subType ?? null, atk: o.atk ?? 0, matk: o.matk ?? 0, def: o.def ?? 0, weaponLevel: o.wlv ?? 0, armorLevel: o.alv ?? 0,
    refineable: true, element: "Neutral", locations: o.loc ?? [], bonuses });
/** Worn +0 stacks. */
const plain = (...items: GearItem[]) => gearOf(items.map((item) => ({ item, refine: 0 })));
const worn = (...ids: number[]) => plain(...ids.map((id) => ITEMS.get(id)!));
/** An imported item (ATK, DEF, Locations as in items.json) given a test script instead of its own. */
const withScript = (id: number, ...bonuses: ItemBonus[]): GearItem => ({ ...ITEMS.get(id)!, bonuses });

test("importer: Ribbon's `bonus bMdef,3;` is data; every imported bonus is one pc_bonus / pc_bonus2 models", () => {
  assert.deepEqual(ITEMS.get(2208)!.bonuses, [{ type: "bMdef", value: 3 }]);
  for (const it of ITEMS.values()) for (const b of it.bonuses as ItemBonus[])
    assert.ok(b.type2 === undefined ? isSupportedBonus(b.type) : isSupportedBonus2(b.type), `${it.id} ${b.type}`);
});

test("weapon MATK: Novice Lv12/J10 INT30 DEX20 + Rod (MATK 30, wlv 1) + Ribbon (bMdef 3)", () => {
  const s = playerStatus({ job: "Novice", level: 12, jobLevel: 10, stats: { str: 1, agi: 1, vit: 10, int: 30, dex: 20, luk: 1 }, ...worn(1601, 2208) });
  // job bonus +1 each -> INT 31, DEX 21, LUK 2. status_base_matk: 31 + 15 + 4 + 0 + 12/4 = 53
  // SCB_MATK RENEWAL: wMatk 30, variance 30 * 1 / 10 = 3 -> 53 + 30 - 3 = 80, 53 + 30 + 3 = 86
  assert.deepEqual([s.matkMin, s.matkMax, s.matkStatus, s.matkEquip], [80, 86, 53, 30]);
  assert.deepEqual([s.def, s.mdef], [1, 3]); // Ribbon DEF 1 (Rod 0); MDEF from its script
  assert.equal(s.mdef2, 40); // floor(31 + 12/4 + (21 + 11) / 5) = floor(40.4)
});

test("shield = an armor in the left hand only (pc_equipitem); a two-handed Bow is not one", () => {
  assert.equal(worn(1702).shield, false); // Bow: Both_Hand weapon
  assert.equal(worn(1201, 2101).shield, true); // Knife + Guard
  // Archer Lv40/J30 AGI50 DEX70 + Bow: AGI 51, DEX 74 -> sqrt(74*74/7 + 51*51*0.5) = sqrt(2082.79) = 45.64 * 0.25 + 196
  // = 207.41 -> 207 - Bow 50 = 157 (with the wrong Shield column: 148); amotion 430 -> adelay 860
  const s = playerStatus({ job: "Archer", level: 40, jobLevel: 30, stats: { str: 10, agi: 50, vit: 10, int: 1, dex: 70, luk: 10 }, ...worn(1702) });
  assert.deepEqual([s.aspd, s.attackDelayMs], [157, 860]);
});

test("equipment scripts in rAthena order: stats, MaxHP/SP, misc stacking, MATK, ASPD (Mage Lv50/J40)", () => {
  const gear = plain(
    raItem("Weapon", { subType: "Staff", atk: 120, matk: 150, wlv: 4, loc: ["Right_Hand"] }, [{ type: "bAspdRate", value: 10 }]), // 1668
    raItem("Armor", { def: 58, loc: ["Armor"] }, [{ type: "bVit", value: 2 }, { type: "bMaxHPrate", value: 10 }]), // 2354
    raItem("Armor", { loc: ["Both_Accessory"] }, [{ type: "bInt", value: 1 }, { type: "bDex", value: 1 }, { type: "bMatk", value: 5 }]), // 2788
    raItem("Armor", { def: 5, loc: ["Head_Low"] }, [{ type: "bAspd", value: 1 }, { type: "bMaxHP", value: 200 }]), // 15967
    // 2390 is body armor like 2354: worn together only to stack their (additive) scripts, both run at EQI_ARMOR
    raItem("Armor", { def: 38, loc: ["Armor"] }, [{ type: "bMdef", value: 2 }, { type: "bFlee2", value: 3 }]), // 2390
  );
  assert.equal(gear.shield, false);
  const s = playerStatus({ job: "Mage", level: 50, jobLevel: 40, stats: { str: 1, agi: 30, vit: 20, int: 80, dex: 40, luk: 10 }, ...gear });
  // job bonus J40 (0,3,0,5,3,1) + equipment (VIT 2, INT 1, DEX 1)
  assert.deepEqual(s.stats, { str: 1, agi: 33, vit: 22, int: 86, dex: 44, luk: 11 });
  assert.deepEqual(s.bonus, { str: 0, agi: 3, vit: 2, int: 6, dex: 4, luk: 1 }); // Status window "+n" = battle_status - status
  // status_calc_maxhp_pc: 670 * 1.22 = 817.4, + equip VIT 2, + bMaxHP 200 = 1019.4, + 10% = 1121.34 -> 1121
  assert.equal(s.maxHp, 1121);
  assert.equal(s.maxSp, 577); // 310 * 1.86 = 576.6, + equip INT 1 = 577.6 -> 577
  assert.equal(s.hit, 272); // 50 + 44 + 11/3 + 175
  assert.equal(s.flee, 185); // 50 + 33 + 11/5 + 100
  assert.equal(s.flee2, 51); // bFlee2 3 -> 30, + 11 + 10
  assert.equal(s.cri, 48); // 50/10 + 10 + 11*3
  assert.deepEqual([s.def, s.def2, s.mdef, s.mdef2], [101, 42, 2, 111]); // 58 + 5 + 38; floor(36 + 6.6); bMdef; floor(86 + 12.5 + 13.2)
  // StatusMATK 86 + 43 + 8 + 3 + 12 = 152; weapon 150 -/+ 150*4/10 = 60; + bMatk 5 -> 247 ~ 367
  assert.deepEqual([s.matkMin, s.matkMax, s.matkStatus, s.matkEquip], [247, 367, 152, 155]);
  assert.deepEqual([s.batk, s.watk], [25, 120]); // (10 + 88 + 36 + 125) / 10
  // base ASPD: sqrt(44*44/5 + 33*33*0.5) = sqrt(931.7) = 30.52 * 0.25 + 196 = 203.63 -> 203 - Staff 55 = 148
  // bAspdRate 10: 148 + (195 - 148) * 10 / 100 = 148 + 4 = 152 -> amotion 480; bAspd 1: aspd_add -10 -> 470
  assert.deepEqual([s.aspd, s.attackDelayMs], [153, 940]);
});

test("rate bonuses apply after status_calc_misc (Thief Lv30/J20 + rAthena 1237 dagger + 2390)", () => {
  const dagger = raItem("Weapon", { subType: "Dagger", atk: 180, wlv: 4, loc: ["Right_Hand"] },
    [{ type: "bFlee", value: 10 }, { type: "bFlee2", value: 5 }, { type: "bDefRate", value: -50 }, { type: "bDef2Rate", value: -50 }]);
  const gear = plain(dagger, raItem("Armor", { def: 38, loc: ["Armor"] }, [{ type: "bMdef", value: 2 }, { type: "bFlee2", value: 3 }]));
  const s = playerStatus({ job: "Thief", level: 30, jobLevel: 20, stats: { str: 30, agi: 50, vit: 10, int: 1, dex: 30, luk: 10 }, ...gear });
  // STR 31 AGI 51 VIT 11 LUK 10. def 38 * 50 / 100 = 19; def2 floor(20.5 + 10.2) = 30 * 50 / 100 = 15
  assert.deepEqual([s.def, s.def2, s.mdef], [19, 15, 2]);
  assert.equal(s.flee, 193); // bFlee 10 + 30 + 51 + 2 + 100
  assert.equal(s.flee2, 100); // (5 + 3) * 10 + 10 + 10
  // battle_calc_base_weapon_attack: variance 5*180*4/100 = 36, STR bonus 180*31/200 = 27.9 -> [171, 243]
  assert.deepEqual(weaponAtkRange(s, gear.weapon), [171, 243]);
});

test("equipment ATK, ATK rate and MATK rate (Novice Lv1 + Knife + rAthena 2887 + 2644) vs 1002", () => {
  // both rings are Both_Accessory: pc_equipitem puts the first one in EQI_ACC_R, the second in EQI_ACC_L
  const gear = plain(ITEMS.get(1201)!, raItem("Armor", { loc: ["Right_Accessory"] }, [{ type: "bBaseAtk", value: 10 }, { type: "bMatk", value: 20 }]),
    raItem("Armor", { loc: ["Left_Accessory"] }, [{ type: "bAtkRate", value: 5 }, { type: "bMatkRate", value: 5 }]));
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...gear });
  assert.deepEqual([p.eatk, p.atkRate], [10, 5]);
  assert.deepEqual([p.matkMin, p.matkMax], [22, 22]); // (1 + bMatk 20) * 105 / 100 = 22.05
  const m = mobStatus(MOB_BY_ID.get(1002)!); // Water 1, def 2, def2 1
  // statusAtk 2; weapon roll 0.5 of [16, 17] -> 17 -> size fix Dagger/Medium 75 -> 12 (equip ATK is not size-fixed:
  // battle_calc_damage_parts adds it after battle_calc_base_weapon_attack); equipAtk 10 (Neutral vs Water 100%);
  // percentAtk (12 + 10) * 5 / 100 = 1. 25 -> trunc(25 * 4002 / 4020) = 24 - 1 = 23
  assert.deepEqual(playerAttack(p, gear.weapon, m, vsMob, fixed(0.999, 0, 0.5)), { dmg: 23, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
});

test("pc_bonus: bAtk feeds rhw.atk (variance too); elements; unknown bonuses change nothing", () => {
  const b = noBonus();
  assert.equal(pcBonus(b, "bAtk", 20), true);
  assert.equal(pcBonus(b, "bAtkEle", "Fire"), true);
  assert.equal(pcBonus(b, "bDefEle", "Ghost"), true);
  assert.equal(pcBonus(b, "bDefEle", "Lava"), false); // PC_BONUS_CHK_ELEMENT
  assert.equal(pcBonus(b, "bCastrate", -10), false); // not modelled: stays out
  assert.equal(pcBonus(b, "toString", 1), false); // only the table's own rows
  assert.deepEqual(b, { ...noBonus(), rhw: { ...noBonus().rhw, atk: 20, ele: "Fire" }, defEle: "Ghost" }); // nothing else moved
  // through the equipment loop: Knife (ATK 17) whose own script is bAtk 20 + bAtkEle Fire, and a body armor with bDefEle Ghost
  const g = plain(withScript(1201, { type: "bAtk", value: 20 }, { type: "bAtkEle", value: "Fire" }),
    raItem("Armor", { loc: ["Armor"] }, [{ type: "bDefEle", value: "Ghost" }]));
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...g });
  assert.deepEqual([p.watk, p.rhw.atk, p.rhw.ele, p.element], [37, 37, "Fire", "Ghost"]);
  // variance 5*37*1/100 = 1.85, STR bonus 37/200 = 0.185 -> [trunc(35.335), trunc(39.035)] = [35, 39]
  assert.deepEqual(weaponAtkRange(p, g.weapon), [35, 39]);
});

// status_calc_pc_sub "Parse equipment" (status.cpp:3904-4058): pieces in equip_index order, the weapon's ATK / refine added to rhw
// before its script, lr_flag SHIELD for the armor in EQI_HAND_L; pc_bonus SP_ATK1 / SP_ATK2 (pc.cpp:3752-3771) cap the running
// rhw value at [0, USHRT_MAX] under LR_FLAG_NONE only; SP_ATKELE / SP_DEFELE (3879, 3907) overwrite.
const swStats: Stats = { str: 30, agi: 20, vit: 20, int: 10, dex: 25, luk: 10 }; // Swordman Lv30/J20: job bonus STR +2 VIT +2 DEX +1

test("a weapon's own bAtk / bAtk2 move its running rhw value (ATK and refine included): negatives subtract, floor 0", () => {
  const sw = (item: GearItem, refine: number) => {
    const g = gearOf([{ item, refine }]);
    return { g, s: playerStatus({ job: "Swordman", level: 30, jobLevel: 20, stats: swStats, ...g }) };
  };
  // Cutter (ATK 30, wlv 1) +17: refine.yml Weapon / Level 1 / Level 17 Bonus 5100 -> rhw.atk2 51, then its bAtk2 -3 -> 48;
  // watk = 30 + 48 = 78 (a bonus kept apart and floored at 0 would give 81)
  const { s: cutter } = sw(withScript(1204, { type: "bAtk2", value: -3 }), 17);
  assert.deepEqual([cutter.rhw.atk, cutter.rhw.atk2, cutter.watk], [30, 48, 78]);
  // bAtk2 -60 can't go below what the refine gave: cap(51 - 60, 0) = 0 -> watk 30
  const { s: overdrawn } = sw(withScript(1204, { type: "bAtk2", value: -60 }), 17);
  assert.deepEqual([overdrawn.rhw.atk2, overdrawn.watk], [0, 30]);
  // Falchion (ATK 39) with bAtk -5 -> rhw.atk 34
  const { g, s: falchion } = sw(withScript(1104, { type: "bAtk", value: -5 }), 0);
  assert.deepEqual([falchion.rhw.atk, falchion.watk], [34, 34]);
  // battle_calc_base_weapon_attack takes that wa->atk: STR 32, variance 5*34*1/100 = 1.7, bonus 34*32/200 = 5.44
  // -> [trunc(34 - 1.7 + 5.44), trunc(34 + 1.7 + 5.44)] = [trunc(37.74), trunc(41.14)] = [37, 41]
  assert.deepEqual(weaponAtkRange(falchion, g.weapon), [37, 41]);
  // Knife (ATK 17) with bAtk -20: cap(17 - 20, 0) = 0, not -3
  const { s: floored } = sw(withScript(1201, { type: "bAtk", value: -20 }), 0);
  assert.deepEqual([floored.rhw.atk, floored.watk], [0, 0]);
});

test("a shield's script runs with LR_FLAG_SHIELD: its bAtk / bAtk2 write nothing, its other bonuses apply", () => {
  // Knife + Guard (DEF 20, Left_Hand -> EQI_HAND_L) whose script is bAtk 10, bAtk2 5, bMdef 1, bAtkEle Fire
  const guard = withScript(2101, { type: "bAtk", value: 10 }, { type: "bAtk2", value: 5 }, { type: "bMdef", value: 1 }, { type: "bAtkEle", value: "Fire" });
  const g = gearOf([{ item: ITEMS.get(1201)!, refine: 0 }, { item: guard, refine: 0 }]);
  const s = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...g });
  assert.equal(g.shield, true);
  assert.deepEqual([s.rhw.atk, s.rhw.atk2, s.watk], [17, 0, 17]); // the Knife alone (a summed bonus would say 17 + 10, 5)
  // SP_MDEF1 applies under LR_FLAG_SHIELD; SP_ATKELE's lr_flag switch sends LR_FLAG_SHIELD to the default branch: rhw.ele = Fire
  assert.deepEqual([s.def, s.mdef, s.rhw.ele], [20, 1, "Fire"]);
  const b = noBonus();
  assert.equal(pcBonus(b, "bAtk2", 5, "shield"), true); // a modelled case that writes nothing under this flag
  assert.deepEqual(b, noBonus());
});

test("last-wins bAtkEle / bDefEle follow equip_index order, not inventory order (pc_is_same_equip_index for multi-slot items)", () => {
  /** The equipment state for these items in either inventory order (both must agree). */
  const either = (...items: GearItem[]) => {
    const a = plain(...items).equip;
    assert.deepEqual(plain(...items.reverse()).equip, a);
    return a;
  };
  // Sword (Right_Hand: EQI_HAND_R 9) runs after Hat (Head_Top: EQI_HEAD_TOP 6), so its Water stays
  assert.equal(either(withScript(1101, { type: "bAtkEle", value: "Water" }), withScript(2220, { type: "bAtkEle", value: "Fire" })).rhw.ele, "Water");
  // rAthena 2344 (body armor, DEF 25, bDefEle Fire: EQI_ARMOR 7) vs Shoes (EQI_SHOES 2) Wind, then a Guard (EQI_HAND_L 8) Water
  const armor = raItem("Armor", { def: 25, loc: ["Armor"] }, [{ type: "bDefEle", value: "Fire" }]);
  const shoes = withScript(2403, { type: "bDefEle", value: "Wind" });
  assert.deepEqual([either(armor, shoes).defEle, either(armor, shoes).def], ["Fire", 35]);
  assert.equal(either(armor, shoes, withScript(2101, { type: "bDefEle", value: "Water" })).defEle, "Water");
  // a headgear in several positions runs once, at the first the loop reaches: Top+Low (row 5053's Locations) at EQI_HEAD_LOW 4,
  // before a Head_Mid piece (5); Top+Mid (row 5022's) at EQI_HEAD_MID 5, after a Head_Low piece (4)
  const topLow = raItem("Armor", { def: 5, loc: ["Head_Low", "Head_Top"] }, [{ type: "bDefEle", value: "Fire" }]);
  const topMid = raItem("Armor", { def: 4, loc: ["Head_Mid", "Head_Top"] }, [{ type: "bDefEle", value: "Fire" }]);
  assert.equal(either(topLow, raItem("Armor", { loc: ["Head_Mid"] }, [{ type: "bDefEle", value: "Water" }])).defEle, "Water");
  assert.equal(either(topMid, raItem("Armor", { loc: ["Head_Low"] }, [{ type: "bDefEle", value: "Water" }])).defEle, "Fire");
  // a two-hander (Bow, Both_Hand) runs at EQI_HAND_L; an item with no position is never worn
  assert.deepEqual([eqiOf(topLow), eqiOf(topMid), eqiOf(ITEMS.get(1702)!), eqiOf(raItem("Armor", {}, []))], [EQI.HEAD_LOW, EQI.HEAD_MID, EQI.HAND_L, Infinity]);
  assert.deepEqual(plain(raItem("Armor", { def: 9 }, [{ type: "bDef", value: 1 }])).equip, noBonus());
});

test("an armor piece's bAtk lands on rhw before the right-hand weapon adds its ATK (EQI_HAND_R is the last position)", () => {
  const nov = (...items: GearItem[]) => playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...plain(...items) });
  const hat = (atk: number) => withScript(2220, { type: "bAtk", value: atk });
  const knife = (atk: number) => withScript(1201, ...(atk ? [{ type: "bAtk", value: atk }] : []));
  assert.equal(nov(knife(0), hat(10)).watk, 27); // Hat first: rhw.atk 0 + 10; Knife: + 17
  assert.equal(nov(knife(0), hat(-5)).watk, 17); // Hat: cap(0 - 5, 0) = 0; Knife: + 17 — a negative bAtk before the weapon is lost
  assert.equal(nov(hat(10), knife(-5)).watk, 22); // 0 + 10, + 17, then the Knife's own -5
  assert.equal(nov(hat(-5), knife(3)).watk, 20); // cap(-5) = 0, + 17, + 3
  // bare hands: rhw.atk 10 from the Hat, and battle_calc_base_weapon_attack adds no variance without a right-hand weapon
  const bare = nov(hat(10));
  assert.deepEqual([bare.watk, ...weaponAtkRange(bare, FISTS)], [10, 10, 10]);
});

test("ASPD: a job without a Shield column pays the default 200 (job_db fills BaseASPD, pc.cpp:13945-13959)", () => {
  const base = { job: "Novice" as const, level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON, shield: true };
  const table: Record<string, number> = JOBS.Novice.aspdBase, shieldColumn = table.Shield;
  delete table.Shield;
  try {
    assert.equal(aspdBase("Novice", "Shield"), 200);
    assert.equal(playerStatus(base).aspd, -4); // trunc(196.209) - min(Dagger 55 + 200, 200)
  } finally {
    table.Shield = shieldColumn;
  }
  assert.equal(playerStatus(base).aspd, 131); // with the column: 196 - (55 + 10)
});

test("ASPD cap: amotion within [max_aspd 190 -> 100, MIN_ASPD/2 = 4000]", () => {
  assert.equal(pcCalcAmotion(185, 0, -200), 100); // 2000 - 1850 - 200 = -50 -> 100 (ASPD 190)
  assert.equal(pcCalcAmotion(150, -10, 0), 540); // C int division truncates toward 0: 150 + (45 * -10) / 100 = 150 - 4 = 146 -> 540
});

test("planStatUp: pc_statusup amount clamped by points and cap", () => {
  // vit 1 +5 with 48 points: costs 2*5 = 10 -> vit 6, 38 left
  assert.deepEqual(planStatUp("Novice", "vit", 1, 48, 5), { amount: 5, cost: 10 });
  // 2 points left, ask +10: partial +1
  assert.deepEqual(planStatUp("Novice", "luk", 1, 2, 10), { amount: 1, cost: 2 });
  assert.deepEqual(planStatUp("Novice", "luk", 1, 1, 1), { amount: 0, cost: 0 });
  // 9 -> 12 crosses the cost step: 2 + 2 + 3 = 7 (value 9: 2, 10: 2, 11: 3)
  assert.deepEqual(planStatUp("Novice", "str", 9, 100, 3), { amount: 3, cost: 7 });
  // cap 99: only 1 step left
  assert.equal(planStatUp("Novice", "str", 98, 999, 5).amount, 1);
  assert.equal(planStatUp("Novice", "str", 99, 999, 1).amount, 0);
  assert.equal(planStatUp("Novice", "str", 1, 99, 0).amount, 0);
  assert.equal(planStatUp("Novice", "str", 1, 99, NaN).amount, 0);
});

// ---------- refine -> status (refine.yml + status_calc_pc_sub equipment loop + SCB_MATK + battle_add_weapon_damage) ----------
import { refineInfo, MAX_REFINE } from "./refine.ts";
const refined = (...w: [number, number][]) => gearOf(w.map(([id, refine]) => ({ item: ITEMS.get(id)!, refine })));

test("refine.yml (Renewal) lookup: findCurrentLevelInfo = row refine-1 (0-based), none at +0, capped at MAX_REFINE", () => {
  const knife = ITEMS.get(1201)!; // Weapon, WeaponLevel 1
  assert.equal(MAX_REFINE, 20);
  assert.equal(refineInfo(knife, 0), null);
  assert.deepEqual(refineInfo(knife, 7), { bonus: 1400, randomBonus: 0 }); // Weapon / Level 1 / Level 7
  assert.deepEqual(refineInfo(knife, 10), { bonus: 2000, randomBonus: 900 });
  assert.deepEqual(refineInfo(knife, 25), { bonus: 6000, randomBonus: 3900 }); // sanitized to +20
  assert.deepEqual(refineInfo(raItem("Weapon", { wlv: 3 }, []), 6), { bonus: 3000, randomBonus: 800 }); // Weapon / Level 3 / Level 6
  assert.deepEqual(refineInfo(ITEMS.get(2301)!, 7), { bonus: 1000, randomBonus: 0 }); // Armor / Level 1 / Level 7
  assert.equal(refineInfo(ITEMS.get(2262)!, 5), null); // Refineable: false -> flag.no_refine
});

test("refined Knife on Novice Lv1 (all 1): ATK2, Renewal weapon MATK, overrefine (+0 / +4 / +7 / +10)", () => {
  const at = (refine: number) => playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...refined([1201, refine]) });
  // status.cpp:3957 atk2 += Bonus/100; 3977 matk += Bonus/100 (not a bow); 3986 overrefine = RandomBonus/100.
  // SCB_MATK: StatusMATK 1; variance = rhw.matk * wlv / 10; overrefine: min + 1, max + (overrefine - 1)
  const row = (s: ReturnType<typeof at>) => [s.watk, s.rhw.atk, s.rhw.atk2, s.rhw.matk, s.overrefine, s.matkMin, s.matkMax, s.matkEquip];
  assert.deepEqual(row(at(0)), [17, 17, 0, 0, 0, 1, 1, 0]);
  assert.deepEqual(row(at(4)), [25, 17, 8, 8, 0, 9, 9, 8]); // Bonus 800; variance 8/10 = 0
  assert.deepEqual(row(at(7)), [31, 17, 14, 14, 0, 14, 16, 14]); // Bonus 1400; variance 1 -> 1 + 14 -/+ 1
  assert.deepEqual(row(at(10)), [37, 17, 20, 20, 9, 20, 31, 20]); // Bonus 2000, RandomBonus 900; 1 + 20 - 2 + 1, 1 + 20 + 2 + 8
  // battle_calc_base_weapon_attack: variance/stat bonus use wa->atk 17 only: 5*17/100 = 0.85, 17*1/200 = 0.085 -> [36, 37]
  const p = at(10);
  assert.deepEqual(weaponAtkRange(p, refined([1201, 10]).weapon), [36, 37]);
  // vs 1002 (Water 1, def 2, def2 1): no crit (999), hit (0), roll 0.5 of [36, 37] -> 37, overrefine rnd()%9 + 1 = 4 + 1 -> 42;
  // size fix Dagger/Medium 75 -> 31; + statusAtk 1*2 = 33 -> trunc(33 * 4002 / 4020) = 32 - 1 = 31
  const m = mobStatus(MOB_BY_ID.get(1002)!);
  assert.deepEqual(playerAttack(p, refined([1201, 10]).weapon, m, vsMob, fixed(0.999, 0, 0.5, 0.5)), { dmg: 31, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  // +7 has no RandomBonus, so no extra draw: watk 31 -> [30, 31], roll 0.5 -> 31 * 75 / 100 = 23 + 2 = 25
  // -> trunc(25 * 4002 / 4020) = 24 - 1 = 23
  assert.equal(playerAttack(at(7), refined([1201, 7]).weapon, m, vsMob, fixed(0.999, 0, 0.5, 0.999)).dmg, 23);
});

test("refined Bow: ATK2 but no refine MATK (sd->weapontype1 == W_BOW)", () => {
  const g = refined([1702, 7]);
  assert.deepEqual([g.weapon.atk2, g.weapon.matk, g.weapon.overrefine], [14, 0, 0]);
});

test("refined armor: refinedef summed over every armor piece, def += (refinedef + 50) / 100 (status.cpp:4014, 4096)", () => {
  const s = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...refined([2301, 7]) });
  assert.equal(s.def, 20); // Cotton Shirt DEF 10 + (1000 + 50) / 100
  assert.equal(playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...refined([2301, 0]) }).def, 10);
  // pooled, not per piece: two ArmorLevel 2 pieces at +2 (Bonus 240 each): (480 + 50) / 100 = 5 (per piece it would be 2 + 2)
  const alv2 = raItem("Armor", { alv: 2, loc: ["Armor"] }, []);
  assert.equal(gearOf([{ item: alv2, refine: 2 }, { item: { ...alv2, locations: ["Garment"] }, refine: 2 }]).equip.def, 5);
  assert.equal(refined([2262, 5]).equip.def, 0); // not refineable: no refine DEF
  assert.equal(refined([1201, 7]).equip.def, 0); // a weapon's refine never reaches DEF
});

test("statusDisplay: Status window halves in clif order (pc.hpp:1239-1253 RENEWAL), Mage Lv40/Job30 critic probe", () => {
  // ATK 41 + 33, MATK 85 + 48, DEF soft 38 + hard 17, MDEF soft 65 + hard 3, CRI cri/10 = trunc(56/10) = 5
  const d = statusDisplay({ batk: 41, watk: 33, eatk: 0, matkStatus: 85, matkEquip: 48, def: 17, def2: 38, mdef: 3, mdef2: 65, hit: 250, flee: 150, flee2: 23, cri: 56, aspd: 150 });
  assert.deepEqual([d.atk, d.matk, d.def, d.mdef, d.cri, d.flee], [[41, 33], [85, 48], [38, 17], [65, 3], 5, [150, 2]]);
  // bBaseAtk (eatk) belongs to the right side of ATK
  assert.deepEqual(statusDisplay({ batk: 10, watk: 20, eatk: 7, matkStatus: 0, matkEquip: 0, def: 0, def2: 0, mdef: 0, mdef2: 0, hit: 1, flee: 1, flee2: 0, cri: 0, aspd: 150 }).atk, [10, 27]);
});

import { statusDetail } from "./status.ts";
test("statusDetail: the Status window's Details ledger in player units (SP_ATTACKRANGE / SP_FLEE2 / SP_CRITICAL / SP_SPEED, adelay)", () => {
  // fresh Novice Lv1, all stats 1, Knife: flee2 = 0 + luk 1 + 10 = 11 -> 1.1 %, cri = 0 + 10 + luk 1 * 3 = 13 -> 1.3 %,
  // ASPD 141 -> amotion 590 -> adelay 2 * 590 = 1180 ms, walk 150 ms per cell, Knife Range 1, no armor element
  const d = statusDetail(playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON }));
  assert.deepEqual([d.range, d.perfectDodge, d.crit, d.attackDelay, d.element, d.elementLevel], [1, 1.1, 1.3, 1.18, "Neutral", 1]);
  assert.ok(Math.abs(d.walkSpeed - 1000 / 150) < 1e-9 && d.walkSpeed.toFixed(1) === "6.7"); // 150 ms per cell = 6.67 cells / s
  // Luk 30 at Lv10, bare hands: flee2 = 30 + 10 = 40 -> 4 %, cri = trunc(10 / 10) + 10 + 30 * 3 = 101 -> 10.1 %, and
  // an attack range below 1 (bare hands) is 1 (status.cpp:4216)
  const b = statusDetail(playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats: { ...ones, luk: 30 } }));
  assert.deepEqual([b.range, b.perfectDodge, b.crit], [1, 4, 10.1]);
  // a Bow (item_db Range 5) and a worn bDefEle armor
  const a = statusDetail(playerStatus({ job: "Archer", level: 1, jobLevel: 1, stats: ones, weapon: { ...STARTER_WEAPON, type: "Bow", range: 5 }, equip: { defEle: "Fire" } }));
  assert.deepEqual([a.range, a.element, a.elementLevel], [5, "Fire", 1]);
});

test("exp: next EXP at max level is MAX_LEVEL_*_EXP and capped gain displays 0 (pc_nextbaseexp / pc_gainexp flag&4,&8)", () => {
  assert.equal(nextJobExp("Novice", 9), JOBS.Novice.jobExp[8]); assert.equal(JOBS.Novice.jobExp[8], 340); // below max: table row
  assert.equal(nextJobExp("Novice", 10), MAX_LEVEL_JOB_EXP);
  assert.equal(nextBaseExp("Novice", 99), MAX_LEVEL_BASE_EXP);
  assert.equal(nextBaseExp("Novice", 98), JOBS.Novice.baseExp[97]);
  // Novice job 10 (max), base 50: +5000 job EXP stores 5000 but displays 0; base part still shown
  const p: Progress = { job: "Novice", level: 50, exp: 0, jobLevel: 10, jobExp: 0, statPoints: 0, skillPoints: 0 };
  assert.deepEqual(displayedGain(p, 100, 5000), { base: 100, job: 0 });
  gainExp(p, 100, 5000);
  assert.equal(p.jobExp, 5000);
  assert.ok(p.jobExp / nextJobExp("Novice", p.jobLevel) < 1);
  // both maxed
  assert.deepEqual(displayedGain({ job: "Novice", level: 99, jobLevel: 10 }, 7, 9), { base: 0, job: 0 });
});

test("status_calc_bl_main floors: CRI / FLEE2 min 10 when non-zero, HIT / FLEE min 1", () => {
  const base = { job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON } as const;
  // base Novice Lv1: cri 13, flee2 11, hit 177, flee 102 (see the fresh-Novice test)
  assert.equal(playerStatus({ ...base, equip: { cri: -50 } as never }).cri, 10); // 13 - 50 -> status_calc_misc cap 1 -> floor 10 (status.cpp:7504)
  assert.equal(playerStatus({ ...base, equip: { criticalRate: 50 } as never }).cri, 10); // trunc(13 * 50 / 100) = 6 -> 10
  assert.equal(playerStatus({ ...base, equip: { flee2: -10 } as never }).flee2, 10); // -10 + 1 + 10 = 1 -> 10 (status.cpp:7724)
  assert.equal(playerStatus({ ...base, equip: { flee2Rate: 0 } as never }).flee2, 0); // base 0 after the rate: stays 0
  assert.equal(playerStatus({ ...base, equip: { hitRate: 0 } as never }).hit, 1); // 0 -> min 1 (status.cpp:7544)
  assert.equal(playerStatus({ ...base, equip: { fleeRate: 0 } as never }).flee, 1); // 0 -> min 1 (status.cpp:7612)
});

test("exp: max_exp_gain_rate caps one gain per part at rate/1000 of the next level (pc_gainexp, pc.cpp:8495-8507)", () => {
  const nov = { job: "Novice", level: 1, jobLevel: 1 } as const; // next base 548, next job 10
  assert.deepEqual(capExpGain(nov, 100, 50), { base: 100, job: 50 }); // shipped exp.conf max_exp_gain_rate: 0 = off
  const conf = { max_exp_gain_rate: 50 }; // 5%
  assert.deepEqual(capExpGain(nov, 100, 50, conf), { base: 27, job: 0 }); // (uint32)(0.05 * 548 = 27.4) = 27; (uint32)(0.05 * 10 = 0.5) = 0
  assert.deepEqual(capExpGain(nov, 27, 0, conf), { base: 27, job: 0 }); // 27 / 548 = 0.0493: not above 0.05, kept
  assert.deepEqual(capExpGain(nov, 28, 0, conf), { base: 27, job: 0 }); // 28 / 548 = 0.0511 > 0.05
  // at max level next = MAX_LEVEL_BASE_EXP / MAX_LEVEL_JOB_EXP (pc_nextbaseexp / pc_nextjobexp): 0.1% of 99,999,999 = 99,999.999
  assert.deepEqual(capExpGain({ job: "Novice", level: 99, jobLevel: 10 }, 9_000_000, 5000, { max_exp_gain_rate: 1 }), { base: 99_999, job: 5000 });
});

test("clif_updatestatus SP_HP: the owner is never sent 0 HP; a Novice-class character at 0 gets max_hp / 2 (clif.cpp:3683-3690)", () => {
  assert.equal(ownerHp("Novice", 0, 40), 20); // fresh Novice Lv1 (MaxHP 40) dead: 40 / 2
  assert.equal(ownerHp("Novice", 0, 45), 22); // integer division
  assert.equal(ownerHp("Novice", 0, 1), 0); // 1 / 2 = 0: the C++ sends that too
  assert.equal(ownerHp("Swordman", 0, 120), 1); // any other class: 1
  assert.equal(ownerHp("Thief", 0, 1), 1);
  assert.equal(ownerHp("Novice", 17, 40), 17); // alive: the real HP
  assert.equal(ownerHp("Mage", 1, 70), 1);
  assert.equal(isNoviceClass("Novice"), true);
  for (const j of ["Swordman", "Mage", "Archer", "Acolyte", "Merchant", "Thief"] as const) assert.equal(isNoviceClass(j), false, j);
  // (class_ & MAPID_SECONDMASK) == MAPID_NOVICE on the map.hpp ids of the jobs not imported yet: Novice High (JOBL_UPPER) and
  // Baby (JOBL_BABY) are Novice-class, the Super Novice line (JOBL_2_1 = 0x100) is not
  assert.equal(0x100000 & MAPID_SECONDMASK, MAPID_NOVICE);
  assert.equal(0x200000 & MAPID_SECONDMASK, MAPID_NOVICE);
  assert.notEqual(0x100 & MAPID_SECONDMASK, MAPID_NOVICE);
  assert.notEqual((0x1000 | 0x100) & MAPID_SECONDMASK, MAPID_NOVICE); // Super Novice Expanded
});

test("B01 r8: a card's bVit / bInt raises the stat but not MaxHP / MaxSP's +1 per point (status.cpp:4093 param_equip, before the card loop)", () => {
  const dagger = [...ITEMS.values()].find((i) => i.type === "Weapon" && i.slots >= 1 && i.subType === "Dagger")!;
  const armor = (bonuses: ItemBonus[]) => ({ ...ITEMS.get(2301)!, bonuses }) as unknown as GearItem; // an armor that itself carries the script
  const status = (job: "Novice" | "Mage" | "Swordman", level: number, stats: Stats, g: ReturnType<typeof gearOf>) =>
    playerStatus({ job, level, jobLevel: 1, stats, weapon: g.weapon, equip: g.equip });
  const withCard = (bonuses: ItemBonus[]) => {
    const card = { ...ITEMS.get(4002)!, id: 999001, bonuses } as unknown as ReturnType<typeof ITEMS.get> & object; ITEMS.set(999001, card);
    try { return gearOf([{ item: dagger, refine: 0, cards: [999001] }]); } finally { ITEMS.delete(999001); }
  };
  const one = { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 };
  // Novice L1 VIT 1, Leafgrub-style card (bVit 1, bMaxHP 100): VIT 2 -> 40 * 1.02 = 40.8, + 100 = 140.8 -> 140 (no +1 from the card)
  const a = status("Novice", 1, one, withCard([{ type: "bVit", value: 1 }, { type: "bMaxHP", value: 100 }]));
  assert.equal(a.stats.vit, 2); assert.equal(a.maxHp, 140);
  // the same script on an ARMOR is param_equip: 40.8 + 1 + 100 = 141.8 -> 141
  const b = status("Novice", 1, one, gearOf([{ item: armor([{ type: "bVit", value: 1 }, { type: "bMaxHP", value: 100 }]), refine: 0 }]));
  assert.equal(b.stats.vit, 2); assert.equal(b.maxHp, 141);
  // Novice L1 INT 1 + card bInt 3 + bMaxSP 20: INT 4 -> 11 * 1.04 = 11.44 + 20 = 31.44 -> 31 (armor: + 3 param_equip = 34.44 -> 34)
  assert.equal(status("Novice", 1, one, withCard([{ type: "bInt", value: 3 }, { type: "bMaxSP", value: 20 }])).maxSp, 31);
  assert.equal(status("Novice", 1, one, gearOf([{ item: armor([{ type: "bInt", value: 3 }, { type: "bMaxSP", value: 20 }]), refine: 0 }])).maxSp, 34);
  // Swordman L50 VIT 40 + card bVit 5 (+ bMaxHPrate 10): total VIT v, 1179 * (1 + v/100) = X, + 0 flat, + X * 10 / 100
  const sw = status("Swordman", 50, { ...one, vit: 40 }, withCard([{ type: "bVit", value: 5 }, { type: "bMaxHPrate", value: 10 }]));
  const x = 1179 * (1 + sw.stats.vit * 0.01); assert.equal(sw.stats.vit >= 45, true);
  assert.equal(sw.maxHp, Math.trunc(x + (x * 10) / 100));
  // Mage L50 INT 60 + card bInt 4 + bMaxSP 100: SP = 310 * (1 + i/100) + 100, no +4
  const mg = status("Mage", 50, { ...one, int: 60 }, withCard([{ type: "bInt", value: 4 }, { type: "bMaxSP", value: 100 }]));
  assert.equal(mg.maxSp, Math.trunc(310 * (1 + mg.stats.int * 0.01) + 100));
  // bAllStats on a card: every stat +1 in the sum, nothing extra in MaxHP / MaxSP
  const all = status("Novice", 1, one, withCard([{ type: "bAllStats", value: 2 }]));
  assert.equal(all.stats.vit, 3); assert.equal(all.maxHp, Math.trunc(40 * 1.03)); assert.equal(all.maxSp, Math.trunc(11 * 1.03));
});

import { ITEM_USE_INTERVAL, delayConsumeBlockedWhileSitting, itemUseReady, nextItemUse } from "./itemuse.ts";
test("item use interval (pc_isUseitem canuseitem_tick, items.conf item_use_interval 100)", () => {
  assert.equal(ITEM_USE_INTERVAL, 100);
  assert.equal(nextItemUse(1000), 1100);
  assert.equal(itemUseReady(1000, 0), true); // never used
  assert.equal(itemUseReady(1050, 1100), false); // 50 ms later: DIFF_TICK > 0
  assert.equal(itemUseReady(1099, 1100), false);
  assert.equal(itemUseReady(1100, 1100), true); // DIFF_TICK == 0 passes
});
test("DelayConsume items (wings) are refused while sitting (pc_useitem pc_issit)", () => {
  assert.equal(delayConsumeBlockedWhileSitting({ effect: { teleport: "random" } }, true), true);
  assert.equal(delayConsumeBlockedWhileSitting({ effect: { teleport: "random" } }, false), false);
  assert.equal(delayConsumeBlockedWhileSitting({ effect: { itemheal: [1, 2] } }, true), false);
});
