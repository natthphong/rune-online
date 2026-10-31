// Golden tests for the race / element / size / class modifiers that cards and gear give a normal attack ("cardfix"), worked out by
// hand from the rAthena Renewal source: battle_calc_cardfix (battle.cpp:769-1218, BF_WEAPON: the attacker's side 940-1087, the
// target's 1089-1153, APPLY_CARDFIX 806), its callers in battle_calc_weapon_attack (the attacker's bonuses on weapon / equipment ATK
// 5495-5497, the target player's on each part 5504-5519 and on a monster's whole damage 5751-5758), battle_calc_damage_parts (percent
// ATK taken before the card fix, 3889-3944), pc_bonus2 (pc.cpp:4498: SP_ADDELE 4503 ... SP_SUBCLASS 4549, SP_SUBSIZE 4806,
// SP_WEAPON_SUBSIZE 4811, SP_SUBDEF_ELE 5070, PC_BONUS_CHK_* 3101-3109) and status_calc_pc_sub's lr_flag per equipment piece
// (status.cpp:4025-4052). Every number below is plain integer arithmetic on the fixture's stats; the derivation is in the comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOBS, MOB_BY_ID, RACES, ELEMENTS, SIZES, MOB_CLASSES, type Stats } from "./data.ts";
import { mobStatus, playerStatus, type Status } from "./status.ts";
import { ATK, BATTLE_CONF, BF, BL, CARDFIX_LEFT, NK_NONE, applyCardfix, battleCalcCardfix, mobAttack, playerAttack, type Target } from "./battle.ts";
import { ITEMS, gearOf, weaponOf, type GearItem } from "./items.ts";
import { INDEXED_BONUS, INDEXED_NAMES, PC_BONUS2, bonus2Type2, emptyIndexed, isSupportedBonus2, noBonus, pcBonus2, scriptBonus, type ItemBonus } from "./bonus.ts";

const fixed = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };
const vsMob: Target = { type: BL.MOB, targeted: 1 }, vsPc: Target = { type: BL.PC, targeted: 1 };
const MELEE = BF.WEAPON | BF.NORMAL | BF.SHORT, SHOT = BF.WEAPON | BF.NORMAL | BF.LONG;
const ones: Stats = { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 };
/** An item_db row as status sees it, `bonuses` in the importer's items.json form. */
const gear = (type: string, subType: string | null, loc: string[], bonuses: ItemBonus[] = [], atk = 0): GearItem =>
  ({ type, subType, atk, matk: 0, def: 0, weaponLevel: 0, armorLevel: 0, refineable: false, element: "Neutral", locations: loc, bonuses });
/** An armor piece worn at `loc` (Armor, Garment, Shoes, Head_Top, Left_Hand ...) whose script is these statements. */
const piece = (loc: string, ...bonuses: ItemBonus[]) => gear("Armor", null, [loc], bonuses);
const ammo = (...bonuses: ItemBonus[]) => gear("Ammo", "Arrow", ["Ammo"], bonuses, 25);
/** `bonus2 type,type2,value;` as the importer stores it. */
const b2 = (type: string, type2: string, value: number): ItemBonus => ({ type, type2, value });
const wear = (...items: GearItem[]) => gearOf(items.map((item) => ({ item, refine: 0 })));
const KNIFE = ITEMS.get(1201)!, BOW = ITEMS.get(1702)!, ARROW = ITEMS.get(1750)!;
const mob = (id: number) => mobStatus(MOB_BY_ID.get(id)!);
const TUMHOG = 1063, MOSSPAW = 1167, PUDDLEBLOOM = 1002;

// ---------- the attacker: a Novice Lv10 STR 9 DEX 9 with a Knife ----------
// batk = (9*10 + 9*10/5 + 1*10/3 + 10*10/4) / 10 = (90 + 18 + 3 + 25) / 10 = 13 -> status ATK 26. Knife (ATK 17, wlv 1): variance
// 5*17/100 = 0.85, STR bonus 17*9/200 = 0.765 -> weapon ATK 16..18; the rolls below take the top, 18 (crit roll 999 of 4: no crit, hit
// roll 0, weapon roll .999). Tumhog (Brute, Small, Neutral 3, Normal, DEF 18, def2 (3 + 3) / 2 = 3): Dagger vs Small 100%, Neutral
// vs Neutral 100%, so 26 + 18 = 44 -> trunc(44 * 4018 / 4180) = 42 - 3 = 39.
const A: Stats = { str: 9, agi: 1, vit: 1, int: 1, dex: 9, luk: 1 };
const fighter = (...items: GearItem[]) => playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats: A, ...wear(KNIFE, ...items) });
const TOP = () => fixed(0.999, 0, 0.999), CRIT = () => fixed(0);
const hit = (s: Status, id: number, rolls = TOP()) => playerAttack(s, weaponOf(KNIFE), mob(id), vsMob, rolls);
const dmg = (s: Status, id: number, rolls = TOP()) => hit(s, id, rolls).dmg;

test("bonus2 bAddRace on weapon ATK: the critic's Brute card, 39 -> 42 (APPLY_CARDFIX 806, weapon ATK 5496)", () => {
  assert.equal(dmg(fighter(), TUMHOG), 39);
  // bonus2 bAddRace,RC_Brute,20: cardfix 1000 * (100 + 20) / 100 = 1200; APPLY_CARDFIX: 18 - trunc(18 * (1000 - 1200) / 1000) = 18 + 3 = 21
  // (trunc(-3.6) = -3), so 26 + 21 = 47 -> trunc(47 * 4018 / 4180) = 45 - 3 = 42
  const brute = fighter(piece("Garment", b2("bAddRace", "Brute", 20)));
  assert.deepEqual(brute.addRace, { Brute: 20 });
  assert.deepEqual(hit(brute, TUMHOG), { dmg: 42, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: MELEE });
  assert.equal(dmg(fighter(piece("Garment", b2("bAddRace", "Plant", 20))), TUMHOG), 39); // another race: nothing
  assert.deepEqual([dmg(brute, PUDDLEBLOOM), dmg(fighter(), PUDDLEBLOOM)], [37, 37]); // a Plant: the Brute card does nothing
  // RC_ALL counts against any race: All 20 -> 1200 -> 42. It adds to the race's own slot inside the same step: All 10 + Brute 20 = 30 ->
  // 1300: 18 + trunc(5.4) = 23 -> 26 + 23 = 49 -> trunc(49 * 4018 / 4180) = 47 - 3 = 44
  assert.equal(dmg(fighter(piece("Garment", b2("bAddRace", "All", 20))), TUMHOG), 42);
  assert.equal(dmg(fighter(piece("Garment", b2("bAddRace", "All", 10), b2("bAddRace", "Brute", 20))), TUMHOG), 44);
  // a critical hit takes the same weapon ATK; DEF first, then floor((float)(damage * 1.4f)): 42 -> 58 (39 -> 54 without the card)
  assert.deepEqual([hit(fighter(), TUMHOG, CRIT()).dmg, hit(brute, TUMHOG, CRIT()).dmg, hit(brute, TUMHOG, CRIT()).crit], [54, 58, true]);
});

test("bAddEle / bAddSize / bAddClass: the target's defense element, size and class (battle.cpp:1021-1053)", () => {
  const one = (type: string, type2: string, value: number) => dmg(fighter(piece("Garment", b2(type, type2, value))), TUMHOG);
  // element: Tumhog is Neutral 3. 1200 -> weapon 21 -> 42; Ele_All counts the same; any other element nothing
  assert.deepEqual([one("bAddEle", "Neutral", 20), one("bAddEle", "All", 20), one("bAddEle", "Fire", 20)], [42, 42, 39]);
  // size: Small. 1150: 18 + trunc(2.7) = 20 -> 46 -> trunc(46 * 4018 / 4180) = 44 - 3 = 41; Size_All too; Large / Medium nothing
  assert.deepEqual([one("bAddSize", "Small", 15), one("bAddSize", "All", 15), one("bAddSize", "Large", 15), one("bAddSize", "Medium", 15)], [41, 41, 39, 39]);
  // class: Tumhog is a Normal monster (status->class_ from mob_db Class, default Normal). 1250: 18 + trunc(4.5) = 22 -> 48 -> 46 - 3 = 43
  assert.deepEqual([one("bAddClass", "Normal", 25), one("bAddClass", "All", 25), one("bAddClass", "Boss", 25), one("bAddClass", "Guardian", 25)], [43, 43, 39, 39]);
  // the same card against a Boss-class monster (class_ comes from the mob row)
  const boss = { ...mob(TUMHOG), class_: "Boss" as const };
  const card = fighter(piece("Garment", b2("bAddClass", "Boss", 25)));
  assert.equal(playerAttack(card, weaponOf(KNIFE), boss, vsMob, TOP()).dmg, 43);
  assert.equal(playerAttack(fighter(), weaponOf(KNIFE), boss, vsMob, TOP()).dmg, 39);
});

test("several cards stack step by step, each truncated: element, race, size, class (battle.cpp:1044-1053)", () => {
  // Tumhog takes all four: cardfix 1000 -> element 20: 1200 -> race 20: 1440 -> size 15: 1656 -> class 25: 2070.
  // 18 + trunc(18 * 1070 / 1000) = 18 + 19 = 37 -> 26 + 37 = 63 -> trunc(63 * 4018 / 4180) = 60 - 3 = 57
  const set = fighter(piece("Garment", b2("bAddEle", "Neutral", 20)), piece("Shoes", b2("bAddRace", "Brute", 20)),
    piece("Armor", b2("bAddSize", "Small", 15)), piece("Head_Top", b2("bAddClass", "Normal", 25)));
  assert.equal(dmg(set, TUMHOG), 57);
  // the same set on one piece, or split another way, is the same: the tables add up per kind whatever carries them
  assert.equal(dmg(fighter(piece("Armor", b2("bAddEle", "Neutral", 20), b2("bAddRace", "Brute", 20), b2("bAddSize", "Small", 15), b2("bAddClass", "Normal", 25))), TUMHOG), 57);
  // two cards of one kind add inside the step (they are not two steps): Brute 10 + Brute 10 = 20 -> 42, not 1100 * 1.1 = 1210
  assert.equal(dmg(fighter(piece("Garment", b2("bAddRace", "Brute", 10)), piece("Shoes", b2("bAddRace", "Brute", 10))), TUMHOG), 42);
  // real monsters, one card set: Brute 20 / Plant 10 / Fish 30, Water 25 / Fire 15, Small 15 / Medium 5. Each monster takes what fits it.
  // Dagger vs Medium 75%: weapon ATK 18 -> 13. Puddlebloom (Plant, Water, Medium): ele 25 -> 1250, race 10 -> 1375, size 5 -> 1443: 13 + 5 = 18.
  const sweep = fighter(piece("Garment", b2("bAddRace", "Brute", 20), b2("bAddRace", "Plant", 10), b2("bAddRace", "Fish", 30)),
    piece("Shoes", b2("bAddEle", "Water", 25), b2("bAddEle", "Fire", 15)), piece("Armor", b2("bAddSize", "Small", 15), b2("bAddSize", "Medium", 5)));
  const plain = fighter();
  // (the field's first eight species, the ones worked out below; C11's newer ones are covered in cards.test.ts)
  const FIRST_EIGHT = new Set([1002, 1113, 1063, 1049, 1010, 1009, 1012, 1167]);
  assert.deepEqual(MOBS.filter((m) => FIRST_EIGHT.has(m.id)).map((m) => [m.id, m.race, m.size, m.element, dmg(plain, m.id), dmg(sweep, m.id)]), [
    [1002, "Plant", "Medium", "Water", 37, 42], // factor 1443
    [1113, "Plant", "Medium", "Fire", 36, 40], // 1150, 1265, 1328
    [1063, "Brute", "Small", "Neutral", 39, 45], // 1000, 1200, 1380
    [1010, "Plant", "Medium", "Earth", 27, 29], // 1000, 1100, 1155
    [1049, "Brute", "Small", "Fire", 33, 42], // 1150, 1380, 1587 (real Picky: DEF 21)
    [1009, "Brute", "Medium", "Wind", 29, 32], // 1000, 1200, 1260
    [1012, "Fish", "Medium", "Water", 29, 38], // 1250, 1625, 1706
    [1167, "Brute", "Small", "Earth", 30, 36], // 1000, 1200, 1380
  ]);
});

test("weapon ATK and equipment ATK are card-fixed on their own; ATK% is not (battle.cpp:5496-5497, 3935-3939)", () => {
  // bBaseAtk 7 = equipment ATK, bAtkRate 10: percent ATK = trunc((18 + 7) * 10 / 100) = 2, taken before the card fix and never fixed.
  // Brute 20 (1200): weapon 18 -> 21, equipment 7 -> 7 + trunc(1.4) = 8 (not 25 * 1.2 = 30). 26 + 21 + 8 + 2 = 57 -> 54 - 3 = 51.
  const stats = [{ type: "bBaseAtk", value: 7 }, { type: "bAtkRate", value: 10 }] as ItemBonus[];
  assert.equal(dmg(fighter(piece("Shoes", ...stats)), TUMHOG), 47); // 26 + 18 + 7 + 2 = 53 -> 50 - 3
  assert.equal(dmg(fighter(piece("Shoes", ...stats, b2("bAddRace", "Brute", 20))), TUMHOG), 51);
  // status ATK is never card-fixed (a card on the whole 26 + 18 would give 52 before DEF, not 47). A negative card lowers weapon ATK:
  // -30 -> 700: 18 - trunc(5.4) = 13 -> 39 -> trunc(39 * 4018 / 4180) = 37 - 3 = 34. A factor of 0 or less (-100 and under; -150 is
  // 1000 * (100 - 150) / 100 = -500, which APPLY_CARDFIX reads as 0) zeroes it and never goes below: 26 -> 24 - 3 = 21
  const minus = (v: number) => dmg(fighter(piece("Garment", b2("bAddRace", "Brute", v))), TUMHOG);
  assert.deepEqual([minus(-30), minus(-100), minus(-150)], [34, 21, 21]);
});

test("pieces in any slot add to the right-hand tables, a shield's too (pc_bonus2 under LR_FLAG_NONE / LR_FLAG_SHIELD, pc.cpp:4503-4535)", () => {
  const card = (n: number) => b2("bAddRace", "Brute", n);
  const guard = { ...ITEMS.get(2101)!, bonuses: [card(10)] }; // Guard: a shield in EQI_HAND_L runs its script with LR_FLAG_SHIELD
  const withShield = wear(KNIFE, guard, piece("Garment", card(10)));
  assert.equal(withShield.shield, true);
  assert.deepEqual(withShield.equip.addRace, { Brute: 20 }); // right_weapon.addrace gets the shield's too
  assert.equal(dmg(fighter(guard, piece("Garment", card(10))), TUMHOG), 42);
  // the weapon's own script (LR_FLAG_NONE) counts as well
  const myKnife = { ...KNIFE, bonuses: [card(20)] };
  const s = playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats: A, ...wear(myKnife) });
  assert.equal(dmg(s, TUMHOG), 42);
});

// ---------- ranged: Archer Lv10 STR 5 AGI 5 VIT 5 INT 1 DEX 30 LUK 1, Bow + Arrow ----------
// batk 33 -> status ATK 66. Bow (ATK 15, wlv 1): variance 0.75, DEX bonus 15 * 30 / 200 = 2.25 -> 16..18, top 18; Bow vs Medium 100%.
// Arrow ATK 25 is equipment ATK. Puddlebloom (Plant, Water 1, Medium, DEF 2, def2 1): 66 + 18 + 25 = 109 -> trunc(109 * 4002 / 4020) = 108 - 1 = 107.
const AR: Stats = { str: 5, agi: 5, vit: 5, int: 1, dex: 30, luk: 1 };
const archer = (...items: GearItem[]) => playerStatus({ job: "Archer", level: 10, jobLevel: 1, stats: AR, ...wear(...items) });
const shot = (s: Status, id: number) => playerAttack(s, weaponOf(BOW), mob(id), vsMob, TOP());

test("a shot: the right-hand tables and the ammo's arrow_add* tables, in the shot's step order (battle.cpp:943-970)", () => {
  assert.deepEqual(shot(archer(BOW, ARROW), PUDDLEBLOOM), { dmg: 107, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: SHOT });
  // armor with Plant 20 (right_weapon.addrace): 1200 -> weapon 18 -> 21, arrow ATK 25 -> 25 + 5 = 30; 66 + 21 + 30 = 117 -> 116 - 1 = 115
  const armor = piece("Garment", b2("bAddRace", "Plant", 20));
  assert.equal(shot(archer(BOW, ARROW, armor), PUDDLEBLOOM).dmg, 115);
  // the ammo's own `bonus2 bAddRace,RC_Plant,10;` runs under LR_FLAG_ARROW: it goes to arrow_addrace and joins the race step of a shot:
  // 20 + 10 = 30 -> 1300: weapon 18 + 5 = 23, arrow 25 + trunc(7.5) = 32; 66 + 23 + 32 = 121 -> 120 - 1 = 119 together with the armor's
  const plantArrow = ammo(b2("bAddRace", "Plant", 10));
  assert.deepEqual([archer(BOW, plantArrow).arrowAddRace, archer(BOW, plantArrow).addRace], [{ Plant: 10 }, {}]);
  // alone it is 10 -> 1100: weapon 18 + trunc(1.8) = 19, arrow 25 + trunc(2.5) = 27; 66 + 19 + 27 = 112 -> trunc(112 * 4002 / 4020) = 111 - 1 = 110
  assert.equal(shot(archer(BOW, plantArrow), PUDDLEBLOOM).dmg, 110);
  assert.equal(shot(archer(BOW, plantArrow, armor), PUDDLEBLOOM).dmg, 119);
  // race 20 (armor), element Water 15 (the ammo's bAddEle), size Medium 10 (armor): race 1200, element 1380, size 1518 (class none).
  // weapon 18 + trunc(9.324) = 27, arrow 25 + trunc(12.95) = 37; 66 + 27 + 37 = 130 -> trunc(130 * 4002 / 4020) = 129 - 1 = 128
  const full = archer(BOW, ammo(b2("bAddEle", "Water", 15)), armor, piece("Shoes", b2("bAddSize", "Medium", 10)));
  assert.equal(shot(full, PUDDLEBLOOM).dmg, 128);
  // a melee attack never reads the ammo's tables: an Archer with a Knife and arrows worn hits as if they weren't there (37), while a
  // right-hand table still counts for it: Plant 20 -> weapon 13 + trunc(2.6) = 15, 26 + 15 = 41 -> 40 - 1 = 39 (Knife vs Medium 75%)
  const stab = (s: Status) => playerAttack(s, weaponOf(KNIFE), mob(PUDDLEBLOOM), vsMob, TOP()).dmg;
  assert.deepEqual([stab(archer(KNIFE, ARROW)), stab(archer(KNIFE, plantArrow)), stab(archer(KNIFE, plantArrow, armor))], [37, 37, 39]);
});

// ---------- the target: a player hit by a monster ----------
// Mosspaw (Brute, Small, Earth 1, Normal; ATK 5 -> 4..5 with the roll at 0, batk 16 + 14 = 30) on a Novice Lv1 (def 0, def2 1; FLEE 102):
// lucky roll 999, hit roll 0 (HIT 185 vs 102), ATK roll 0 -> 34 -> DEF 33.
const defender = (...items: GearItem[]) => playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...wear(KNIFE, ...items) });
const struck = (s: Status, m = mob(MOSSPAW)) => mobAttack(m, s, vsPc, fixed(0.999, 0, 0));

test("a player's damage-taken bonuses against a monster's race, element, size and class (battle.cpp:1089-1153, 5751-5758)", () => {
  assert.equal(struck(defender()).dmg, 33);
  const one = (type: string, type2: string, value: number, m = mob(MOSSPAW)) => struck(defender(piece("Garment", b2(type, type2, value))), m).dmg;
  // bSubRace Brute 30 (the critic's case): cardfix 700 -> 33 - trunc(33 * 300 / 1000) = 24; RC_ALL counts, another race doesn't
  assert.deepEqual([one("bSubRace", "Brute", 30), one("bSubRace", "All", 30), one("bSubRace", "Plant", 30)], [24, 24, 33]);
  // bSubEle: the attack's own element, a monster's is Neutral (no rhw.ele in mob.cpp): 800 -> 33 - 6 = 27; Fire does nothing
  assert.deepEqual([one("bSubEle", "Neutral", 20), one("bSubEle", "All", 20), one("bSubEle", "Fire", 20)], [27, 27, 33]);
  // bSubDefEle: the attacker's DEFENSE element (Mosspaw is Earth): 750 -> 33 - trunc(8.25) = 25
  assert.deepEqual([one("bSubDefEle", "Earth", 25), one("bSubDefEle", "All", 25), one("bSubDefEle", "Water", 25)], [25, 25, 33]);
  // bSubSize / bWeaponSubSize: the attacker's size (Small): 850 -> 33 - 4 = 29; 800 -> 27
  assert.deepEqual([one("bSubSize", "Small", 15), one("bSubSize", "All", 15), one("bSubSize", "Large", 15), one("bWeaponSubSize", "Small", 20)], [29, 29, 33, 27]);
  // bSubClass: Normal 900 -> 33 - 3 = 30; a Boss-class attacker 600 -> 33 - trunc(13.2) = 20
  const boss = { ...mob(MOSSPAW), class_: "Boss" as const };
  assert.deepEqual([one("bSubClass", "Normal", 10), one("bSubClass", "Boss", 40), one("bSubClass", "Boss", 40, boss), one("bSubClass", "All", 40, boss)], [30, 33, 20, 20]);
  // a negative bonus raises the damage: bSubEle Neutral -50 -> 1500: 33 - trunc(33 * -500 / 1000) = 33 + 16 = 49
  assert.equal(one("bSubEle", "Neutral", -50), 49);
  // 100 and over leaves nothing: the hit becomes ATK_MISS (shown as Miss, nothing applied)
  assert.deepEqual(struck(defender(piece("Garment", b2("bSubRace", "Brute", 100)))), { dmg: 0, crit: false, miss: true, lucky: false, dmgLv: ATK.MISS, flag: MELEE });
  assert.equal(one("bSubRace", "Brute", 150), 0);
  // another real monster: Puddlebloom (Plant, Water 1, Medium; ATK 1 -> 0..1, roll 0; batk 6 + 1 = 7) hits a Novice Lv1 for 7 - def2 1 = 6.
  // Plant 30 / Medium 30 (700): 6 - trunc(1.8) = 5; Water 50 (500): 6 - 3 = 3
  const pud = mob(PUDDLEBLOOM), plantHit = (...b: ItemBonus[]) => struck(defender(piece("Garment", ...b)), pud).dmg;
  assert.equal(plantHit(), 6);
  assert.deepEqual([plantHit(b2("bSubRace", "Plant", 30)), plantHit(b2("bSubDefEle", "Water", 50)), plantHit(b2("bSubSize", "Medium", 30))], [5, 3, 5]);
});

test("the defender's steps in order: bSubEle, bSubDefEle, bSubSize, bWeaponSubSize, bSubRace, bSubClass, bNearAtkDef (battle.cpp:1091-1150)", () => {
  // Mosspaw (Neutral attack, Earth, Small, Brute, Normal) against Neutral 20, Earth 25, Small 15, Brute 30, Normal 10, near 10:
  // 1000 -> 800 -> 600 -> 510 -> 510 (no bWeaponSubSize) -> 357 -> 321 -> 288; 33 - trunc(33 * 712 / 1000) = 33 - 23 = 10
  const stack = defender(piece("Garment", b2("bSubEle", "Neutral", 20), b2("bSubDefEle", "Earth", 25), b2("bSubSize", "Small", 15)),
    piece("Shoes", b2("bSubRace", "Brute", 30), b2("bSubClass", "Normal", 10), { type: "bNearAtkDef", value: 10 }));
  assert.equal(struck(stack).dmg, 10);
  // each step truncates, and bWeaponSubSize has its own step after bSubSize: with it at 5 and the race at 31 the chain is
  // 1000 -> 800 -> 600 -> 510 -> 484 (510 * 95 / 100 = 484.5) -> 333 (484 * 69 / 100 = 333.96) -> 299 -> 269: 33 - trunc(33 * 731 / 1000) = 33 - 24 = 9
  const longer = defender(piece("Garment", b2("bSubEle", "Neutral", 20), b2("bSubDefEle", "Earth", 25), b2("bSubSize", "Small", 15), b2("bWeaponSubSize", "Small", 5)),
    piece("Shoes", b2("bSubRace", "Brute", 31), b2("bSubClass", "Normal", 10), { type: "bNearAtkDef", value: 10 }));
  assert.equal(struck(longer).dmg, 9);
  // a monster with an attack range above 3 is BF_LONG (here Mosspaw with range 9): bLongAtkDef joins after the race instead of bNearAtkDef.
  // Brute 30, long 50, near 80: far 1000 -> 700 -> 350: 33 - trunc(33 * 650 / 1000) = 33 - 21 = 12; melee 700 -> 140: 33 - 28 = 5
  const far = { ...mob(MOSSPAW), rhw: { ...mob(MOSSPAW).rhw, range: 9 } };
  const ranged = defender(piece("Garment", b2("bSubRace", "Brute", 30), { type: "bLongAtkDef", value: 50 }, { type: "bNearAtkDef", value: 80 }));
  assert.equal(struck(ranged, far).flag, SHOT);
  assert.deepEqual([struck(ranged, far).dmg, struck(ranged).dmg], [12, 5]);
});

// ---------- player -> player: the card fix runs on each part ----------
// Novice Lv1 (status ATK 2) with a Knife, rolls lucky 999, crit 999, hit 0, weapon .5 -> 17 -> Dagger vs Medium 75% = 12: 2 + 12 = 14 -> 13.
const novice = (...items: GearItem[]) => playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...wear(KNIFE, ...items) });
const duel = (a: Status, d: Status) => playerAttack(a, weaponOf(KNIFE), d, vsPc, fixed(0.999, 0.999, 0, 0.5)).dmg;

test("player vs player: both sides, per ATK part, status ATK without the element bonuses (battle.cpp:5504-5512)", () => {
  assert.equal(duel(novice(), novice()), 13);
  // attacker Player_Human 20 (weapon 12 -> 14), defender Player_Human 30 on every part (14 -> 10, status 2 -> 2): 12 -> 11
  const ph = (type: string, n: number) => piece("Garment", b2(type, "Player_Human", n));
  assert.equal(duel(novice(ph("bAddRace", 20)), novice(ph("bSubRace", 30))), 11);
  // bSubEle reads the attack's element (the attacker's weapon: a Fire bAtkEle) and skips the status ATK part (NK_IGNOREELEMENT):
  // weapon 12 - trunc(12 * 500 / 1000) = 6, status 2 -> 8 -> 7. (Taken off the 14 whole it would be 14 - 7 = 7 -> 6.)
  const fire = piece("Shoes", { type: "bAtkEle", value: "Fire" });
  assert.equal(duel(novice(fire), novice(piece("Garment", b2("bSubEle", "Fire", 50)))), 7);
  assert.equal(duel(novice(), novice(piece("Garment", b2("bSubEle", "Fire", 50)))), 13); // a Neutral weapon: nothing
  // bSubDefEle reads the attacker's armor element (bDefEle Fire): weapon 12 - 4 = 8, status 2 -> 10 -> 9
  const fireArmor = piece("Armor", { type: "bDefEle", value: "Fire" });
  assert.equal(duel(novice(fireArmor), novice(piece("Garment", b2("bSubDefEle", "Fire", 40)))), 9);
  // bSubSize Medium 30 (a player is Medium) applies to the status ATK part too: 2 -> 2, 12 -> 9: 11 -> 10 (on the whole 14 it would be 9)
  assert.equal(duel(novice(), novice(piece("Garment", b2("bSubSize", "Medium", 30)))), 10);
  // Fire weapon with size 30 and race 30: weapon (element 50 -> 500, size 350, race 245) 12 - trunc(12 * 755 / 1000) = 3,
  // status (size 700, race 490) 2 - 1 = 1: 4 -> 3
  const combo = novice(piece("Garment", b2("bSubEle", "Fire", 50), b2("bSubSize", "Medium", 30), b2("bSubRace", "Player_Human", 30)));
  assert.equal(duel(novice(fire), combo), 3);
});

// ---------- the function itself ----------
test("battleCalcCardfix: APPLY_CARDFIX, the step rounding, left / NK_* gates, left_cardfix_to_right (battle.cpp:780, 806, 940-1087)", () => {
  assert.deepEqual([[1000, 1000], [1000, 1200], [1000, 700], [18, 1200], [33, 700], [1000, 0], [1000, -400], [5, 1999]].map(([d, f]) => applyCardfix(d, f)), [1000, 1200, 700, 21, 24, 0, 0, 9]);
  const tum = mob(TUMHOG); // Brute, Small, Neutral, Normal
  const withTables = (equip: Partial<ReturnType<typeof noBonus>>) => playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats: A, equip });
  const call = (att: Status, nk = NK_NONE, d = 1000, flag = MELEE, left: number = CARDFIX_LEFT.ATTACKER, arrow = false) =>
    battleCalcCardfix({ status: att, type: BL.PC, arrowAtk: arrow }, { status: tum, type: BL.MOB }, nk, "Neutral", d, left, flag);
  // four 5% steps from 1000: 1050, 1102 (1102.5), 1157 (1157.1), 1214 (1214.85): 1000 -> 1214; the product at once would give 1215
  const four = withTables({ addEle: { Neutral: 5 }, addRace: { Brute: 5 }, addSize: { Small: 5 }, addClass: { Normal: 5 } });
  assert.equal(call(four), 1214);
  assert.equal(call(four, NK_NONE, 100), 121); // 100 + trunc(100 * 214 / 1000)
  assert.equal(call(four, NK_NONE, 0), 0); // `if (!damage) return 0`
  // the gates: left bit 2 selects the attacker's side; a monster as src has no tables; NK_IGNOREATKCARD skips it
  assert.equal(call(four, NK_NONE, 1000, MELEE, CARDFIX_LEFT.TARGET), 1000);
  assert.equal(call(four, { ignoreAtkCard: true }), 1000);
  assert.equal(battleCalcCardfix({ status: four, type: BL.MOB }, { status: tum, type: BL.MOB }, NK_NONE, "Neutral", 1000, CARDFIX_LEFT.ATTACKER, MELEE), 1000);
  // NK_IGNOREELEMENT: right and left as one (left_cardfix_to_right, the official 1) applies the element bonus anyway (1021-1022), a shot
  // and each hand on its own skip it (946, 978)
  const ele = withTables({ addEle: { Neutral: 20 } });
  assert.deepEqual([call(ele), call(ele, { ignoreElement: true })], [1200, 1200]);
  assert.equal(BATTLE_CONF.left_cardfix_to_right, true);
  assert.equal(battleCalcCardfix({ status: ele, type: BL.PC }, { status: tum, type: BL.MOB }, { ignoreElement: true }, "Neutral", 1000, CARDFIX_LEFT.ATTACKER, MELEE,
    { ...BATTLE_CONF, left_cardfix_to_right: false }), 1000);
  assert.deepEqual([call(ele, NK_NONE, 1000, SHOT, CARDFIX_LEFT.ATTACKER, true), call(ele, { ignoreElement: true }, 1000, SHOT, CARDFIX_LEFT.ATTACKER, true)], [1200, 1000]);
  // the ammo's tables count only for a shot
  const arrowOnly = withTables({ arrowAddRace: { Brute: 30 } });
  assert.deepEqual([call(arrowOnly), call(arrowOnly, NK_NONE, 1000, SHOT, CARDFIX_LEFT.ATTACKER, true)], [1000, 1300]);
  // the target side: only for a player target, gated by NK_IGNOREDEFCARD; BF_LONG reads bLongAtkDef unless NK_IGNORELONGCARD
  const tgt = withTables({ subRace: { Brute: 40 }, nearAtkDef: 10, longAtkDef: 50 });
  const back = (nk = NK_NONE, flag = MELEE, type: number = BL.PC) =>
    battleCalcCardfix({ status: tum, type: BL.MOB }, { status: tgt, type }, nk, "Neutral", 1000, CARDFIX_LEFT.TARGET, flag);
  assert.deepEqual([back(), back(NK_NONE, SHOT), back({ ignoreLongCard: true }, SHOT), back({ ignoreDefCard: true }), back(NK_NONE, MELEE, BL.MOB)], [1000 - 460, 1000 - 700, 1000 - 400, 1000, 1000]);
  // (1000 * 60 / 100 = 600, * 90 / 100 = 540: 1000 - trunc(1000 * 460 / 1000); long: 600 * 50 / 100 = 300)
});

test("indexed bonus tables: pc_bonus2 rows, lr_flag routes, type2 checks and the importer's constant names (pc.cpp:4503-4549, 4806-4811, 5070)", () => {
  // every row names an existing table; an arrow route stays within the same kind of index
  for (const [name, rule] of Object.entries(PC_BONUS2)) {
    assert.ok(INDEXED_NAMES.includes(rule.table), name);
    if (typeof rule.arrow === "string") assert.equal(INDEXED_BONUS[rule.arrow], INDEXED_BONUS[rule.table], name);
  }
  assert.deepEqual(Object.keys(emptyIndexed()), INDEXED_NAMES);
  for (const n of ["bAddRace", "bAddEle", "bAddSize", "bAddClass", "bSubRace", "bSubEle", "bSubSize", "bSubClass", "bSubDefEle", "bWeaponSubSize", "bCriticalAddRace"])
    assert.ok(isSupportedBonus2(n), n);
  assert.equal(isSupportedBonus2("bIgnoreDefRaceRate"), false);
  // constants -> mob_db spellings, per kind (script constants are case-insensitive)
  assert.deepEqual(["RC_DemiHuman", "RC_Player_Doram", "RC_All", "rc_formless"].map((c) => bonus2Type2("bAddRace", c)), ["Demihuman", "Player_Doram", "All", "Formless"]);
  assert.deepEqual(["Ele_Neutral", "ELE_UNDEAD", "Ele_All"].map((c) => bonus2Type2("bSubEle", c)), ["Neutral", "Undead", "All"]);
  assert.deepEqual(["Size_Small", "Size_Large", "SIZE_ALL"].map((c) => bonus2Type2("bAddSize", c)), ["Small", "Large", "All"]);
  assert.deepEqual(["Class_Normal", "Class_Boss", "Class_Guardian", "Class_Battlefield", "Class_Event", "Class_All"].map((c) => bonus2Type2("bAddClass", c)),
    ["Normal", "Boss", "Guardian", "Battlefield", "Event", "All"]);
  // a constant of another kind, or that CHK_* refuses (CLASS_NONE, CLASS_MAX, ELE_WEAPON, SZ_MAX), is not a type2
  assert.deepEqual([bonus2Type2("bAddRace", "Ele_Fire"), bonus2Type2("bAddEle", "RC_Brute"), bonus2Type2("bAddClass", "Class_None"), bonus2Type2("bAddClass", "Class_Max"),
    bonus2Type2("bSubEle", "Ele_Weapon"), bonus2Type2("bAddSize", "Size_Max"), bonus2Type2("bAddSize", "Size_Medium2"), bonus2Type2("bFoo", "RC_Brute")],
    [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  // the lists the constants resolve against are the data.ts ones
  assert.deepEqual([RACES.length, ELEMENTS.length, SIZES.length, MOB_CLASSES.length], [12, 10, 3, 5]);
  // pc_bonus2: one table per lr_flag. add* under none / shield -> right hand, under the ammo -> arrow_add*; sub* nothing under the ammo,
  // except bSubDefEle (no lr_flag test)
  const b = noBonus();
  assert.equal(pcBonus2(b, "bAddRace", "Brute", 5, "none") && pcBonus2(b, "bAddRace", "Brute", 3, "shield") && pcBonus2(b, "bAddRace", "Brute", 2, "arrow"), true);
  assert.deepEqual([b.addRace, b.arrowAddRace], [{ Brute: 8 }, { Brute: 2 }]);
  assert.equal(pcBonus2(b, "bSubRace", "Brute", 5, "none") && pcBonus2(b, "bSubRace", "Brute", 7, "arrow") && pcBonus2(b, "bSubRace", "Brute", -2, "shield"), true);
  assert.deepEqual(b.subRace, { Brute: 3 });
  assert.equal(pcBonus2(b, "bSubDefEle", "Fire", 10, "arrow") && pcBonus2(b, "bSubDefEle", "Fire", 5, "none"), true);
  assert.deepEqual(b.subDefEle, { Fire: 15 });
  assert.deepEqual([b.addEle, b.addSize, b.addClass, b.subEle, b.subSize, b.subClass, b.weaponSubSize, b.critAddRace], [{}, {}, {}, {}, {}, {}, {}, {}]);
  // a type2 outside the case's kind is refused (PC_BONUS_CHK_*) and changes nothing; so is an unknown bonus
  const c = noBonus();
  assert.deepEqual([pcBonus2(c, "bAddRace", "Fire", 5), pcBonus2(c, "bAddEle", "Brute", 5), pcBonus2(c, "bAddClass", "Large", 5), pcBonus2(c, "bAddSize", "Boss", 5),
    pcBonus2(c, "bAddRace", "brute", 5), pcBonus2(c, "bAddRace", "RC_Brute", 5), pcBonus2(c, "bHPDrainRate", "Brute", 5)], [false, false, false, false, false, false, false]);
  assert.deepEqual(c, noBonus());
  // the script dispatch (buildin_bonus) with the importer's rows; val is an int
  assert.equal(scriptBonus(c, b2("bAddClass", "Boss", 25)) && scriptBonus(c, b2("bSubSize", "All", -5), "shield") && pcBonus2(c, "bAddEle", "Fire", 2.7), true);
  assert.deepEqual([c.addClass, c.subSize, c.addEle], [{ Boss: 25 }, { All: -5 }, { Fire: 2 }]);
});

test("data: a monster's class_ is its mob_db Class, its attack element Neutral, its tables empty; players are Normal / Medium / Player_Human", () => {
  for (const m of MOBS) {
    const s = mobStatus(m);
    assert.ok((MOB_CLASSES as readonly string[]).includes(m.class), m.name);
    assert.deepEqual([s.class_, s.rhw.ele], [m.class, "Neutral"], m.name); // no rhw.ele in mob.cpp: the mob_db Element is def_ele
    assert.deepEqual(INDEXED_NAMES.map((n) => s[n]), INDEXED_NAMES.map(() => ({})), m.name); // a monster has no sd, so no bonus tables
  }
  assert.deepEqual([mobStatus(MOB_BY_ID.get(PUDDLEBLOOM)!).element, mobStatus(MOB_BY_ID.get(PUDDLEBLOOM)!).class_], ["Water", "Normal"]); // the defense element stays what mob_db says
  const p = defender();
  assert.deepEqual([p.class_, p.size, p.race, p.element], ["Normal", "Medium", "Player_Human", "Neutral"]);
  // a Status owns its tables: changing one doesn't reach the equipment state it was built from
  const g = wear(KNIFE, piece("Garment", b2("bAddRace", "Brute", 20)));
  const s = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: ones, ...g });
  s.addRace.Brute = 99;
  assert.deepEqual(g.equip.addRace, { Brute: 20 });
});
