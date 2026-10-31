// Who receives a per-event packet, re-implemented from rAthena src/map/clif.cpp clif_send (clif.cpp:477) and clif_send_sub
// (clif.cpp:401). The area targets reach every player whose cell lies within AREA_SIZE cells of the source unit's cell on
// both axes: map_foreachinallarea(bl->x - AREA_SIZE .. bl->x + AREA_SIZE, same for y, BL_PC) is a square (the same square
// distance as the other AREA checks, shared/map.ts distance) with no wall check (map.cpp:913, wall_check false).
// AREA_SIZE = battle_config.area_size (map.hpp; conf/battle/client.conf:39 area_size: 14).
//
// Only events go through this. The synced room state (positions, looks, monster HP ...) still reaches every client on the
// map; an area-of-interest filter for it is a separate change.
import { distance } from "../../shared/map.ts";
import { BATTLE_CONF } from "../../shared/rules/battle.ts";

/**
 * enum send_target (clif.hpp:207), the targets our per-event packets use:
 * - AREA: everyone in the area, the source included (clif.cpp:517-526; a player source off the map gets it through SELF).
 * - AREA_WOS: the area without the source itself (clif_send_sub, clif.cpp:422-424).
 * - AREA_WOC: the area without players sitting in a chat room, and without the source (clif.cpp:426-428). Chat rooms don't
 *   exist yet, so this is AREA_WOS for now.
 * - AREA_CHAT_WOC: AREA_WOC over the "hearable" area, AREA_SIZE - 5 cells (clif.cpp:527-530): public chat.
 * - SELF: the source player only (clif.cpp:622).
 */
export type SendTarget = "AREA" | "AREA_WOS" | "AREA_WOC" | "AREA_CHAT_WOC" | "SELF";

type Cell = { x: number; y: number };

/** How far a target reaches, in cells (square distance): AREA_SIZE, AREA_SIZE - 5 for AREA_CHAT_WOC, 0 for SELF. */
export function areaRange(type: SendTarget, c: { area_size: number } = BATTLE_CONF) {
  return type === "SELF" ? 0 : type === "AREA_CHAT_WOC" ? c.area_size - 5 : c.area_size;
}

/**
 * clif_send's receivers for one event. `src` = the unit the packet is sent around (clif_send's `bl`): its id (a player's
 * session id, a monster id ...) and its cell. `players` = every player on the map with its cell (BL_PC in the area search).
 * Returns the ids of the players that get the packet, in `players` order.
 */
export function areaReceivers(type: SendTarget, src: { id: string } & Cell, players: Iterable<readonly [string, Cell]>,
  c: { area_size: number } = BATTLE_CONF): string[] {
  const out: string[] = [];
  const range = areaRange(type, c), withSelf = type === "AREA" || type === "SELF";
  for (const [id, at] of players) {
    if (id === src.id ? !withSelf : type === "SELF") continue;
    if (distance(at.x - src.x, at.y - src.y) <= range) out.push(id);
  }
  return out;
}
