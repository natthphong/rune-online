// Renewal normal (non-skill) attack, re-implemented from rAthena src/map/battle.cpp (RENEWAL branches):
// initialize_weapon_data (BF_SHORT / BF_LONG), battle_calc_weapon_attack (check order: lucky dodge -> crit -> hit -> infinite
// defense), is_attack_critical / is_attack_hitting, battle_calc_damage_parts (player: status ATK x2 + weapon ATK),
// battle_calc_base_weapon_attack (weapon variance + STR/DEX bonus + size fix), battle_attr_fix (attr_fix.yml), the player's
// crit / range damage rates, battle_calc_cardfix (the attacker's race / element / size / class bonuses on weapon and equipment ATK,
// the target player's damage-taken bonuses on each part), battle_calc_defense_reduction + battle_calc_attack_post_defense (min 1)
// for a non-zero total, then the critical x1.4 and battle_calc_attack's ATK_MISS for a result below 1. Monsters take the
// battle_calc_base_damage path instead; plants take battle_calc_attack_plant. Skills and masteries arrive in later MVPs.
import { beastBane } from "./skills2.ts";
import { TABLES, type Element, type Size } from "./data.ts";
import type { MobStatus, Status, Weapon } from "./status.ts";
import { applyRate } from "./penalty.ts";
import { MD, hasMode } from "./mode.ts";
import { DEX_WEAPONS, SHOOTING_WEAPONS, shootsAmmo, type AmmoFail } from "./weapons.ts";

/** bl_type bits (rathena src/map/map.hpp), used by the battle.conf "who does this apply to" masks (Note 3). */
export const BL = { PC: 0x001, MOB: 0x002, PET: 0x004, HOM: 0x008, MER: 0x010, NPC: 0x080, ELEM: 0x200 } as const;

/** enum damage_lv (battle.hpp:24): how an attack ended. battle_damage applies only dmg_lv > ATK_BLOCK (battle.cpp:337-361): below
 *  it the target loses no HP, isn't stopped (no walk delay) and no mob_attacked timer starts. */
export const ATK = { NONE: 0, LUCKY: 1, FLEE: 2, MISS: 3, BLOCK: 4, DEF: 5 } as const;
export type DamageLv = (typeof ATK)[keyof typeof ATK];

/** enum e_battle_flag (battle.hpp:43), Damage::flag: the attack's kind (weapon / magic / misc), its range (short / long) and
 *  whether a skill or a normal attack made it. */
export const BF = { WEAPON: 0x0001, MAGIC: 0x0002, MISC: 0x0004, SHORT: 0x0010, LONG: 0x0040, SKILL: 0x0100, NORMAL: 0x0200 } as const;

/** conf/battle/battle.conf values (rAthena defaults, battle.cpp battle_data[]). Keys keep the conf names. */
export const BATTLE_CONF = {
  min_hitrate: 5,
  max_hitrate: 100,
  // Multi-attacker FLEE penalty: once agi_penalty_count units target the defender, FLEE drops by agi_penalty_num
  // (type 1: percent, type 2: flat) per unit from the count on. Applies to the unit types in agi_penalty_target.
  agi_penalty_type: 1,
  agi_penalty_target: BL.PC,
  agi_penalty_count: 3,
  agi_penalty_num: 10,
  // Same for hard DEF (def1) and soft DEF (def2); def2 is floored at 1 whenever the penalty applies to the unit type.
  vit_penalty_type: 1,
  vit_penalty_target: BL.PC,
  vit_penalty_count: 3,
  vit_penalty_num: 5,
  // Normal-attack timing (battle_delay_damage / battle_calc_walkdelay). area_size lives in client.conf.
  delay_battle_damage: true,
  synchronize_damage: false,
  snap_dodge: false,
  area_size: 14,
  multihit_delay: 200,
  pc_damage_walk_delay_rate: 20,
  damage_walk_delay_rate: 100,
  // Ammo (battle.conf, battle.cpp battle_data[]): 1 = a bow / gun normal attack uses up one of the equipped ammo
  // (battle_consume_ammo); ammo comes off with a bow / instrument / whip / gun or when the new weapon can't use it
  // (pc_equipitem / pc_unequipitem); ammo can only be put on with a weapon that uses it (pc_isequip).
  arrow_decrement: 1,
  ammo_unequip: true,
  ammo_check_weapon: true,
  // conf/battle/player.conf:20: 1 = a left-hand weapon's cards and elements count for the right-hand attack as one (battle_calc_cardfix
  // adds them into the same steps, battle.cpp:1020-1054); 0 = each hand on its own (975-1017). Matters for the order of the steps.
  left_cardfix_to_right: true,
};
export const MIN_HITRATE = BATTLE_CONF.min_hitrate, MAX_HITRATE = BATTLE_CONF.max_hitrate;

/** Who is being hit: its bl_type bit (BL.PC / BL.MOB) and unit_counttargeted (how many units hold it as attack target). */
export type Target = { type: number; targeted: number };

export type Rng = () => number; // [0, 1)
const rnd = (r: Rng, n: number) => Math.floor(r() * n); // rAthena rnd() % n
const f32 = Math.fround; // the C++ does these steps in `float`
const UINT16_MAX = 65535;

/** battle_attr_fix (battle.cpp:708-712, RENEWAL): damage - trunc(damage * (100 - ratio) / 100), so reductions round down
 *  and increases add trunc(damage * (ratio - 100) / 100). A negative ratio is clamped to 0 (attr_recover 0, flag 0). */
export function attrFix(dmg: number, atk: Element, def: Element, defLevel: number) {
  const pct = Math.max(0, TABLES.attr[String(defLevel)]?.[atk]?.[def] ?? 100);
  return dmg - Math.trunc((dmg * (100 - pct)) / 100);
}

/** status_calc_pc atkmods from size_fix_db (status.cpp:4226-4235): the Renewal table is db/size_fix.yml + its db/re overlay
 *  (merged by the importer); a weapon type with no row keeps 100. Applied in battle_calc_sizefix (battle.cpp:2427-2433). */
export function sizeFix(weaponType: string, size: Size) {
  return TABLES.size[weaponType]?.[size] ?? 100;
}

/** agi_penalty (is_attack_hitting, battle.cpp:3265-3276): the defender's FLEE once agi_penalty_count or more units target
 *  it. With n attackers, k = n - (count - 1): type 1 -> flee * (100 - k * num) / 100, type 2 -> flee - k * num; min 1.
 *  Below the count, or for unit types outside agi_penalty_target, FLEE is unchanged. */
export function agiPenaltyFlee(flee: number, tgt?: Target, c = BATTLE_CONF) {
  if (!tgt || !c.agi_penalty_type || !(c.agi_penalty_target & tgt.type)) return flee;
  const n = Math.min(tgt.targeted, 255); // unit_data.target_count is capped at 255 (unit_set_target)
  if (n < c.agi_penalty_count) return flee;
  const k = n - (c.agi_penalty_count - 1);
  const f = c.agi_penalty_type === 1 ? Math.trunc((flee * (100 - k * c.agi_penalty_num)) / 100) : flee - k * c.agi_penalty_num;
  return Math.max(1, f);
}

/** vit_penalty (battle_calc_defense_reduction, battle.cpp:4780-4797): [def1, def2] after the multi-attacker penalty. The
 *  attacker count is capped at 100 / num + (count - 1) (22 by default, "official servers limit the count to 22"); with
 *  k = n - (count - 1), type 1 scales both by (100 - k * num) / 100, type 2 subtracts k * num. def2 is then floored at 1
 *  for every unit type in vit_penalty_target, even below the count. SC_STEELBODY (keeps def1) arrives with skills. */
export function vitPenaltyDef(def1: number, def2: number, tgt?: Target, c = BATTLE_CONF): [number, number] {
  if (!tgt || !c.vit_penalty_type || !(c.vit_penalty_target & tgt.type)) return [def1, def2];
  const n = Math.min(tgt.targeted, 255, Math.trunc(100 / c.vit_penalty_num) + (c.vit_penalty_count - 1));
  if (n >= c.vit_penalty_count) {
    const k = n - (c.vit_penalty_count - 1);
    if (c.vit_penalty_type === 1) {
      def1 = Math.trunc((def1 * (100 - k * c.vit_penalty_num)) / 100);
      def2 = Math.trunc((def2 * (100 - k * c.vit_penalty_num)) / 100);
    } else {
      def1 -= k * c.vit_penalty_num;
      def2 -= k * c.vit_penalty_num;
    }
  }
  return [def1, Math.max(1, def2)];
}

/** Chance (0..100) that a normal attack connects, before crit / perfect dodge (is_attack_hitting, RENEWAL: hitrate starts
 *  at 0, += hit - flee after agi_penalty, + `bonus` (an arrow attack's sd->bonus.arrow_hit, battle.cpp:3284-3285), capped to
 *  [min_hitrate, max_hitrate]). */
export function hitChance(att: Status, def: Status, tgt?: Target, bonus = 0, mod?: (hitrate: number) => number) {
  let hitrate = att.hit - agiPenaltyFlee(def.flee, tgt) + bonus;
  if (mod) hitrate = mod(hitrate); // a skill's modifyHitRate (battle.cpp:3300-3304), before the cap
  return Math.min(MAX_HITRATE, Math.max(MIN_HITRATE, hitrate));
}

/** Renewal DEF (battle_calc_defense_reduction): damage * (4000 + def1) / (4000 + 10 * def1) - def2, after vit_penalty. */
export function defenseReduce(dmg: number, def: Status, tgt?: Target) {
  let [def1, def2] = vitPenaltyDef(def.def, def.def2, tgt);
  if (def1 === -400) def1 = -399; // the C++ guards the division by zero
  return Math.trunc((dmg * (4000 + def1)) / (4000 + 10 * def1)) - def2;
}

/** Weapon classes whose weapon-ATK stat bonus uses DEX instead of STR (battle_calc_base_weapon_attack: W_BOW, W_MUSICAL,
 *  W_WHIP, W_REVOLVER, W_RIFLE, W_GATLING, W_SHOTGUN, W_GRENADE): the one weapons.ts DEX_WEAPONS table status uses too. */
export const DEX_WEAPON_TYPES = DEX_WEAPONS;

/** battle_calc_base_weapon_attack (RENEWAL) range, inclusive. Starts from status watk (= rhw.atk + rhw.atk2,
 *  status_weapon_atk); with a weapon equipped adds +-variance (5% * wa->atk * wa->wlv) and a stat bonus
 *  (wa->atk * STR / 200, DEX for bows/instruments/whips/guns). wa = status rhw, so bAtk counts. Bare hands: [watk, watk].
 *  Float math as in the C++. */
export function weaponAtkRange(att: Status, weapon: Weapon): [number, number] {
  if (weapon.type === "Fist") return [att.watk, att.watk];
  const stat = DEX_WEAPON_TYPES.has(weapon.type) ? att.stats.dex : att.stats.str;
  const wa = att.rhw;
  const variance = f32(f32(f32(5 * wa.atk) * wa.wlv) / 100);
  const bonus = f32((wa.atk * stat) / 200);
  const min = Math.max(0, Math.trunc(f32(f32(att.watk - variance) + bonus)));
  const max = Math.min(UINT16_MAX, Math.trunc(f32(f32(att.watk + variance) + bonus)));
  return [min, max];
}

/** battle_add_weapon_damage (battle.cpp:2407-2424), right hand: an overrefined weapon (status overrefine = refine.yml
 *  RandomBonus / 100) adds rnd() % overrefine + 1, crit or not. 0 = no roll, no RNG draw. (weapon_damage_rate: no bonus yet.) */
export const overrefineDamage = (overrefine: number, r: Rng = Math.random) => (overrefine > 0 ? rnd(r, overrefine) + 1 : 0);

/** battle_calc_base_weapon_attack (RENEWAL): crit takes the top of the range, otherwise rnd_value(min, max) (inclusive);
 *  + the overrefine roll (battle_add_weapon_damage), then battle_calc_sizefix (player size modifier, size_fix.yml). */
export function baseWeaponAttack(att: Status, weapon: Weapon, size: Size, crit: boolean, r: Rng = Math.random) {
  const [min, max] = weaponAtkRange(att, weapon);
  const w = (crit ? max : min + rnd(r, max - min + 1)) + overrefineDamage(att.overrefine, r);
  return att.noSizeFix ? w : Math.trunc((w * sizeFix(weapon.type, size)) / 100); // SC_WEAPONPERFECTION: no size modifier
}

/** Critical multiplier (battle_calc_weapon_attack RENEWAL, battle.cpp:5646-5656): floor((float)(damage * (1.4f + 0.01f * crate))),
 *  applied after DEF reduction and the min-1 clamp (a total of 0 stays 0). crate = status crate, the 4th-job C.RATE trait (none
 *  here); the equipment's bCritAtkRate is crit_atk_rate, added before DEF (playerAttack). */
export function critDamage(dmg: number, crate = 0) {
  return Math.floor(f32(dmg * f32(f32(1.4) + f32(f32(0.01) * crate))));
}

/** One normal attack as battle_calc_attack hands it back (struct Damage, battle.hpp:94), the fields this port uses:
 *  - dmgLv: ATK.LUCKY (perfect dodge), ATK.FLEE (failed the hit roll), ATK.MISS (connected but came out below 1, e.g. an element
 *    at 0%: battle_calc_attack 6766-6770 turns damage < 1 into ATK_MISS with dmotion 0) or ATK.DEF (connected: damage applies);
 *  - dmg: the damage, 0 unless dmgLv is ATK.DEF; crit: type DMG_CRITICAL (an ATK_MISS crit keeps it, as rAthena does);
 *  - flag: the BF bits (normalAttackFlag);
 *  - miss / lucky: what the client shows: "Miss" for every dmgLv <= ATK.BLOCK (the packet carries damage 0), "Lucky" for ATK.LUCKY. */
export type AttackResult = { dmg: number; crit: boolean; miss: boolean; lucky: boolean; dmgLv: DamageLv; flag: number };
/** A weapon skill's part of battle_calc_weapon_attack (shared/rules/skill.ts weaponSkillHit builds it from the skill's rules):
 *  ratio = battle_calc_attack_skill_ratio (100 = x1), div = hits (skill_get_num), element = the skill's own element (undefined = the
 *  weapon's), range = battle_range_type (BF.SHORT / BF.LONG), usesArrow = Requires.Ammo, hitRate = modifyHitRate, hitBonus = flat
 *  hit added before it (Far Sight's +1 per level in Renewal), masteryAtk = the skill's mastery-type ATK. */
export type WeaponSkillHit = { ratio: number; div: number; element?: Element; range: number; usesArrow: boolean; hitRate?: (hitrate: number) => number; hitBonus?: number; masteryAtk?: number };
const attackResult = (dmgLv: DamageLv, dmg: number, crit: boolean, flag: number): AttackResult => {
  const connects = dmgLv > ATK.BLOCK;
  return { dmg: connects ? dmg : 0, crit, miss: !connects, lucky: dmgLv === ATK.LUCKY, dmgLv, flag };
};

/** initialize_weapon_data's flag for a normal attack (battle.cpp:5294-5319): BF_WEAPON | BF_NORMAL, plus BF_LONG when it uses
 *  ammo (is_skill_using_arrow, 2925-2943: for a player sd->state.arrow_atk, i.e. a weapon that shoots, weapons.ts shootsAmmo; for
 *  any other unit an attack range above 3, mobUsesArrow), else BF_SHORT. (SC_SOULATTACK arrives with status changes.) */
export const normalAttackFlag = (usesArrow: boolean) => BF.WEAPON | BF.NORMAL | (usesArrow ? BF.LONG : BF.SHORT);
/** is_skill_using_arrow for a non-player's normal attack (battle.cpp:2939-2942): status rhw.range > 3. */
export const mobUsesArrow = (att: Pick<Status, "rhw">) => att.rhw.range > 3;

/** is_infinite_defense (battle.cpp:2890-2913) for a unit target: its mode makes the attack deal exactly 1 whatever it would have
 *  dealt (battle_calc_attack_plant, 4951-4966) — MD_IGNOREMELEE against BF_WEAPON|BF_SHORT, MD_IGNORERANGED against
 *  BF_WEAPON|BF_LONG, MD_IGNOREMAGIC against BF_MAGIC, MD_IGNOREMISC against BF_MISC. Plants (mob_db Modes IgnoreMelee / Magic /
 *  Ranged / Misc) have all four. SC_INVINCIBLE arrives with status changes; skill-unit targets don't exist here. */
export function isInfiniteDefense(def: Pick<Status, "mode">, flag: number) {
  const all = (bits: number) => (flag & bits) === bits;
  return (hasMode(def.mode, MD.IGNOREMELEE) && all(BF.WEAPON | BF.SHORT)) || (hasMode(def.mode, MD.IGNOREMAGIC) && all(BF.MAGIC))
    || (hasMode(def.mode, MD.IGNORERANGED) && all(BF.WEAPON | BF.LONG)) || (hasMode(def.mode, MD.IGNOREMISC) && all(BF.MISC));
}

/** is_attack_critical's rate for a player's normal attack (battle.cpp:3030, 3047-3053, 3061, 3152), in tenths of %, rolled as
 *  rnd() % 1000 < rate and only when status cri is non-zero: cri + critaddrace[target race] + critaddrace[RC_ALL]
 *  (bCriticalAddRace), + arrow_cri + critical_rangeatk (bCriticalLong) when the attack shoots ammo, - the target's LUK * 2.
 *  (The target player's bCriticalDef and SC_SLEEP's x2 arrive with those bonuses / status changes.) */
export function critRate(att: Status, def: Status, usesArrow: boolean) {
  let cri = att.cri + (att.critAddRace[def.race] ?? 0) + (att.critAddRace.All ?? 0);
  if (usesArrow) cri += (att.arrow?.cri ?? 0) + att.critRangeAtk;
  return cri - def.stats.luk * 2;
}

/** ATK_ADDRATE (battle.cpp:3555): damage += damage * rate / 100, int64 math (truncated toward 0). */
const addRate = (dmg: number, rate: number) => dmg + Math.trunc((dmg * rate) / 100);

// ---------- battle_calc_cardfix (battle.cpp:769-1218, the BF_WEAPON case) ----------

/** The NK_* damage properties battle_calc_cardfix reads (skill.hpp e_nk). A normal attack has none (battle_skill_get_damage_properties,
 *  battle.cpp:3204-3216: skill 0 -> 0); skills set them. */
export type Nk = { ignoreAtkCard?: boolean; ignoreDefCard?: boolean; ignoreElement?: boolean; ignoreLongCard?: boolean };
export const NK_NONE: Readonly<Nk> = {};

/** One side of a battle_calc_cardfix call: the unit's status, its bl_type (only a player, BL_CAST(BL_PC), has bonus tables: a
 *  monster's are zeros) and, for a player attacker, sd->state.arrow_atk (its attack shoots the equipped ammo). */
export type CardfixUnit = { status: Status; type: number; arrowAtk?: boolean };

/** The `left` argument (battle.cpp:762-765): bit 2 = the attacker's bonuses of the right hand, otherwise the target's. Bit 1 (the
 *  left hand: its tables and element) arrives with dual wield. */
export const CARDFIX_LEFT = { TARGET: 0, ATTACKER: 2 } as const;

const CARDFIX_BASE = 1000;
/** APPLY_CARDFIX (battle.cpp:806): the fix is a factor on a base of 1000 (below 0 counts as 0); the damage loses the truncated
 *  difference, so a fix above 1000 raises it by the truncated excess. */
export const applyCardfix = (damage: number, fix: number) => damage - Math.trunc((damage * (CARDFIX_BASE - Math.max(0, fix))) / CARDFIX_BASE);
/** One `cardfix = cardfix * (100 + pct) / 100` step: int32 math, the quotient truncates toward 0. */
const cardfixStep = (cardfix: number, pct: number) => Math.trunc((cardfix * (100 + pct)) / 100);
/** `table[x] + table[ALL]` of one indexed bonus table: the target's own slot and the table's RC_ALL / ELE_ALL / SZ_ALL / CLASS_ALL one. */
const slot = <K extends string>(table: Partial<Record<K | "All", number>>, key: K) => (table[key] ?? 0) + (table.All ?? 0);

/**
 * battle_calc_cardfix(BF_WEAPON, src, target, nk, rh_ele, lh_ele, damage, left, flag): what cards and gear do to one part of a weapon
 * attack's damage; returns the new damage (rAthena returns the difference). Each call is one of the two sides, never both:
 * - `left & 2`, a player attacker (battle.cpp:940-1087): the factor from its race / element / size / class bonuses against the
 *   TARGET's race, defense element, size and class — right-hand tables (bAddRace, bAddEle, bAddSize, bAddClass: the weapon and every
 *   armor piece), plus the ammo's (arrow_add*) when the attack shoots it. The steps and their order follow the branch: shot
 *   (943-970) and each hand on its own (975-995, left_cardfix_to_right off): race, element, size, class; right and left as one
 *   (1020-1054, left_cardfix_to_right on, the official setting): element (even under NK_IGNOREELEMENT, 1021-1022), race, size, class.
 *   Every step is `cardfix = cardfix * (100 + x) / 100` from a base of 1000, truncating, x = the target's slot + the table's All slot.
 * - otherwise, a player target (1089-1153): the factor from its damage-taken bonuses against the ATTACKER: rh_ele (the attack's
 *   element) in bSubEle, then the attacker's own defense element in bSubDefEle (both skipped under NK_IGNOREELEMENT), then the
 *   attacker's size in bSubSize and bWeaponSubSize, its race in bSubRace, its class in bSubClass, then bNearAtkDef for a BF_SHORT
 *   attack or else bLongAtkDef (skipped under NK_IGNORELONGCARD), each as `cardfix * (100 - x) / 100`.
 * A zero damage stays 0 (780). Not modelled yet (they need their data, each is one more step here): race2 groups (bAddRace2 /
 * bSubRace2), the monster-id lists (bAddDamageClass, bAddDefMonster), bonus3's flagged tables (addele2 / subele2 / subrace3), the
 * left hand, SC_DEF_RATE and the status changes' element debuffs (1155-1160). BF_MAGIC / BF_MISC arrive with skills.
 */
export function battleCalcCardfix(src: CardfixUnit, target: CardfixUnit, nk: Readonly<Nk>, rhEle: Element, damage: number, left: number, flag: number, c = BATTLE_CONF): number {
  if (!damage) return 0;
  const att = src.status, def = target.status;
  let cardfix = CARDFIX_BASE;
  if (src.type === BL.PC && !nk.ignoreAtkCard && (left & 2)) {
    const shot = !!src.arrowAtk; // the ammo's tables count only for an attack that shoots it (the melee branch never reads them)
    const race = slot(att.addRace, def.race) + (shot ? slot(att.arrowAddRace, def.race) : 0);
    const ele = slot(att.addEle, def.element) + (shot ? slot(att.arrowAddEle, def.element) : 0);
    const size = slot(att.addSize, def.size) + (shot ? slot(att.arrowAddSize, def.size) : 0);
    const cls = slot(att.addClass, def.class_) + (shot ? slot(att.arrowAddClass, def.class_) : 0);
    if (shot || !c.left_cardfix_to_right) {
      cardfix = cardfixStep(cardfix, race);
      if (!nk.ignoreElement) cardfix = cardfixStep(cardfix, ele);
    } else {
      cardfix = cardfixStep(cardfix, ele);
      cardfix = cardfixStep(cardfix, race);
    }
    cardfix = cardfixStep(cardfix, size);
    cardfix = cardfixStep(cardfix, cls);
    return applyCardfix(damage, cardfix);
  }
  if (target.type === BL.PC && !nk.ignoreDefCard && !(left & 2)) {
    if (!nk.ignoreElement) {
      cardfix = cardfixStep(cardfix, -slot(def.subEle, rhEle));
      cardfix = cardfixStep(cardfix, -slot(def.subDefEle, att.element));
    }
    cardfix = cardfixStep(cardfix, -slot(def.subSize, att.size));
    cardfix = cardfixStep(cardfix, -slot(def.weaponSubSize, att.size));
    cardfix = cardfixStep(cardfix, -slot(def.subRace, att.race));
    cardfix = cardfixStep(cardfix, -slot(def.subClass, att.class_));
    if (flag & BF.SHORT) cardfix = cardfixStep(cardfix, -def.nearAtkDef);
    else if (!nk.ignoreLongCard) cardfix = cardfixStep(cardfix, -def.longAtkDef); // BF_LONG (there's no other choice)
    return applyCardfix(damage, cardfix);
  }
  return damage;
}

/** battle_weapon_attack's ammo check (battle.cpp:7161-7205), before anything is rolled: a player's normal attack with a weapon
 *  that shoots ammo (weapons.ts SHOOTING_WEAPONS: bow, guns) needs the ammo subtype it fires in EQI_AMMO, otherwise the attack
 *  is refused (ATK_NONE: no swing, no damage, no attack delay) with this failure. null = the attack goes ahead (the ammo fits, or
 *  the weapon doesn't shoot). ammo = the worn ammo's item_db SubType (items.ts Gear.ammo), null = none worn. */
export function weaponAttackAmmo(weaponType: string, ammo: string | null): AmmoFail | null {
  const s = SHOOTING_WEAPONS[weaponType];
  return s && ammo !== s.ammo ? s.fail : null;
}

/** battle_consume_ammo(sd, 0, 0) (battle.cpp:2645-2669), after a normal attack that shot ammo, hit or miss (battle.cpp:7382-
 *  7383): how many of the worn ammo it uses up (pc_delitem; a stack that runs out comes off). 0 with arrow_decrement off.
 *  Skills' own quantities (skill_get_ammo_qty) arrive with skills. */
export const consumedAmmo = (c = BATTLE_CONF) => (c.arrow_decrement ? 1 : 0);

/** battle_addmastery (battle.cpp:2277): the passive-skill ATK a player adds after the damage parts: the weapon's mastery (SM_SWORD /
 *  SM_TWOHAND, Status.masteryAtk) and AL_DEMONBANE vs a monster that is Undead-element or Demon race (undead_detect_type 0):
 *  (int)(lv * (base_level / 20.0 + 3.0)). */
export function passiveMastery(att: Status, def: Status, tgt: Target) {
  let m = att.masteryAtk ?? 0;
  if ((att.beastBane ?? 0) > 0) m += beastBane(att.beastBane!, def.race); // 2.5.0 HT_BEASTBANE (battle_addmastery)
  if ((att.demonBane ?? 0) > 0 && tgt.type === BL.MOB && (def.element === "Undead" || def.race === "Demon")) m += Math.trunc(att.demonBane! * ((att.baseLv ?? 1) / 20 + 3));
  return m;
}
/** battle_calc_defense (battle.cpp:4817): a monster that is Undead-element or Demon race hitting a player with AL_DP: vit_def +=
 *  (int)((base_level / 25.0 + 3.0) * lv + 0.5). */
export function passiveDefense(att: Status, def: Status) {
  if (!(def.dpLv && (att.element === "Undead" || att.race === "Demon"))) return 0;
  return Math.trunc(((def.baseLv ?? 1) / 25 + 3) * def.dpLv + 0.5);
}

/** Player -> anything (battle_calc_weapon_attack, skill 0, RENEWAL). weapon must be the attacker's weapon; status.watk is
 *  its weapon ATK. tgt = the defender's unit type + how many units target it (agi/vit_penalty). Perfect dodge rolls on
 *  tstatus->flee2, which status only gives to enable_perfect_flee types (mobStatus sets 0); then the crit (critRate), then the
 *  hit roll (crits always hit). A weapon that shoots ammo (sd->state.arrow_atk -> is_skill_using_arrow, battle.cpp:2925-2935)
 *  makes the attack BF_LONG and adds the worn ammo's status.arrow (sd->bonus.arrow_*): arrow_cri to the crit rate, arrow_hit to the
 *  hit rate (3284-3285), its element when it has one (battle_get_weapon_element, 3476-3477) and arrow_atk to equipment ATK
 *  (battle_calc_equip_attack, 3439-3444). A target with infinite defense against it (plants: isInfiniteDefense) takes exactly 1
 *  once the attack connects. Otherwise the damage below; a result under 1 is ATK_MISS (shown as "Miss": no HP change, no flinch,
 *  no mob_attacked). battle_weapon_attack refuses a shooting attack without matching ammo before this runs (weaponAttackAmmo). */
export function playerAttack(att: Status, weapon: Weapon, def: Status, tgt: Target, r: Rng = Math.random, sk?: WeaponSkillHit): AttackResult {
  // is_skill_using_arrow: a normal attack shoots when the weapon does; a skill only when it needs ammo (skill_db Requires.Ammo)
  const arrow = shootsAmmo(weapon.type) && (!sk || sk.usesArrow) ? att.arrow : undefined;
  const flag = sk ? BF.WEAPON | BF.SKILL | sk.range : normalAttackFlag(arrow !== undefined);
  // lucky dodge only against normal attacks (battle.cpp:5426 `!skill_id`); a skill crits only with NK_CRITICAL (is_attack_critical)
  if (!sk && def.flee2 > 0 && rnd(r, 1000) < def.flee2) return attackResult(ATK.LUCKY, 0, false, flag);
  const crit = !sk && att.cri !== 0 && rnd(r, 1000) < critRate(att, def, arrow !== undefined); // is_attack_critical: `if (sstatus->cri)`
  // is_attack_hitting (battle.cpp:3250): a target under Stone / Freeze / Stun / Sleep (sc->opt1) is always hit
  if (!crit && !def.noFlee && rnd(r, 100) >= hitChance(att, def, tgt, (arrow?.hit ?? 0) + (att.vultureHit ?? 0) + (sk?.hitBonus ?? 0), sk?.hitRate)) return attackResult(ATK.FLEE, 0, false, flag);
  // battle.cpp:5452: no damage math against infinite defense; battle_calc_attack_plant (5762-5765) then sets 1, crit or not
  if (isInfiniteDefense(def, flag)) return attackResult(ATK.DEF, sk ? sk.div : 1, crit, flag); // plant: 1 per hit (battle_calc_attack_plant)
  // battle_calc_damage_parts (battle.cpp:3889-3944): status ATK is neutral, doubled after the element fix; weapon ATK and
  // equipment ATK (battle_calc_equip_attack: status eatk, + arrow ATK) take the right-hand element (rhw.ele, or the arrow's);
  // bAtkRate adds (weaponAtk + equipAtk) * atk_rate / 100.
  // battle_get_weapon_element: a skill with its own element uses it, "Weapon" ones the weapon's (or the arrow's)
  const ele = sk?.element ?? (arrow && arrow.ele !== "Neutral" ? arrow.ele : att.rhw.ele);
  let statusAtk = attrFix(att.batk, "Neutral", def.element, def.elementLevel) * 2;
  let weaponAtk = attrFix(baseWeaponAttack(att, weapon, def.size, crit, r), ele, def.element, def.elementLevel);
  let equipAtk = attrFix(att.eatk + (arrow?.atk ?? 0), ele, def.element, def.elementLevel);
  const percentAtk = att.atkRate ? Math.trunc(((weaponAtk + equipAtk) * att.atkRate) / 100) : 0;
  // battle_calc_cardfix, with percentAtk already taken (it is never card-fixed): the attacker's bonuses on weapon ATK and equipment
  // ATK (battle.cpp:5495-5497), then, against a player, the target's on each part, status ATK without the element bonuses
  // (NK_IGNOREELEMENT, 5504-5512; the mastery ATK of 5512, likewise element-free, joins with the masteries)
  const src: CardfixUnit = { status: att, type: BL.PC, arrowAtk: arrow !== undefined }, dst: CardfixUnit = { status: def, type: tgt.type };
  weaponAtk = battleCalcCardfix(src, dst, NK_NONE, ele, weaponAtk, CARDFIX_LEFT.ATTACKER, flag);
  equipAtk = battleCalcCardfix(src, dst, NK_NONE, ele, equipAtk, CARDFIX_LEFT.ATTACKER, flag);
  if (tgt.type === BL.PC) {
    statusAtk = battleCalcCardfix(src, dst, { ignoreElement: true }, ele, statusAtk, CARDFIX_LEFT.TARGET, flag);
    weaponAtk = battleCalcCardfix(src, dst, NK_NONE, ele, weaponAtk, CARDFIX_LEFT.TARGET, flag);
    equipAtk = battleCalcCardfix(src, dst, NK_NONE, ele, equipAtk, CARDFIX_LEFT.TARGET, flag);
  }
  // battle.cpp:5525-5563: damage = statusAtk + weaponAtk + equipAtk + percentAtk; a crit adds floor((float)(damage * crit_atk_rate
  // / 100)), anything else ATK_ADDRATE non_crit_atk_rate; then ATK_ADDRATE short_attack_atk_rate (BF_SHORT) / long_attack_atk_rate
  // (BF_LONG). All before DEF.
  let dmg = statusAtk + weaponAtk + equipAtk + percentAtk;
  // masteryAtk (battle_calc_damage_parts -> battle_addmastery, battle.cpp:3812: Envenom's 15 x level) joins after the parts, element-free
  const mastery = (sk?.masteryAtk ?? 0) + passiveMastery(att, def, tgt);
  if (mastery) dmg += tgt.type === BL.PC ? battleCalcCardfix(src, dst, { ignoreElement: true }, ele, mastery, CARDFIX_LEFT.TARGET, flag) : mastery;
  dmg = crit ? dmg + Math.floor(f32(Math.trunc((dmg * att.critAtkRate) / 100))) : addRate(dmg, att.nonCritAtkRate);
  if (flag & BF.SHORT) dmg = addRate(dmg, att.shortAtkRate);
  if (flag & BF.LONG) dmg = addRate(dmg, att.longAtkRate);
  // the skill ratio, ATK_RATE (battle.cpp:5567): damage * ratio / 100, after the rate bonuses and before DEF
  // Renewal: the status-change attack percent (Curse -25, Provoke +; battle_get_atkpercent, battle.cpp:4355) is the base of the skill ratio
  // (battle.cpp:4421), so it also scales a normal attack; a skill's own ratio adds to it
  const ratio = (sk ? sk.ratio : 100) + ((att.atkPercent ?? 100) - 100);
  if (sk || ratio !== 100) dmg = Math.trunc((dmg * ratio) / 100);
  // battle.cpp:5617-5628: DEF and battle_calc_attack_post_defense's min 1 (battle_min_damage, 4931) run only
  // `if (wd.damage + wd.damage2)`: a total of 0 stays 0 (a negative one still becomes 1)
  if (dmg !== 0) dmg = Math.max(1, defenseReduce(dmg, def, tgt));
  if (crit) dmg = critDamage(dmg); // 0 stays 0
  if (dmg > 0 && att.auraBlade) dmg += att.auraBlade; // SC_AURABLADE: ATK_ADD after the defense (battle.cpp)
  if (sk && dmg > 0) dmg *= sk.div; // battle_apply_div_fix: DAMAGE_DIV_FIX (battle.cpp:4238), every hit deals the same
  return dmg < 1 ? attackResult(ATK.MISS, 0, crit, flag) : attackResult(ATK.DEF, dmg, crit, flag); // battle_calc_attack 6766-6770
}

/** Monster -> anything. Renewal monsters skip the player "damage parts" path (battle.cpp: `if (sd) battle_calc_damage_parts
 *  else battle_calc_base_damage`): damage = rand(atkMin..atkMax-1) + batk, no status-ATK doubling. Monsters can't crit
 *  (enable_critical: 17) and their normal attacks are non-elemental (attack_attr_none: 14 includes BL_MOB, so
 *  battle_calc_element_damage returns early: 100% vs every armor element). An attack range above 3 makes it BF_LONG
 *  (mobUsesArrow). Perfect dodge / agi / vit penalty / infinite defense / the min-1 exception as playerAttack; a player target's
 *  card fix (`if (tsd && !sd)`, battle.cpp:5751-5756: battleCalcCardfix with the monster's race / size / class / defense element and
 *  its Neutral attack element against the target's bSubRace / bSubSize / bSubClass / bSubDefEle / bSubEle, then bNearAtkDef /
 *  bLongAtkDef) then scales the whole damage after DEF, so a factor of 0 (a rate of 100 or more) turns the hit into ATK_MISS. */
export function mobAttack(att: MobStatus, def: Status, tgt: Target, r: Rng = Math.random, hitRate?: (hitrate: number) => number): AttackResult {
  const flag = normalAttackFlag(mobUsesArrow(att));
  if (def.flee2 > 0 && rnd(r, 1000) < def.flee2) return attackResult(ATK.LUCKY, 0, false, flag);
  if (!def.noFlee && rnd(r, 100) >= hitChance(att, def, tgt, 0, hitRate)) return attackResult(ATK.FLEE, 0, false, flag); // hitRate = a skill's modifyHitRate (NPC_POISON ... +20 %)
  if (isInfiniteDefense(def, flag)) return attackResult(ATK.DEF, 1, false, flag);
  let dmg = (att.atkMax > att.atkMin ? rnd(r, att.atkMax - att.atkMin) : 0) + att.atkMin + att.batk;
  if ((att.atkPercent ?? 100) !== 100) dmg = Math.trunc((dmg * att.atkPercent!) / 100); // battle_get_atkpercent: Provoke / Curse on a monster
  if (dmg !== 0) dmg = Math.max(1, defenseReduce(dmg, def, tgt) - passiveDefense(att, def)); // as playerAttack (batk = STR + level, so never 0 here)
  if (tgt.type === BL.PC) dmg = battleCalcCardfix({ status: att, type: BL.MOB }, { status: def, type: BL.PC }, NK_NONE, att.rhw.ele, dmg, CARDFIX_LEFT.TARGET, flag);
  return dmg < 1 ? attackResult(ATK.MISS, 0, false, flag) : attackResult(ATK.DEF, dmg, false, flag);
}

// ---------- attack timing ----------

/** status->amotion of a player (status_calc_bl_ RENEWAL_ASPD): displayed ASPD = (2000 - amotion) / 10, so amotion = 2000 - aspd*10;
 *  adelay is twice that (AMOTION_DIVIDER_PC, see status.ts aspdToDelay). Monsters take mob_db AttackMotion as is. */
export const pcAmotion = (aspd: number) => 2000 - aspd * 10;

/** status->dmotion of a player (status_calc_bl_, status.cpp:6438-6441): 800 - agi*4 capped to [400, 800] (pc_damage_delay_rate 100).
 *  Monsters take mob_db DamageMotion as is. */
export const pcDmotion = (agi: number) => Math.min(800, Math.max(400, 800 - agi * 4));

/**
 * battle_delay_damage (battle.cpp:449-470): ms between the swing and the moment a normal attack's damage is applied.
 * synchronize_damage clamps monster normal attacks to their client motion; delay_battle_damage: no makes everything land
 * at once (1 = "no timer"); otherwise non-player sources are capped at 1000 ms (Aegis) and players use their full amotion.
 * A result <= 1 means the damage is applied immediately.
 */
export function damageDelay(amotion: number, srcType: number, skill = false, clientAmotion = amotion, c = BATTLE_CONF) {
  if (c.synchronize_damage && !skill && srcType === BL.MOB && amotion > clientAmotion) return clientAmotion;
  if (!c.delay_battle_damage) return 1;
  if (srcType !== BL.PC && amotion > 1000) return 1000;
  return amotion;
}

/** battle_delay_damage (battle.cpp:480): the delayed hit is dropped if, when it lands, the two units are farther apart (in cells,
 *  distance_bl) than their distance at swing time plus this margin ("check to see if you haven't teleported"). */
export const delayedDamageReach = (swingDistance: number, c = BATTLE_CONF) => swingDistance + (c.snap_dodge ? 10 : c.area_size);

/**
 * battle_calc_walkdelay (battle.cpp:274): how long a hit stops the target (also when the mob_attacked retaliation timer fires).
 * 0 = no delay (no damage, or div 0); multi-hit adds multihit_delay per extra hit (>10 hits count as 2); scaled by
 * pc_damage_walk_delay_rate for players / damage_walk_delay_rate for everything else; never below 1 when it applies.
 */
export function walkDelay(dmotion: number, targetType: number, damage: number, div = 1, c = BATTLE_CONF) {
  if (damage < 1 || div === 0) return 0;
  let delay = dmotion;
  if (div > 1) delay += c.multihit_delay * ((div > 10 ? 2 : div) - 1);
  delay = applyRate(delay, targetType === BL.PC ? c.pc_damage_walk_delay_rate : c.damage_walk_delay_rate);
  return delay > 0 ? delay : 1;
}

/** A magic skill's part of battle_calc_magic_attack (shared/rules/skill.ts magicSkillHit builds it): ratio = the skill ratio
 *  (100 = x1), div = hits, element = the skill's element, range = battle_range_type, base = a fixed base damage instead of the MATK
 *  roll and ratio (AL_HEAL: skill_calc_heal(.., false), battle.cpp:5888-5893), ignoreDefense = NK_IGNOREDEFENSE (no MDEF). */
export type MagicSkillHit = { ratio: number; div: number; element: Element; range: number; base?: number; ignoreDefense?: boolean };

/**
 * battle_calc_magic_attack (battle.cpp:5801, RENEWAL) for a player's magic skill: magic always hits (no hit roll). Damage = a roll of
 * status MATK, min + rnd() % (max - min) (5973-5977), x skill ratio (MATK_RATE, 6014-6019: after the attacker's magic card fix, which
 * needs bonuses we don't import yet), then the Renewal MDEF reduction damage * (1000 + mdef) / (1000 + mdef * 10) - mdef2 (6093-6100,
 * negative hard MDEF counts as 0) unless the skill ignores defense, min 1 (6178), the element fix (battle_attr_fix, 6200), and every
 * hit deals the same (battle_apply_div_fix). A plant (infinite defense against BF_MAGIC) takes 1 per hit. A result of 0 after the
 * element (e.g. 0% against its element) is ATK_MISS like a weapon hit (battle_calc_attack 6766-6770).
 */
export function magicAttack(att: Status, def: Status, m: MagicSkillHit, r: Rng = Math.random): AttackResult {
  const flag = BF.MAGIC | BF.SKILL | m.range;
  if (isInfiniteDefense(def, flag)) return attackResult(ATK.DEF, m.div, false, flag);
  let dmg: number;
  if (m.base !== undefined) dmg = m.base;
  else {
    dmg = att.matkMax > att.matkMin ? att.matkMin + rnd(r, att.matkMax - att.matkMin) : att.matkMin;
    dmg = Math.trunc((dmg * m.ratio) / 100);
  }
  if (!m.ignoreDefense) {
    const mdef = Math.max(0, def.mdef);
    dmg = Math.trunc((dmg * (1000 + mdef)) / (1000 + mdef * 10)) - def.mdef2;
  }
  if (dmg < 1) dmg = 1;
  dmg = attrFix(dmg, m.element, def.element, def.elementLevel);
  if (dmg > 0) dmg *= m.div;
  return dmg < 1 ? attackResult(ATK.MISS, 0, false, flag) : attackResult(ATK.DEF, dmg, false, flag);
}
