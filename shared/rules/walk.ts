// Unit movement, re-implemented from rAthena src/map/unit.cpp (unit_walktoxy, unit_walktoxy_sub, unit_walktoxy_nextcell,
// unit_walktoxy_timer, unit_stop_walking, unit_stop_walking_soon, unit_set_walkdelay, unit_data::update_pos). Pure:
// server/src/rooms/MapRoom.ts keeps each unit's walk state (ud->walkpath, walktimer, to_x / to_y, change_walk_target,
// canmove_tick) and runs these rules on its timeline.
//
// The model, as in rAthena: a unit stands on one cell (bl->x / bl->y). A walk is a path of cells; each step is a timer that
// fires `speed` ms after the step began (speed * 14 / 10 on a diagonal), and only then does the unit's cell change
// (unit_walktoxy_timer -> map_moveblock). Everything that asks where a unit is (walk requests, range checks, FIXPOS stops)
// reads that cell, never the half-way position the client draws.
import { MAX_WALK_PATH, MOVE_COST, MOVE_DIAGONAL_COST, OFFICIAL_WALKPATH, findPath, pathSearchLong, walkable, type GameMap } from "../map.ts";
import { BL } from "./battle.ts";

export type Cell = { x: number; y: number };

/** Conf values of the movement rules, keyed by their rAthena conf name (defaults unless noted). */
export const WALK_CONF = {
  /** conf/battle/client.conf: the longest path (cells) a walk request may ask for. */
  max_walk_path: MAX_WALK_PATH,
  /** conf/battle/battle.conf:27-33 (Note 3 unit-type mask): units that can't move for their amotion after a normal attack
   *  (unit.cpp:3328-3330 -> unit_set_walkdelay type 1). rAthena ships 0 because the official client itself holds its move
   *  requests during the attack motion ("for client-controlled characters this setting is mainly a safety mechanism against
   *  client edits"); our client sends every click, so the server keeps that window for players. Monsters stay off: their
   *  AI already pauses for amotion (mob_set_delay). */
  attack_walk_delay: BL.PC,
  /** conf/battle/battle.conf:40: 0 = official, a hit only stops the target on the nearest cell centre (USW_MOVE_FULL_CELL,
   *  unit.cpp:2026-2029) and never blocks its next move. */
  damage_walk_delay: 0,
  /** conf/battle/misc.conf:103: how many standing units (players, monsters, NPCs) a cell holds before a unit whose walk ends
   *  there moves on to a free neighbour (unit_walktoxy_timer) and a click one cell west onto it is dropped (clif_parse_WalkToXY);
   *  0 = off. */
  official_cell_stack_limit: 1,
};

/** e_unit_stop_walking (unit.hpp:103-111). */
export const USW = { NONE: 0x0, FIXPOS: 0x1, MOVE_ONCE: 0x2, MOVE_FULL_CELL: 0x4, FORCE_STOP: 0x8, RELEASE_TARGET: 0x10 } as const;

/** unit_walktoxy_nextcell (unit.cpp:226-238): how long the step from `from` into `to` takes at `speed` ms per cell. A diagonal
 *  step takes speed * MOVE_DIAGONAL_COST / MOVE_COST (integer division); its timer fires that long after the step begins. */
export const stepTime = (speed: number, from: Cell, to: Cell) =>
  from.x !== to.x && from.y !== to.y ? Math.trunc((speed * MOVE_DIAGONAL_COST) / MOVE_COST) : speed;

/** path_search (path.cpp:258, A*, CELL_CHKNOPASS) including its same-cell case: the target itself when passable gives
 *  path_len 0 ([]); null = no path. */
export function searchPath(m: GameMap, from: Cell, to: Cell): Cell[] | null {
  if (from.x === to.x && from.y === to.y) return walkable(m, to.x, to.y) ? [] : null;
  const path = findPath(m, from.x, from.y, to.x, to.y);
  return path.length ? path : null;
}

/**
 * The path checks of unit_walktoxy (unit.cpp:855-869), searched from `from` = the cell the unit stands on (bl->x / bl->y),
 * also while it is stepping into the next one: path_search (<= MAX_WALKPATH cells), then, for anything but an NPC, at most
 * max_walk_path cells and, over OFFICIAL_WALKPATH cells, a clear straight line (path_search_long). Returns the path (cells
 * after `from`; [] for a request onto the unit's own cell, which path_search accepts with path_len 0) or null = refused,
 * which leaves whatever the unit was doing untouched.
 */
export function walkRequestPath(m: GameMap, from: Cell, to: Cell, npc = false, c = WALK_CONF): Cell[] | null {
  const path = searchPath(m, from, to);
  if (!path || npc) return path;
  if (path.length > c.max_walk_path) return null;
  if (path.length > OFFICIAL_WALKPATH && !pathSearchLong(m, from.x, from.y, to.x, to.y)) return null;
  return path;
}

/**
 * unit_walktoxy_sub (unit.cpp:254-272): the search a walk really starts with, from the unit's cell to ud->to_x / to_y:
 * path_search (<= MAX_WALKPATH) and OFFICIAL_WALKPATH, but no max_walk_path. A request accepted while a step runs
 * (change_walk_target) is searched again with this when the step ends, from the cell just entered (unit.cpp:738-743); null
 * there stops the unit on that cell (clif_fixpos). Chases (unit_walktobl) start through here too.
 */
export function walkSubPath(m: GameMap, from: Cell, to: Cell, npc = false): Cell[] | null {
  const path = searchPath(m, from, to);
  if (!path || npc) return path;
  if (path.length > OFFICIAL_WALKPATH && !pathSearchLong(m, from.x, from.y, to.x, to.y)) return null;
  return path;
}

/** unit_walktoxy flag 4 (unit.cpp:872-878, every player walk request): while ud->canmove_tick is still ahead, less than
 *  2000 ms away, the request is not refused but run again at canmove_tick + 1 (unit_delay_walktoxy_timer -> unit_walktoxy
 *  with flag 0). Returns that time, or undefined to go on now (where unit_can_move still refuses a longer delay). */
export function delayedWalkAt(canmoveTick: number, tick: number): number | undefined {
  const d = canmoveTick - tick;
  return d > 0 && d < 2000 ? canmoveTick + 1 : undefined;
}

/** unit_set_walkdelay type 1 (unit.cpp:2016-2023, 2043): a skill or attack walk delay; the unit can't move before
 *  tick + delay. Never shortens a delay already set, and a status-immune monster (boss) ignores it. Returns the new
 *  canmove_tick (the old one when nothing applies). */
export function skillWalkDelay(canmoveTick: number, tick: number, delay: number, statusImmune = false): number {
  if (delay <= 0 || statusImmune) return canmoveTick;
  return canmoveTick - (tick + delay) > 0 ? canmoveTick : tick + delay;
}

/** attack_walk_delay (unit.cpp:3328-3330): whether a unit of bl_type `type` gets a walk delay of its amotion per swing. */
export const attackWalkDelay = (type: number, c = WALK_CONF) => (c.attack_walk_delay & type) !== 0;

/** USW_MOVE_FULL_CELL (unit.cpp:1725-1730): a unit being stopped still finishes its step once at least half of it has
 *  passed, i.e. the step timer is due within half its data (td->data / 2, integer division). */
export const pastHalfStep = (stepAt: number, stepMs: number, tick: number) => stepAt - tick <= Math.trunc(stepMs / 2);

/** How far into its running step a unit is, 0..1: unit_data::update_pos's cell_percent = 1 - (timer tick - tick) / data. */
export const stepProgress = (stepAt: number, stepMs: number, tick: number) =>
  Math.min(1, Math.max(0, 1 - (stepAt - tick) / stepMs));

/**
 * unit_data::update_pos (unit.cpp:1532-1585): the "exact" cell of a unit stepping from `cell` into `next` with `progress`
 * (stepProgress) of the step done. The sub-cell position 24 + dir * 16 * progress (truncated to an integer) leaves
 * 16..31 when the unit crosses the border into the next cell, i.e. half way through the step ("officially the coordinates
 * update when crossing the border"). rAthena reads it where the half-way point matters: a looter's "ready to loot"
 * (mob.cpp:2076) and unit_stop_walking_soon.
 */
export function exactCell(cell: Cell, next: Cell, progress: number): Cell {
  if (progress >= 1) return { x: next.x, y: next.y };
  if (progress <= 0) return { x: cell.x, y: cell.y };
  const sx = Math.trunc(24 + (next.x - cell.x) * 16 * progress), sy = Math.trunc(24 + (next.y - cell.y) * 16 * progress);
  return { x: cell.x + (sx < 16 ? -1 : sx > 31 ? 1 : 0), y: cell.y + (sy < 16 ? -1 : sy > 31 ? 1 : 0) };
}

/** unit_stop_walking_soon (unit.cpp:1636-1690): how many cells of the walkpath (from path_pos) a walk that should end soon
 *  still walks: whatever is left when that is less than one cell, else one more cell, or two once the unit has crossed into
 *  the next cell (exactCell). The walk goes on, shortened to that ("stop after 0.5-1.5 cells moved"). */
export function stopSoonRemain(pathPos: number, pathLen: number, crossed: boolean) {
  if (pathPos + 1 >= pathLen) return Math.max(0, pathLen - pathPos);
  return crossed ? 2 : 1;
}

/** unit_walktoxy_timer (unit.cpp:764-779): a walk that ends on a cell where map_count_oncell(BL_CHAR|BL_NPC, flag 1) — the
 *  standing units, the one that just stopped included — exceeds official_cell_stack_limit goes on to a free neighbour
 *  (unit_walktoxy flag 8). Walking NPCs and chase stops (unit_update_chase -> unit_stop_walking) never get here. */
export const cellStackExceeded = (standingOnCell: number, c = WALK_CONF) =>
  c.official_cell_stack_limit > 0 && standingOnCell > c.official_cell_stack_limit;

/** clif_parse_WalkToXY (clif.cpp:11402-11405): a click on the cell one west of the player is dropped while any standing unit
 *  is on it (official_cell_stack_limit on). */
export const westClickBlocked = (from: Cell, to: Cell, standingOnTarget: number, c = WALK_CONF) =>
  c.official_cell_stack_limit > 0 && from.x === to.x + 1 && from.y === to.y && standingOnTarget > 0;

/** dirx / diry (path.cpp), indexed by rAthena's direction (0 = north (+y) ... 7 = northeast). */
const DIR_DX = [0, -1, -1, -1, 0, 1, 1, 1], DIR_DY = [1, 1, 0, -1, -1, -1, 0, 1];
/** map_nearby_freecell's two direction orders (map.cpp:1968-1971): NE E SE S N SW W NW, or SW W NW N S NE E SE. */
export const FREECELL_ORDERS = [[7, 6, 5, 4, 0, 3, 2, 1], [3, 2, 1, 0, 4, 7, 6, 5]] as const;

/** map_nearby_freecell (map.cpp:1957-1988): (x, y) itself when no standing unit is on it, else the first neighbour in the
 *  order picked at random (`order` 0 / 1, the caller's rnd) that holds no standing unit and is passable; null = none. */
export function nearbyFreecell(m: GameMap, x: number, y: number, standingOn: (x: number, y: number) => number, order: 0 | 1): Cell | null {
  if (!standingOn(x, y)) return { x, y };
  for (const d of FREECELL_ORDERS[order]) {
    const tx = x + DIR_DX[d], ty = y + DIR_DY[d];
    if (!standingOn(tx, ty) && walkable(m, tx, ty)) return { x: tx, y: ty };
  }
  return null;
}
