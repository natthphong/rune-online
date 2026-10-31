// Golden tests for weapon range, ammo and a player's line of attack. Expectations worked out by hand from the rAthena Renewal
// source: status_calc_pc_sub (wa->range, the EQI_AMMO pass), pc_bonus under LR_FLAG_ARROW, status_base_atk /
// status_base_amotion_pc (DEX weapons), pc_isequip / pc_equipitem / pc_unequipitem (ammo), battle_weapon_attack (ammo check,
// battle_consume_ammo), battle_calc_damage_parts + battle_calc_equip_attack (arrow ATK / element), is_attack_critical /
// is_attack_hitting (arrow cri / hit) and unit_attack_timer_sub (OFFICIAL_WALKPATH straight line, reach).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOB_BY_ID, type Stats } from "./data.ts";
import { FISTS, mobStatus, pcBaseAspd, playerStatus } from "./status.ts";
import { ATK, BATTLE_CONF, BF, BL, consumedAmmo, critDamage, hitChance, playerAttack, weaponAttackAmmo } from "./battle.ts";
import { EQI, ITEMS, ammoOffForWeapon, ammoOffWithWeapon, eqiOf, equipBlock, gearOf, isEquip, slotsOf, weaponOf, type GearItem } from "./items.ts";
import { noBonus, pcBonus, type ItemBonus } from "./bonus.ts";
import { checkAddItem, isStackable, slotsNeeded } from "./shop.ts";
import { AMMO_USERS, DEX_WEAPONS, SHOOTING_WEAPONS } from "./weapons.ts";
import { pcAttackStep } from "./unit.ts";
import type { GameMap } from "../map.ts";

const fixed = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };
const vsMob = { type: BL.MOB, targeted: 1 };
/** initialize_weapon_data flag of a normal attack that shoots ammo (battle.cpp:5313-5317): BF_WEAPON | BF_NORMAL | BF_LONG */
const SHOT = BF.WEAPON | BF.NORMAL | BF.LONG;
/** An rAthena item_db row as status sees it (ids cite the source row in db/re/item_db_equip.yml / item_db_etc.yml). */
const ra = (type: string, subType: string, o: { atk?: number; wlv?: number; range?: number; loc: string[] }, bonuses: ItemBonus[] = []): GearItem =>
  ({ type, subType, atk: o.atk ?? 0, matk: 0, def: 0, weaponLevel: o.wlv ?? 0, armorLevel: 0, refineable: type === "Weapon",
    element: "Neutral", locations: o.loc, bonuses, range: o.range });
const wear = (...items: GearItem[]) => gearOf(items.map((item) => ({ item, refine: 0 })));
const BOW = ITEMS.get(1702)!, ARROW = ITEMS.get(1750)!, KNIFE = ITEMS.get(1201)!;
const ROPE = ra("Weapon", "Whip", { atk: 45, wlv: 1, range: 2, loc: ["Right_Hand"] }); // 1950 Rope
const VIOLIN = ra("Weapon", "Musical", { atk: 50, wlv: 1, range: 1, loc: ["Right_Hand"] }); // 1901 Violin
const SIX_SHOOTER = ra("Weapon", "Revolver", { atk: 30, wlv: 1, range: 7, loc: ["Both_Hand"] }, [{ type: "bHit", value: -10 }]); // 13100
const FIRE_ARROW = ra("Ammo", "Arrow", { atk: 30, loc: ["Ammo"] }, [{ type: "bAtkEle", value: "Fire" }]); // 1752 Fire_Arrow
// Archer Lv10 / Job 1 (no job bonus before job level 2): STR 5 AGI 5 VIT 5 INT 1 DEX 30 LUK 1
const A: Stats = { str: 5, agi: 5, vit: 5, int: 1, dex: 30, luk: 1 };
const archer = (...items: GearItem[]) => playerStatus({ job: "Archer", level: 10, jobLevel: 1, stats: A, ...wear(...items) });

test("data: Arrow 1750 is ammo (Type Ammo / SubType Arrow, ATK 25, Locations Ammo, the Archer + Thief lines incl. 2nd / trans jobs) and sold by the merchant", () => {
  assert.deepEqual([ARROW.type, ARROW.subType, ARROW.atk, ARROW.weight, ARROW.buy, ARROW.locations, ARROW.jobs, ARROW.shop],
    ["Ammo", "Arrow", 25, 1, 1, ["Ammo"], ["Archer", "Thief", "Hunter", "Bard", "Dancer", "Assassin", "Rogue", "Archer_High", "Thief_High", "Sniper", "Clown", "Gypsy", "Assassin_Cross", "Stalker"], true]);
  assert.deepEqual([BOW.subType, BOW.range, KNIFE.range], ["Bow", 5, 1]); // item_db Range
  // itemdb_isequip2 (weapon / armor / ammo are worn) but item_data::isStackable (only weapon / armor never stack)
  assert.deepEqual([isEquip(ARROW), isStackable(ARROW), slotsNeeded(ARROW, 500), isStackable(KNIFE)], [true, true, 1, false]);
  assert.deepEqual([slotsOf(ARROW), eqiOf(ARROW)], [["ammo"], EQI.AMMO]);
  // pc_checkadditem matches the item alone: bought arrows join the equipped stack
  assert.equal(checkAddItem([{ itemId: 1750, amount: 100, equip: "ammo" }], ARROW, 50), "exist");
});

test("status rhw.range = the weapon's item Range + bAtkRange, at least 1 (status.cpp:3989, 4216; pc_bonus SP_ATTACKRANGE)", () => {
  assert.equal(archer().rhw.range, 1); // bare hands: wa->range 0 -> 1
  assert.equal(playerStatus({ job: "Archer", level: 10, jobLevel: 1, stats: A, weapon: FISTS }).rhw.range, 1);
  assert.equal(archer(KNIFE).rhw.range, 1);
  assert.equal(archer(BOW).rhw.range, 5);
  assert.equal(archer(ROPE).rhw.range, 2);
  assert.equal(archer(SIX_SHOOTER).rhw.range, 7);
  assert.equal(weaponOf(BOW).range, 5);
  // SP_ATTACKRANGE: the switch's default branch (LR_FLAG_NONE and LR_FLAG_SHIELD) adds to rhw.range
  const hat = ra("Armor", "", { loc: ["Head_Top"] }, [{ type: "bAtkRange", value: 1 }]);
  const guard = { ...ITEMS.get(2101)!, bonuses: [{ type: "bAtkRange", value: 2 }] };
  assert.equal(archer(BOW, hat).rhw.range, 6);
  assert.equal(archer(KNIFE, guard).rhw.range, 3);
  assert.equal(mobStatus(MOB_BY_ID.get(1002)!).rhw.range, 1); // monsters: mob_db AttackRange
});

test("ammo pass: arrow ATK -> arrow_atk, its script under LR_FLAG_ARROW (status.cpp:4042-4052, pc.cpp:3817-3896, 3943-3955)", () => {
  const g = wear(BOW, ARROW);
  assert.deepEqual([g.ammo, g.equip.arrowAtk, g.equip.rhw.atk, g.equip.def, g.equip.rhw.ele], ["Arrow", 25, 15, 0, "Neutral"]);
  assert.deepEqual(archer(BOW, ARROW).arrow, { atk: 25, hit: 0, cri: 0, ele: "Neutral" });
  assert.deepEqual(wear(ARROW, BOW), g); // EQI_AMMO runs after the loop whatever the stack order: the bow is known by then
  assert.deepEqual([wear(BOW).ammo, archer(BOW).arrow], [null, { atk: 0, hit: 0, cri: 0, ele: "Neutral" }]);
  // SP_ATKELE under LR_FLAG_ARROW: with W_BOW .. W_GRENADE it becomes the weapon element, otherwise the arrow element
  assert.deepEqual([archer(BOW, FIRE_ARROW).rhw.ele, archer(BOW, FIRE_ARROW).arrow!.ele], ["Fire", "Neutral"]);
  assert.deepEqual([archer(ROPE, FIRE_ARROW).rhw.ele, archer(ROPE, FIRE_ARROW).arrow!.ele], ["Neutral", "Fire"]);
  // SP_HIT / SP_CRITICAL -> arrow_hit / arrow_cri (x10); SP_ATTACKRANGE only with a shooting weapon; every other case skipped
  const odd = ra("Ammo", "Arrow", { atk: 10, loc: ["Ammo"] }, [{ type: "bHit", value: 10 }, { type: "bCritical", value: 2 }, { type: "bStr", value: 5 },
    { type: "bDef", value: 3 }, { type: "bAtk", value: 7 }, { type: "bDefEle", value: "Ghost" }, { type: "bAtkRange", value: 1 }, { type: "bMaxHP", value: 50 }]);
  const s = archer(BOW, odd), base = archer(BOW);
  assert.deepEqual(s.arrow, { atk: 10, hit: 10, cri: 20, ele: "Neutral" });
  assert.deepEqual([s.hit, s.cri, s.stats.str, s.def, s.rhw.atk, s.element, s.maxHp], [base.hit, base.cri, 5, base.def, 15, "Neutral", base.maxHp]);
  assert.equal(s.rhw.range, 6); // Bow 5 + the arrow's bAtkRange 1
  assert.equal(archer(ROPE, odd).rhw.range, 2); // a whip doesn't shoot: the arrow's bAtkRange writes nothing
  // pc_bonus itself: a modelled case that writes nothing under LR_FLAG_ARROW still reports true
  const b = noBonus();
  assert.equal(pcBonus(b, "bHit", 10, "arrow", "Bow"), true);
  assert.equal(pcBonus(b, "bFlee", 10, "arrow", "Bow"), true);
  assert.equal(pcBonus(b, "bAtkEle", "Holy", "arrow", "Whip"), true);
  assert.deepEqual(b, { ...noBonus(), arrowHit: 10, arrowEle: "Holy" });
});

test("DEX weapons (bow, instrument, whip, guns): status ATK swaps STR/DEX, ASPD takes DEX²/7 (status.cpp:2372-2386, 2436-2446)", () => {
  assert.deepEqual([...DEX_WEAPONS].sort(), ["Bow", "Gatling", "Grenade", "Musical", "Revolver", "Rifle", "Shotgun", "Whip"]);
  // Archer Lv10: (DEX 30 * 10 + STR 5 * 10 / 5 + LUK 1 * 10 / 3 + Lv 10 * 10 / 4) / 10 = (300 + 10 + 3 + 25) / 10 = 33
  for (const w of [BOW, ROPE, VIOLIN, SIX_SHOOTER]) assert.equal(archer(w).batk, 33, String(w.subType));
  assert.equal(archer(KNIFE).batk, 13); // a dagger keeps STR: (50 + 300 / 5 + 3 + 25) / 10 = 138 / 10
  // status_base_amotion_pc, Thief (no Whip column -> aspd_base 200; Dagger 48), DEX 30 AGI 5:
  // DEX weapon: sqrt(900 / 7 + 25 * 0.5) = sqrt(141.07) = 11.877 -> * 0.25 + 196 = 198.97 -> 198 - min(200, 200) = -2
  // dagger:     sqrt(900 / 5 + 12.5)     = sqrt(192.5)  = 13.874 -> * 0.25 + 196 = 199.47 -> 199 - 48 = 151
  assert.equal(pcBaseAspd("Thief", A, weaponOf(ROPE)), -2);
  assert.equal(pcBaseAspd("Thief", A, weaponOf(KNIFE)), 151);
  // Bow kept its branch: Archer Bow column 50 -> 198 - 50 = 148
  assert.equal(pcBaseAspd("Archer", A, weaponOf(BOW)), 148);
});

test("battle_weapon_attack: a bow / gun normal attack needs its ammo in EQI_AMMO, else ATK_NONE (battle.cpp:7161-7205)", () => {
  assert.deepEqual(Object.keys(SHOOTING_WEAPONS).sort(), ["Bow", "Gatling", "Grenade", "Revolver", "Rifle", "Shotgun"]); // arrow_atk, 7163
  assert.equal(weaponAttackAmmo("Bow", null), "noArrow"); // clif_arrow_fail(ARROWFAIL_NO_AMMO)
  assert.equal(weaponAttackAmmo("Bow", "Bullet"), "noArrow"); // wrong subtype: still ARROWFAIL_NO_AMMO
  assert.equal(weaponAttackAmmo("Bow", "Arrow"), null);
  assert.equal(weaponAttackAmmo("Revolver", null), "needBullet"); // W_KATAR < type < W_HUUMA: USESKILL_FAIL_NEED_MORE_BULLET
  assert.equal(weaponAttackAmmo("Rifle", "Arrow"), "needBullet");
  assert.equal(weaponAttackAmmo("Grenade", "Bullet"), null); // RENEWAL: the grenade launcher fires AMMO_BULLET
  for (const t of ["Fist", "Dagger", "Musical", "Whip", "1hSword"]) assert.equal(weaponAttackAmmo(t, null), null, t); // not arrow_atk
  // battle_consume_ammo: one per normal attack (qty 1) while arrow_decrement is on
  assert.equal(BATTLE_CONF.arrow_decrement, 1);
  assert.equal(consumedAmmo(), 1);
  assert.equal(consumedAmmo({ ...BATTLE_CONF, arrow_decrement: 0 }), 0);
});

test("arrow attack: arrow ATK joins equipment ATK, its element the weapon's (battle_calc_equip_attack 3439-3444, damage parts)", () => {
  // Archer Lv10 (batk 33, HIT 215, CRI 14) + Bow 1702 (ATK 15, wlv 1) vs Puddlebloom 1002 (Water 1, Medium, FLEE 102, DEF 2,
  // def2 (1 + 1) / 2 = 1, LUK 5). Hit rate 215 - 102 -> capped 100; crit chance 14 - 5 * 2 = 4 per mille: a 0.999 roll misses it.
  // Weapon ATK: variance 5 * 15 * 1 / 100 = 0.75, DEX bonus 15 * 30 / 200 = 2.25 -> [16, 18]; the 0.999 roll takes 18
  // (size fix Bow / Medium 100). Status ATK 33 * 2 = 66 (neutral).
  const m = mobStatus(MOB_BY_ID.get(1002)!), top = fixed(0.999, 0, 0.999);
  // no ammo (battle_weapon_attack would refuse it; the calculation alone): 66 + 18 = 84 -> trunc(84 * 4002 / 4020) = 83 - 1 = 82
  assert.equal(playerAttack(archer(BOW), weaponOf(BOW), m, vsMob, top).dmg, 82);
  // + Arrow (arrow_atk 25, Neutral -> Water 100%): 66 + 18 + 25 = 109 -> trunc(436218 / 4020) = 108 - 1 = 107
  assert.deepEqual(playerAttack(archer(BOW, ARROW), weaponOf(BOW), m, vsMob, fixed(0.999, 0, 0.999)), { dmg: 107, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: SHOT });
  // + Fire Arrow (ATK 30, its bAtkEle makes rhw.ele Fire; Fire -> Water 1 = 90%): weapon 18 - trunc(1.8) = 17,
  // equip 30 - 3 = 27: 66 + 17 + 27 = 110 -> trunc(440220 / 4020) = 109 - 1 = 108
  assert.equal(playerAttack(archer(BOW, FIRE_ARROW), weaponOf(BOW), m, vsMob, fixed(0.999, 0, 0.999)).dmg, 108);
  // critical (roll 0 < 4): weapon max 18, 109 -> 107 -> floor((float)(107 * 1.4f)) = floor(149.80000305) = 149
  assert.deepEqual(playerAttack(archer(BOW, ARROW), weaponOf(BOW), m, vsMob, fixed(0)), { dmg: 149, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: SHOT });
  assert.equal(critDamage(107), 149);
  // a whip doesn't shoot (no arrow_atk): Rope 1950 (ATK 45, DEX bonus 45 * 30 / 200 = 6.75, variance 2.25 -> [49, 54]), the arrow
  // adds nothing: 66 + 54 = 120 -> trunc(480240 / 4020) = 119 - 1 = 118
  assert.equal(playerAttack(archer(ROPE, ARROW), weaponOf(ROPE), m, vsMob, fixed(0.999, 0, 0.999)).dmg, 118);
});

test("arrow hit / crit count only for an attack that shoots the ammo (battle.cpp:3050-3053, 3284-3285)", () => {
  const m = mobStatus(MOB_BY_ID.get(1002)!);
  const sharp = ra("Ammo", "Arrow", { atk: 25, loc: ["Ammo"] }, [{ type: "bCritical", value: 2 }]); // arrow_cri 20
  // crit chance (14 + 20) - 5 * 2 = 24 per mille: the roll 0.02 -> 20 crits; weapon max 18: 66 + 18 + 25 = 109 -> 107 -> 149
  assert.deepEqual(playerAttack(archer(BOW, sharp), weaponOf(BOW), m, vsMob, fixed(0.02)), { dmg: 149, crit: true, miss: false, lucky: false, dmgLv: ATK.DEF, flag: SHOT });
  // plain Arrow: 20 >= 4, no crit; hit roll 2 < 100; weapon 16 + floor(0.06) = 16: 66 + 16 + 25 = 107 -> trunc(428214 / 4020) = 106 - 1 = 105
  assert.deepEqual(playerAttack(archer(BOW, ARROW), weaponOf(BOW), m, vsMob, fixed(0.02)), { dmg: 105, crit: false, miss: false, lucky: false, dmgLv: ATK.DEF, flag: SHOT });
  // the whip ignores the arrow's crit: 20 >= 4; weapon 49 + floor(0.12) = 49: 66 + 49 = 115 -> trunc(460230 / 4020) = 114 - 1 = 113
  assert.equal(playerAttack(archer(ROPE, sharp), weaponOf(ROPE), m, vsMob, fixed(0.02)).dmg, 113);
  // arrow_hit: against FLEE 200 the hit rate is 215 - 200 = 15, + 10 = 25 with the arrow; the roll 0.2 -> 20 hits only with it
  const evasive = { ...m, flee: 200 };
  const aim = ra("Ammo", "Arrow", { atk: 25, loc: ["Ammo"] }, [{ type: "bHit", value: 10 }]);
  assert.equal(hitChance(archer(BOW, aim), evasive, vsMob, archer(BOW, aim).arrow!.hit), 25);
  assert.equal(playerAttack(archer(BOW, aim), weaponOf(BOW), evasive, vsMob, fixed(0.2)).miss, false);
  assert.equal(playerAttack(archer(BOW, ARROW), weaponOf(BOW), evasive, vsMob, fixed(0.2)).miss, true);
});

test("pc_isequip ammo (pc.cpp:1897-1928, order: level, ammo, job) and ammo_unequip (pc.cpp:12201-12226, 12461-12479)", () => {
  assert.equal(equipBlock(ARROW, "Archer", 10, "Bow"), null);
  assert.equal(equipBlock(ARROW, "Archer", 10, "Fist"), "equip a bow, instrument or whip first"); // MSI_FAIL_NEED_EQUIPPED_BOW
  assert.equal(equipBlock(ARROW, "Archer", 10, "Dagger"), "equip a bow, instrument or whip first");
  assert.equal(equipBlock(ARROW, "Thief", 10, "Whip"), null); // AMMO_ARROW: W_BOW, W_MUSICAL, W_WHIP
  assert.equal(equipBlock(ARROW, "Novice", 10, "Bow"), "Fledgling can't use this"); // passes the ammo check, fails the job
  assert.equal(equipBlock(BOW, "Novice", 1), "requires base level 4"); // ITEM_EQUIP_ACK_FAILLEVEL comes before the job
  assert.equal(equipBlock(BOW, "Archer", 4), null);
  // pc_equipitem: a new weapon that can't use the worn ammo takes it off
  assert.deepEqual(["Dagger", "Bow", "Whip", "Musical", "Revolver"].map((w) => ammoOffForWeapon(w, "Arrow")), [true, false, false, false, true]);
  assert.deepEqual([ammoOffForWeapon("Bow", "Bullet"), ammoOffForWeapon("Grenade", "Bullet"), ammoOffForWeapon("Dagger", "Shuriken")], [true, false, false]);
  // pc_unequipitem: taking off a bow / instrument / whip / gun takes the ammo with it
  assert.deepEqual([...AMMO_USERS].sort(), ["Bow", "Gatling", "Grenade", "Musical", "Revolver", "Rifle", "Shotgun", "Whip"]);
  assert.deepEqual(["Bow", "Whip", "Rifle", "Dagger", "Fist"].map(ammoOffWithWeapon), [true, true, true, false, false]);
});

/** A w x h map whose only blocked cells are the listed ones (plus nothing else: no edge needed for these lines). */
function openMap(w: number, h: number, blocked: [number, number][] = []): GameMap {
  const m: GameMap = { w, h, height: new Float32Array(w * h), kind: new Uint8Array(w * h), blocked: new Uint8Array(w * h), props: [] };
  for (const [x, y] of blocked) m.blocked[y * w + x] = 1;
  return m;
}

test("unit_attack_timer_sub, OFFICIAL_WALKPATH: a wall on the straight line drops the attack before any range check", () => {
  const P = { x: 20, y: 20 }, at = (x: number, y: number) => ({ x, y });
  // path_search_long (20,20)->(24,20) visits (21,20) (22,20) (23,20): the wall at (22,20) blocks -> unit_unattackable
  assert.equal(pcAttackStep(openMap(40, 40, [[22, 20]]), P, at(24, 20), 1, false), "drop");
  assert.equal(pcAttackStep(openMap(40, 40), P, at(24, 20), 1, false), "chase"); // clear: client distance trunc(3.9) = 3 > 1
  // (22,20) is within a Knife's reach (client distance trunc(2 - 0.1) = 1) but (21,20) is a wall: still dropped
  assert.equal(pcAttackStep(openMap(40, 40, [[21, 20]]), P, at(22, 20), 1, false), "drop");
  assert.equal(pcAttackStep(openMap(40, 40), P, at(22, 20), 1, false), "swing");
  // (20,20)->(26,23): weight 6, wy += 3 per step -> (21,20) then (22,21), a wall
  assert.equal(pcAttackStep(openMap(40, 40, [[22, 21], [23, 21], [24, 22]]), P, at(26, 23), 1, false), "drop");
  // a wall beside the line doesn't matter; neighbours have no cell between them
  assert.equal(pcAttackStep(openMap(40, 40, [[22, 21]]), P, at(24, 20), 1, false), "chase");
  assert.equal(pcAttackStep(openMap(40, 40, [[21, 20], [20, 21]]), P, at(21, 21), 1, false), "swing");
  // Bow (rhw.range 5) on the client's circle: straight 6 cells = trunc(5.9) = 5 -> in reach; 7 cells only while the target walks
  assert.equal(pcAttackStep(openMap(40, 40), P, at(26, 20), 5, false), "swing");
  assert.equal(pcAttackStep(openMap(40, 40), P, at(27, 20), 5, false), "chase");
  assert.equal(pcAttackStep(openMap(40, 40), P, at(27, 20), 5, true), "swing"); // range++ for a walking target
  assert.equal(pcAttackStep(openMap(40, 40), P, at(24, 24), 5, false), "swing"); // trunc(sqrt(32) - 0.1) = 5
  assert.equal(pcAttackStep(openMap(40, 40, [[23, 20]]), P, at(25, 20), 5, false), "drop"); // in reach, line blocked
  // in reach by a 15-cell weapon but beyond area_size 14: battle_check_range fails
  assert.equal(pcAttackStep(openMap(40, 40), at(5, 20), at(20, 20), 15, false), "drop");
});
