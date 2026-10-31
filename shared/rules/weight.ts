// Overweight state — rAthena pc_updateweightstatus (pc.cpp:3020-3050): SC_WEIGHT50 from natural_heal_weight_rate (Renewal 70),
// SC_WEIGHT90 from major_overweight_rate (90), both from pc_getpercentweight (floored). Consumers in rAthena:
//  - natural regen: status.cpp:13811 (either state blocks it)
//  - skill casts:   skill_check_condition_castbegin / castend (skill.cpp:8312, 9374) fail with USESKILL_FAIL_WEIGHTOVER at SC_WEIGHT90
// Normal attacks are NOT gated by weight (clif_parse_ActionRequest_sub / unit_attack / battle_weapon_attack read no weight).
import { MAJOR_OVERWEIGHT, NATURAL_HEAL_WEIGHT, weightPct } from "./items.ts";

export const WEIGHT_OK = 0, WEIGHT50 = 1, WEIGHT90 = 2;
export type OverweightState = 0 | 1 | 2;

/** pc_updateweightstatus new_overweight: 0, 1 (SC_WEIGHT50) or 2 (SC_WEIGHT90). */
export function overweightState(weight: number, max: number): OverweightState {
  const pct = weightPct(weight, max);
  return pct >= MAJOR_OVERWEIGHT ? WEIGHT90 : pct >= NATURAL_HEAL_WEIGHT ? WEIGHT50 : WEIGHT_OK;
}
/** Natural HP/SP recovery is blocked in either state (status.cpp:13811). */
export const blocksNaturalRegen = (weight: number, max: number) => overweightState(weight, max) !== WEIGHT_OK;
/** Skill casts fail at SC_WEIGHT90 (skill.cpp:8312, 9374) — call from the cast condition check (castbegin and castend). */
export const blocksSkillCast = (weight: number, max: number) => overweightState(weight, max) === WEIGHT90;
