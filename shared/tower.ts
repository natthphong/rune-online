// The Tower rule (2.7.0, from a viewer's comment): every floor has ONE guardian boss. Kill it and the way to the next floor opens for
// everyone of the party that cleared it (a permanent character variable, `clearVar`). A higher floor's guardian is clearly harder:
// the scaling table below is the single place its numbers live (they replace the mob_db row's at load, shared/rules/data.ts), its
// skill set is its BOSS_MOVES row (shared/rules/bossmoves.ts).
//
// Floors built for the rule (floor 3 on) are one big map and the guardian spawns at a RANDOM valid spot of it (server/src/tower.ts:
// a server-wide announce, a direction hint to everyone on the map, Msg.tower). Floors 1-2 predate the rule: their guardians keep the
// boss halls at the bottom of their dungeons (the dungeon bots and the story walk there), but the clear flag and the scaling apply.
// This file imports nothing, so the data loader and the client can both use it.

export type TowerFloor = {
  floor: number;
  /** the floor's name and its guardian's map (shared/maps.ts) */
  title: string; map: string;
  /** the guardian's mob id (shared/data/mobs.json) */
  guardian: number;
  /** true = it spawns at a random valid spot of `map`; false = in its fixed hall (its boss_monster line in spawns.txt) */
  random: boolean;
  /** permanent character variable set to 1 for every party member on the map when the guardian dies */
  clearVar: string;
  /** the level a solo climber is expected to have */
  level: number;
  /** the guardian's numbers: max HP, ATK (mob_db Attack), attack delay / motion (ms), walk time per cell (ms) */
  hp: number; atk: number; attackDelay: number; attackMotion: number; walkSpeed: number;
  /** what the numbers were before 2.7.0 (the episode's before / after) */
  was?: { hp: number; atk: number; attackDelay: number };
  /** respawn after a kill: ms + up to `respawnVar` more (random floors; the hall bosses keep their spawn lines' delays) */
  respawnMs: number; respawnVar: number;
};

export const TOWER: readonly TowerFloor[] = [
  { floor: 1, title: "The Verdant Floor", map: "f1_dun03", guardian: 3810, random: false, clearVar: "tower_f1", level: 30,
    hp: 72000, atk: 105, attackDelay: 1150, attackMotion: 650, walkSpeed: 170, was: { hp: 50000, atk: 90, attackDelay: 1632 }, respawnMs: 3600000, respawnVar: 3600000 },
  { floor: 2, title: "The Ember Floor", map: "f2_dun01", guardian: 3999, random: false, clearVar: "tower_f2", level: 46,
    hp: 135000, atk: 130, attackDelay: 1000, attackMotion: 520, walkSpeed: 150, was: { hp: 90000, atk: 100, attackDelay: 1400 }, respawnMs: 3600000, respawnVar: 3600000 },
  // floor 3 (shared/floor3.ts): the first floor built for the rule. Morrowgast roams: a random spot of Witherwick each time it rises.
  { floor: 3, title: "The Blighted Shire", map: "f3_field01", guardian: 4310, random: true, clearVar: "tower_f3", level: 58,
    hp: 230000, atk: 175, attackDelay: 900, attackMotion: 450, walkSpeed: 140, respawnMs: 1800000, respawnVar: 900000 },
];
export const TOWER_BY_GUARDIAN: ReadonlyMap<number, TowerFloor> = new Map(TOWER.map((f) => [f.guardian, f]));
export const TOWER_BY_MAP: ReadonlyMap<string, TowerFloor> = new Map(TOWER.map((f) => [f.map, f]));
export const towerFloor = (n: number) => TOWER.find((f) => f.floor === n);
/** The highest floor a character may enter: 1 + the floors it has cleared in a row (`get` reads a permanent character variable). */
export function floorsOpen(get: (name: string) => number): number {
  let n = 1;
  for (const f of TOWER) { if (f.floor === n && get(f.clearVar) > 0) n++; }
  return n;
}

/** The compass direction (0-7, the order of protocol.ts dirFromDelta: 0 = south (+y), 1 SE, 2 E, 3 NE, 4 N, 5 NW, 6 W, 7 SW) and the
 *  distance in cells from (x, y) to the guardian at (bx, by): the hint a climber gets. */
export function towerHint(x: number, y: number, bx: number, by: number): { dir: number; dist: number } {
  const dx = bx - x, dy = by - y;
  const dir = dx === 0 && dy === 0 ? 0 : ((Math.round(Math.atan2(dx, dy) / (Math.PI / 4)) % 8) + 8) % 8;
  return { dir, dist: Math.max(Math.abs(dx), Math.abs(dy)) };
}
export const DIR_NAMES = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"] as const;
/** The hint in words: "far to the north-east", "close, to the west", "right here". */
export function hintText(h: { dir: number; dist: number }): string {
  if (h.dist <= 6) return "right here";
  return `${h.dist > 45 ? "far " : h.dist > 20 ? "" : "close, "}to the ${DIR_NAMES[h.dir]}`;
}
