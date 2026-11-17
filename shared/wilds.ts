// 2.9.0 the Tower rule on floors 1 and 2 (a viewer's comment: one big map per floor, its guardian rises at a random spot, kill it and
// the next floor opens, each floor with its own monsters, boss, mood and weather). Floor 3 was built that way (shared/floor3.ts);
// floors 1 and 2 had towns, fields and dungeons with the guardian waiting in a fixed hall. Each now gets ONE big guardian map, the
// floor's "wilds": the guardian left its hall and roams there (server/src/tower.ts picks a random valid spot each time it rises), and
// the way up from that floor opens only for the party that felled it (`tower_f1` on the Ascent Stair, `tower_f2` on the stair to 3).
//
//   f1_field05 Greenhollow Wilds  floor 1: rolling meadows and old-growth woods, sunny, pollen and leaves on the wind; the Verdant
//                                 floor's cute monsters (Lv 5-20); Gloopking roams. In from the Sunken Mire's west ring stones.
//   f2_field03 Sunscour Ruins     floor 2: a sand sea of dunes with a buried city, a sandstorm blowing; the Ember floor's monsters
//                                 (Lv 32-45); Devo roams. In from Cinderwatch Heights' south-west ruin.
// This file imports only the generator, so maps.ts (the warp graph) can import it.
import { generateField, gateCell, type FieldTheme, type GameMap } from "./map.ts";

export const F1_WILD = "f1_field05";
export const F2_WILD = "f2_field03";
export const WILD_MAPS = [F1_WILD, F2_WILD] as const;
export type WildName = (typeof WILD_MAPS)[number];

export const WILD_THEMES: Record<WildName, FieldTheme> = {
  // big, open and green like a capital's outer fields: wide meadows, groves of old trees, ponds, a ruin on a rise. Gate north.
  [F1_WILD]: {
    key: "meadow", w: 120, h: 120, water: 0.27, relief: 2.4, stone: 0.78, dirt: 0.74,
    props: [["tree", 0.06], ["pine", 0.015], ["rock", 0.01], ["stump", 0.005]], border: ["tree", "pine", "tree"], borderDensity: 0.9,
    gates: { N: 60 },
    keep: [{ x: 60, y: 7, r: 2 }, { x: 30, y: 30, r: 3 }, { x: 90, y: 32, r: 3 }, { x: 28, y: 88, r: 3 }, { x: 92, y: 90, r: 3 }, { x: 60, y: 64, r: 4 }],
    lakes: [{ x: 44, y: 48, r: 4 }, { x: 80, y: 72, r: 5 }],
    ruins: [{ x: 60, y: 64, w: 7, h: 5 }],
  },
  // dunes: almost no water, high relief, bare ground everywhere; rocks and dead trees, a buried city's walls. Gate east.
  [F2_WILD]: {
    key: "desert", w: 120, h: 120, water: 0.12, relief: 3.2, stone: 0.7, dirt: 0.02,
    props: [["rock", 0.03], ["deadtree", 0.012], ["stump", 0.003]], border: ["rock", "rock", "deadtree"], borderDensity: 0.9,
    gates: { E: 60 },
    keep: [{ x: 113, y: 60, r: 2 }, { x: 30, y: 30, r: 3 }, { x: 88, y: 26, r: 3 }, { x: 26, y: 90, r: 3 }, { x: 88, y: 94, r: 3 }, { x: 54, y: 60, r: 5 }],
    lakes: [{ x: 70, y: 62, r: 3 }], // the oasis
    ruins: [{ x: 54, y: 60, w: 11, h: 8 }, { x: 30, y: 30, w: 6, h: 5 }, { x: 88, y: 94, w: 6, h: 5 }],
  },
};
const EDGE = { [F1_WILD]: "N", [F2_WILD]: "E" } as const;
/** A wild's gate (the warp back down to the floor's other maps) and where a climber coming in arrives (4 cells inside). */
export function wildGate(w: WildName) {
  const t = WILD_THEMES[w], edge = EDGE[w], gate = gateCell(t, edge, t.gates[edge]!);
  const back = { N: [0, 4], S: [0, -4], W: [4, 0], E: [-4, 0] }[edge];
  return { gate, arrival: { x: gate.x + back[0], y: gate.y + back[1] } };
}
export const generateWild = (w: WildName, seed: number): GameMap => generateField(seed, WILD_THEMES[w]);

/** The floors' monster sets on their wilds (shared/data/spawns.txt lines; maps.ts FIELD_MOBS) and the hunting ground's middle. */
export const WILD_MOBS: Record<WildName, { mobs: number[]; hunt: { x: number; y: number } }> = {
  // Puddlebloom, Sootcap, Dartwing, Dappleegg, Mistfin, Chirpjack: the floor's cute ones
  [F1_WILD]: { mobs: [1002, 1113, 1011, 1047, 1012, 1052], hunt: { x: 60, y: 64 } },
  // Slagimp, Ashhound, Cairnshell, Kilnmite, Cinderbough
  [F2_WILD]: { mobs: [1123, 1013, 1391, 1176, 1033], hunt: { x: 54, y: 60 } },
};
