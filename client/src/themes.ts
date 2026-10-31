// The look of each map theme (W01): sky / fog / light colours for the scene, ground tints for the terrain shader, a canopy tint
// for the props, and what stands in the ring of scenery outside the playable area. The cells themselves (water, rocky ground,
// which props) come from the shared generator (shared/map.ts generateField); this is only how they are drawn.
import type { PropType, ThemeKey } from "../../shared/map.ts";

type RGB = [number, number, number];
export type ThemeLook = {
  sky: string; fog: string; fogNear: number; fogFar: number;
  hemiSky: string; hemiGround: string; hemi: number; sunColor: string; sun: number;
  /** multipliers on the painted ground textures (linear) */
  grass: RGB; dirt: RGB; water: RGB;
  /** multiplier on every leaf clump */
  leaves: RGB;
  /** the scenery ring outside the map's edge: what stands there, and how many */
  ring: PropType[]; ringCount: number;
  /** meadow decor density (flowers / tufts), 1 = the plains */
  decor: number; flowers: number; mushrooms: number;
  /** W03 caves: no meadow / shore plants; the ground is dark except in the torches' light pools (this is the shade between
   *  them, 1 = no darkening), and bones, pebbles and pale mushrooms lie on the floor */
  cave?: { dark: number };
};

const PLAINS: ThemeLook = {
  sky: "#9fc7e8", fog: "#9fc7e8", fogNear: 30, fogFar: 60, hemiSky: "#ffffff", hemiGround: "#5a6b3a", hemi: 1.6, sunColor: "#fff4dc", sun: 1.6,
  grass: [1, 1, 1], dirt: [1, 1, 1], water: [1, 1, 1], leaves: [1, 1, 1], ring: ["tree"], ringCount: 260, decor: 1, flowers: 1, mushrooms: 1,
};
export const LOOKS = {
  town: PLAINS,
  grass: PLAINS,
  forest: {
    sky: "#8db7a6", fog: "#86aa92", fogNear: 22, fogFar: 52, hemiSky: "#e6f2dc", hemiGround: "#3c5226", hemi: 1.35, sunColor: "#f6efc4", sun: 1.3,
    grass: [0.74, 0.86, 0.62], dirt: [0.82, 0.78, 0.7], water: [0.8, 0.95, 0.85], leaves: [0.78, 0.92, 0.82],
    ring: ["tree", "pine", "pine"], ringCount: 380, decor: 1.3, flowers: 0.35, mushrooms: 3,
  },
  highland: {
    sky: "#a7bed6", fog: "#b3c3d1", fogNear: 28, fogFar: 64, hemiSky: "#eef3ff", hemiGround: "#6a685a", hemi: 1.7, sunColor: "#fffaf0", sun: 1.75,
    grass: [0.92, 0.9, 0.7], dirt: [0.95, 0.9, 0.84], water: [0.85, 0.95, 1.08], leaves: [0.8, 0.9, 0.86],
    ring: ["pine", "rock", "pine"], ringCount: 240, decor: 0.6, flowers: 0.5, mushrooms: 0.3,
  },
  swamp: { // W01 r1: murky, not a green meadow: dark olive-brown ground, tea-coloured water, thick grey-green fog close in
    sky: "#5f6b60", fog: "#5b6858", fogNear: 9, fogFar: 36, hemiSky: "#a9b5a0", hemiGround: "#2a2f20", hemi: 0.95, sunColor: "#c9ccaa", sun: 0.8,
    grass: [0.5, 0.5, 0.31], dirt: [0.5, 0.42, 0.33], water: [0.42, 0.46, 0.26], leaves: [0.62, 0.64, 0.4],
    ring: ["deadtree", "deadtree", "tree"], ringCount: 220, decor: 0.8, flowers: 0.1, mushrooms: 4,
  },
} as Record<ThemeKey | "town", ThemeLook>;
// W03: the Mirefall Catacombs. Black fog close in, a dim cold fill and a warm low key light; the torches' pools do the rest
// (world.ts lights the ground around every torch, torch.ts draws the flames)
LOOKS.cave = {
  sky: "#050407", fog: "#08070b", fogNear: 17, fogFar: 40, hemiSky: "#9aa0c8", hemiGround: "#2a2018", hemi: 0.85, sunColor: "#ffd2a0", sun: 0.6,
  grass: [0.3, 0.28, 0.27], dirt: [0.62, 0.55, 0.5], water: [0.32, 0.4, 0.46], leaves: [0.6, 0.6, 0.5],
  ring: [], ringCount: 0, decor: 0, flowers: 0, mushrooms: 0, cave: { dark: 0.36 },
};
// 2.5.0 floor 2 (shared/floor2.ts): the Ember Floor. "dusk" = Lanternrest and the Emberlit Terraces, an amber evening; "ash" = Cinderwatch
// Heights, grey ash under a low red sun
LOOKS.dusk = {
  sky: "#d9a58a", fog: "#cc9c86", fogNear: 22, fogFar: 54, hemiSky: "#ffe2c6", hemiGround: "#5a4630", hemi: 1.4, sunColor: "#ffc48c", sun: 1.5,
  grass: [0.95, 0.82, 0.58], dirt: [1, 0.84, 0.72], water: [0.9, 0.82, 0.95], leaves: [1, 0.78, 0.5],
  ring: ["pine", "tree", "rock"], ringCount: 260, decor: 0.7, flowers: 0.3, mushrooms: 0.8,
};
LOOKS.ash = {
  sky: "#7d7079", fog: "#85777e", fogNear: 14, fogFar: 44, hemiSky: "#d4c3cb", hemiGround: "#3a2f33", hemi: 1.15, sunColor: "#ffae88", sun: 1.2,
  grass: [0.56, 0.52, 0.5], dirt: [0.72, 0.6, 0.55], water: [0.6, 0.55, 0.66], leaves: [0.52, 0.46, 0.44],
  ring: ["deadtree", "rock", "rock"], ringCount: 230, decor: 0.3, flowers: 0, mushrooms: 1.5,
};
export const lookOf = (theme?: ThemeKey) => LOOKS[theme ?? "town"];
