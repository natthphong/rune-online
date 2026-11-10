// Floor 3 of the Tower (2.7.0) — the first floor built for the Tower rule (shared/tower.ts): ONE big map, the whole floor.
//
// Witherwick, "the Blighted Shire": a medieval village and its countryside that fell to the witches' experiments. The brew they
// cooked in the chapel seeped into the wells; the dead got up, the hounds went rabid, the scarecrows' lanterns lit themselves. The
// village (houses with their roofs caved in, carts left in the lanes, the witches' cauldrons still on the green) lies in the middle of
// the map, the graveyard north of it by the ruined chapel, poisoned ponds and dead orchards all around. Dark fog, a sickly green light,
// ash falling: the client's "blight" theme (client/src/themes.ts).
//
//   in from floor 2 (Lanternrest's north stair, opened by floor 2's guardian) at the south edge -> the survivors' camp (save keeper)
//   the floor guardian Morrowgast spawns at a RANDOM spot of the map (server/src/tower.ts), the mini-boss Ashgrim haunts the graveyard
//   the sealed gate to floor 4 stands in the chapel ruin; it opens for the party that fells Morrowgast.
import { generateField, gateCell, walkable, type FieldTheme, type GameMap, type PropType } from "./map.ts";

export const F3_MAP = "f3_field01";
export const F3_W = 120;
/** The village green (the map's hub), the chapel ruin with the gate up, the graveyard, the survivors' camp at the south road. */
export const F3_CELLS = {
  green: { x: 60, y: 60 }, chapel: { x: 60, y: 34 }, gateUp: { x: 60, y: 31 }, graveyard: { x: 84, y: 32 },
  camp: { x: 60, y: 108 }, keeper: { x: 57, y: 108 },
} as const;

export const F3_THEME: FieldTheme = {
  key: "blight", w: F3_W, h: F3_W, water: 0.25, relief: 1.6, stone: 0.8, dirt: 0.55,
  props: [["deadtree", 0.035], ["stump", 0.012], ["rock", 0.008]], border: ["deadtree", "rock", "deadtree"], borderDensity: 0.9,
  gates: { S: 60 },
  keep: [
    { x: 60, y: 113, r: 2 }, { ...F3_CELLS.camp, r: 4 }, { ...F3_CELLS.green, r: 15 }, { ...F3_CELLS.chapel, r: 5 }, { ...F3_CELLS.graveyard, r: 7 },
    { x: 24, y: 30, r: 3 }, { x: 26, y: 84, r: 3 }, { x: 96, y: 86, r: 3 }, { x: 98, y: 58, r: 3 }, { x: 22, y: 58, r: 3 }, // the hunting grounds
  ],
  lakes: [{ x: 38, y: 44, r: 4 }, { x: 86, y: 70, r: 5 }, { x: 40, y: 96, r: 3 }],
  ruins: [{ x: 60, y: 32, w: 7, h: 5 }],
};
const SIDE_GATE = gateCell(F3_THEME, "S", 60);
/** The stair back down to floor 2 (a plain warp on the south road's end) and where a climber coming up arrives. */
export const F3_GATE = { map: F3_MAP, ...SIDE_GATE } as const;
export const F3_ARRIVAL = { map: F3_MAP, x: SIDE_GATE.x, y: SIDE_GATE.y - 4 } as const;
export const F3_SAVE = { map: F3_MAP, x: F3_CELLS.keeper.x, y: F3_CELLS.keeper.y + 1 } as const;

type Piece = { type: PropType; x: number; y: number };
/** The village: houses (3x3 footprint, the prop on the middle cell) around the green, and the one-cell pieces between them. */
const HOUSES: [number, number][] = [
  [50, 52], [56, 50], [64, 50], [70, 52], [48, 60], [72, 60], [50, 68], [56, 70], [64, 70], [70, 68], [52, 44], [68, 44], [52, 76], [68, 76],
];
const PIECES: Piece[] = [
  { type: "well", x: 60, y: 60 }, { type: "cauldron", x: 58, y: 62 }, { type: "cauldron", x: 63, y: 58 }, { type: "cauldron", x: 60, y: 36 },
  { type: "wreck", x: 54, y: 57 }, { type: "wreck", x: 66, y: 64 }, { type: "wreck", x: 60, y: 82 }, { type: "wreck", x: 61, y: 100 },
  { type: "crates", x: 53, y: 63 }, { type: "crates", x: 67, y: 56 }, { type: "crates", x: 58, y: 105 }, { type: "crates", x: 63, y: 106 },
  { type: "lamppost", x: 57, y: 57 }, { type: "lamppost", x: 63, y: 57 }, { type: "lamppost", x: 57, y: 63 }, { type: "lamppost", x: 63, y: 63 },
  { type: "lamppost", x: 58, y: 110 }, { type: "lamppost", x: 62, y: 110 },
  ...[46, 47, 48, 49, 51, 52, 53].map((x): Piece => ({ type: "fence", x, y: 56 })),
  ...[67, 68, 69, 71, 72, 73, 74].map((x): Piece => ({ type: "fence", x, y: 64 })),
  ...[55, 56, 57, 63, 64, 65].map((x): Piece => ({ type: "fence", x, y: 80 })),
  // the graveyard: rows of stones east of the chapel
  ...[80, 82, 84, 86, 88].flatMap((x) => [28, 31, 35].map((y): Piece => ({ type: "gravestone", x, y }))),
  ...[79, 81, 83, 85, 87, 89].map((x): Piece => ({ type: "fence", x, y: 25 })),
];

/** The floor's one map: the blighted field, then the village stamped onto its kept-open ground (cells only blocked where they were
 *  open, so the generator's reachability holds: every piece leaves the lanes around it free). */
export function generateFloor3(seed: number): GameMap {
  const m = generateField(seed, F3_THEME);
  const at = (x: number, y: number) => y * m.w + x;
  const free = new Set(Object.values(F3_CELLS).map((c) => at(c.x, c.y)));
  free.add(at(F3_SAVE.x, F3_SAVE.y)); free.add(at(F3_ARRIVAL.x, F3_ARRIVAL.y));
  const put = (x: number, y: number) => { if (walkable(m, x, y) && !free.has(at(x, y))) { m.blocked[at(x, y)] = 1; return true; } return false; };
  for (const [x, y] of HOUSES) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(x + dx, y + dy);
    m.props.push({ x, y, type: "house" });
  }
  for (const p of PIECES) if (p.type === "well" ? (m.blocked[at(p.x, p.y)] = 1) : put(p.x, p.y)) m.props.push({ x: p.x, y: p.y, type: p.type });
  return m;
}

// ---------- the floor's monsters ----------
// Rows built from an existing species' mob_db row (`base`: its modes, motions, drops and sprite sheets) with our own id, name, level
// and numbers (shared/rules/data.ts appends them to MOBS). The art is the base species' sheets, tinted (`tint`, the client multiplies
// the sprite by it) and scaled, until the floor's own sheets are drawn.
export type TowerMob = {
  id: number; base: number; name: string; level: number; hp: number; atk: number; def: number; baseExp: number; jobExp: number;
  walkSpeed?: number; attackDelay?: number; attackMotion?: number; range?: number; mvpExp?: number;
  /** "Mvp" = the floor guardian, "Boss" = a mini-boss, undefined = an ordinary monster */
  boss?: "Mvp" | "Boss";
  race: "Undead" | "Demon" | "Brute" | "Formless"; element: "Undead" | "Dark" | "Poison"; size?: "Small" | "Medium" | "Large";
  /** client look: 0xRRGGBB multiplied over the base species' sprite, and its scale */
  tint: number; scale: number;
  /** the species whose sheets draw it when not `base` */
  art?: number;
};
export const MORROWGAST = 4310;
export const ASHGRIM = 4311;
export const F3_MOBS: readonly TowerMob[] = [
  // the villagers who drank from the wells
  { id: 4301, base: 1015, name: "Plaguewalker", level: 50, hp: 2400, atk: 150, def: 40, baseExp: 1500, jobExp: 1100, race: "Undead", element: "Undead", tint: 0x9bd36a, scale: 1.05 },
  // the shepherds' hounds, rabid and fast
  { id: 4302, base: 1013, name: "Rotfang", level: 52, hp: 2100, atk: 170, def: 35, baseExp: 1650, jobExp: 1200, walkSpeed: 150, race: "Brute", element: "Poison", tint: 0x8fae5c, scale: 1.0 },
  // carrion bats that roost in the caved-in roofs
  { id: 4303, base: 1005, name: "Blightwing", level: 51, hp: 1700, atk: 140, def: 28, baseExp: 1400, jobExp: 1050, race: "Brute", element: "Poison", tint: 0xa7e06f, scale: 1.0 },
  // the witches' wardens, armour stitched onto the dead
  { id: 4304, base: 1028, name: "Hexbound Sentry", level: 55, hp: 3200, atk: 190, def: 62, baseExp: 2100, jobExp: 1500, race: "Undead", element: "Undead", tint: 0x86b98c, scale: 1.1 },
  // what was left over
  { id: 4305, base: 1076, name: "Witchbone", level: 56, hp: 2900, atk: 205, def: 45, baseExp: 2200, jobExp: 1600, race: "Undead", element: "Dark", tint: 0xb9f08a, scale: 1.05 },
  // the floor guardian: the village's alderman, the witches' finished work
  { id: MORROWGAST, base: 3810, name: "Morrowgast", level: 58, hp: 230000, atk: 175, def: 70, baseExp: 60000, jobExp: 48000, mvpExp: 15000, boss: "Mvp", range: 2,
    walkSpeed: 140, attackDelay: 900, attackMotion: 450, race: "Undead", element: "Undead", size: "Large", tint: 0x7fd65a, scale: 1.25 },
  // the mini-boss: a horned goat-demon with a scythe the witches called up and could not send back
  { id: ASHGRIM, base: 3999, name: "Ashgrim", level: 56, hp: 110000, atk: 160, def: 60, baseExp: 30000, jobExp: 24000, mvpExp: 0, boss: "Boss", range: 2,
    walkSpeed: 150, attackDelay: 1000, attackMotion: 520, race: "Demon", element: "Dark", size: "Large", tint: 0x8a3a52, scale: 1.2 },
];
export const F3_MOB_BY_ID: ReadonlyMap<number, TowerMob> = new Map(F3_MOBS.map((m) => [m.id, m]));
/** The floor's ordinary species and the middle of its hunting grounds (shared/maps.ts FIELD_MOBS). */
export const F3_HUNT = { mobs: [4301, 4302, 4303, 4304, 4305], hunt: { x: 60, y: 88 } };
