// Golden tests for shared/rules/skill.ts (+ the skill paths of battle.ts and equipsweep.ts), numbers worked out by hand from the
// rAthena functions each rule cites.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILLS, SKILL_ID, afterCastDelay, castEndCanact, castStartCanact, castTime, checkSkill, healAmount, magicSkillHit, normalizeJob,
  skillCondition, skillList, skillRange, skillRatio, skillReady, skillLearnable, refundUnready, skillUpBlock, weaponSkillHit, type Skill,
} from "./skill.ts";
import { BF, BL, magicAttack, passiveDefense, passiveMastery, playerAttack } from "./battle.ts";
import { MOB_BY_ID } from "./data.ts";
import { STARTER_WEAPON, mobStatus, playerStatus, skillRegen } from "./status.ts";
import { equipSweep } from "./equipsweep.ts";
import { equipBlock, ITEMS } from "./items.ts";
import { hotkeyList, hotkeySkill, skillHotkey } from "./hotkey.ts";

const S = (key: string) => SKILLS.get(SKILL_ID[key])!;
const fixed = (v: number) => () => v;

test("skill data: imported names are ours, per-level tables are full (skill_db.yml)", () => {
  assert.equal(S("SM_BASH").name, "Crushing Blow");
  assert.deepEqual(S("SM_BASH").sp, [8, 8, 8, 8, 8, 15, 15, 15, 15, 15]);
  assert.deepEqual(S("MG_FIREBOLT").castTime.slice(0, 3), [500, 800, 1100]);
  assert.deepEqual(S("MG_FIREBOLT").fixedCastTime.slice(0, 3), [300, 400, 500]);
  assert.deepEqual(S("MG_FIREBOLT").hitCount, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(S("SM_MAGNUM").cooldown[0], 2000);
  assert.deepEqual(S("AC_DOUBLE").weapons, ["Bow"]);
  assert.deepEqual(S("AC_DOUBLE").ammo, ["Arrow"]);
  assert.deepEqual(S("MC_MAMMONITE").zeny.slice(0, 3), [100, 200, 300]);
});

test("skill tree: Novice points first (pc_calc_skilltree_normalize_job_sub), prerequisites (skill_tree.yml Requires)", () => {
  // a Swordman that hasn't spent the 9 Novice points only has the Novice tree
  assert.equal(normalizeJob("Swordman", {}), "Novice");
  assert.equal(checkSkill("Swordman", { [SKILL_ID.SM_BASH]: 3 }, 10, 5, SKILL_ID.SM_BASH), 0);
  const basic9 = { [SKILL_ID.NV_BASIC]: 9 };
  assert.equal(normalizeJob("Swordman", basic9), "Swordman");
  assert.equal(skillUpBlock("Swordman", basic9, 10, 2, 1, SKILL_ID.SM_BASH), null);
  assert.equal(skillUpBlock("Swordman", { ...basic9, [SKILL_ID.SM_BASH]: 4 }, 10, 6, 1, SKILL_ID.SM_MAGNUM), "its requirements aren't met");
  assert.equal(skillUpBlock("Swordman", { ...basic9, [SKILL_ID.SM_BASH]: 5 }, 10, 6, 1, SKILL_ID.SM_MAGNUM), null);
  assert.equal(skillUpBlock("Swordman", { ...basic9, [SKILL_ID.SM_BASH]: 10 }, 10, 6, 1, SKILL_ID.SM_BASH), "already at its maximum level");
  assert.equal(skillUpBlock("Novice", {}, 1, 1, 0, SKILL_ID.NV_BASIC), "no skill points");
  assert.equal(skillUpBlock("Novice", {}, 1, 2, 1, SKILL_ID.SM_BASH), "not in your skill tree");
  // the window lists the Novice rows first, then the job's own
  const list = skillList("Mage", basic9, 10, 1, 1);
  assert.equal(list[0].id, SKILL_ID.NV_BASIC);
  assert.equal(list.find((e) => e.id === SKILL_ID.MG_FIREBOLT)!.upgradable, true);
  assert.equal(list.find((e) => e.id === SKILL_ID.MG_FIREBALL)!.upgradable, false); // needs Fire Bolt 4
});

test("Renewal cast time (skill_vfcastfix): variable x (1 - sqrt((DEX*2+INT)/530)) + fixed", () => {
  // Fire Bolt 3: cast 1100, fixed 500. DEX 30 INT 40: sqrt(100/530) = 0.43437 -> 1100 x 0.56563 = 622.19 -> 622 + 500
  assert.equal(castTime(S("MG_FIREBOLT"), 3, { dex: 30, int: 40 }), 1122);
  // DEX 99 INT 99: sqrt(297/530) = 0.74858 -> 1100 x 0.25142 = 276.56 -> 276 + 500
  assert.equal(castTime(S("MG_FIREBOLT"), 3, { dex: 99, int: 99 }), 776);
  // DEX*2 + INT = 530: no variable part left, the fixed part stays
  assert.equal(castTime(S("MG_FIREBOLT"), 3, { dex: 265, int: 0 }), 500);
  // a negative FixedCastTime: default_fixed_castrate 20 % of the cast is fixed (1000 -> 200 fixed + 800 variable)
  const neg = { ...S("MG_FIREBOLT"), castTime: [1000], fixedCastTime: [-1] } as Skill;
  assert.equal(castTime(neg, 1, { dex: 0, int: 0 }), 1000);
  assert.equal(castTime(neg, 1, { dex: 265, int: 0 }), 200);
  assert.equal(castTime(S("SM_BASH"), 10, { dex: 1, int: 1 }), 0); // no cast
});

test("after-cast delay (skill_delayfix), canact (unit_set_castdelay / skill_castend_id)", () => {
  assert.equal(afterCastDelay(S("MG_FIREBOLT"), 1, 400), 1400);
  assert.equal(afterCastDelay(S("SM_MAGNUM"), 1, 400), 500);
  assert.equal(afterCastDelay({ ...S("SM_BASH"), delay: [-500] } as Skill, 1, 400), 900); // negative: |delay| + amotion
  // cast start at 1000 with a 1122 ms cast: canact = 1000 + 1122 + SECURITY_CASTTIME 100
  assert.equal(castStartCanact(0, 1000, 1122), 2222);
  // instant skill: min_skill_delay_limit 100 + 100
  assert.equal(castStartCanact(0, 1000, 0), 1200);
  // cast end at 2122: max(2122 + 1400, 2222 - 100)
  assert.equal(castEndCanact(2222, 2122, 1400), 3522);
});

test("skill range (skill_get_range2): negative = absolute, Far Sight on AlterRangeVulture skills", () => {
  assert.equal(skillRange(S("SM_BASH"), 1), 1);
  assert.equal(skillRange(S("AC_DOUBLE"), 1), 9);
  assert.equal(skillRange(S("AC_DOUBLE"), 1, { [SKILL_ID.AC_VULTURE]: 3 }), 12);
  assert.equal(skillRange(S("MG_FIREBOLT"), 1), 9);
});

test("skill ratios (skills/<class>/*.cpp calculateSkillRatio)", () => {
  assert.equal(skillRatio("SM_BASH", 10), 400);
  assert.equal(skillRatio("SM_MAGNUM", 10, { inner: true }), 300);
  assert.equal(skillRatio("SM_MAGNUM", 10), 200);
  assert.equal(skillRatio("MG_NAPALMBEAT", 1), 80);
  assert.equal(skillRatio("AC_DOUBLE", 10), 190);
  assert.equal(skillRatio("AC_SHOWER", 1), 160);
  assert.equal(skillRatio("MC_MAMMONITE", 10), 600);
  assert.equal(skillRatio("MG_SOULSTRIKE", 10, { undead: true }), 150);
});

test("weapon skill = the normal attack's damage x ratio before DEF, x hits (battle_calc_weapon_attack RENEWAL)", () => {
  const p = playerStatus({ job: "Swordman", level: 20, jobLevel: 5, stats: { str: 30, agi: 10, vit: 10, int: 1, dex: 20, luk: 1 }, weapon: STARTER_WEAPON });
  const mob = { ...mobStatus(MOB_BY_ID.get(1063)!), def: 0, def2: 0, element: "Neutral" as const, elementLevel: 1 };
  const vs = { type: BL.MOB, targeted: 0 };
  const normal = playerAttack(p, STARTER_WEAPON, mob, vs, fixed(0.5));
  assert.equal(normal.crit, false);
  const bash = playerAttack(p, STARTER_WEAPON, mob, vs, fixed(0.5), weaponSkillHit(S("SM_BASH"), 10, {}));
  assert.equal(bash.dmg, Math.trunc((normal.dmg * 400) / 100));
  assert.equal(bash.flag, BF.WEAPON | BF.SKILL | BF.SHORT);
  // Envenom: + 15 x lv mastery ATK (battle.cpp:3812) before the 100 % ratio, Poison element (Neutral target: 100 %)
  const env = playerAttack(p, STARTER_WEAPON, mob, vs, fixed(0.5), weaponSkillHit(S("TF_POISON"), 5, {}));
  assert.equal(env.dmg, normal.dmg + 75);
  // a skill can't be lucky-dodged or crit: a target with perfect dodge still gets hit
  const lucky = { ...mob, flee2: 1000 };
  assert.equal(playerAttack(p, STARTER_WEAPON, lucky, vs, fixed(0.5), weaponSkillHit(S("SM_BASH"), 1, {})).lucky, false);
});

test("magic skill (battle_calc_magic_attack RENEWAL): MATK x ratio, MDEF (1000+mdef)/(1000+10mdef) - mdef2, element, x hits", () => {
  // Mage Lv10 INT 30 DEX 10 LUK 1, no weapon: status MATK = 30 + 15 + 2 + 0 + 2 = 49 (min = max)
  const p = playerStatus({ job: "Mage", level: 10, jobLevel: 1, stats: { str: 1, agi: 1, vit: 1, int: 30, dex: 10, luk: 1 } });
  assert.equal(p.matkMin, 49); assert.equal(p.matkMax, 49);
  // Frost Bolt 3 vs Cinderpaw (Fire 1, MDEF 3, mdef2 2): 49 x 1003 / 1030 = 47 - 2 = 45, Water -> Fire 150 % = 67, x3
  const cold = magicAttack(p, mobStatus(MOB_BY_ID.get(1049)!), magicSkillHit(S("MG_COLDBOLT"), 3, {}));
  assert.equal(cold.dmg, 201);
  // Flame Bolt 2 vs Puddlebloom (Water 1, MDEF 5): 49 x 1005 / 1050 = 46, Fire -> Water 90 % = 42, x2
  assert.equal(magicAttack(p, mobStatus(MOB_BY_ID.get(1002)!), magicSkillHit(S("MG_FIREBOLT"), 2, {})).dmg, 84);
  // Spirit Pulse 1: ratio 80 -> 39, Ghost vs Water 1 = 100 %, MDEF 5: 39 x 1005 / 1050 = 37
  assert.equal(magicAttack(p, mobStatus(MOB_BY_ID.get(1002)!), magicSkillHit(S("MG_NAPALMBEAT"), 1, {})).dmg, 37);
});

test("Heal (skill_calc_heal RENEWAL): (BaseLv + INT) / 5 x 30 x lv / 10 + status MATK roll; half against Undead", () => {
  // Lv 50 INT 50 DEX 1 LUK 1: 100 / 5 = 20 x 30 = 600 x 10 / 10 = 600; MATK 50 + 25 + 0 + 0 + 12 = 87
  const src = { level: 50, int: 50, matkStatus: 87, rhw: { matk: 0, wlv: 0 }, overrefine: 0 };
  assert.equal(healAmount(10, src), 687);
  assert.equal(healAmount(10, src, false), 387);
  assert.equal(healAmount(1, src), 60 + 87);
  assert.equal(healAmount(11, src), 9999); // max_heal_lv
});

test("cast conditions (skill_check_condition_castbegin): SP, HP, zeny, weapon, ammo, SC_WEIGHT90", () => {
  const u = { hp: 100, sp: 50, zeny: 1000, weaponType: "Bow", ammo: { subType: "Arrow", amount: 10 }, overweight: false };
  assert.equal(skillCondition(S("AC_DOUBLE"), 1, u), null);
  assert.equal(skillCondition(S("AC_DOUBLE"), 1, { ...u, ammo: null }), "ammo");
  assert.equal(skillCondition(S("AC_DOUBLE"), 1, { ...u, weaponType: "Dagger" }), "weapon");
  assert.equal(skillCondition(S("AC_DOUBLE"), 1, { ...u, sp: 11 }), "sp");
  assert.equal(skillCondition(S("AC_DOUBLE"), 1, { ...u, overweight: true }), "weight");
  assert.equal(skillCondition(S("MC_MAMMONITE"), 10, { ...u, weaponType: "Dagger", zeny: 999 }), "zeny");
  assert.equal(skillCondition(S("SM_BASH"), 1, { ...u, weaponType: "Bow" }), "weapon"); // Bash lists every type but Bow
});

test("equipment sweep (map_quit / pc_jobchange / pc_baselevelchanged): pc_isequip failures come off, the bow takes its arrows", () => {
  const worn = [{ uid: 1, itemId: 1702, equip: "weapon" as const }, { uid: 2, itemId: 1750, equip: "ammo" as const }, { uid: 3, itemId: 2301, equip: "armor" as const }];
  assert.deepEqual(equipSweep(worn, "Archer", 10), []);
  assert.deepEqual(equipSweep(worn, "Novice", 10), [1, 2]); // Bow: Archer / Thief only; the arrows follow it (pc_unequipitem flag 2)
  // Rod (Novice / Mage / Acolyte) stays on a Mage, the Knife comes off an Acolyte
  assert.deepEqual(equipSweep([{ uid: 5, itemId: 1601, equip: "weapon" }], "Mage", 10), []);
  assert.deepEqual(equipSweep([{ uid: 6, itemId: 1201, equip: "weapon" }], "Acolyte", 10), [6]);
  // EquipLevelMax (pc_isequip FAILLEVEL): only that test on a base level up
  const capped = new Map(ITEMS); capped.set(2301, { ...ITEMS.get(2301)!, equipLevelMax: 10 });
  assert.deepEqual(equipSweep(worn, "Archer", 11, true, capped), [3]);
  assert.deepEqual(equipSweep(worn, "Novice", 11, true, capped), [3]); // the job test is not part of a level-up sweep
  assert.equal(equipBlock(capped.get(2301)!, "Archer", 11), "only up to base level 10");
});

test("skill hotkeys: struct hotkey type 1 (id + lv) kept in the slot list", () => {
  const k = skillHotkey(SKILL_ID.MG_FIREBOLT, 3);
  assert.deepEqual(hotkeySkill(k), { id: SKILL_ID.MG_FIREBOLT, lv: 3 });
  assert.equal(hotkeySkill(-1), null); // the sit action
  assert.equal(hotkeySkill(501), null); // an item
  const list = hotkeyList([k, skillHotkey(9999, 1), -1]);
  assert.equal(list[0], k);
  assert.equal(list[1], null); // unknown skill
  assert.equal(list[2], -1);
});

test("passive skills in status_calc_pc: Keen Eye +DEX (status.cpp:4283), Evasion +3 FLEE after the rate (4517), Far Sight bow range (4485)", () => {
  const base = { level: 1, jobLevel: 1, stats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 } };
  // Thief Lv1 AGI 1 LUK 1: FLEE 1 + 1 + 0 + 100 = 102, + Evasion 10 x 3 = 132
  assert.equal(playerStatus({ ...base, job: "Thief", passives: { miss: 10 } }).flee, 132);
  // Archer Keen Eye 10: DEX 1 -> 11, HIT 1 + 11 + 0 + 175 = 187
  const owl = playerStatus({ ...base, job: "Archer", passives: { owl: 10 } });
  assert.equal(owl.stats.dex, 11); assert.equal(owl.hit, 187); assert.equal(owl.bonus.dex, 10);
  const bow = { atk: 15, atk2: 0, matk: 0, overrefine: 0, level: 1, type: "Bow", element: "Neutral" as const, range: 5 };
  assert.equal(playerStatus({ ...base, job: "Archer", weapon: bow, passives: { vulture: 3 } }).rhw.range, 8);
  assert.equal(playerStatus({ ...base, job: "Archer", weapon: STARTER_WEAPON, passives: { vulture: 3 } }).rhw.range, 1);
});

test("passive skills: Blade/Greatblade Practice, Fiendbane, Sacred Ward, Second Wind / Mana Well (battle_addmastery, battle_calc_defense, status_calc_regen)", () => {
  const b = { job: "Swordman" as const, level: 40, jobLevel: 10, stats: { str: 10, agi: 5, vit: 10, int: 5, dex: 5, luk: 5 } };
  const sword = playerStatus({ ...b, weapon: STARTER_WEAPON, passives: { sword: 10, twohand: 5 } });
  assert.equal(sword.masteryAtk, 40); // Dagger: SM_SWORD 10 x 4 (battle.cpp:2338)
  const two = playerStatus({ ...b, weapon: { ...STARTER_WEAPON, type: "2hSword" }, passives: { sword: 10, twohand: 5 } });
  assert.equal(two.masteryAtk, 20); // 2hSword: SM_TWOHAND 5 x 4 (battle.cpp:2344)
  assert.equal(playerStatus({ ...b, weapon: { ...STARTER_WEAPON, type: "Bow" }, passives: { sword: 10 } }).masteryAtk, 0);
  // Fiendbane 10 at base 40 vs an Undead-element monster: (int)(10 * (40 / 20 + 3)) = 50; none vs a Brute or a player
  const bane = playerStatus({ ...b, weapon: STARTER_WEAPON, passives: { demonbane: 10 } });
  const undead = { ...mobStatus(MOB_BY_ID.values().next().value!), element: "Undead" as const };
  assert.equal(passiveMastery(bane, undead, { type: BL.MOB, targeted: 1 }), 50);
  assert.equal(passiveMastery(bane, undead, { type: BL.PC, targeted: 1 }), 0);
  assert.equal(passiveMastery(bane, { ...undead, element: "Neutral", race: "Brute" }, { type: BL.MOB, targeted: 1 }), 0);
  assert.equal(passiveMastery(bane, { ...undead, element: "Neutral", race: "Demon" }, { type: BL.MOB, targeted: 1 }), 50);
  // Sacred Ward 5 at base 50 vs an Undead attacker: (int)((50 / 25 + 3) * 5 + 0.5) = 25; base 30, lv 10: (int)((1.2 + 3) * 10 + 0.5) = 42
  const dp5 = playerStatus({ ...b, level: 50, passives: { dp: 5 } }), dp10 = playerStatus({ ...b, level: 30, passives: { dp: 10 } });
  assert.equal(passiveDefense(undead, dp5), 25);
  assert.equal(passiveDefense(undead, dp10), 42);
  assert.equal(passiveDefense({ ...undead, element: "Neutral" }, dp5), 0);
  // Second Wind 10 with 1000 max HP: 10 * 5 + 10 * 1000 / 500 = 70; Mana Well 5 with 200 max SP: 5 * 3 + 5 * 200 / 500 = 17
  assert.equal(skillRegen(10, 5, 1000), 70);
  assert.equal(skillRegen(5, 3, 200), 17);
  assert.equal(skillRegen(0, 5, 1000), 0);
});

test("skills that do nothing yet are flagged later but take points like rAthena (2.5.0); only unknown ids are refunded", () => {
  assert.equal(skillReady(SKILL_ID.SM_BASH), true);
  assert.equal(skillReady(SKILL_ID.SM_SWORD), true);
  assert.equal(skillReady(SKILL_ID.MG_FIREWALL), false); // B14 unlocked Provoke / Endure / Blessing ... (status_change.ts); Fire Wall, Warp ... later
  assert.equal(skillReady(SKILL_ID.SM_PROVOKE), true);
  assert.equal(skillReady(SKILL_ID.AL_WARP), false);
  // 2.5.0: a prerequisite of a working skill takes points (Ruwach -> Lex Divina) but stays "later"
  assert.equal(skillReady(SKILL_ID.AL_RUWACH), false); assert.equal(skillLearnable(SKILL_ID.AL_RUWACH), true); assert.equal(skillLearnable(SKILL_ID.MG_FIREWALL), true);
  const learned = { [SKILL_ID.NV_BASIC]: 9 };
  assert.equal(skillUpBlock("Merchant", learned, 10, 10, 3, SKILL_ID.MC_INCCARRY), null); // 2.5.0: every tree skill takes points (effect later)
  assert.equal(skillUpBlock("Swordman", learned, 10, 10, 3, SKILL_ID.SM_SWORD), null);
  const e = skillList("Merchant", learned, 10, 10, 3).find((x) => x.id === SKILL_ID.MC_INCCARRY)!;
  assert.equal(e.later, true); assert.equal(e.upgradable, true);
  assert.deepEqual(refundUnready({ ...learned, [SKILL_ID.MG_FIREWALL]: 3, [SKILL_ID.AL_WARP]: 2, [SKILL_ID.AL_RUWACH]: 1, [SKILL_ID.SM_BASH]: 5, 99999: 2 }), { 99999: 2 }); // only unknown ids
});
