// Monster AI decisions, re-implemented from rAthena src/map/mob.cpp (mob_ai_sub_hard and the helpers it calls),
// src/map/unit.cpp (unit_can_reach_bl, unit_get_walkpath_time) and src/map/battle.cpp (battle_check_range).
// Everything here is pure (map + cells + numbers in, decision out); server/src/rooms/MapRoom.ts runs the per-tick loop and
// owns the world. Behaviour is driven by each monster's mob_db data (shared/data/mobs.json: mode bits from Ai + Modes,
// AttackRange / SkillRange / ChaseRange, speeds, delays), so a new monster type needs data only.
import { distance, distanceClient, findPath, pathSearchLong, walkable, MOVE_COST, MOVE_DIAGONAL_COST, OFFICIAL_WALKPATH, type GameMap } from "../map.ts";
import { BATTLE_CONF } from "./battle.ts";
import { MD, hasMode } from "./mode.ts";

// enum e_mode (src/common/mmo.hpp:242) and status_has_mode live in mode.ts (battle reads them too); re-exported for the AI's users.
export { MD, hasMode };
export type { ModeName } from "./mode.ts";

/** conf/battle/monster.conf values used by the AI (rAthena defaults). Keys keep the conf names. */
export const MONSTER_CONF = {
  monster_ai: 0, // no custom AI bits: 0x1 chase refresh, 0x8 instant walk after unlock, 0x2000 AI during amotion are all off
  monster_chase_refresh: 32, // a chasing monster walks this many cells of its path before re-deciding (>= MAX_WALKPATH: whole path)
  loot_range: 12,
  monster_loot_type: 0, // 0: a full loot bag drops its oldest item and keeps looting
  monster_loot_search_type: 1, // 1: among reachable items take the one with the lowest id (first dropped); 0: the closest
  assist_range: 11,
  mob_unlock_time: 2000, // an immobile monster keeps an out-of-range target this long before unlocking it
  monster_active_enable: true, // false would strip MD_AGGRESSIVE from every monster (import-time, MobDatabase::loadingFinished)
};

export const MIN_MOBTHINKTIME = 100; // mob.hpp:35 — mob_ai_hard timer interval
export const MIN_MOBLINKTIME = 1000; // mob.hpp:37 — an assist monster links at most once per second
export const MIN_RANDOMWALKTIME = 4000; // mob.hpp:39
export const LOOTITEM_SIZE = 10; // mob.hpp — items a looter can carry
/** mob_randomwalk `d`: a random walk goes to a cell within +-7 of where the monster stands. */
export const RANDOMWALK_RANGE = 7;

/** MobSkillState (mob.hpp) for the states the normal AI moves through. ANGRY / FOLLOW are the MD_ANGRY variants of
 *  BERSERK / RUSH (mob_setstate); they wait for MD_ANGRY monsters. */
export type MobState = "idle" | "walk" | "loot" | "rush" | "berserk";
/** mob_is_chasing (mob.cpp:986): states in which the monster is walking after a target. */
export const isChasing = (s: MobState) => s === "loot" || s === "rush";

type Cell = { x: number; y: number };

/**
 * battle_check_range (battle.cpp:8215): `range` cells apart (square distance; players use the client's circular one,
 * CIRCULAR_AREA off), and beyond 1 cell also within area_size and a clear straight line (path_search_long).
 */
export function battleCheckRange(m: GameMap, src: Cell, dst: Cell, range: number, circular = false, c = BATTLE_CONF) {
  const dx = dst.x - src.x, dy = dst.y - src.y;
  if ((circular ? distanceClient(dx, dy) : distance(dx, dy)) > range) return false;
  const d = distance(dx, dy);
  if (d < 2) return true;
  if (d > c.area_size) return false;
  return pathSearchLong(m, src.x, src.y, dst.x, dst.y);
}

/** status_check_visibility (status.cpp:2292) for a monster: the target is no farther than its ChaseRange (range3),
 *  square distance. (Hiding / cloaking checks wait for those statuses.) */
export const mobCanSee = (mob: Cell, tgt: Cell, chaseRange: number) => distance(tgt.x - mob.x, tgt.y - mob.y) <= chaseRange;

/** path_search result length (A*, flag 0): 0 for the same cell, -1 when there is no path. */
export function pathLength(m: GameMap, from: Cell, to: Cell) {
  if (from.x === to.x && from.y === to.y) return walkable(m, to.x, to.y) ? 0 : -1;
  const p = findPath(m, from.x, from.y, to.x, to.y);
  return p.length ? p.length : -1;
}

/** dirx / diry (unit.cpp:70-71), indexed by direction 0..7. */
const DIRX = [0, -1, -1, -1, 0, 1, 1, 1], DIRY = [1, 1, 0, -1, -1, -1, 0, 1];

/**
 * unit_can_reach_bl (unit.cpp:3044) with easy = 0: the cell next to the target on the side facing `from` (or the first
 * passable neighbour in dir order when that one is blocked) must be reachable by path_search, within `range` cells of
 * `from` when range > 0, and a path over OFFICIAL_WALKPATH cells also needs a clear straight line. Returns that cell (the
 * chase destination, ud->to_x/to_y) or undefined. Same cell = reachable.
 */
export function canReach(m: GameMap, from: Cell, to: Cell, range: number): Cell | undefined {
  if (from.x === to.x && from.y === to.y) return { x: to.x, y: to.y };
  if (range > 0 && distance(to.x - from.x, to.y - from.y) > range) return undefined;
  let dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  if (!walkable(m, to.x - dx, to.y - dy)) {
    let i = 0;
    while (i < 8 && !walkable(m, to.x - DIRX[i], to.y - DIRY[i])) i++;
    if (i === 8) return undefined;
    dx = DIRX[i]; dy = DIRY[i];
  }
  const dest = { x: to.x - dx, y: to.y - dy };
  const len = pathLength(m, from, dest);
  if (len < 0) return undefined;
  if (len > OFFICIAL_WALKPATH && !pathSearchLong(m, from.x, from.y, dest.x, dest.y)) return undefined;
  return dest;
}

/**
 * mob_can_changetarget (mob.cpp:1229), monster_ai 0: idle / walking / looting monsters always switch; a chasing one only
 * with MD_CHANGETARGETCHASE; an attacking (berserk) one only with MD_CHANGETARGETMELEE and only for the special
 * "normal attacked" event (hit by a normal attack from within its attack range + 1 by someone it isn't fighting).
 */
export function canChangeTarget(state: MobState, mode: number, normAttacked: boolean) {
  switch (state) {
    case "berserk": return hasMode(mode, MD.CHANGETARGETMELEE) && normAttacked;
    case "rush": return hasMode(mode, MD.CHANGETARGETCHASE);
    default: return true;
  }
}

/** One candidate of mob_ai_sub_hard_activesearch: the unit's cell, base level and whether it can be targeted at all
 *  (alive, an enemy, status_check_skilluse). */
export type AggroCandidate<T> = { id: T; x: number; y: number; level: number };

/**
 * mob_ai_sub_hard_activesearch (mob.cpp:1312) run over every unit within view range (SkillRange, `range2`): skip
 * MD_TARGETWEAK targets of level >= mob level - 5; take a unit that is closer than the current pick (square distance,
 * first one wins ties) and within battle_check_range(range2); with ACTIVEPATHSEARCH (mob.cpp:58) the walk path to it must
 * exist and be at most range2 cells for a standing monster, range3 for a walking one.
 */
export function pickAggroTarget<T>(m: GameMap, mob: Cell & { level: number; mode: number; range2: number; range3: number; walking: boolean },
  cands: Iterable<AggroCandidate<T>>): T | undefined {
  let best: AggroCandidate<T> | undefined, bestD = Infinity;
  for (const c of cands) {
    if (hasMode(mob.mode, MD.TARGETWEAK) && c.level >= mob.level - 5) continue;
    const d = distance(c.x - mob.x, c.y - mob.y);
    if (best && bestD <= d) continue; // !check_distance_bl(md, *target, dist): only a strictly closer unit replaces the pick
    if (!battleCheckRange(m, mob, c, mob.range2)) continue;
    const len = pathLength(m, mob, c);
    if (len < 0 || len > (mob.walking ? mob.range3 : mob.range2)) continue;
    best = c; bestD = d;
  }
  return best?.id;
}

/**
 * mob_ai_sub_hard_lootsearch (mob.cpp:1412) over the floor items in shoot range (loot_range, clear line): an item the
 * monster can reach (mob_can_reach within loot_range); with monster_loot_search_type 1 the lowest block id wins, with 0
 * the closest. Items are given in any order with a numeric id (our floor items are numbered in drop order like block ids).
 */
export function pickLoot<T extends Cell & { n: number }>(m: GameMap, mob: Cell, items: Iterable<T>, c = MONSTER_CONF): T | undefined {
  let best: T | undefined;
  for (const it of items) {
    if (!battleCheckRange(m, mob, it, c.loot_range)) continue; // map_foreachinshootrange
    if (!canReach(m, mob, it, c.loot_range)) continue;
    if (!best) { best = it; continue; }
    if (c.monster_loot_search_type ? it.n < best.n : distance(best.x - mob.x, best.y - mob.y) > distance(it.x - mob.x, it.y - mob.y)) best = it;
  }
  return best;
}

/** Store a looted item (mob_ai_sub_hard loot branch): append while there is room; monster_loot_type 0 drops the oldest
 *  item of a full bag to make room. Returns the new bag. */
export function addLoot<I>(bag: readonly I[], item: I, size = LOOTITEM_SIZE): I[] {
  return bag.length < size ? [...bag, item] : [...bag.slice(1), item];
}

/**
 * The cells mob_randomwalk (mob.cpp:1673) tries, in order, for one random number `r` (rnd()) and direction `rdir`
 * (rnd()%4): start at (r % 15 - 7, r / 15 % 15 - 7), then jump 7 cells in the rdir direction, wrapping around the 15x15
 * square — all 225 offsets once. The caller takes the first one that is not the monster's own cell, is passable and can
 * be walked to.
 */
export function randomWalkOffsets(r: number, rdir: number, d = RANDOMWALK_RANGE): { dx: number; dy: number }[] {
  const side = d * 2 + 1, out: { dx: number; dy: number }[] = [];
  let dx = (r % side) - d, dy = (Math.trunc(r / side) % side) - d;
  for (let i = 0; i < side * side; i++) {
    out.push({ dx, dy });
    switch (rdir) {
      case 0: dx += d; if (dx > d) { dx -= side; dy += d; if (dy > d) dy -= side; } break;
      case 1: dx -= d; if (dx < -d) { dx += side; dy -= d; if (dy < -d) dy += side; } break;
      case 2: dy += d; if (dy > d) { dy -= side; dx += d; if (dx > d) dx -= side; } break;
      default: dy -= d; if (dy < -d) { dy += side; dx -= d; if (dx < -d) dx += side; } break;
    }
  }
  return out;
}

/** unit_get_walkpath_time (unit.cpp:1112): how long walking `path` (cells after `from`) takes at `speed` ms per cell. */
export function walkpathTime(from: Cell, path: readonly Cell[], speed: number) {
  let t = 0, p = from;
  for (const c of path) {
    t += c.x !== p.x && c.y !== p.y ? Math.trunc((speed * MOVE_DIAGONAL_COST) / MOVE_COST) : speed;
    p = c;
  }
  return t;
}

/** next_walktime (mob_spawn mob.cpp:1190, mob_unlocktarget, mob_randomwalk mob.cpp:1766): MIN_RANDOMWALKTIME + rnd()%1000
 *  after `tick`, plus the time the walk just started takes. `rnd` is the random number. */
export const nextWalkTime = (tick: number, rnd: number, walkMs = 0) => tick + (rnd % 1000) + MIN_RANDOMWALKTIME + walkMs;
