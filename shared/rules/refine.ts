// Refine levels -> status bonuses, Renewal (rAthena src/map/status.cpp RefineDatabase + status_calc_pc_sub). Numbers come from
// db/re/refine.yml through the importer (TABLES.refine); the refiner's chances, ores and prices (Normal cost type, TABLES.refineChances) are below.
import { TABLES } from "./data.ts";

export const MAX_REFINE = TABLES.maxRefine; // status.hpp MAX_REFINE (20 in Renewal)

/** s_refine_level_info: Bonus is in 1/100 (ATK/MATK/DEF), RandomBonus is the overrefine cap in 1/100. */
export type RefineLevelInfo = { bonus: number; randomBonus: number };

/** The item fields the refine table is keyed on (an items.json row satisfies it). */
export type RefineItem = { type: string; weaponLevel: number; armorLevel: number; refineable: boolean; locations: readonly string[] };

/** RefineDatabase::calculate_refine_info (status.cpp:465-490): weapons by weapon level, armor by armor level, shadow gear
 *  (weapon or armor location) at level 1; anything else has no refine group. */
export function refineGroup(it: RefineItem): { group: string; level: number } | null {
  if (it.type === "Weapon") return { group: "Weapon", level: it.weaponLevel };
  if (it.type === "Armor") return { group: "Armor", level: it.armorLevel };
  if (it.type === "Shadowgear") return { group: it.locations.includes("Shadow_Weapon") ? "Shadow_Weapon" : "Shadow_Armor", level: 1 };
  return null;
}

/** RefineDatabase::findCurrentLevelInfo + findLevelInfoSub (status.cpp:415-462): nothing at +0 or for a non-refineable item
 *  (item_db Refineable: false -> flag.no_refine), otherwise the refine.yml row of the item's group/level for this refine,
 *  the refine capped at MAX_REFINE first (status_calc_pc_sub sanitizes it the same way, status.cpp:3927-3929). */
export function refineInfo(it: RefineItem, refine: number): RefineLevelInfo | null {
  if (refine <= 0 || !it.refineable) return null;
  const g = refineGroup(it);
  if (!g) return null;
  return TABLES.refine[g.group]?.[String(g.level)]?.[String(Math.min(refine, MAX_REFINE))] ?? null;
}

/** One refine attempt's cost row (struct s_refine_cost, status.cpp:296-399): rates are out of 10000, `material` is an item id
 *  (0 = an ore this game does not have). */
export type RefineCost = { rate: number; price: number; material: number; breakingRate: number; downgrade: number };

/** The NPC refiner stops here (npc/merchants/refine.txt refinemain: "getequiprefinerycnt >= 10"); +11 and up is the separate
 *  Renewal refiner (npc/re/merchants/refine.txt, HD / Carnium / Bradium ores) and is not offered. */
export const NPC_MAX_REFINE = 10;

/** The cost row for taking `it` from +refine to +refine+1 (getequippercentrefinery / getequiprefinecost -> refine_db.findLevelInfo
 *  + info->costs[NORMAL]); null for a non-refineable item, an item without a refine group or a level past the table. */
export function refineCost(it: RefineItem, refine: number): RefineCost | null {
  if (!it.refineable || refine < 0) return null;
  const g = refineGroup(it);
  return (g && TABLES.refineChances[g.group]?.[String(g.level)]?.[String(refine + 1)]) || null;
}

/** getequippercentrefinery (script.cpp:9684): the chance in percent (cost->chance / 100); 0 when the item can't be refined. */
export const refinePercent = (it: RefineItem, refine: number) => Math.floor((refineCost(it, refine)?.rate ?? 0) / 100);

/** Safe = the attempt cannot fail (rate 10000): the "safe limit" the NPC refiner offers (refinemain: weapon Lv 1/2/3/4 -> +7/+6/+5/+4,
 *  armor Lv 1 -> +4, which is exactly where refine.yml's Rate drops below 10000). */
export const refineIsSafe = (it: RefineItem, refine: number) => (refineCost(it, refine)?.rate ?? 0) >= 10000;

/** The highest refine reachable without any risk from +0 (refinemain .@safe). */
export function refineSafeLimit(it: RefineItem): number {
  let n = 0;
  while (n < NPC_MAX_REFINE && refineIsSafe(it, n)) n++;
  return n;
}

/** Why the NPC refiner won't take the piece, or null (getequipisenableref, the +10 stop of refinemain, a missing ore). */
export function refineBlock(it: RefineItem, refine: number): string | null {
  if (!it.refineable) return "can't be refined";
  if (refine >= NPC_MAX_REFINE) return "is as refined as it gets";
  const c = refineCost(it, refine);
  if (!c || !c.material) return "needs an ore this blacksmith does not have";
  return null;
}

/** The outcome of one attempt given a roll: `roll` is rand(100) (0..99). script: `if (getequippercentrefinery(part) <= rand(100))
 *  failedrefitem` (refinemain), so the attempt succeeds when percent > roll. A failure at these levels destroys the piece
 *  (failedrefitem; every BreakingRate of the first ten levels is 10000). */
export const refineSucceeds = (it: RefineItem, refine: number, roll: number) => refinePercent(it, refine) > roll;

/** getequiprefinecost's second argument (REFINE_ZENY_COST / REFINE_MATERIAL_ID, script_constants). */
export const REFINE_COST = { ZENY: 0, MATERIAL_ID: 1 } as const;
