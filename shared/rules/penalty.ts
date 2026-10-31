// Renewal level-difference penalty for EXP and item drops, re-implemented from rAthena:
//   src/map/pc.cpp PenaltyDatabase::loadingFinished (gap filling of db/re/level_penalty.yml)
//   src/map/pc.cpp pc_level_penalty_mod (rate lookup, diff = monster level - player base level)
//   src/map/mob.cpp mob_dead, RENEWAL_EXP block (how the rate is applied to each EXP share)
//   src/common/utils.hpp apply_rate
// RENEWAL_EXP / RENEWAL_DROP are on (src/config/renewal.hpp), so both penalties always apply.
import { TABLES } from "./data.ts";

/** rAthena src/map/map.hpp MAX_LEVEL. Bounds the penalty table: index = difference + MAX_LEVEL - 1. */
export const MAX_LEVEL = 275;
/** rAthena src/config/const.hpp MAX_EXP (INT64_MAX for PACKETVER >= 20170830); JS-safe stand-in. */
export const MAX_EXP = Number.MAX_SAFE_INTEGER;

/** e_penalty_type (pc.hpp). Exp/Drop come from level_penalty.yml; MvpExp/MvpDrop have no table there, so they are 100%. */
export type PenaltyType = "Exp" | "Drop" | "MvpExp" | "MvpDrop";

/** PenaltyDatabase::loadingFinished: turn the sparse [difference, rate] list into a dense table of MAX_LEVEL*2-1 rates.
 *  Undefined differences take the nearest defined rate walking away from 0: from diff 0 upward (start 100), then from
 *  diff 0 downward (start 100, but diff 0 is already filled by the first pass, so it seeds the downward walk). */
export function penaltyLoadingFinished(defined: readonly (readonly number[])[]): number[] {
  const rate: (number | undefined)[] = new Array(MAX_LEVEL * 2 - 1).fill(undefined);
  for (const [difference, r] of defined) {
    if (Math.abs(difference) > MAX_LEVEL) throw new Error(`level_penalty: difference ${difference} beyond MAX_LEVEL`);
    rate[difference + MAX_LEVEL - 1] = r; // PenaltyDatabase::parseBodyNode
  }
  for (let i = MAX_LEVEL - 1, last = 100; i < rate.length; i++) {
    if (rate[i] === undefined) rate[i] = last;
    else last = rate[i]!;
  }
  for (let i = MAX_LEVEL - 1, last = 100; i >= 0; i--) {
    if (rate[i] === undefined) rate[i] = last;
    else last = rate[i]!;
  }
  return rate as number[];
}

const PENALTY = new Map<PenaltyType, number[]>(
  Object.entries(TABLES.levelPenalty).map(([type, list]) => [type as PenaltyType, penaltyLoadingFinished(list)]),
);

/** Map flags that switch the penalty off (MF_NORENEWALEXPPENALTY / MF_NORENEWALDROPPENALTY). */
export type PenaltyMapFlags = { noRenewalExpPenalty?: boolean; noRenewalDropPenalty?: boolean };

/** pc_level_penalty_mod: percentage (100 = untouched) for `type` given the receiving player's base level and the
 *  monster. `pc` undefined = no player attached -> 100. Drop types skip monsters with MD_FIXEDITEMDROP.
 *  Differences outside the table (impossible with levels <= MAX_LEVEL) clamp to its ends instead of reading past it. */
export function levelPenaltyMod(
  type: PenaltyType,
  pc: { baseLevel: number } | undefined,
  mob: { level: number; fixedItemDrop?: boolean },
  map: PenaltyMapFlags = {},
): number {
  if (!pc) return 100;
  if ((type === "Drop" && map.noRenewalDropPenalty) || (type === "Exp" && map.noRenewalExpPenalty)) return 100;
  if ((type === "Drop" || type === "MvpDrop") && mob.fixedItemDrop) return 100;
  const table = PENALTY.get(type);
  if (!table) return 100;
  const i = mob.level - pc.baseLevel + MAX_LEVEL - 1;
  return table[Math.max(0, Math.min(table.length - 1, i))];
}

/** utils.hpp apply_rate: integer `val * rate / 100`, dividing first above 100000 to avoid overflow (keeps that rounding). */
export const applyRate = (val: number, rate: number) =>
  rate === 100 ? val : val > 100000 ? Math.trunc(val / 100) * rate : Math.trunc((val * rate) / 100);

/** mob_dead RENEWAL_EXP block (mob.cpp, just before pc_gainexp): each non-zero EXP share is scaled by the receiver's
 *  PENALTY_EXP rate and capped to [1, MAX_EXP]; a zero share stays zero. */
export function applyExpPenalty(base: number, job: number, rate: number) {
  if (rate === 100) return { base, job };
  const cap = (v: number) => (v ? Math.max(1, Math.min(MAX_EXP, applyRate(v, rate))) : 0);
  return { base: cap(base), job: cap(job) };
}
