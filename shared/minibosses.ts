// 2.9.0 the roaming mini-bosses (viewers' comments: "the goat-demon on four legs whose ultimate sweeps almost the whole map", "a big
// blue slime as a boss that turns into a person"). Our own designs and names.
//   Ashgrim   a horned goat-demon beast on four legs with a scythe on its back; its ultimate, the Long Harvest, reaps almost the whole map
//   Ceruleen  phase 1: a huge blue jelly (hops, splashes, splits); at half HP it collapses, swirls and rises as a slim slime-folk
//             swordsman of water (phase 2: dashes, water blades, a ring of slime rain)
// Spawn rule (server/src/minibosses.ts): each rises on a RANDOM floor 1-3 (that floor's one big map, shared/tower.ts) at a random valid
// spot, with a server-wide announce; after its death it rises again later on another random floor. Its strength is the floor's: one
// row per floor below (own id, the same art), scaled by MINI_SCALE. This file imports only types, so the data loader can use it.
import type { TowerMob } from "./floor3.ts";

export type MiniKey = "ashgrim" | "ceruleen";
export type MiniBoss = {
  key: MiniKey; name: string;
  /** mob id per floor (the phase-1 form for Ceruleen) */
  ids: Record<1 | 2 | 3, number>;
  /** Ceruleen: the phase-2 form's id per floor (the boss turns into it at `transformBelow` % HP, keeping its HP) */
  phase2?: Record<1 | 2 | 3, number>;
  /** respawn after a death: ms + up to `respawnVar` more, on a newly rolled floor */
  respawnMs: number; respawnVar: number;
};
export const MINIS: readonly MiniBoss[] = [
  { key: "ashgrim", name: "Ashgrim", ids: { 1: 4312, 2: 4313, 3: 4311 }, respawnMs: 1500000, respawnVar: 900000 },
  { key: "ceruleen", name: "Ceruleen", ids: { 1: 4321, 2: 4323, 3: 4325 }, phase2: { 1: 4322, 2: 4324, 3: 4326 }, respawnMs: 1500000, respawnVar: 900000 },
];
/** Ceruleen turns at this % of max HP. */
export const TRANSFORM_BELOW = 50;

/** The floor scaling of the mini-bosses (F1 < F2 < F3; floor N's guardian stays the stronger boss of its floor, bossfeel.test.ts). */
export const MINI_SCALE = {
  ashgrim: { 1: { level: 32, hp: 56000, atk: 112, def: 38 }, 2: { level: 47, hp: 104000, atk: 142, def: 52 }, 3: { level: 58, hp: 170000, atk: 182, def: 66 } },
  ceruleen: { 1: { level: 30, hp: 52000, atk: 104, def: 30 }, 2: { level: 45, hp: 96000, atk: 136, def: 44 }, 3: { level: 57, hp: 160000, atk: 176, def: 58 } },
} as const;

const floors = [1, 2, 3] as const;
const exp = (hp: number) => ({ baseExp: Math.round(hp * 0.3), jobExp: Math.round(hp * 0.24) });
/** Rows for the data loader (shared/rules/data.ts, like floor 3's species): Ashgrim on Devo's row, Ceruleen on Gloopking's. */
export const MINI_MOBS: TowerMob[] = floors.flatMap((f): TowerMob[] => {
  const a = MINI_SCALE.ashgrim[f], c = MINI_SCALE.ceruleen[f];
  return [
    { id: MINIS[0].ids[f], base: 3999, name: "Ashgrim", level: a.level, hp: a.hp, atk: a.atk, def: a.def, ...exp(a.hp), mvpExp: 0, boss: "Boss", range: 2,
      walkSpeed: 150, attackDelay: 1000, attackMotion: 520, race: "Demon", element: "Dark", size: "Large", tint: 0xffffff, scale: 1.35, art: 4311 },
    { id: MINIS[1].ids[f], base: 3810, name: "Ceruleen", level: c.level, hp: c.hp, atk: c.atk, def: c.def, ...exp(c.hp), mvpExp: 0, boss: "Boss", range: 1,
      walkSpeed: 170, attackDelay: 1150, attackMotion: 600, race: "Formless", element: "Water", size: "Large", tint: 0xffffff, scale: 1.5, art: 4321 },
    // phase 2: same HP pool (the server keeps the HP across the change), harder hits, much faster
    { id: MINIS[1].phase2![f], base: 3810, name: "Ceruleen", level: c.level, hp: c.hp, atk: Math.round(c.atk * 1.2), def: c.def, ...exp(c.hp), mvpExp: 0, boss: "Boss", range: 2,
      walkSpeed: 120, attackDelay: 760, attackMotion: 380, race: "Formless", element: "Water", size: "Medium", tint: 0xffffff, scale: 1.15, art: 4322 },
  ];
});
export const MINI_IDS: ReadonlySet<number> = new Set(MINI_MOBS.map((m) => m.id));
/** The mini-boss and floor a mob id belongs to. */
export function miniOf(mobId: number): { mini: MiniBoss; floor: 1 | 2 | 3; phase: 1 | 2 } | undefined {
  for (const mini of MINIS) for (const f of floors) {
    if (mini.ids[f] === mobId) return { mini, floor: f, phase: 1 };
    if (mini.phase2?.[f] === mobId) return { mini, floor: f, phase: 2 };
  }
  return undefined;
}
