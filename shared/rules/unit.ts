// A player's normal-attack loop, re-implemented from rAthena src/map/unit.cpp unit_attack_timer_sub (src/config/core.hpp
// OFFICIAL_WALKPATH on, CIRCULAR_AREA off). Pure: server/src/rooms/MapRoom.ts fight() runs it whenever the attack timer would
// run and applies the result. Monsters take their swing decisions from mobai.ts (mob_ai_sub_hard).
import { distanceClient, pathSearchLong, type GameMap } from "../map.ts";
import { battleCheckRange } from "./mobai.ts";

type Cell = { x: number; y: number };

/** What one run of a player's attack timer decides. */
export type PcAttackStep = "drop" | "chase" | "swing";

/** The reach of a player's normal attack (unit_attack_timer_sub, unit.cpp:3253-3258): status rhw.range (the weapon's item Range,
 *  at least 1), +1 while the target is walking (`unit_is_walking(target)`), on the client's circular distance. */
export const pcAttackReach = (range: number, targetWalking: boolean) => range + (targetWalking ? 1 : 0);
/** check_distance_client_bl (unit.cpp:3260-3263): the target is within `reach` cells by the client's circular distance. */
export const inPcReach = (from: Cell, to: Cell, reach: number) => distanceClient(to.x - from.x, to.y - from.y) <= reach;

/**
 * One run of a player's attack timer against the target (unit_attack_timer_sub, unit.cpp:3187-3277). It runs on the attack
 * request (unit_attack runs it at once when the attack delay is over, else at attackabletime; unit.cpp:2971-2977), at each swing
 * (attackabletime) and each time the client comes back after walking in.
 * - "drop": OFFICIAL_WALKPATH — the straight line to the target crosses a wall (`!path_search_long(.., CELL_CHKWALL)`,
 *   unit.cpp:3221-3228), checked before the range: the timer returns 0 and unit_attack_timer calls unit_unattackable
 *   (unit.cpp:3361-3362), so the target is dropped with no walk around the obstacle ("players will have to click to walk
 *   around it before attacking", core.hpp:20-25). Also when the target is within reach but battle_check_range still fails
 *   (unit.cpp:3270-3281: with the line clear it only fails beyond area_size, where rAthena walks a continuous attacker with
 *   chaserange > 1 closer; no weapon here reaches that far, so it is dropped).
 * - "chase": farther than the reach (pcAttackReach, check_distance_client_bl): clif_movetoattack, the client walks in.
 * - "swing": within reach on a clear line; battle_weapon_attack decides the rest (ammo, battle.ts weaponAttackAmmo).
 * This map has no shootable-but-unwalkable cells (no gat type 5 "cliffs"): every blocked cell (water, tree, rock, the edge) is a
 * gat-1 wall, so CELL_CHKWALL is path_search_long over walkable cells.
 */
export function pcAttackStep(m: GameMap, from: Cell, to: Cell, range: number, targetWalking: boolean): PcAttackStep {
  if (!pathSearchLong(m, from.x, from.y, to.x, to.y)) return "drop";
  const reach = pcAttackReach(range, targetWalking);
  if (!inPcReach(from, to, reach)) return "chase";
  return battleCheckRange(m, from, to, reach, true) ? "swing" : "drop";
}

/**
 * unit_attack's step action (unit.cpp:2955-2966): an attack a player asks for while its step timer runs is decided at the
 * request. Not within battle_check_range(range - 1) (the client's circular distance for players, battle.cpp:8215-8239), it is
 * only remembered (ud->stepaction, ud->target_to) and the walk goes on; within it, the attack timer runs now (or at
 * attackabletime, unit.cpp:2971-2977) and the swing stops the walk on the cell the player stands on (USW_FIXPOS,
 * unit.cpp:3294-3295). True = remember it as a step action.
 */
export const pcDefersAttack = (m: GameMap, from: Cell, to: Cell, range: number, walking: boolean) =>
  walking && !battleCheckRange(m, from, to, range - 1, true);

/** unit_walktoxy_timer (unit.cpp:723-736): a remembered step action is tried again half the step just finished after the unit
 *  entered its new cell (speed / 2, or speed * MOVE_DIAGONAL_COST / MOVE_COST / 2 on a diagonal = half that step's time, C
 *  integer division) -> unit_step_timer (unit.cpp:439-496) -> unit_attack with step_attack, which adds 1 to the reach
 *  (unit.cpp:3256-3258, see pcAttackReach). */
export const stepActionDelay = (stepMs: number) => Math.trunc(stepMs / 2);
