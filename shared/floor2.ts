// Floor 2 of the Tower (2.5.0): Lanternrest (the rest town), two fields and the Emberhollow Vault (a one-level dungeon). The map
// data lives here, without the warp graph (shared/maps.ts imports this file and lists the warps); the NPCs are in
// shared/content/f2/*, the spawns in shared/data/spawns.txt, the story in docs/TOWER_STORY.md.
//
//   f2_field01 Emberlit Terraces (Lv 22-26) -- W  Lanternrest  E -- f2_field02 Cinderwatch Heights (Lv 25-29) -- stair -- f2_dun01
//                                                  | S: the Ascent Stair, down to floor 1's Sunken Mire
//
// Same shape as floor 1 (a walled rest town, a gate on each side with a field behind it), smaller: 41x41 town, 80x80 fields.
import { TILE, gateCell, type Building, type DungeonTheme, type FieldTheme, type GameMap, type TownDecor, type TownLayout } from "./map.ts";

export const F2_TOWN = "f2_town01";
export const F2_FIELD1 = "f2_field01";
export const F2_FIELD2 = "f2_field02";
export const F2_FIELDS = [F2_FIELD1, F2_FIELD2] as const;
export type F2FieldName = (typeof F2_FIELDS)[number];
export const F2_DUN = "f2_dun01";
export type F2MapName = typeof F2_TOWN | F2FieldName | typeof F2_DUN;
export const F2_MAP_NAMES: F2MapName[] = [F2_TOWN, ...F2_FIELDS, F2_DUN];

// ---------- Lanternrest ----------
export const T2_W = 41, T2_C = 20, T2_RING = 15, T2_STREET = 1, T2_PLAZA = 4;
/** Warp cells outside the three gates (W, E, S) and where a walker coming in arrives (just inside the wall). */
export const T2_GATE_CELLS = { W: { x: 3, y: T2_C }, E: { x: T2_W - 4, y: T2_C }, S: { x: T2_C, y: T2_W - 4 } } as const;
export const T2_IN_CELLS = { W: { x: 8, y: T2_C }, E: { x: T2_W - 9, y: T2_C }, S: { x: T2_C, y: T2_W - 9 } } as const;
/** Where the town's people stand: each at its building's door (save keeper, shop), the Sentinel by the lodge, the crystal on the plaza. */
export const T2_CELLS = {
  keeper: { x: 14, y: 15 }, shop: { x: 27, y: 15 }, sentinel: { x: 23, y: 27 }, crystal: { x: 22, y: 23 },
  save: { x: 14, y: 16 },
} as const;

const BUILDINGS2: Building[] = [
  { x0: 11, y0: 8, x1: 17, y1: 13, face: "S", door: 14, kind: "chapel", roof: 3, floors: 2, sign: "The Lantern House" },
  { x0: 24, y0: 9, x1: 30, y1: 13, face: "S", door: 27, kind: "shop", roof: 1, floors: 1, sign: "Marrow's Provisions" },
  { x0: 7, y0: 8, x1: 9, y1: 12, face: "S", door: 8, kind: "house", roof: 0, floors: 1 },
  { x0: 32, y0: 8, x1: 34, y1: 12, face: "S", door: 33, kind: "house", roof: 2, floors: 2 },
  { x0: 8, y0: 25, x1: 14, y1: 30, face: "E", door: 27, kind: "inn", roof: 3, floors: 2, sign: "The Last Rung" },
  { x0: 26, y0: 25, x1: 33, y1: 29, face: "W", door: 27, kind: "guild", roof: 1, floors: 2, sign: "Spire Lodge" },
  { x0: 8, y0: 33, x1: 12, y1: 36, face: "N", door: 10, kind: "house", roof: 2, floors: 1 },
  { x0: 28, y0: 32, x1: 32, y1: 36, face: "N", door: 30, kind: "house", roof: 0, floors: 2 },
];
const DECOR2: TownDecor[] = [
  { type: "fountain", x: T2_C, y: T2_C },
  { type: "bed", x: 17, y: 17 }, { type: "bed", x: 23, y: 17 }, { type: "bed", x: 17, y: 23 },
  { type: "lamp", x: 16, y: 16 }, { type: "lamp", x: 24, y: 16 }, { type: "lamp", x: 16, y: 24 }, { type: "lamp", x: 24, y: 24 },
  { type: "brazier", x: 12, y: 14 }, { type: "brazier", x: 16, y: 14 },
  { type: "bench", x: 25, y: 20, dir: "E" },
  { type: "barrels", x: 31, y: 14 }, { type: "crates", x: 23, y: 14 },
  { type: "well", x: 18, y: 30 },
  { type: "lamp", x: 18, y: 12 }, { type: "lamp", x: 22, y: 12 }, { type: "lamp", x: 18, y: 28 }, { type: "lamp", x: 22, y: 32 },
  { type: "lamp", x: 11, y: 18 }, { type: "lamp", x: 29, y: 22 },
  { type: "tree", x: 7, y: 16 }, { type: "tree", x: 34, y: 16 }, { type: "tree", x: 7, y: 22 }, { type: "tree", x: 34, y: 23 },
  { type: "tree", x: 16, y: 34 }, { type: "tree", x: 25, y: 34 },
];
/** Lanternrest's layout; `signs` = the signpost text at each gate. */
export function townLayout2(signs: Record<"W" | "E" | "S", string[]>): TownLayout {
  const posts: TownDecor[] = [
    { type: "signpost", x: 8, y: 17, dir: "W", label: signs.W }, { type: "signpost", x: T2_W - 9, y: 17, dir: "E", label: signs.E },
    { type: "signpost", x: 17, y: T2_W - 9, dir: "S", label: signs.S },
  ];
  return { cx: T2_C, cy: T2_C, ring: T2_RING, street: T2_STREET, plaza: T2_PLAZA, buildings: BUILDINGS2, decor: [...DECOR2, ...posts] };
}
/** The town's cells (the shape of shared/town.ts generateTown at a smaller size): cobbled plaza and streets, a stone wall ring
 *  open where the streets pass, woods outside. Themed "dusk" so the client lights it as an evening town. */
export function generateTown2(layout: TownLayout): GameMap {
  const w = T2_W, h = T2_W, C = T2_C;
  const height = new Float32Array(w * h), kind = new Uint8Array(w * h), blocked = new Uint8Array(w * h);
  const props: GameMap["props"] = [];
  const at = (x: number, y: number) => y * w + x;
  const hash = (x: number, y: number) => ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 1000 / 1000;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y), d = Math.max(Math.abs(x - C), Math.abs(y - C));
    const street = Math.abs(y - C) <= T2_STREET || Math.abs(x - C) <= T2_STREET;
    height[i] = 0.05;
    kind[i] = d <= T2_PLAZA || street ? TILE.cobble : hash(x, y) < 0.1 ? TILE.dirt : TILE.grass;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { blocked[i] = 1; continue; }
    if (d === T2_RING && !street) { blocked[i] = 1; continue; }
    if (d > T2_RING && !street) {
      blocked[i] = 1;
      const nearRoad = Math.abs(y - C) <= T2_STREET + 1 || Math.abs(x - C) <= T2_STREET + 1;
      if (d >= T2_RING + 2 && !nearRoad && hash(y, x) < 0.55) props.push({ x, y, type: hash(x + 7, y) < 0.2 ? "rock" : "pine" });
    }
  }
  // the lodge courtyard in front of its door
  for (let y = 26; y <= 28; y++) for (let x = 23; x <= 25; x++) kind[at(x, y)] = TILE.cobble;
  for (const b of layout.buildings) {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { blocked[at(x, y)] = 1; kind[at(x, y)] = TILE.dirt; }
    const step = b.face === "S" ? { x: b.door, y: b.y1 + 1 } : b.face === "N" ? { x: b.door, y: b.y0 - 1 } : b.face === "E" ? { x: b.x1 + 1, y: b.door } : { x: b.x0 - 1, y: b.door };
    if (kind[at(step.x, step.y)] === TILE.grass) kind[at(step.x, step.y)] = TILE.dirt;
  }
  for (const d of layout.decor) {
    if (d.type === "fountain") {
      for (let y = d.y - 3; y <= d.y + 3; y++) for (let x = d.x - 3; x <= d.x + 3; x++) if (Math.hypot(x - d.x, y - d.y) <= 2.3) blocked[at(x, y)] = 1;
      continue;
    }
    blocked[at(d.x, d.y)] = 1;
    if (d.type === "tree") props.push({ x: d.x, y: d.y, type: "tree" });
  }
  return { w, h, height, kind, blocked, props, town: layout, theme: "dusk" };
}

// ---------- the fields (80x80) ----------
export const F2_FIELD_THEMES: Record<F2FieldName, FieldTheme> = {
  // terraces of dry amber grass and pines in the evening light, west of the town; the road comes in from the east gate
  [F2_FIELD1]: {
    key: "dusk", w: 80, h: 80, water: 0.26, relief: 2.6, stone: 0.66, dirt: 0.7,
    props: [["pine", 0.04], ["tree", 0.02], ["rock", 0.022], ["stump", 0.005]], border: ["pine", "rock", "pine"], borderDensity: 0.85,
    gates: { E: 40 },
    keep: [{ x: 73, y: 40, r: 2 }, { x: 50, y: 40, r: 2 }, { x: 56, y: 24, r: 1 }, { x: 20, y: 24, r: 1 }],
    ruins: [{ x: 22, y: 60, w: 4, h: 3 }],
  },
  // ash-grey heights under a low red sun, east of the town; the stair down into the Emberhollow Vault stands in the north-east ruin
  [F2_FIELD2]: {
    key: "ash", w: 80, h: 80, water: 0.2, relief: 3.0, stone: 0.5, dirt: 0.66,
    props: [["rock", 0.05], ["deadtree", 0.028], ["stump", 0.006]], border: ["rock", "deadtree", "rock"], borderDensity: 0.85,
    gates: { W: 40 },
    keep: [{ x: 6, y: 40, r: 2 }, { x: 46, y: 40, r: 2 }, { x: 66, y: 22, r: 2 }, { x: 60, y: 44, r: 2 }],
    ruins: [{ x: 66, y: 18, w: 5, h: 4 }],
    stair: { x: 66, y: 18 },
  },
};
/** The side of its map each field's road to town leaves by. */
export const F2_SIDE = { [F2_FIELD1]: "E", [F2_FIELD2]: "W" } as const;
/** The field behind each of the town's gates. */
export const F2_GATE_OF = { [F2_FIELD1]: "W", [F2_FIELD2]: "E" } as const;
export const F2_FIELD_GATE = (f: F2FieldName) => {
  const t = F2_FIELD_THEMES[f], edge = F2_SIDE[f], gate = gateCell(t, edge, t.gates[edge]!);
  const back = { N: [0, 4], S: [0, -4], W: [4, 0], E: [-4, 0] }[edge];
  return { gate, arrival: { x: gate.x + back[0], y: gate.y + back[1] } };
};
/** The stair down into the vault (field 02) and where a walker coming up out of the vault arrives (4 cells south of it). */
export const F2_VAULT_STAIR = { map: F2_FIELD2, x: 66, y: 18 } as const;
export const F2_VAULT_STAIR_IN = { map: F2_FIELD2, x: 66, y: 22 } as const;

// ---------- the Emberhollow Vault: one cave level, the boss's hall at the bottom ----------
export const F2_DUN_STAIRS = { up: { x: 32, y: 6 }, upIn: { x: 32, y: 10 } } as const;
/** The dungeon boss's hall: Devo's spawn cell (its boss_monster line in spawns.txt). */
export const F2_BOSS_HALL = { map: F2_DUN, x: 32, y: 53 } as const;
export const F2_DUN_THEME: DungeonTheme = {
  key: "cave", w: 64, h: 64, extra: 3, loops: 0.35,
  keep: [{ ...F2_DUN_STAIRS.up, r: 1 }, { ...F2_DUN_STAIRS.upIn, r: 1 }, { x: F2_BOSS_HALL.x, y: F2_BOSS_HALL.y, r: 2 }],
  chambers: [
    { x: 32, y: 8, rx: 5, ry: 4 }, { x: 13, y: 20, rx: 5, ry: 4 }, { x: 51, y: 20, rx: 5, ry: 4 }, { x: 31, y: 34, rx: 6, ry: 5 },
    { x: 13, y: 46, rx: 5, ry: 5 }, { x: 51, y: 46, rx: 5, ry: 5 }, { x: 32, y: 53, rx: 9, ry: 6, hall: true },
  ],
};
