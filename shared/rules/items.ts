// Items, equipment, weight and drops — Renewal behaviour from rAthena (pc.cpp pc_additem/pc_equipitem/pc_isequip,
// status.cpp max_weight) with default conf/battle (player.conf). Monster drops / floor items: rules/drops.ts.
import itemsJson from "../data/items.json" with { type: "json" };
import { JOBS, type JobKey } from "./data.ts";
import { FISTS, type Weapon } from "./status.ts";
import { noBonus, scriptBonus, type EquipBonus, type ItemBonus, type LrFlag } from "./bonus.ts";
import { refineInfo } from "./refine.ts";
import { BATTLE_CONF } from "./battle.ts";
import { AMMO_USERS, AMMO_WEAPONS } from "./weapons.ts";

export type Item = (typeof itemsJson)[number];
export const ITEMS = new Map<number, Item>(itemsJson.map((i) => [i.id, i]));
export const SHOP_ITEMS = itemsJson.filter((i) => i.shop).map((i) => i.id);
/** New characters: one of each starter equipment + 5 starter tonics (like the original novice kit). */
export const STARTER_KIT = itemsJson.filter((i) => i.starter).map((i) => ({ id: i.id, amount: i.type === "Healing" ? 5 : 1 }));

export const NATURAL_HEAL_WEIGHT = 70; // % — Renewal natural_heal_weight_rate
export const MAJOR_OVERWEIGHT = 90; // % — major_overweight_rate: no regen, no skills (normal attacks still work)
export const MAX_STACK = 30_000;
export const INVENTORY_SLOTS = 100;

export const SLOTS = ["headTop", "headMid", "headLow", "armor", "weapon", "shield", "garment", "shoes", "ammo"] as const;
export type EquipSlot = (typeof SLOTS)[number];
const LOCATION_SLOT: Record<string, EquipSlot[]> = {
  Head_Top: ["headTop"], Head_Mid: ["headMid"], Head_Low: ["headLow"], Armor: ["armor"],
  Right_Hand: ["weapon"], Left_Hand: ["shield"], Both_Hand: ["weapon", "shield"], Garment: ["garment"], Shoes: ["shoes"],
  Ammo: ["ammo"], // EQP_AMMO -> EQI_AMMO
};
export const SLOT_LABEL: Record<EquipSlot, string> = {
  headTop: "Upper Head", headMid: "Middle Head", headLow: "Lower Head", armor: "Armor", weapon: "Weapon", shield: "Shield", garment: "Garment", shoes: "Shoes",
  ammo: "Ammo",
};

/** itemdb_isequip2 (itemdb.cpp): weapons, armor and ammo are worn (ammo stacks all the same: item_data::isStackable). */
export const isEquip = (it: { type: string }) => it.type === "Weapon" || it.type === "Armor" || it.type === "Ammo";
export const isAmmo = (it: { type: string }) => it.type === "Ammo";
export const isUsable = (it: Item) => it.effect !== null;
export const slotsOf = (it: { locations: readonly string[] }): EquipSlot[] => it.locations.flatMap((l) => LOCATION_SLOT[l] ?? []);

/** Why pc_isequip refuses an ammo for the worn weapon type (MSI_FAIL_NEED_EQUIPPED_BOW / MSI_WRONG_BULLET / no message). */
const AMMO_EQUIP_FAIL = {
  needBow: "equip a bow, instrument or whip first",
  wrongBullet: "this ammunition doesn't fit your weapon",
  needSkill: "you lack the skill to use this",
} as const;

/** pc_isequip (pc.cpp:1849-1968) in its order: base level (EquipLevelMin, ITEM_EQUIP_ACK_FAILLEVEL), then ammo against the worn
 *  weapon type (EQP_AMMO, battle.conf ammo_check_weapon: weapons.ts AMMO_WEAPONS), then the job (pc_job_can_use_item).
 *  weaponType = sd->status.weapon, the worn weapon's item_db SubType ("Fist" bare-handed). Returns a reason when it can't be worn. */
export function equipBlock(it: Item, job: JobKey, level: number, weaponType = "Fist"): string | null {
  if (!isEquip(it) || !slotsOf(it).length) return "can't be equipped";
  if (level < it.equipLevel) return `requires base level ${it.equipLevel}`;
  // pc_isequip: `item->elvmax != 0 && base_level > item->elvmax` is ITEM_EQUIP_ACK_FAILLEVEL too (pc.cpp:1884)
  if (((it as { equipLevelMax?: number }).equipLevelMax ?? 0) > 0 && level > (it as { equipLevelMax?: number }).equipLevelMax!) return `only up to base level ${(it as { equipLevelMax?: number }).equipLevelMax}`;
  if (isAmmo(it)) {
    const fit = AMMO_WEAPONS[it.subType ?? ""];
    if (fit && (!fit.weapons || (BATTLE_CONF.ammo_check_weapon && !fit.weapons.includes(weaponType)))) return AMMO_EQUIP_FAIL[fit.fail];
  }
  if (!(it.jobs as string[]).includes(job)) return `${JOBS[job].name} can't use this`;
  return null;
}

/** battle.conf ammo_unequip when a weapon is put on (pc_equipitem, pc.cpp:12201-12226): worn ammo of `ammoSubType` comes off when
 *  the new weapon of `weaponType` can't use it (only arrows / bullets / shells have a weapon list). */
export const ammoOffForWeapon = (weaponType: string, ammoSubType: string) => {
  const w = AMMO_WEAPONS[ammoSubType]?.weapons;
  return BATTLE_CONF.ammo_unequip && !!w && !w.includes(weaponType);
};
/** battle.conf ammo_unequip when a weapon is taken off by request (pc_unequipitem without flag 4, pc.cpp:12461-12479): a bow,
 *  instrument, whip or gun takes the worn ammo off with it. A weapon pushed out by another piece (flag 4) never does. */
export const ammoOffWithWeapon = (weaponType: string) => BATTLE_CONF.ammo_unequip && AMMO_USERS.has(weaponType);

/** The fields of an item that status needs (an items.json row satisfies it; tests build them from rAthena item_db rows).
 *  range = item_db Range (a weapon's attack range; absent = 0). */
export type GearItem = {
  type: string; subType: string | null; atk: number; matk: number; def: number; weaponLevel: number; armorLevel: number;
  refineable: boolean; element: string; locations: readonly string[]; bonuses: readonly ItemBonus[]; range?: number;
};
/** One worn stack: the item plus that stack's refine level (inventory.refine) and the cards compounded into it (item ids, shared/rules/cards.ts). */
export type WornItem = { item: GearItem; refine: number; cards?: readonly number[] };

/** What the right-hand weapon item itself adds in status_calc_pc_sub's equipment loop, before its script runs (status.cpp:
 *  3939-3986, RENEWAL): wa->atk += item ATK; with a refine row (refine.ts refineInfo) wa->atk2 += Bonus / 100, wa->matk +=
 *  Bonus / 100 unless the weapon is a bow (sd->weapontype1 != W_BOW), right_weapon.overrefine = RandomBonus / 100; wa->matk +=
 *  item MagicAttack; wa->range += item Range (3989). element = its own bAtkEle (importer), for status computed without the loop.
 *  The level-5-weapon P.ATK/S.MATK and enchant-grade bonuses belong to 4th jobs / enchant grades, which don't exist here yet. */
export function weaponOf(it: GearItem | undefined, refine = 0): Weapon {
  if (!it || it.type !== "Weapon") return FISTS;
  const type = it.subType ?? "Fist", info = refineInfo(it, refine);
  const bonus = info ? Math.trunc(info.bonus / 100) : 0;
  return {
    atk: it.atk, atk2: bonus, matk: it.matk + (type !== "Bow" ? bonus : 0), overrefine: info ? Math.trunc(info.randomBonus / 100) : 0,
    level: it.weaponLevel, type, element: (it.element as Weapon["element"]) ?? "Neutral", range: it.range ?? 0,
  };
}

/** ammo = the item_db SubType of the worn ammo (sd->inventory_data[sd->equip_index[EQI_AMMO]]->subtype), null when EQI_AMMO is
 *  empty: what battle_weapon_attack checks before a shooting weapon may attack (battle.ts weaponAttackAmmo). */
export type Gear = { weapon: Weapon; shield: boolean; equip: EquipBonus; ammo: string | null };

/** pc.hpp enum equip_index, the positions status_calc_pc_sub's "Parse equipment" loop walks in this order (status.cpp:3905,
 *  i = 0 .. EQI_MAX). EQI_AMMO is skipped by the loop and handled after it (gearOf). Costume and shadow positions
 *  (EQI_COSTUME_HEAD_TOP = 10 ..) arrive with those items. */
export const EQI = { ACC_L: 0, ACC_R: 1, SHOES: 2, GARMENT: 3, HEAD_LOW: 4, HEAD_MID: 5, HEAD_TOP: 6, ARMOR: 7, HAND_L: 8, HAND_R: 9, AMMO: 14 } as const;
/** item_db Location -> the equip_index position the item's script runs at. An item filling several positions runs once, at the
 *  first one the loop reaches (pc_is_same_equip_index, pc.cpp:15308): a two-hander at EQI_HAND_L, a Top+Mid headgear at
 *  EQI_HEAD_MID, a Top+Low one at EQI_HEAD_LOW. A Both_Accessory item fills one accessory position, EQI_ACC_R while that one
 *  is free (pc_equipitem, pc.cpp:12088-12091); this game has no accessory slots yet. */
const EQI_OF_LOCATION: Readonly<Record<string, number>> = {
  Left_Accessory: EQI.ACC_L, Right_Accessory: EQI.ACC_R, Both_Accessory: EQI.ACC_R, Shoes: EQI.SHOES, Garment: EQI.GARMENT,
  Head_Low: EQI.HEAD_LOW, Head_Mid: EQI.HEAD_MID, Head_Top: EQI.HEAD_TOP, Armor: EQI.ARMOR,
  Left_Hand: EQI.HAND_L, Both_Hand: EQI.HAND_L, Right_Hand: EQI.HAND_R, Ammo: EQI.AMMO,
};
/** The equip_index position a worn item is processed at; Infinity = none (it can't be worn). */
export const eqiOf = (it: { locations: readonly string[] }) => Math.min(...it.locations.map((l) => EQI_OF_LOCATION[l] ?? Infinity));

/** playerStatus inputs from the worn stacks, shared by server (Inventory.gear) and client (myStatus): status_calc_pc_sub's
 *  "Parse equipment" loop (status.cpp:3904-4058), in equip_index order whatever order the stacks come in. Every piece adds its
 *  DEF to base_status->def (3917). The weapon (weaponOf: item ATK, refine ATK2, MATK, level) is added to rhw (3955-3977) before
 *  its script runs with lr_flag NONE, so its own bAtk / bAtk2 move (and floor at 0) that running value. An armor piece adds its
 *  refine Bonus to refinedef (4010-4014) and runs its script with lr_flag SHIELD in EQI_HAND_L (4025-4029), NONE elsewhere.
 *  Scripts = the item's imported `bonuses` through scriptBonus (pc_bonus / pc_bonus2; `unsupported` statements are skipped). After the loop
 *  def += (refinedef + 50) / 100 (4096). The order matters: bAtkEle / bDefEle are last-wins, and an armor's bAtk lands on rhw
 *  before the right-hand weapon (EQI_HAND_R, the last position) adds its ATK. Shield follows pc_equipitem (pc.cpp:12181-12195):
 *  only a non-weapon in the left hand sets status.shield, so a two-handed bow is no shield. The weapon adds its Range to
 *  rhw.range (3989). The worn ammo is skipped by the loop (3910: no DEF, no refine) and handled after it (4042-4052): its item
 *  ATK goes to sd->bonus.arrow_atk and its script runs with LR_FLAG_ARROW (bonus.ts: only bHit / bCritical / bCriticalLong / bAtkEle /
 *  bAtkRange and the bonus2 cases with an `arrow` route write anything then: the bAdd* bonuses go to their arrow_add* table and
 *  bSubDefEle has no lr_flag test; IG_THROWABLE items skip their script, none are in the data yet). */
export function gearOf(worn: Iterable<WornItem>): Gear {
  const equip = noBonus(), rhw = equip.rhw;
  let weapon = FISTS, shield = false, refinedef = 0, ammo: GearItem | undefined;
  const pieces = [...worn].map((w) => ({ ...w, eqi: eqiOf(w.item) })).filter((w) => isEquip(w.item) && w.eqi < Infinity);
  for (const { item: it, refine, eqi } of pieces.sort((a, b) => a.eqi - b.eqi)) {
    if (eqi === EQI.AMMO) { ammo = it; continue; }
    equip.def += it.def;
    let lr: LrFlag = "none";
    if (it.type === "Weapon") { // a weapon only in EQI_HAND_L (dual wield: lhw, LR_FLAG_WEAPON) doesn't exist here
      weapon = weaponOf(it, refine);
      rhw.atk += weapon.atk; rhw.atk2 += weapon.atk2; rhw.matk += weapon.matk; rhw.wlv = weapon.level; rhw.range += weapon.range;
    } else {
      refinedef += refineInfo(it, refine)?.bonus ?? 0;
      if (eqi === EQI.HAND_L) { shield = true; lr = "shield"; }
    }
    for (const b of it.bonuses) scriptBonus(equip, b, lr);
  }
  if (ammo) {
    equip.arrowAtk += ammo.atk;
    for (const b of ammo.bonuses) scriptBonus(equip, b, "arrow", weapon.type);
  }
  equip.def += Math.trunc((refinedef + 50) / 100);
  // status.cpp:4092-4094: memcpy(param_equip, param_bonus) once the equipment loop is done and before the card loop below, so a card's
  // bStr..bLuk raises the stat (param_bonus feeds base_status) but not MaxHP / MaxSP's "+ param_equip[VIT / INT]" (3534, 3585).
  equip.paramEquip = { ...equip.param };
  // "Parse Cards" (status.cpp:4098-4136), after the loop above and the refine DEF: the same equip_index walk, every filled slot's card
  // script in slot order. Only a left-hand WEAPON's cards run under LR_FLAG_WEAPON (none here), a shield's cards run with lr_flag NONE.
  for (const { cards } of pieces.sort((a, b) => a.eqi - b.eqi)) {
    for (const id of cards ?? []) {
      const card = ITEMS.get(id);
      if (card) for (const b of card.bonuses) scriptBonus(equip, b, "none");
    }
  }
  return { weapon, shield, equip, ammo: ammo ? ammo.subType : null };
}

/** status.cpp: max_weight = job MaxWeight + STR * 300 (weights are in 0.1 units, like the item db). */
export const maxWeight = (job: JobKey, str: number, packMule = 0) => JOBS[job].maxWeight + str * 300 + 2000 * packMule; // + MC_INCCARRY (status.cpp:3678)
export const weightPct = (w: number, max: number) => (max > 0 ? Math.floor((w * 100) / max) : 100);

export type Rng = () => number;
export function rollHeal(it: Item, r: Rng = Math.random) {
  const h = (it.effect as { heal?: number[] } | null)?.heal;
  if (!h) return null;
  const between = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  return { hp: between(h[0], h[1]), sp: between(h[2], h[3]) };
}

/** Extra heal-rate sources (percent added to the 100 base); hook for SM_RECOVERY (+10/lv), AM_LEARNINGPOTION (+5/lv), item bonuses. */
export type HealBonus = { hpPct?: number; spPct?: number };

/** pc.cpp pc_itemheal: bonus = 100 + 2*stat (+ skill/item bonus); applied only if bonus != 100 and the result is larger (integer division).
 * `stat` is total VIT for HP, total INT for SP (battle_status, incl. job bonus). */
export function itemHealAmount(rolled: number, stat: number, extraPct = 0): number {
  const bonus = 100 + stat * 2 + extraPct;
  if (bonus === 100) return rolled;
  const tmp = Math.trunc((rolled * bonus) / 100);
  return tmp > rolled ? tmp : rolled;
}
