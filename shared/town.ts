// Hearthmoor (f1_town01), floor 1's rest town (W01 r2): a walled town of 57x57 cells in the manner of a classic MMORPG capital.
// A square cobbled plaza with a fountain in the middle, four streets running from it to the four gates in the town wall, and
// around the plaza the town's buildings, each with its NPC at the door (the cells here; the NPC rows in shared/content):
//
//   north-west: Bren's hearth chapel on the plaza (the save point), Tilda's Sundries on the west street, houses
//   north-east: the Hearth & Kettle inn (Pella), Garrow's Arms on the east street, Garr's woodpile up the north street
//   south-west: Drillmaster Kessa's training yard at the plaza's south-west corner, houses, the well
//   south-east: the guild hall with the six job masters in its courtyard, houses; Warden Orrin inside the south gate
//
// Every building, wall, lamp, stall and planter is a blocked cell (the server only sees `blocked`); the client draws them from
// `GameMap.town` (client/src/town.ts). Pure data + one generator, the same on both sides.
import { TILE, type Building, type GameMap, type TownDecor, type TownLayout } from "./map.ts";

export const TOWN_W = 57;
/** the centre cell (the fountain), the wall ring (Chebyshev distance from the centre), the streets' half width, the plaza's */
export const TOWN_C = 28, TOWN_RING = 23, TOWN_STREET = 1, TOWN_PLAZA = 8;
const C = TOWN_C;

/** The warp cells outside the four gates and where a walker coming in through each gate arrives (just inside the wall). */
export const TOWN_GATE_CELLS = { W: { x: 3, y: C }, E: { x: TOWN_W - 4, y: C }, N: { x: C, y: 3 }, S: { x: C, y: TOWN_W - 4 } } as const;
export const TOWN_IN_CELLS = { W: { x: 8, y: C }, E: { x: TOWN_W - 9, y: C }, N: { x: C, y: 8 }, S: { x: C, y: TOWN_W - 9 } } as const;

/** Where the town's people stand (shared/content: SPOT, TOWN_SPOT, GUILD_ROW read these). */
export const TOWN_CELLS = {
  guide: { x: 22, y: 30 }, start: { x: 24, y: 31 }, merchant: { x: 34, y: 31 },
  hearthkeeper: { x: 22, y: 20 }, save: { x: 22, y: 22 },
  tools: { x: 14, y: 26 }, arms: { x: 42, y: 26 }, refiner: { x: 44, y: 26 }, pella: { x: 33, y: 19 }, garr: { x: 31, y: 9 }, merrit: { x: 25, y: 23 },
  drillmaster: { x: 19, y: 34 }, warden: { x: 30, y: 48 },
  grandmaster: { x: 49, y: 40 }, // 2.5.0: the Guild Grandmaster at the east end of the guild row
  rebirth: { x: 49, y: 43 }, // 2.5.0: the Keeper of the Second Dawn (rebirth)
  guild: {
    center: { x: 43, y: 40 },
    Swordman: { x: 40, y: 38 }, Mage: { x: 43, y: 38 }, Archer: { x: 46, y: 38 },
    Acolyte: { x: 40, y: 42 }, Merchant: { x: 43, y: 42 }, Thief: { x: 46, y: 42 },
  },
} as const;

const BUILDINGS: Building[] = [
  // north-west
  { x0: 19, y0: 12, x1: 25, y1: 18, face: "S", door: 22, kind: "chapel", roof: 1, floors: 2, sign: "The Hearth" },
  { x0: 11, y0: 20, x1: 17, y1: 25, face: "S", door: 14, kind: "shop", roof: 0, floors: 1, sign: "Tilda's Sundries" },
  { x0: 7, y0: 7, x1: 12, y1: 12, face: "S", door: 9, kind: "house", roof: 2, floors: 2 },
  { x0: 15, y0: 7, x1: 18, y1: 11, face: "S", door: 16, kind: "house", roof: 0, floors: 1 },
  { x0: 6, y0: 15, x1: 9, y1: 19, face: "E", door: 17, kind: "house", roof: 3, floors: 1 },
  // north-east
  { x0: 31, y0: 11, x1: 38, y1: 18, face: "S", door: 34, kind: "inn", roof: 0, floors: 2, sign: "Hearth & Kettle" },
  { x0: 39, y0: 20, x1: 45, y1: 25, face: "S", door: 42, kind: "smithy", roof: 3, floors: 1, sign: "Garrow's Arms" },
  { x0: 41, y0: 7, x1: 48, y1: 13, face: "S", door: 44, kind: "house", roof: 1, floors: 2 },
  { x0: 47, y0: 17, x1: 50, y1: 22, face: "W", door: 20, kind: "house", roof: 2, floors: 1 },
  // south-west
  { x0: 7, y0: 41, x1: 13, y1: 46, face: "N", door: 10, kind: "house", roof: 1, floors: 2 },
  { x0: 16, y0: 42, x1: 22, y1: 47, face: "N", door: 19, kind: "house", roof: 0, floors: 1 },
  { x0: 6, y0: 32, x1: 8, y1: 37, face: "E", door: 34, kind: "house", roof: 2, floors: 1 },
  // south-east
  { x0: 38, y0: 31, x1: 48, y1: 36, face: "S", door: 43, kind: "guild", roof: 2, floors: 2, sign: "Climbers' Guild" },
  { x0: 38, y0: 46, x1: 43, y1: 50, face: "N", door: 40, kind: "house", roof: 3, floors: 1 },
  { x0: 46, y0: 46, x1: 50, y1: 50, face: "N", door: 48, kind: "house", roof: 0, floors: 2 },
  { x0: 32, y0: 41, x1: 35, y1: 45, face: "W", door: 43, kind: "house", roof: 1, floors: 1 },
];

/** The training yard's fence (Drillmaster Kessa): a rim of fence cells, open to the street (north) and the plaza (east). */
const YARD = { x0: 10, y0: 31, x1: 18, y1: 37 };
function yardFence(): TownDecor[] {
  const out: TownDecor[] = [];
  for (let x = YARD.x0; x <= YARD.x1; x++) for (let y = YARD.y0; y <= YARD.y1; y++) {
    const rim = x === YARD.x0 || x === YARD.x1 || y === YARD.y0 || y === YARD.y1;
    if (!rim) continue;
    if (y === YARD.y0 && x >= 13 && x <= 15) continue; // gate to the west street
    if (x === YARD.x1 && y >= 33 && y <= 35) continue; // gate to the plaza
    out.push({ type: "fence", x, y, dir: y === YARD.y0 || y === YARD.y1 ? "E" : "S" });
  }
  return out;
}

const DECOR: TownDecor[] = [
  { type: "fountain", x: C, y: C },
  // the plaza: planters on the diagonals, lamps at the corners, the hearth's braziers, Merrit's bench, the market stalls
  { type: "bed", x: 23, y: 23 }, { type: "bed", x: 33, y: 23 }, { type: "bed", x: 23, y: 33 }, { type: "bed", x: 33, y: 33 },
  { type: "lamp", x: 20, y: 20 }, { type: "lamp", x: 36, y: 20 }, { type: "lamp", x: 20, y: 36 }, { type: "lamp", x: 36, y: 36 },
  { type: "brazier", x: 20, y: 19 }, { type: "brazier", x: 24, y: 19 },
  { type: "bench", x: 25, y: 22, dir: "E" },
  { type: "stall", x: 22, y: 35, tint: 0 }, { type: "stall", x: 25, y: 35, tint: 1 }, { type: "stall", x: 31, y: 35, tint: 2 },
  { type: "stall", x: 35, y: 32, tint: 3 }, { type: "crates", x: 36, y: 32 },
  // shops and trades
  { type: "barrels", x: 18, y: 23 }, { type: "crates", x: 10, y: 24 },
  { type: "anvil", x: 46, y: 25 }, { type: "barrels", x: 38, y: 24 },
  { type: "barrels", x: 39, y: 18 }, { type: "crates", x: 30, y: 17 },
  { type: "woodpile", x: 31, y: 7 }, { type: "woodpile", x: 32, y: 7 }, { type: "woodpile", x: 33, y: 7 },
  // the training yard and the well
  { type: "dummy", x: 12, y: 33 }, { type: "dummy", x: 12, y: 35 }, { type: "dummy", x: 15, y: 36 },
  ...yardFence(),
  { type: "well", x: 24, y: 41 },
  // the guild courtyard: lamps at its corners
  { type: "lamp", x: 37, y: 37 }, { type: "lamp", x: 49, y: 37 }, { type: "lamp", x: 37, y: 44 }, { type: "lamp", x: 49, y: 44 },
  // street lamps
  { type: "lamp", x: 26, y: 11 }, { type: "lamp", x: 30, y: 15 }, { type: "lamp", x: 26, y: 45 }, { type: "lamp", x: 30, y: 41 },
  { type: "lamp", x: 11, y: 30 }, { type: "lamp", x: 16, y: 26 }, { type: "lamp", x: 45, y: 30 }, { type: "lamp", x: 40, y: 26 },
  // gardens and back yards
  { type: "tree", x: 9, y: 22 }, { type: "tree", x: 13, y: 15 }, { type: "tree", x: 47, y: 15 }, { type: "tree", x: 36, y: 8 },
  { type: "tree", x: 8, y: 49 }, { type: "tree", x: 14, y: 49 }, { type: "tree", x: 49, y: 26 }, { type: "tree", x: 45, y: 48 },
  { type: "tree", x: 21, y: 8 }, { type: "tree", x: 33, y: 48 },
];

/** Hearthmoor's layout; `signs` = the signpost text for each gate (the field behind it and its level band). */
export function townLayout(signs: Record<"N" | "E" | "S" | "W", string[]>): TownLayout {
  const posts: TownDecor[] = [
    { type: "signpost", x: 8, y: 26, dir: "W", label: signs.W }, { type: "signpost", x: TOWN_W - 9, y: 26, dir: "E", label: signs.E },
    { type: "signpost", x: 26, y: 8, dir: "N", label: signs.N }, { type: "signpost", x: 26, y: TOWN_W - 9, dir: "S", label: signs.S },
  ];
  return { cx: C, cy: C, ring: TOWN_RING, street: TOWN_STREET, plaza: TOWN_PLAZA, buildings: BUILDINGS, decor: [...DECOR, ...posts] };
}

/** The town's cells: grass, cobbled plaza / streets / courtyards, a stone wall ring with a gate on each street, woods outside. */
export function generateTown(layout: TownLayout): GameMap {
  const w = TOWN_W, h = TOWN_W;
  const height = new Float32Array(w * h), kind = new Uint8Array(w * h), blocked = new Uint8Array(w * h);
  const props: GameMap["props"] = [];
  const at = (x: number, y: number) => y * w + x;
  const hash = (x: number, y: number) => ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 1000 / 1000;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y), d = Math.max(Math.abs(x - C), Math.abs(y - C));
    const street = Math.abs(y - C) <= TOWN_STREET || Math.abs(x - C) <= TOWN_STREET;
    height[i] = 0.05;
    kind[i] = d <= TOWN_PLAZA || street ? TILE.cobble : hash(x, y) < 0.08 ? TILE.dirt : TILE.grass;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { blocked[i] = 1; continue; }
    if (d === TOWN_RING && !street) { blocked[i] = 1; continue; } // the wall (drawn by the client)
    if (d > TOWN_RING && !street) { // woods outside the wall, a cell clear of it and of the roads
      blocked[i] = 1;
      const nearRoad = Math.abs(y - C) <= TOWN_STREET + 1 || Math.abs(x - C) <= TOWN_STREET + 1;
      if (d >= TOWN_RING + 2 && !nearRoad && hash(y, x) < 0.55) props.push({ x, y, type: hash(x + 7, y) < 0.15 ? "rock" : "tree" });
    }
  }
  // the guild courtyard and the training yard: cobbles and beaten earth
  for (let y = 37; y <= 44; y++) for (let x = 37; x <= 49; x++) kind[at(x, y)] = TILE.cobble;
  for (let y = YARD.y0 + 1; y < YARD.y1; y++) for (let x = YARD.x0 + 1; x < YARD.x1; x++) kind[at(x, y)] = TILE.dirt;
  // the hearth's forecourt and each building's doorstep
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
  return { w, h, height, kind, blocked, props, town: layout };
}
