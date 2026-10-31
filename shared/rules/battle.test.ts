// Golden tests for a normal attack's outcome state and range flag, worked out by hand from the rAthena Renewal source:
// initialize_weapon_data (BF_SHORT / BF_LONG, battle.cpp:5294-5319), battle_calc_weapon_attack (the `if (wd.damage + wd.damage2)`
// guard on DEF + min 1 at 5617-5628, crit / non-crit / short / long rates at 5525-5563, crit x1.4 at 5646-5656, the target
// player's card fix at 5504-5518 / 5751-5756, infinite defense at 5452 / 5762-5765), battle_calc_attack (ATK_MISS, 6766-6770),
// is_infinite_defense (2890-2913), battle_calc_attack_plant (4951-4966), is_attack_critical (3030-3061), battle_calc_cardfix
// (1089-1153, APPLY_CARDFIX 806) and pc_bonus / pc_bonus2 (pc.cpp:3996-4454, 4709).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOB_BY_ID, TABLES, type Stats } from "./data.ts";
import { STARTER_WEAPON, mobStatus, playerStatus, type Status } from "./status.ts";
import { ATK, BF, BL, CARDFIX_LEFT, NK_NONE, battleCalcCardfix, critDamage, critRate, isInfiniteDefense, mobAttack, mobUsesArrow, normalAttackFlag, playerAttack, type Target } from "./battle.ts";
import { ITEMS, gearOf, weaponOf, type GearItem } from "./items.ts";
import { bonus2Type2, noBonus, pcBonus, pcBonus2, scriptBonus, type ItemBonus } from "./bonus.ts";
import { MD, MD_MASK, PC_MODE } from "./mode.ts";
import { MD as MD_AI } from "./mobai.ts";

const fixed = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };
const vsMob: Target = { type: BL.MOB, targeted: 1 };
const vsPc: Target = { type: BL.PC, targeted: 1 };
const MELEE = BF.WEAPON | BF.NORMAL | BF.SHORT, SHOT = BF.WEAPON | BF.NORMAL | BF.LONG;
const ones: Stats = { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 };
/** An item_db row as status sees it (bonuses in the importer's items.json form). */
const gear = (type: string, subType: string | null, loc: string[], bonuses: ItemBonus[] = [], atk = 0): GearItem =>
  ({ type, subType, atk, matk: 0, def: 0, weaponLevel: 0, armorLevel: 0, refineable: false, element: "Neutral", locations: loc, bonuses });
const garment = (...bonuses: ItemBonus[]) => gear("Armor", null, ["Garment"], bonuses);
const wear = (...items: GearItem[]) => gearOf(items.map((item) => ({ item, refine: 0 })));
const KNIFE = ITEMS.get(1201)!, BOW = ITEMS.get(1702)!, ARROW = ITEMS.get(1750)!;
/** Novice Lv1, every stat 1 (batk 1, HIT 177, CRI 13, FLEE 102, flee2 11, def 0, def2 1) with a Knife and the given pieces. */
const novice = (...items: GearItem[]) => playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...wear(KNIFE, ...items) });
/** Archer Lv10 / Job 1: STR 5 AGI 5 VIT 5 INT 1 DEX 30 LUK 1 (batk 33 with a bow, HIT 215, CRI 14). */
const archer = (...items: GearItem[]) => playerStatus({ job: "Archer", level: 10, jobLevel: 1, stats: { str: 5, agi: 5, vit: 5, int: 1, dex: 30, luk: 1 }, ...wear(...items) });
// Puddlebloom 1002: Water 1, Medium, Plant, FLEE 102, DEF 2, def2 (1 + 1) / 2 = 1, LUK 5. A Novice's Knife hit on it (rolls: crit
// 999 >= 13 - 10 = 3, hit 0 < 75, weapon rnd(2) at 0.5 -> 17): size fix Dagger / Medium 75 -> 12, + status ATK 1 * 2 = 14 before DEF,
// trunc(14 * 4002 / 4020) = 13 - 1 = 12 after. The crit (roll 0) takes the top 17 as well: 14 -> 12 -> floor(12 * 1.4f) = 16.
const puddle = () => mobStatus(MOB_BY_ID.get(1002)!);
const HIT = () => fixed(0.999, 0, 0.5), CRIT = () => fixed(0);

test("e_mode moved to mode.ts: same table for the AI, MD_MASK from mmo.hpp:274, a player's mode (status.cpp:3827)", () => {
  assert.equal(MD_AI, MD);
  assert.equal(MD_MASK, 0xffff);
  // MD_MASK minus MD_ANGRY 0x800 and MD_TARGETWEAK 0x4000 (the other cleared bits lie above the mask): 0xffff - 0x4800
  assert.equal(PC_MODE, 0xb7ff);
  assert.equal(novice().mode, PC_MODE);
  assert.equal(novice().race, "Player_Human"); // status.cpp:3840
  assert.deepEqual([puddle().race, puddle().mode], ["Plant", 0x83]); // mob_db Race / Ai 02 mask
});

test("BF_SHORT / BF_LONG on every normal attack (initialize_weapon_data 5294-5319, is_skill_using_arrow 2925-2943)", () => {
  assert.equal(normalAttackFlag(false), 0x211); // BF_WEAPON 0x1 | BF_NORMAL 0x200 | BF_SHORT 0x10
  assert.equal(normalAttackFlag(true), 0x241); // ... | BF_LONG 0x40
  const m = puddle();
  assert.equal(playerAttack(novice(), weaponOf(KNIFE), m, vsMob, HIT()).flag, MELEE);
  assert.equal(playerAttack(archer(BOW, ARROW), weaponOf(BOW), m, vsMob, HIT()).flag, SHOT); // sd->state.arrow_atk
  assert.equal(playerAttack(archer(BOW, ARROW), weaponOf(BOW), m, vsMob, fixed(0.999, 0.999)).flag, SHOT); // set on a miss too
  // a monster's normal attack is BF_LONG only with an attack range above 3 (sstatus->rhw.range > 3)
  const p = novice();
  assert.equal(mobAttack(m, p, vsPc, fixed(0.999, 0, 0)).flag, MELEE);
  assert.deepEqual([3, 4, 9].map((range) => mobUsesArrow({ rhw: { ...m.rhw, range } })), [false, true, true]);
  assert.equal(mobAttack({ ...m, rhw: { ...m.rhw, range: 4 } }, p, vsPc, fixed(0.999, 0, 0)).flag, SHOT);
});

test("zero total -> ATK_MISS: no DEF, no min 1, crit x1.4 keeps 0 (battle.cpp:5617-5628, 5646-5656, 6766-6770)", () => {
  // the critic's case: Mosspaw 1167 as Ghost 4 (attr_fix Neutral -> Ghost lv4 = 0%: status, weapon and equipment ATK all 0)
  assert.equal(TABLES.attr["4"].Neutral.Ghost, 0);
  const ghost = mobStatus({ ...MOB_BY_ID.get(1167)!, element: "Ghost", elementLevel: 4 }); // LUK 18, FLEE 122
  const stats = { str: 20, agi: 5, vit: 5, int: 1, dex: 30, luk: 60 };
  const knife = playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats, ...wear(KNIFE) });
  const fists = playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats, ...wear() });
  // CRI 1 + 10 + 60 * 3 = 191, - 18 * 2 = 155 per mille; HIT 10 + 30 + 20 + 175 = 235 vs FLEE 122: 100%
  assert.equal(critRate(knife, ghost, false), 155);
  const miss = (crit: boolean, flag: number) => ({ dmg: 0, crit, miss: true, lucky: false, dmgLv: ATK.MISS, flag });
  assert.deepEqual(playerAttack(knife, weaponOf(KNIFE), ghost, vsMob, fixed(0.999, 0, 0.5)), miss(false, MELEE)); // roll 999: no crit; hits
  assert.deepEqual(playerAttack(knife, weaponOf(KNIFE), ghost, vsMob, fixed(0)), miss(true, MELEE)); // crit: floor(0 * 1.4f) = 0
  assert.deepEqual(playerAttack(fists, weaponOf(undefined), ghost, vsMob, fixed(0.999, 0, 0)), miss(false, MELEE));
  const arch = playerStatus({ job: "Archer", level: 10, jobLevel: 1, stats, ...wear(BOW, ARROW) }); // Neutral arrow: 0% too
  assert.deepEqual(playerAttack(arch, weaponOf(BOW), ghost, vsMob, fixed(0.999, 0, 0.5)), miss(false, SHOT));
  assert.deepEqual(playerAttack(arch, weaponOf(BOW), ghost, vsMob, fixed(0)), miss(true, SHOT));
  assert.equal(critDamage(0), 0);
  // a total of exactly 0 any other way is ATK_MISS too; a negative one still goes through DEF and becomes 1. Bare-handed Novice
  // Lv1 vs Puddlebloom: status ATK 2, weapon ATK 0, equipment ATK = bBaseAtk (Neutral -> Water 100%).
  const bare = (eatk: number) => playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, equip: { eatk } });
  assert.deepEqual(playerAttack(bare(-2), weaponOf(undefined), puddle(), vsMob, fixed(0.999, 0, 0)), miss(false, MELEE)); // 2 + 0 - 2 = 0
  // 2 - 3 = -1: trunc(-1 * 4002 / 4020) = 0, - def2 1 = -1 -> battle_min_damage 1, a connecting hit
  assert.deepEqual(playerAttack(bare(-3), weaponOf(undefined), puddle(), vsMob, fixed(0.999, 0, 0)),
    { dmg: 1, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  // a dodge stays ATK_FLEE / ATK_LUCKY (dmg_lv != ATK_DEF is not rewritten): roll 99 >= hit rate 75
  assert.deepEqual(playerAttack(novice(), weaponOf(KNIFE), puddle(), vsMob, fixed(0.999, 0.999)),
    { dmg: 0, crit: false, miss: true, lucky: false, dmgLv: ATK.FLEE, flag: MELEE });
  assert.equal(playerAttack(novice(), weaponOf(KNIFE), novice(), vsPc, fixed(0)).dmgLv, ATK.LUCKY); // 0 < flee2 11
});

test("plants and IgnoreMelee / IgnoreRanged: a connecting normal attack deals exactly 1 (is_infinite_defense, attack_plant)", () => {
  const base = puddle();
  const plant = { ...base, mode: base.mode | MD.IGNOREMELEE | MD.IGNOREMAGIC | MD.IGNORERANGED | MD.IGNOREMISC }; // mob_db Modes of a plant
  const one = (crit: boolean, flag: number) => ({ dmg: 1, crit, miss: false, lucky: false, dmgLv: ATK.DEF, flag });
  assert.deepEqual(playerAttack(novice(), weaponOf(KNIFE), plant, vsMob, HIT()), one(false, MELEE)); // would be 12
  assert.deepEqual(playerAttack(novice(), weaponOf(KNIFE), plant, vsMob, CRIT()), one(true, MELEE)); // would be 16: still a crit
  assert.deepEqual(playerAttack(archer(BOW, ARROW), weaponOf(BOW), plant, vsMob, fixed(0.999, 0, 0.999)), one(false, SHOT)); // would be 107
  assert.equal(playerAttack(novice(), weaponOf(KNIFE), plant, vsMob, fixed(0.999, 0.999)).dmgLv, ATK.FLEE); // it can still be missed
  // no damage math: only the lucky / crit / hit rolls are drawn (no weapon variance)
  let draws = 0;
  playerAttack(novice(), weaponOf(KNIFE), plant, vsMob, () => { draws++; return draws === 1 ? 0.999 : 0; });
  assert.equal(draws, 2);
  // one immunity each: melee vs ranged
  const noMelee = { ...base, mode: base.mode | MD.IGNOREMELEE }, noRanged = { ...base, mode: base.mode | MD.IGNORERANGED };
  assert.equal(playerAttack(novice(), weaponOf(KNIFE), noMelee, vsMob, HIT()).dmg, 1);
  assert.equal(playerAttack(archer(BOW, ARROW), weaponOf(BOW), noMelee, vsMob, fixed(0.999, 0, 0.999)).dmg, 107);
  assert.equal(playerAttack(novice(), weaponOf(KNIFE), noRanged, vsMob, HIT()).dmg, 12);
  assert.equal(playerAttack(archer(BOW, ARROW), weaponOf(BOW), noRanged, vsMob, fixed(0.999, 0, 0.999)).dmg, 1);
  // the flag test itself (BF_MAGIC / BF_MISC need IgnoreMagic / IgnoreMisc), and a player never has it
  assert.equal(isInfiniteDefense({ mode: MD.IGNOREMAGIC }, BF.MAGIC | BF.SKILL | BF.LONG), true);
  assert.equal(isInfiniteDefense({ mode: MD.IGNOREMAGIC }, MELEE), false);
  assert.equal(isInfiniteDefense({ mode: MD.IGNOREMISC }, BF.MISC | BF.SKILL | BF.SHORT), true);
  assert.equal(isInfiniteDefense({ mode: MD.IGNOREMELEE }, BF.MAGIC | BF.SHORT), false); // needs BF_WEAPON too
  assert.equal(isInfiniteDefense({ mode: PC_MODE }, MELEE) || isInfiniteDefense({ mode: PC_MODE }, SHOT), false);
  // a monster hitting a unit with that mode deals 1 the same way (6 without it: rules.test.ts "monster attack + perfect dodge")
  assert.equal(mobAttack(base, { ...novice(), mode: MD.IGNOREMELEE }, vsPc, fixed(0.999, 0, 0)).dmg, 1);
});

test("crit_atk_rate before DEF, non_crit_atk_rate, short / long_attack_atk_rate (battle.cpp:5543-5563, ATK_ADDRATE)", () => {
  const m = puddle(), k = weaponOf(KNIFE);
  // bCritAtkRate 20 on a crit: 14 + floor((float)(14 * 20 / 100)) = 16 before DEF -> trunc(16 * 4002 / 4020) = 15 - 1 = 14
  // -> floor((float)(14 * 1.4f)) = floor(19.6000004) = 19 (16 without it). It does nothing to a normal hit (12).
  const crate = novice(garment({ type: "bCritAtkRate", value: 20 }));
  assert.equal(crate.critAtkRate, 20);
  assert.deepEqual(playerAttack(crate, k, m, vsMob, CRIT()), { dmg: 19, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  assert.equal(playerAttack(crate, k, m, vsMob, HIT()).dmg, 12);
  // bNonCritAtkRate 50 on a normal hit: 14 + 7 = 21 -> trunc(21 * 4002 / 4020) = 20 - 1 = 19; a crit ignores it (16)
  const ncrate = novice(garment({ type: "bNonCritAtkRate", value: 50 }));
  assert.equal(playerAttack(ncrate, k, m, vsMob, HIT()).dmg, 19);
  assert.equal(playerAttack(ncrate, k, m, vsMob, CRIT()).dmg, 16);
  // bShortAtkRate 25 on a melee hit (BF_SHORT): 14 + trunc(3.5) = 17 -> trunc(16.92) = 16 - 1 = 15; bLongAtkRate doesn't apply
  assert.equal(playerAttack(novice(garment({ type: "bShortAtkRate", value: 25 })), k, m, vsMob, HIT()).dmg, 15);
  assert.equal(playerAttack(novice(garment({ type: "bLongAtkRate", value: 100 })), k, m, vsMob, HIT()).dmg, 12);
  // one ATK_ADDRATE after the other: non-crit 50 then short 25 = 14 -> 21 -> 21 + 5 = 26 -> trunc(25.88) = 25 - 1 = 24
  // (adding the rates first would give 14 + 10 = 24 -> 22)
  const both = novice(garment({ type: "bNonCritAtkRate", value: 50 }), gear("Armor", null, ["Shoes"], [{ type: "bShortAtkRate", value: 25 }]));
  assert.equal(playerAttack(both, k, m, vsMob, HIT()).dmg, 24);
  // a rate that brings the total to 0 makes it ATK_MISS: 14 + trunc(14 * -100 / 100) = 0
  assert.equal(playerAttack(novice(garment({ type: "bShortAtkRate", value: -100 })), k, m, vsMob, HIT()).dmgLv, ATK.MISS);
  // a bow shot is BF_LONG: Archer + Bow + Arrow, max roll: 66 + 18 + 25 = 109 (107 after DEF); bLongAtkRate 10:
  // 109 + trunc(10.9) = 119 -> trunc(119 * 4002 / 4020) = 118 - 1 = 117; bShortAtkRate doesn't apply (107)
  const top = () => fixed(0.999, 0, 0.999);
  assert.equal(playerAttack(archer(BOW, ARROW, garment({ type: "bLongAtkRate", value: 10 })), weaponOf(BOW), m, vsMob, top()).dmg, 117);
  assert.equal(playerAttack(archer(BOW, ARROW, garment({ type: "bShortAtkRate", value: 50 })), weaponOf(BOW), m, vsMob, top()).dmg, 107);
});

test("crit rate: critaddrace by race / RC_ALL, critical_rangeatk on arrow attacks (is_attack_critical 3049-3053)", () => {
  const m = puddle(), k = weaponOf(KNIFE);
  // Novice CRI 13 vs LUK 5: 3 per mille; the roll 0.02 -> 20 misses it (then hits for 12: weapon 16 -> 12, + 2 = 14 -> 12)
  assert.equal(critRate(novice(), m, false), 3);
  assert.deepEqual(playerAttack(novice(), k, m, vsMob, fixed(0.02)), { dmg: 12, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  // bonus2 bCriticalAddRace,RC_Plant,5 -> critaddrace[RC_PLANT] += 50: 53 per mille vs a Plant, the same roll crits (16)
  const plant5 = novice(garment({ type: "bCriticalAddRace", type2: "Plant", value: 5 }));
  assert.deepEqual(plant5.critAddRace, { Plant: 50 });
  assert.equal(critRate(plant5, m, false), 53);
  assert.deepEqual(playerAttack(plant5, k, m, vsMob, fixed(0.02)), { dmg: 16, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  // another race doesn't count; RC_ALL counts against anything and stacks with the race's own
  assert.equal(critRate(novice(garment({ type: "bCriticalAddRace", type2: "Brute", value: 5 })), m, false), 3);
  const all = novice(garment({ type: "bCriticalAddRace", type2: "All", value: 2 }), gear("Armor", null, ["Shoes"], [{ type: "bCriticalAddRace", type2: "Plant", value: 1 }]));
  assert.equal(critRate(all, m, false), 3 + 20 + 10);
  // bCriticalLong 2 on armor -> critical_rangeatk 20: only an attack that shoots ammo adds it (Archer CRI 14 vs LUK 5: 4 -> 24)
  const longCri = garment({ type: "bCriticalLong", value: 2 });
  assert.deepEqual([archer(BOW, ARROW, longCri).critRangeAtk, archer(BOW, ARROW, longCri).arrow!.cri], [20, 0]);
  assert.equal(critRate(archer(BOW, ARROW, longCri), m, true), 24);
  assert.equal(critRate(archer(BOW, ARROW, longCri), m, false), 4);
  // roll 20 < 24: crit, weapon max 18: 66 + 18 + 25 = 109 -> 107 -> floor((float)(107 * 1.4f)) = 149
  assert.equal(playerAttack(archer(BOW, ARROW, longCri), weaponOf(BOW), m, vsMob, fixed(0.02)).dmg, 149);
  // on the ammo itself (LR_FLAG_ARROW) bCriticalLong becomes arrow_cri instead (pc.cpp:4450-4454): same 24 with a bow
  const longArrow = gear("Ammo", "Arrow", ["Ammo"], [{ type: "bCriticalLong", value: 2 }], 25);
  assert.deepEqual([archer(BOW, longArrow).critRangeAtk, archer(BOW, longArrow).arrow!.cri], [0, 20]);
  assert.equal(critRate(archer(BOW, longArrow), m, true), 24);
});

test("the target player's near / long_attack_def_rate (battle_calc_cardfix BF_WEAPON target side, APPLY_CARDFIX)", () => {
  // cardfix = 1000 * (100 - rate) / 100, damage -= trunc(damage * (1000 - max(0, cardfix)) / 1000). The target side of battle_calc_cardfix
  // (left 0) for a Puddlebloom hitting a Novice whose gear gives just these two rates:
  const cardfixTarget = (dmg: number, flag: number, equip: { nearAtkDef: number; longAtkDef: number }) =>
    battleCalcCardfix({ status: puddle(), type: BL.MOB }, { status: playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, equip }), type: BL.PC },
      NK_NONE, "Neutral", dmg, CARDFIX_LEFT.TARGET, flag);
  assert.deepEqual([10, 50, 100, 150].map((nearAtkDef) => cardfixTarget(33, MELEE, { nearAtkDef, longAtkDef: 0 })), [30, 17, 0, 0]);
  assert.equal(cardfixTarget(33, SHOT, { nearAtkDef: 50, longAtkDef: 0 }), 33); // BF_LONG reads long_attack_def_rate
  assert.equal(cardfixTarget(0, MELEE, { nearAtkDef: 50, longAtkDef: 0 }), 0);
  // monster -> player (`if (tsd && !sd)`, battle.cpp:5751-5756: the whole damage, after DEF). Mosspaw 1167 (ATK 5: 4..5, batk
  // 16 + 14 = 30) on a Novice Lv1 (def 0, def2 1): HIT 185 vs FLEE 102 = 83%; rolls lucky 999, hit 0, ATK 0 -> 34 - 1 = 33
  const moss = mobStatus(MOB_BY_ID.get(1167)!), rolls = () => fixed(0.999, 0, 0);
  const vs = (nearAtkDef: number, longAtkDef = 0) => playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, equip: { nearAtkDef, longAtkDef } });
  assert.equal(mobAttack(moss, vs(0), vsPc, rolls()).dmg, 33);
  assert.equal(mobAttack(moss, vs(10), vsPc, rolls()).dmg, 30); // 33 - trunc(3.3)
  assert.equal(mobAttack(moss, vs(0, 50), vsPc, rolls()).dmg, 33); // a melee monster: long rate unused
  // bNearAtkDef 100: cardfix 0 takes it all -> ATK_MISS (shown as Miss, nothing applied)
  assert.deepEqual(mobAttack(moss, vs(100), vsPc, rolls()), { dmg: 0, crit: false, miss: true, lucky: false, dmgLv: ATK.MISS, flag: MELEE });
  // a monster with an attack range above 3 is BF_LONG: bLongAtkDef 50 -> 33 - trunc(16.5) = 17, bNearAtkDef no longer counts
  const far = { ...moss, rhw: { ...moss.rhw, range: 9 } };
  assert.equal(mobAttack(far, vs(0, 50), vsPc, rolls()).dmg, 17);
  assert.equal(mobAttack(far, vs(100), vsPc, rolls()).dmg, 33);
  // the bonus rows (pc.cpp:3996 / 4000) feed it through the equipment loop
  assert.deepEqual([novice(garment({ type: "bNearAtkDef", value: 10 })).nearAtkDef, novice(garment({ type: "bLongAtkDef", value: 7 })).longAtkDef], [10, 7]);
  // player -> player: the card fix runs on each part before they are summed (battle.cpp:5504-5518). Knife hit on a Novice with
  // bNearAtkDef 30 (cardfix 700); rolls lucky 999 (flee2 11), crit 999 (13 - 2 = 11), hit 0 (75%), weapon 17 -> size 75 -> 12:
  // status ATK 2 - trunc(0.6) = 2, weapon ATK 12 - trunc(3.6) = 9 -> 11 -> DEF (def2 1) 10. (On the 14 total it would be 10 -> 9.)
  const pvp = () => fixed(0.999, 0.999, 0, 0.5);
  assert.equal(playerAttack(novice(), weaponOf(KNIFE), vs(0), vsPc, pvp()).dmg, 13);
  assert.equal(playerAttack(novice(), weaponOf(KNIFE), vs(30), vsPc, pvp()).dmg, 10);
});

test("pc_bonus / pc_bonus2 rows: lr_flag gates and bCriticalAddRace's race check (pc.cpp:3996-4454, 4709)", () => {
  // every new pc_bonus row writes under LR_FLAG_NONE and LR_FLAG_SHIELD, nothing under LR_FLAG_ARROW (bCriticalLong excepted)
  for (const [type, field] of [["bCritAtkRate", "critAtkRate"], ["bNonCritAtkRate", "nonCritAtkRate"], ["bShortAtkRate", "shortAtkRate"],
    ["bLongAtkRate", "longAtkRate"], ["bNearAtkDef", "nearAtkDef"], ["bLongAtkDef", "longAtkDef"]] as const) {
    const b = noBonus();
    assert.equal(pcBonus(b, type, 5, "none") && pcBonus(b, type, 3, "shield") && pcBonus(b, type, 50, "arrow", "Bow"), true);
    assert.equal(b[field], 8, type);
  }
  const b = noBonus();
  pcBonus(b, "bCriticalLong", 3, "none"); pcBonus(b, "bCriticalLong", 1, "arrow", "Bow"); pcBonus(b, "bCriticalLong", 1, "arrow", "Dagger");
  assert.deepEqual([b.critRangeAtk, b.arrowCri], [30, 20]); // val * 10; under LR_FLAG_ARROW always arrow_cri, whatever the weapon
  // pc_bonus2: race-indexed, val * 10, nothing under LR_FLAG_ARROW; an invalid race (PC_BONUS_CHK_RACE) or unknown bonus is refused
  const c = noBonus();
  assert.equal(pcBonus2(c, "bCriticalAddRace", "Undead", 5), true);
  assert.equal(pcBonus2(c, "bCriticalAddRace", "Undead", 2, "shield"), true);
  assert.equal(pcBonus2(c, "bCriticalAddRace", "Undead", 9, "arrow"), true);
  assert.equal(pcBonus2(c, "bCriticalAddRace", "Undeadish", 5), false);
  assert.equal(pcBonus2(c, "bIgnoreDefRaceRate", "Undead", 5), false); // not modelled yet
  assert.deepEqual(c.critAddRace, { Undead: 70 });
  // the script dispatch (buildin_bonus): a row with type2 is pc_bonus2, one without is pc_bonus
  const d = noBonus();
  assert.equal(scriptBonus(d, { type: "bCriticalAddRace", type2: "All", value: 1 }) && scriptBonus(d, { type: "bCritAtkRate", value: 4 }), true);
  assert.deepEqual([d.critAddRace, d.critAtkRate], [{ All: 10 }, 4]);
  // what the importer stores for `bonus2 bCriticalAddRace,<RC_*>,n;` (script constants are case-insensitive)
  assert.deepEqual(["RC_DemiHuman", "RC_Player_Human", "RC_All", "rc_brute", "RC_Foo"].map((c) => bonus2Type2("bCriticalAddRace", c)),
    ["Demihuman", "Player_Human", "All", "Brute", undefined]);
  assert.equal(bonus2Type2("bIgnoreDefRaceRate", "RC_Brute"), undefined); // not modelled yet -> stays `unsupported`
  // monsters have no sd->bonus: all zero
  const mob: Status = puddle();
  assert.deepEqual([mob.critAtkRate, mob.nonCritAtkRate, mob.shortAtkRate, mob.longAtkRate, mob.nearAtkDef, mob.longAtkDef, mob.critRangeAtk, mob.critAddRace], [0, 0, 0, 0, 0, 0, 0, {}]);
});

test("STARTER_WEAPON fixtures still hit as before (regression guard for the reshaped AttackResult)", () => {
  const p = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, weapon: STARTER_WEAPON });
  assert.deepEqual(playerAttack(p, STARTER_WEAPON, puddle(), vsMob, HIT()), { dmg: 12, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  assert.deepEqual(playerAttack(p, STARTER_WEAPON, puddle(), vsMob, CRIT()), { dmg: 16, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
});
