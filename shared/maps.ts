// Every map of the world (rAthena: maps listed in conf/maps_athena.conf + their warps in npc/re/warps). One Colyseus room per
// map (server/src/index.ts); a map is generated from its name + the world seed, the same on both sides.
//
// Floor 1 is a hub world like the fields around a capital (W01): Hearthmoor (the rest town) in the middle, a gate on each
// side, and behind each gate a field with its own ground, props, light, music, level band and monster species:
//
//                         f1_field03 Cragrise Highlands (Lv 10-15)
//                                        | N
//   f1_field01 Verdant Plains (Lv 1-5) - W  Hearthmoor  E - f1_field02 Whisperwood (Lv 5-10)
//                                        | S
//                         f1_field04 Sunken Mire (Lv 15-20, the sealed stair down)
//                                        | the stair (opens with Warden Orrin's quest, W03)
//                         f1_dun01 .. f1_dun03 Mirefall Catacombs B1-B3 (Lv 20-30, the MVP's hall at the bottom)
import { generateDungeon, generateField, gateCell, generateMap, walkable, type DungeonTheme, type FieldTheme, type GameMap } from "./map.ts";
import { TOWN_CELLS, TOWN_GATE_CELLS, TOWN_IN_CELLS, generateTown as generateTownCells, townLayout } from "./town.ts";
import {
  F2_BOSS_HALL, F2_DUN, F2_DUN_STAIRS, F2_DUN_THEME, F2_FIELDS, F2_FIELD1, F2_FIELD2, F2_FIELD_GATE, F2_FIELD_THEMES, F2_GATE_OF, F2_MAP_NAMES, F2_TOWN,
  F2_VAULT_STAIR, F2_VAULT_STAIR_IN, T2_CELLS, T2_GATE_CELLS, T2_IN_CELLS, generateTown2, townLayout2, type F2FieldName,
} from "./floor2.ts";
export { F2_BOSS_HALL, F2_DUN, F2_DUN_STAIRS, F2_DUN_THEME, F2_FIELDS, F2_FIELD1, F2_FIELD2, F2_FIELD_THEMES, F2_TOWN, F2_VAULT_STAIR, F2_VAULT_STAIR_IN, T2_CELLS, type F2FieldName };

export const TOWN = "f1_town01";
/** The west field (the first field, its id kept from the single-field days). */
export const FIELD = "f1_field01";
export const FOREST = "f1_field02";
export const HIGHLAND = "f1_field03";
export const MIRE = "f1_field04";
export const FIELDS = [FIELD, FOREST, HIGHLAND, MIRE] as const;
export type FieldName = (typeof FIELDS)[number];
/** W03: the floor's dungeon, three levels down from the sealed stair under the Sunken Mire's keep. */
export const DUN1 = "f1_dun01";
export const DUN2 = "f1_dun02";
export const DUN3 = "f1_dun03";
export const DUNGEONS = [DUN1, DUN2, DUN3] as const;
export type DungeonName = (typeof DUNGEONS)[number];
/** Maps with monsters to hunt (fields and dungeon levels): FIELD_MOBS, habitatOf, the auto-hunt. */
export const HUNT_MAPS = [...FIELDS, ...DUNGEONS, ...F2_FIELDS, F2_DUN] as const;
export type HuntMap = FieldName | DungeonName | F2FieldName | typeof F2_DUN;
export type MapName = typeof TOWN | FieldName | DungeonName | (typeof F2_MAP_NAMES)[number];
export const MAP_NAMES: MapName[] = [TOWN, ...FIELDS, ...DUNGEONS, ...F2_MAP_NAMES];
export const isMapName = (m: unknown): m is MapName => MAP_NAMES.includes(m as MapName);
export const isField = (m: unknown): m is FieldName => FIELDS.includes(m as FieldName);
export const isDungeon = (m: unknown): m is DungeonName => DUNGEONS.includes(m as DungeonName);
export const isHuntMap = (m: unknown): m is HuntMap => isField(m) || isDungeon(m);

/** What the client shows for a map: minimap / entry banner title and subtitle, the music track (client/public/audio/music/
 *  <music>.mp3), and for a field its level band (the auto-hunt picks the field for the character's level). */
export type MapInfo = { title: string; sub: string; town: boolean; music: string; band?: [number, number] };
export const MAP_INFO: Record<MapName, MapInfo> = {
  [TOWN]: { title: "Hearthmoor", sub: "Rest Town — Floor 1", town: true, music: "town" },
  [FIELD]: { title: "Verdant Plains", sub: "Field — Lv 1-5", town: false, music: "field", band: [1, 5] },
  [FOREST]: { title: "Whisperwood", sub: "Field — Lv 5-10", town: false, music: "forest", band: [5, 10] },
  [HIGHLAND]: { title: "Cragrise Highlands", sub: "Field — Lv 10-15", town: false, music: "highland", band: [10, 15] },
  [MIRE]: { title: "Sunken Mire", sub: "Field — Lv 15-20", town: false, music: "ruins", band: [15, 20] },
  [DUN1]: { title: "Mirefall Catacombs B1", sub: "Dungeon — Lv 20-24", town: false, music: "dungeon", band: [20, 24] },
  [DUN2]: { title: "Mirefall Catacombs B2", sub: "Dungeon — Lv 23-27", town: false, music: "dungeon", band: [23, 27] },
  [DUN3]: { title: "Mirefall Catacombs B3", sub: "Dungeon — Lv 26-30", town: false, music: "dungeon", band: [26, 30] },
  // 2.5.0: floor 2 (shared/floor2.ts)
  [F2_TOWN]: { title: "Lanternrest", sub: "Rest Town — Floor 2", town: true, music: "town" },
  [F2_FIELD1]: { title: "Emberlit Terraces", sub: "Field — Lv 30-36", town: false, music: "highland", band: [30, 36] },
  [F2_FIELD2]: { title: "Cinderwatch Heights", sub: "Field — Lv 38-46", town: false, music: "ruins", band: [38, 46] },
  [F2_DUN]: { title: "Emberhollow Vault", sub: "Dungeon — Lv 34-46", town: false, music: "dungeon", band: [34, 46] },
};
/** The Colyseus room of a map: the west field keeps the original room name, so old clients and the test bots join it unchanged. */
export const roomOf = (m: MapName) => (m === FIELD ? "map" : m);

// ---------- the four fields ----------
/** Where each field's road comes in from town (the gate cell is gateCell(theme, edge, at)) and where a walker arrives. */
const SIDE = { [FIELD]: "E", [FOREST]: "W", [HIGHLAND]: "S", [MIRE]: "N" } as const;
// W01 r2: the fields grew from 72-76 to 104-108 cells. Each kept its old content anchored to its gate (shifted by the growth on
// the far side: plains +32,+16, woods +0,+16, highlands +16,+32, mire +16,+0; migration 016 moved saved positions the same way)
// and gained new zones on the far side. `keep` holds the arrival, the NPC camps and each field's hunting-ground cell (FIELD_MOBS).
export const FIELD_THEMES: Record<FieldName, FieldTheme> = {
  // open meadows, scattered trees and ponds; Ranger Vessa's watch post, the old lookout's ruin, Herbalist Tamsin's lake camp; the
  // standing stones of an older ruin in the far west
  [FIELD]: {
    key: "grass", w: 104, h: 104, water: 0.28, relief: 2.2, stone: 0.74, dirt: 0.72,
    props: [["tree", 0.05], ["rock", 0.012], ["stump", 0.004]], border: ["tree", "tree", "rock"], borderDensity: 0.8,
    gates: { E: 52 },
    keep: [{ x: 97, y: 52, r: 2 }, { x: 88, y: 31, r: 3 }, { x: 68, y: 27, r: 2 }, { x: 68, y: 46, r: 2 }, { x: 76, y: 52, r: 1 }, { x: 24, y: 52, r: 2 },
      { x: 90, y: 43, r: 1 }, { x: 82, y: 28, r: 1 }, { x: 60, y: 56, r: 1 }], // + the quests' hunting cells (chapter1.ts HUNT)
    ruins: [{ x: 68, y: 27, w: 4, h: 3 }, { x: 24, y: 52, w: 3, h: 3 }],
  },
  // thick woods of broadleaf and conifer, a lake in the south-west and a bigger one in the east
  [FOREST]: {
    key: "forest", w: 104, h: 104, water: 0.27, relief: 2.0, stone: 0.8, dirt: 0.76,
    props: [["tree", 0.11], ["pine", 0.05], ["stump", 0.01], ["rock", 0.008]], border: ["tree", "pine", "pine"], borderDensity: 0.95,
    gates: { W: 52 },
    keep: [{ x: 6, y: 52, r: 2 }, { x: 15, y: 63, r: 2 }, { x: 32, y: 50, r: 1 }, { x: 16, y: 34, r: 1 }],
    lakes: [{ x: 21, y: 69, r: 3 }, { x: 74, y: 46, r: 5 }],
  },
  // high rocky ground, crags and pines, a tarn in the middle and a smaller one under the north summit
  [HIGHLAND]: {
    key: "highland", w: 108, h: 108, water: 0.24, relief: 3.4, stone: 0.52, dirt: 0.7,
    props: [["rock", 0.055], ["pine", 0.035], ["stump", 0.004]], border: ["rock", "pine", "rock"], borderDensity: 0.85,
    gates: { S: 54 },
    keep: [{ x: 54, y: 101, r: 2 }, { x: 54, y: 82, r: 1 }],
    lakes: [{ x: 54, y: 65, r: 5 }, { x: 34, y: 22, r: 3 }],
  },
  // black water, mud and dead trees; broken walls of an old keep, and under them the sealed stair down (W03); the drowned
  // chapel deeper south
  [MIRE]: {
    key: "swamp", w: 108, h: 108, water: 0.4, relief: 1.2, stone: 0.86, dirt: 0.6,
    props: [["deadtree", 0.05], ["tree", 0.012], ["stump", 0.015], ["rock", 0.006]], border: ["deadtree", "tree", "deadtree"], borderDensity: 0.85,
    gates: { N: 54 },
    keep: [{ x: 54, y: 6, r: 2 }, { x: 54, y: 66, r: 2 }, { x: 54, y: 30, r: 1 }, { x: 30, y: 22, r: 1 }, { x: 34, y: 94, r: 2 }],
    ruins: [{ x: 54, y: 64, w: 6, h: 5 }, { x: 34, y: 52, w: 4, h: 3 }, { x: 34, y: 94, w: 4, h: 3 }],
    stair: { x: 54, y: 66 },
  },
};
/** A field's own seed: the world seed mixed with its name (FNV-1a), so the four fields differ and each stays the same. */
export function fieldSeed(name: string, seed: number) {
  let s = 2166136261 ^ seed;
  for (let i = 0; i < name.length; i++) s = Math.imul(s ^ name.charCodeAt(i), 16777619);
  return s >>> 0;
}

// ---------- the dungeon (W03): Mirefall Catacombs, three levels under the Sunken Mire's keep ----------
/** Each level's stairs: `up` / `down` = the warp cell (a stair portal), `upIn` / `downIn` = where a walker coming the other
 *  way arrives (4 cells inside the chamber, outside the warp's area). Chambers sit on fixed cells (spawn zones in spawns.txt). */
export const DUNGEON_STAIRS: Record<DungeonName, { up: { x: number; y: number }; upIn: { x: number; y: number }; down?: { x: number; y: number }; downIn?: { x: number; y: number } }> = {
  [DUN1]: { up: { x: 32, y: 6 }, upIn: { x: 32, y: 10 }, down: { x: 32, y: 58 }, downIn: { x: 32, y: 54 } },
  [DUN2]: { up: { x: 10, y: 7 }, upIn: { x: 10, y: 11 }, down: { x: 55, y: 60 }, downIn: { x: 55, y: 56 } },
  [DUN3]: { up: { x: 36, y: 65 }, upIn: { x: 36, y: 61 } },
};
/** The MVP's hall at the bottom of B3: Gloopking's spawn cell (its boss_monster line in spawns.txt). */
export const MVP_HALL = { map: DUN3, x: 36, y: 14 } as const;
const stairKeep = (d: DungeonName) => Object.values(DUNGEON_STAIRS[d]).map((c) => ({ ...c, r: 1 }));
export const DUNGEON_THEMES: Record<DungeonName, DungeonTheme> = {
  // B1 (64x64, Lv 20-24): the entrance hall under the stair at the top, Pilferbugs west, Gravelpedes east and in the middle,
  // Duskgnaws in the south-east cave, the stair down at the bottom
  [DUN1]: {
    key: "cave", w: 64, h: 64, extra: 3, loops: 0.35, keep: stairKeep(DUN1),
    chambers: [
      { x: 32, y: 8, rx: 5, ry: 4 }, { x: 13, y: 16, rx: 5, ry: 4 }, { x: 51, y: 17, rx: 5, ry: 4 }, { x: 31, y: 31, rx: 6, ry: 5 },
      { x: 13, y: 44, rx: 5, ry: 5 }, { x: 50, y: 45, rx: 5, ry: 5 }, { x: 32, y: 56, rx: 5, ry: 4 },
    ],
  },
  // B2 (68x68, Lv 23-27): in at the north-west corner, out at the south-east; Duskgnaws, Gloombats, Rattlebones in the middle
  [DUN2]: {
    key: "cave", w: 68, h: 68, extra: 3, loops: 0.35, keep: stairKeep(DUN2),
    chambers: [
      { x: 10, y: 10, rx: 4, ry: 4 }, { x: 34, y: 12, rx: 6, ry: 4 }, { x: 57, y: 14, rx: 5, ry: 5 }, { x: 14, y: 36, rx: 5, ry: 6 },
      { x: 36, y: 36, rx: 6, ry: 5 }, { x: 14, y: 57, rx: 5, ry: 4 }, { x: 55, y: 57, rx: 5, ry: 5 },
    ],
  },
  // B3 (72x72, Lv 26-30): in at the bottom, Rattlebones and Gloombats in the side caves, Gloopking's paved hall at the top
  [DUN3]: {
    key: "cave", w: 72, h: 72, extra: 3, loops: 0.3, keep: [...stairKeep(DUN3), { ...MVP_HALL, r: 2 }],
    chambers: [
      { x: 36, y: 62, rx: 5, ry: 4 }, { x: 13, y: 52, rx: 5, ry: 5 }, { x: 59, y: 52, rx: 5, ry: 5 }, { x: 14, y: 28, rx: 5, ry: 5 },
      { x: 58, y: 28, rx: 5, ry: 5 }, { x: 36, y: 16, rx: 9, ry: 7, hall: true },
    ],
  },
};

const sign2 = (f: F2FieldName) => [MAP_INFO[f].title, MAP_INFO[f].sub.replace("Field — ", "")];
/** The map's cells, the same on server and client. */
export function buildMap(name: MapName, seed: number): GameMap {
  if (name === TOWN) return generateTown();
  if (name === F2_TOWN) return generateTown2(townLayout2({ W: sign2(F2_FIELD1), E: sign2(F2_FIELD2), S: ["The Ascent Stair", "down to Floor 1"] }));
  if (name === F2_DUN) return generateDungeon(fieldSeed(name, seed), F2_DUN_THEME);
  if (isDungeon(name)) return generateDungeon(fieldSeed(name, seed), DUNGEON_THEMES[name]);
  if (name === F2_FIELD1 || name === F2_FIELD2) return generateField(fieldSeed(name, seed), F2_FIELD_THEMES[name]);
  return generateField(fieldSeed(name, seed), FIELD_THEMES[name]);
}
export { generateMap }; // the legacy single field (path_search golden tests run on it)

/** Hearthmoor (W01 r2): a walled town with a fountain plaza, buildings, four streets to four gates (shared/town.ts). The signposts
 *  at the gates name the field behind each and its level band. */
export function generateTown(): GameMap {
  const sign = (f: FieldName) => [MAP_INFO[f].title, MAP_INFO[f].sub.replace("Field — ", "")];
  return generateTownCells(townLayout({ W: sign(FIELD), E: sign(FOREST), N: sign(HIGHLAND), S: sign(MIRE) }));
}

/** The walkable cell nearest to (x, y) (ring search), for arrival cells. */
export function nearestWalkable(m: GameMap, x: number, y: number) {
  for (let r = 0; r < 8; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) === r && walkable(m, x + dx, y + dy)) return { x: x + dx, y: y + dy };
  return { x: m.w >> 1, y: m.h >> 1 };
}

/** A point on a map (rAthena: a map name + cell, as in warp / savepoint). */
export type MapPos = { map: MapName; x: number; y: number };

// ---------- warps (npc/re/warps) ----------
/** npc/re/warps: `<map>,<x>,<y>,0	warp	<name>	<spanx>,<spany>,<to map>,<to x>,<to y>`. A warp is an NPC whose OnTouch area
 *  (spanx / spany cells either side) moves whoever steps in (npc_touch_areanpc NPCTYPE_WARP -> pc_setpos). The client draws a
 *  portal on every warp cell. Arrival cells lie 3-4 cells inside the other map, outside its own warp's area. */
export type Warp = {
  name: string; map: MapName; x: number; y: number; spanx: number; spany: number; to: MapPos;
  /** A scripted door (W03: the sealed stair): the NPC with this id stands on the cell and its OnTouch script decides whether
   *  to warp (rAthena: a script NPC whose OnTouch label calls `warp` when a condition holds). warpAt ignores it; it is in the
   *  list for the warp graph (navigation walks onto it) and the minimap. */
  npc?: string;
};
/** Hearthmoor's four gates (warp cells at the street ends) and where a walker coming in from each field arrives. */
export const TOWN_GATES = TOWN_GATE_CELLS;
const TOWN_IN = TOWN_IN_CELLS;
/** Which town gate leads to which field (the field lies on that side of town). */
const GATE_OF: Record<FieldName, keyof typeof TOWN_GATES> = { [FIELD]: "W", [FOREST]: "E", [HIGHLAND]: "N", [MIRE]: "S" };
/** A field's gate cell (its road out to town) and the cell a walker from town arrives on. */
export function fieldGate(f: FieldName) {
  const t = FIELD_THEMES[f], edge = SIDE[f], along = t.gates[edge]!;
  const gate = gateCell(t, edge, along);
  const back = { N: [0, 4], S: [0, -4], W: [4, 0], E: [-4, 0] }[edge];
  return { gate, arrival: { map: f, x: gate.x + back[0], y: gate.y + back[1] } as MapPos };
}
/** The sealed stair under the Mire's keep (the f1_stair NPC, shared/content/f1/stair.ts) and where a walker coming up out of the
 *  catacombs arrives on the Mire: in the keep, 4 cells north of the stair, outside its trigger area. */
export const MIRE_STAIR = { map: MIRE, ...FIELD_THEMES[MIRE].stair! } as const;
export const MIRE_STAIR_IN: MapPos = { map: MIRE, x: MIRE_STAIR.x, y: MIRE_STAIR.y - 4 };
/** Where the stair down leads: B1's entrance hall. */
export const DUNGEON_ENTRY: MapPos = { map: DUN1, ...DUNGEON_STAIRS[DUN1].upIn };
/** 2.5.0: the Ascent Stair, the way UP to floor 2: a pale spiral stair in the Mire's drowned chapel (the f1_ascent NPC, shared/content/f2/ascent.ts;
 *  a scripted door like the sealed stair: it needs the wardens' seal and Base Lv F2_GATE_LEVEL). A walker coming back down arrives 4 cells north. */
export const MIRE_ASCENT = { map: MIRE, x: 34, y: 94 } as const;
export const MIRE_ASCENT_IN: MapPos = { map: MIRE, x: MIRE_ASCENT.x, y: MIRE_ASCENT.y - 4 };
/** Where the Ascent Stair leads: Lanternrest's south gate, inside the wall. */
export const F2_ARRIVAL: MapPos = { map: F2_TOWN, ...T2_IN_CELLS.S };
export const F2_SAVE: MapPos = { map: F2_TOWN, ...T2_CELLS.save };
/** Lanternrest's gates: town cell -> the field's arrival, and the field's gate -> the town's inside cell. */
const F2_WARPS: Warp[] = [
  ...F2_FIELDS.flatMap((f): Warp[] => {
    const side = F2_GATE_OF[f], { gate, arrival } = F2_FIELD_GATE(f), n = f.slice(3);
    return [
      { name: `town02_${n}`, map: F2_TOWN, ...T2_GATE_CELLS[side], spanx: 1, spany: 1, to: { map: f, ...arrival } },
      { name: `${n}_town02`, map: f, ...gate, spanx: 1, spany: 1, to: { map: F2_TOWN, ...T2_IN_CELLS[side] } },
    ];
  }),
  // the way up (scripted) and the stair back down from Lanternrest's south gate
  { name: "field04_town02", map: MIRE, x: MIRE_ASCENT.x, y: MIRE_ASCENT.y, spanx: 1, spany: 1, to: F2_ARRIVAL, npc: "f1_ascent" },
  { name: "town02_field04", map: F2_TOWN, ...T2_GATE_CELLS.S, spanx: 1, spany: 1, to: MIRE_ASCENT_IN },
  // the Emberhollow Vault under the north-east ruin
  { name: "field06_dun04", map: F2_FIELD2, x: F2_VAULT_STAIR.x, y: F2_VAULT_STAIR.y, spanx: 1, spany: 1, to: { map: F2_DUN, ...F2_DUN_STAIRS.upIn } },
  { name: "dun04_field06", map: F2_DUN, ...F2_DUN_STAIRS.up, spanx: 1, spany: 1, to: F2_VAULT_STAIR_IN },
];
export const WARPS: Warp[] = [
  ...FIELDS.flatMap((f): Warp[] => {
    const side = GATE_OF[f], { gate, arrival } = fieldGate(f), n = f.slice(3); // field01 ...
    return [
      { name: `town01_${n}`, map: TOWN, ...TOWN_GATES[side], spanx: 1, spany: 1, to: arrival },
      { name: `${n}_town01`, map: f, ...gate, spanx: 1, spany: 1, to: { map: TOWN, ...TOWN_IN[side] } },
    ];
  }),
  // W03: the stair down (scripted: it opens with Warden Orrin's quest) and the stairs between the catacomb levels, both ways
  { name: "field04_dun01", map: MIRE, x: MIRE_STAIR.x, y: MIRE_STAIR.y, spanx: 1, spany: 1, to: DUNGEON_ENTRY, npc: "f1_stair" },
  { name: "dun01_field04", map: DUN1, ...DUNGEON_STAIRS[DUN1].up, spanx: 1, spany: 1, to: MIRE_STAIR_IN },
  ...DUNGEONS.slice(0, -1).flatMap((d, i): Warp[] => {
    const below = DUNGEONS[i + 1], n = d.slice(3), m = below.slice(3);
    return [
      { name: `${n}_${m}`, map: d, ...DUNGEON_STAIRS[d].down!, spanx: 1, spany: 1, to: { map: below, ...DUNGEON_STAIRS[below].upIn } },
      { name: `${m}_${n}`, map: below, ...DUNGEON_STAIRS[below].up, spanx: 1, spany: 1, to: { map: d, ...DUNGEON_STAIRS[d].downIn! } },
    ];
  }),
  ...F2_WARPS,
];
/** The plain warp whose area holds (x, y) on `map` (npc_touch_areanpc: |x - nd.x| <= spanx, |y - nd.y| <= spany). Scripted
 *  doors (`npc`) are their NPC's business. */
export const warpAt = (map: MapName, x: number, y: number) =>
  WARPS.find((w) => !w.npc && w.map === map && Math.abs(x - w.x) <= w.spanx && Math.abs(y - w.y) <= w.spany);

/** The warps to take from `from` to reach `to`, in order: a breadth-first search over the warp graph (fewest map changes).
 *  [] when already there, undefined when no chain of warps leads there. `doors` = false leaves the scripted doors out (a
 *  character the sealed stair would turn away). */
export function warpRoute(from: string, to: string, doors = true): Warp[] | undefined {
  if (from === to) return [];
  const prev = new Map<string, Warp | null>([[from, null]]);
  for (let queue = [from], i = 0; i < queue.length; i++) {
    for (const w of WARPS) {
      if (w.map !== queue[i] || prev.has(w.to.map) || (!doors && w.npc)) continue;
      prev.set(w.to.map, w);
      if (w.to.map === to) {
        const out: Warp[] = [];
        for (let k: Warp | null | undefined = w; k; k = prev.get(k.map)) out.unshift(k);
        return out;
      }
      queue.push(w.to.map);
    }
  }
  return undefined;
}
/** Where to walk on `from` to head for map `to`: the cell of the first warp on the way (client auto-navigation), or undefined. */
export const exitToward = (from: string, to: string, doors = true) => warpRoute(from, to, doors)?.[0];

// Kept names from the two-map days (town bot, content): the west gate pair.
export const TOWN_GATE = TOWN_GATES.W; // Hearthmoor's west gate (to the Verdant Plains)
export const TOWN_ARRIVAL: MapPos = { map: TOWN, ...TOWN_IN.W }; // where the road from the west field comes in
export const FIELD_GATE = fieldGate(FIELD).gate; // the Verdant Plains' east gate (to town)
export const FIELD_ARRIVAL: MapPos = fieldGate(FIELD).arrival; // on the Verdant Plains, coming from town

/** Hearthmoor's save point (the Hearthkeeper, npcs.ts): where a climber respawns; also the default save point. */
export const TOWN_SAVE: MapPos = { map: TOWN, ...TOWN_CELLS.save };
/** Where a new character starts (and where migration 016 put everyone in town): the plaza, inside Guide Lio's greeting area. */
export const TOWN_START: MapPos = { map: TOWN, ...TOWN_CELLS.start };

// ---------- what the client knows about places it is not on ----------
/** The map and display name of every NPC a quest or a dialog can send a player to (the client only receives the NPCs of its
 *  own room; navigation needs to know which map to head for). shared/rules/content.test.ts checks this against
 *  shared/content/npcs.ts. */
export const NPC_HOMES: Record<string, { map: MapName; name: string }> = {
  npc_guide: { map: TOWN, name: "Guide Lio" }, npc_merchant: { map: TOWN, name: "Mira the Merchant" },
  npc_warden: { map: TOWN, name: "Warden Orrin" }, npc_hearthkeeper: { map: TOWN, name: "Hearthkeeper Bren" },
  npc_drillmaster: { map: TOWN, name: "Drillmaster Kessa" }, npc_pella: { map: TOWN, name: "Pella the Cook" },
  npc_garr: { map: TOWN, name: "Woodcutter Garr" }, npc_merrit: { map: TOWN, name: "Old Merrit" },
  town_tools: { map: TOWN, name: "Tilda's Sundries" }, town_arms: { map: TOWN, name: "Garrow's Arms" },
  npc_refiner: { map: TOWN, name: "Forgemaster Brann" },
  npc_beastkeeper: { map: TOWN, name: "Keeper Wren" }, // 2.4.0 pets
  npc_ranger: { map: FIELD, name: "Ranger Vessa" }, npc_herbalist: { map: FIELD, name: "Herbalist Tamsin" },
  // 2.5.0 floor 2 (shared/content/f2/*) and the warp crystal of Hearthmoor
  npc_f2_keeper: { map: F2_TOWN, name: "Lamplighter Isolde" }, npc_f2_sentinel: { map: F2_TOWN, name: "Sentinel Corwin" },
  f2_shop: { map: F2_TOWN, name: "Marrow's Provisions" }, f2_crystal: { map: F2_TOWN, name: "Warp Crystal" },
  f1_crystal: { map: TOWN, name: "Warp Crystal" },
  npc_job_swordman: { map: TOWN, name: "Vanguard Master Brannoc" }, npc_job_mage: { map: TOWN, name: "Arcanist Master Ysolde" },
  npc_job_archer: { map: TOWN, name: "Fletcher Master Kestrel" }, npc_job_acolyte: { map: TOWN, name: "Cleric Master Aurel" },
  npc_job_merchant: { map: TOWN, name: "Peddler Master Tobin" }, npc_job_thief: { map: TOWN, name: "Prowler Master Sable" },
  npc_job_grandmaster: { map: TOWN, name: "Guild Grandmaster Aldric" }, npc_rebirth: { map: TOWN, name: "Keeper of the Second Dawn" }, // 2.5.0 (f1/jobs2.ts)
};
/** The monsters of each field and dungeon level (its `monster` spawn lines in shared/data/spawns.txt, not the boss_monster
 *  mini-bosses / MVP, which the auto-hunt must not walk into; shared/rules/spawn.test.ts keeps the two in step) and
 *  the middle of its hunting grounds: where navigation heads for a species that is not in sight, and the auto-hunt's field. */
export const FIELD_MOBS: Record<HuntMap, { mobs: number[]; hunt: { x: number; y: number } }> = {
  [FIELD]: { mobs: [1002, 1113, 1063, 1008], hunt: { x: 76, y: 52 } },
  [FOREST]: { mobs: [1011, 1007, 1047, 1010, 1049, 1004], hunt: { x: 32, y: 50 } },
  [HIGHLAND]: { mobs: [1009, 1012, 1020, 1167, 1052, 1107, 1001], hunt: { x: 54, y: 82 } },
  [MIRE]: { mobs: [1015, 1024, 1014, 1025, 1094, 1019], hunt: { x: 54, y: 30 } },
  // W03: the catacombs (a chamber in the middle of each level's zones)
  [DUN1]: { mobs: [1051, 1174, 1175], hunt: { x: 31, y: 31 } },
  [DUN2]: { mobs: [1175, 1005, 1076], hunt: { x: 36, y: 36 } },
  [DUN3]: { mobs: [1076, 1005], hunt: { x: 14, y: 52 } },
  // 2.5.0 floor 2: its own ember / ash / slag species (rAthena Lv 32-45), the Heights' mini-boss is Cinderwarden
  [F2_FIELD1]: { mobs: [1128, 1176, 1033, 1028], hunt: { x: 50, y: 40 } },
  [F2_FIELD2]: { mobs: [1123, 1013, 1391], hunt: { x: 46, y: 40 } },
  [F2_DUN]: { mobs: [1028, 1013, 1123], hunt: { x: 31, y: 34 } },
};
/** The nearest hunting map (fewest warps from `from`) where any of these monsters lives, or undefined. */
export function habitatOf(mobIds: readonly number[], from: string): HuntMap | undefined {
  let best: HuntMap | undefined, hops = Infinity;
  for (const f of HUNT_MAPS) {
    if (!FIELD_MOBS[f].mobs.some((id) => mobIds.includes(id))) continue;
    const n = warpRoute(from, f)?.length ?? Infinity;
    if (n < hops) { hops = n; best = f; }
  }
  return best;
}
/** Where the auto-hunt goes for a quest target: the quest's Navi place when monsters of `mobIds` live on its map, else the
 *  hunting ground of their nearest habitat (a quest with targets on several fields, e.g. Tumhogs on the plains + Loamblooms
 *  in the woods, has one Navi cell). A Navi without a map, or targets with no known habitat, keep the Navi place. */
export function huntPlaceFor(mobIds: readonly number[], navi: { x: number; y: number; map?: string } | undefined, from: string) {
  const on = navi?.map && (HUNT_MAPS as readonly string[]).includes(navi.map) ? FIELD_MOBS[navi.map as HuntMap] : undefined;
  if (navi && (!navi.map || on?.mobs.some((id) => mobIds.includes(id)))) return navi;
  const h = habitatOf(mobIds, from);
  return h ? { ...FIELD_MOBS[h].hunt, map: h as string } : navi;
}
/** The field (or, for a character the sealed stair lets down, `deep`, the dungeon level) whose level band suits a character of
 *  base level `lv` (the auto-hunt's default ground). */
export function fieldForLevel(lv: number, deep = false): HuntMap {
  let best: HuntMap = FIELD;
  for (const f of deep ? [...FIELDS, ...DUNGEONS] : FIELDS) if (lv > MAP_INFO[f].band![0]) best = f; // a band's first level still hunts the map above
  return best;
}

const built = new Map<string, GameMap>();
/** The map a room state describes (its `map` + `seed`), built once and cached: for client modules that read cells / heights. */
export function mapOfState(S: { seed: number; map?: string }): GameMap {
  const name = isMapName(S.map) ? S.map : FIELD, k = `${name}:${S.seed}`;
  let m = built.get(k);
  if (!m) { m = buildMap(name, S.seed); built.set(k, m); }
  return m;
}
