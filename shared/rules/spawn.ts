// Permanent monster spawns, re-implemented from rAthena: the spawn-line parser npc_parse_mob (src/map/npc.cpp:5218), the
// per-monster centre cell npc_parse_mob2 (npc.cpp:5197), the spawn cell mob_spawn (mob.cpp:1123) with map_search_freecell
// (map.cpp:1798), and the respawn timer mob_setdelayspawn (mob.cpp:1064).
// Data: shared/data/spawns.txt, written in the npc/re/mobs line format with our own map and monster names. Everything here
// is pure (text / map / numbers + a random source in, data or a cell out); server/src/rooms/MapRoom.ts owns the timers.
import { walkable, type GameMap } from "../map.ts";
import { MD, hasMode } from "./mobai.ts";

/** conf/battle/monster.conf (+ misc.conf map_edge_size) spawn keys, rAthena defaults. Keys keep the conf names. */
export const SPAWN_CONF = {
  mob_count_rate: 100, // monsters per spawn line, percent (lines of 1 stay 1)
  mob_spawn_delay: 100, // respawn time of normal monsters, percent
  plant_spawn_delay: 100, // ... of plant-type monsters (all of MD_IGNOREMELEE|MAGIC|RANGED|MISC)
  boss_spawn_delay: 100, // ... of MD_STATUSIMMUNE monsters
  mob_spawn_variance: 1, // bit 1: boss_monster lines keep delay2, bit 2: monster lines keep it (official: bosses only)
  no_spawn_on_player: 0, // 0: monsters may (re)spawn in sight of players
  force_random_spawn: false, // true: every line spawns anywhere on the map
  randomize_center_cell: true, // each monster of a line gets its own centre cell once, at first spawn
  mob_respawn_time: 1000, // a monster with no free cell retries this much later; also the lowest delay1 a line may set
  map_edge_size: 15, // misc.conf: a map-wide search keeps this many cells away from the edges
};
export type SpawnConf = typeof SPAWN_CONF;

/** struct spawn_data (mob.hpp) after npc_parse_mob: x = y = -1 (xs = ys = 0) is "anywhere on the map". */
export type SpawnData = {
  map: string;
  x: number; y: number;
  xs: number; ys: number; // half-spans: the area is x-(xs-1) .. x+(xs-1); 1 = that coordinate is fixed
  boss: boolean; // state.boss: the line was `boss_monster`
  name: string; // the line's display name (shared/data/mobs.json names; the client shows the mobs.json one)
  mobId: number;
  num: number;
  delay1: number; delay2: number; // respawn: delay1 + rnd() % delay2 ms
};

type Cell = { x: number; y: number };
/** rnd_value(min, max) (common/random.hpp): a uniform integer in [min, max]. */
export type RndValue = (min: number, max: number) => number;

const int = (s: string | undefined) => (s === undefined || s.trim() === "" || !/^\s*-?\d+\s*$/.test(s) ? undefined : Number(s));

/**
 * npc_parse_mob (npc.cpp:5218) for one line `map,x,y{,xs,ys}<TAB>monster|boss_monster<TAB>Name<TAB>id,amount{,delay1{,delay2}}`.
 * Same normalisation as the C++: delay1 defaults to 5000 and a given delay1 below mob_respawn_time (other than 5000) falls back
 * to 5000; xs/ys 0 with a non-zero x/y fixes that coordinate (span 1); amount scales with mob_count_rate; 0,0 coordinates,
 * force_random_spawn, or a fixed cell that can't be stood on spawn anywhere on the map (x = y = -1); delay2 is dropped unless
 * mob_spawn_variance keeps it for this kind of line. rAthena logs and skips a bad line; ours throws, so bad data fails at
 * start. Not supported yet (throws): a level override in the name column and the event / size / ai columns.
 */
export function parseSpawnLine(line: string, map: GameMap, mobExists: (id: number) => boolean, conf: SpawnConf = SPAWN_CONF): SpawnData {
  const w = line.split("\t");
  if (w.length !== 4) throw new Error(`spawn line needs 4 tab-separated columns: ${line}`);
  const [w1, w2, w3, w4] = w;
  if (w2 !== "monster" && w2 !== "boss_monster") throw new Error(`not a monster spawn line: ${line}`);
  const p1 = w1.split(","), p4 = w4.split(",");
  const mapName = p1[0];
  const coords = p1.slice(1).map(int); // missing ones are 0 (sscanf leaves them untouched)
  if (!mapName || p1.length > 5 || coords.some((v) => v === undefined)) throw new Error(`bad map column: ${line}`);
  const [x = 0, y = 0, xs0 = 0, ys0 = 0] = coords as number[];
  const mobId = int(p4[0]), num = int(p4[1]), d1 = int(p4[2]), d2 = int(p4[3]) ?? 0;
  if (w3.includes(",")) throw new Error(`spawn level override not supported yet: ${line}`);
  if (p4.length > 4) throw new Error(`spawn event/size/ai columns not supported yet: ${line}`);
  if (mobId === undefined || num === undefined || (p4.length > 2 && d1 === undefined)) throw new Error(`bad mob column: ${line}`);
  if (x < 0 || x >= map.w || y < 0 || y >= map.h) throw new Error(`spawn coordinates out of range: ${line}`);
  if (!mobExists(mobId)) throw new Error(`unknown mob id ${mobId}: ${line}`);
  if (num < 1 || num > 1000) throw new Error(`amount must be 1..1000: ${line}`);
  const delay1 = d1 !== undefined && d1 !== 5000 && d1 < conf.mob_respawn_time ? 5000 : d1 ?? 5000;

  let xs = xs0, ys = ys0, sx = x, sy = y;
  if (xs < 0) xs = 0; else if (xs === 0 && sx > 0) xs = 1; // fixed X
  if (ys < 0) ys = 0; else if (ys === 0 && sy > 0) ys = 1; // fixed Y
  let n = num;
  if (n > 1 && conf.mob_count_rate !== 100) n = Math.max(1, Math.trunc((n * conf.mob_count_rate) / 100));
  if (conf.force_random_spawn || (sx === 0 && sy === 0) || (xs === 1 && ys === 1 && !walkable(map, sx, sy))) {
    sx = sy = -1; xs = ys = 0; // anywhere on the map
  }
  const boss = w2 === "boss_monster";
  const delay2 = (!(conf.mob_spawn_variance & 1) && boss) || (!(conf.mob_spawn_variance & 2) && !boss) ? 0 : d2;
  if (delay1 > 0xfffffff || delay2 > 0xfffffff) throw new Error(`invalid spawn delays: ${line}`);
  return { map: mapName, x: sx, y: sy, xs, ys, boss, name: w3, mobId, num: n, delay1, delay2 };
}

/** The spawn lines of one map from a spawn file (blank lines and `//` comments skipped; other maps' lines ignored, like a
 *  map-server that doesn't load that map). */
export function parseSpawns(text: string, mapName: string, map: GameMap, mobExists: (id: number) => boolean, conf: SpawnConf = SPAWN_CONF) {
  const out: SpawnData[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("//")) continue;
    if (line.split(",", 1)[0] !== mapName) continue;
    out.push(parseSpawnLine(line, map, mobExists, conf));
  }
  return out;
}

/** npc_parse_mob2 (npc.cpp:5197): the centre cell one monster of a line keeps for all its respawns (md->centerX/Y). With
 *  randomize_center_cell each spanned coordinate is a random cell of the area, x first. */
export function spawnCenter(sd: SpawnData, rndValue: RndValue, conf: SpawnConf = SPAWN_CONF): Cell {
  let x = sd.x, y = sd.y;
  if (conf.randomize_center_cell) {
    if (sd.xs > 1) x = rndValue(sd.x - sd.xs + 1, sd.x + sd.xs - 1);
    if (sd.ys > 1) y = rndValue(sd.y - sd.ys + 1, sd.y + sd.ys - 1);
  }
  return { x, y };
}

/**
 * map_search_freecell (map.cpp:1798) without a source unit's own checks (flag 0, no_spawn_on_player off): up to `tries`
 * random cells within rx/ry of (bx, by) — or anywhere at least map_edge_size from the edges when rx/ry < 0 — skipping the
 * centre itself and cells within 5 of the map edge (4 on the far side), first one that can be stood on (CELL_CHKREACH).
 * rx = ry = 0 just checks the centre. undefined = nothing found (the C++ then leaves x/y on the centre).
 */
export function searchFreeCell(map: GameMap, bx: number, by: number, rx: number, ry: number, tries: number, rndValue: RndValue, conf: SpawnConf = SPAWN_CONF): Cell | undefined {
  if (!rx && !ry) return walkable(map, bx, by) ? { x: bx, y: by } : undefined;
  const edge = conf.map_edge_size, edgeValid = Math.min(edge, 5);
  while (tries--) {
    const x = rx >= 0 ? rndValue(bx - rx, bx + rx) : rndValue(edge, map.w - edge - 1);
    const y = ry >= 0 ? rndValue(by - ry, by + ry) : rndValue(edge, map.h - edge - 1);
    if (x === bx && y === by) continue;
    if (x < edgeValid || x > map.w - edgeValid || y < edgeValid || y > map.h - edgeValid) continue;
    if (walkable(map, x, y)) return { x, y };
  }
  return undefined;
}

/**
 * mob_spawn (mob.cpp:1123-1163): where a monster of spawn line `sd` with centre `c` appears. A normal monster stands on its
 * centre with chance 1/(xs*ys) when that cell is free; otherwise 8 tries in the area (span - 1 around the centre), then the
 * centre if free, then 50 tries anywhere on the map. undefined = no cell: retry after mob_respawn_time.
 * (A boss_monster line with one fixed cell skips the search.)
 */
export function mobSpawnCell(map: GameMap, sd: SpawnData, c: Cell, rndValue: RndValue, conf: SpawnConf = SPAWN_CONF): Cell | undefined {
  const { xs, ys } = sd;
  // rnd_chance(1, xs*ys) = rnd_value(1, xs*ys) <= 1; only rolled when the area has a span (C++ short-circuit)
  if ((!sd.boss || (c.x === 0 && c.y === 0) || xs !== 1 || ys !== 1)
    && (xs + ys < 1 || !(rndValue(1, xs * ys) <= 1) || !walkable(map, c.x, c.y))) {
    const area = searchFreeCell(map, c.x, c.y, xs - 1, ys - 1, 8, rndValue, conf);
    if (area) return area;
    if (walkable(map, c.x, c.y)) return { ...c }; // the failed search leaves x/y on the centre
    return searchFreeCell(map, c.x, c.y, -1, -1, 50, rndValue, conf);
  }
  return { ...c };
}

const PLANT = MD.IGNOREMELEE | MD.IGNOREMAGIC | MD.IGNORERANGED | MD.IGNOREMISC;

/**
 * mob_setdelayspawn (mob.cpp:1064): ms from death to respawn = delay1 + rnd() % delay2, scaled by boss_spawn_delay
 * (MD_STATUSIMMUNE), plant_spawn_delay (all four MD_IGNORE* bits) or mob_spawn_delay (others) — the C++ divides by 100 first —
 * and never under 1000 ms. `rnd` = rnd() (only used when delay2 is set).
 */
export function respawnDelay(sd: Pick<SpawnData, "delay1" | "delay2">, mode: number, rnd: number, conf: SpawnConf = SPAWN_CONF) {
  let t = sd.delay1;
  if (sd.delay2) t += rnd % sd.delay2;
  const rate = hasMode(mode, MD.STATUSIMMUNE) ? conf.boss_spawn_delay
    : (mode & PLANT) === PLANT ? conf.plant_spawn_delay // status_has_mode with several bits needs all of them
    : conf.mob_spawn_delay;
  if (rate !== 100) t = Math.trunc(t / 100) * rate;
  return Math.max(1000, t);
}
