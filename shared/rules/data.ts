// Typed access to the imported rAthena Renewal data (tools/rathena/import.ts writes shared/data/*.json).
import jobsJson from "../data/jobs.json" with { type: "json" };
import tablesJson from "../data/tables.json" with { type: "json" };
import mobsJson from "../data/mobs.json" with { type: "json" };

import { TOWER } from "../tower.ts";
import { F3_MOBS } from "../floor3.ts";

export type JobKey = keyof typeof jobsJson;
export type Job = (typeof jobsJson)[JobKey];
/** The six first jobs (a Novice's choices, the 2nd jobs' base classes). */
export type FirstJob = "Swordman" | "Mage" | "Archer" | "Acolyte" | "Merchant" | "Thief";
export type Mob = (typeof mobsJson)[number];
// The lists below are rAthena's enums spelled the way mob_db spells them; the script constants name them RC_<race> / Ele_<element> /
// Size_<size> / Class_<class> in any case, and tools/rathena/import.ts checks every list against the C++ headers before it imports.
/** enum e_element (map.hpp:390) up to ELE_UNDEAD, in index order: mob_db `Element`, the Ele_* constants. */
export const ELEMENTS = ["Neutral", "Water", "Earth", "Fire", "Wind", "Poison", "Holy", "Dark", "Ghost", "Undead"] as const;
export type Element = (typeof ELEMENTS)[number];
/** enum e_size (mob.hpp:114) up to SZ_BIG: mob_db `Size`; SZ_BIG is "Large" (the constant Size_Large). */
export const SIZES = ["Small", "Medium", "Large"] as const;
export type Size = (typeof SIZES)[number];
/** enum e_race (map.hpp:324) in index order, spelled as mob_db `Race` (the script constants are RC_<name>, any case). */
export const RACES = ["Formless", "Undead", "Brute", "Plant", "Insect", "Fish", "Demon", "Demihuman", "Angel", "Dragon", "Player_Human", "Player_Doram"] as const;
export type Race = (typeof RACES)[number];
/** enum e_aegis_monsterclass (mob.hpp:185) without CLASS_NONE: mob_db `Class` (a player is Normal, status.cpp:3841), the Class_* constants.
 *  status_data::class_ is what the bAddClass / bSubClass bonuses index; CLASS_NORMAL..CLASS_GUARDIAN are 0-2, BATTLEFIELD 4, EVENT 5. */
export const MOB_CLASSES = ["Normal", "Boss", "Guardian", "Battlefield", "Event"] as const;
export type MobClass = (typeof MOB_CLASSES)[number];
// An indexed bonus table's key (sd->right_weapon.addrace[RC_MAX], sd->indexed_bonus.subele[ELE_MAX], ...): a member of the list, or
// "All" for the table's RC_ALL / ELE_ALL / SZ_ALL / CLASS_ALL slot, which battle_calc_cardfix adds to the target's own slot.
export type RaceKey = Race | "All";
export type EleKey = Element | "All";
export type SizeKey = Size | "All";
export type ClassKey = MobClass | "All";

export const JOBS = jobsJson as Record<JobKey, Job & { aspdBase: Record<string, number>; bonusStats: ({ level: number } & Partial<Stats>)[] }>;
export const MOBS: Mob[] = mobsJson;
// 2.7.0 floor 3's species (shared/floor3.ts F3_MOBS): each is an existing row (modes, motions, non-card drops) under our own id, name and numbers
/** The Tower's own species (not rAthena rows): in MOB_BY_ID like any monster, kept out of MOBS (the imported roster the card / album / art rules run over). */
export const TOWER_MOBS: Mob[] = [];
for (const t of F3_MOBS) {
  const base = MOBS.find((m) => m.id === t.base);
  if (!base) continue;
  const k = t.level / base.level, up = (v: number) => Math.max(1, Math.round(v * k));
  TOWER_MOBS.push({
    ...base, id: t.id, name: t.name, level: t.level, hp: t.hp, atk: t.atk, matk: Math.round(t.atk * 0.8), def: t.def, mdef: Math.round(t.def / 2),
    str: up(base.str), agi: up(base.agi), vit: up(base.vit), int: up(base.int), dex: up(base.dex), luk: up(base.luk),
    baseExp: t.baseExp, jobExp: t.jobExp, mvpExp: t.mvpExp ?? 0, race: t.race, element: t.element, size: t.size ?? base.size,
    range: t.range ?? base.range, walkSpeed: t.walkSpeed ?? base.walkSpeed, attackDelay: t.attackDelay ?? base.attackDelay, attackMotion: t.attackMotion ?? base.attackMotion,
    mode: t.boss === "Mvp" ? base.mode | 0x80000 : base.mode & ~0x80000, // MD_MVP (rules/mode.ts) only on the guardian
    bossType: t.boss ?? "None", class: t.boss ? "Boss" : "Normal", mvpDrops: t.boss === "Mvp" ? base.mvpDrops : [],
    drops: base.drops.filter((d) => d.item < 4001 || d.item > 4999), slaves: [], statusSkills: [], // no other species' card, no borrowed mob skills
  } as Mob);
}
export const MOB_BY_ID = new Map([...MOBS, ...TOWER_MOBS].map((m) => [m.id, m]));
// 2.7.0 the Tower's floor scaling (shared/tower.ts): a floor guardian's HP / ATK / speed come from the tower table, not from its mob_db row
for (const f of TOWER) {
  const m = MOB_BY_ID.get(f.guardian);
  if (m) Object.assign(m, { hp: f.hp, atk: f.atk, attackDelay: f.attackDelay, attackMotion: f.attackMotion, walkSpeed: f.walkSpeed });
}
export const TABLES = tablesJson as {
  statpoint: number[];
  attr: Record<string, Record<string, Record<string, number>>>;
  size: Record<string, Record<Size, number>>;
  levelPenalty: Record<string, number[][]>; // level_penalty.yml [difference, rate] pairs, sparse (see rules/penalty.ts)
  maxRefine: number; // MAX_REFINE (status.hpp, RENEWAL)
  // refine.yml: refine[group][item weapon/armor level][refine level 1..maxRefine] (see rules/refine.ts)
  refine: Record<string, Record<string, Record<string, { bonus: number; randomBonus: number }>>>;
  // refine.yml Chances of the Normal cost type: refineChances[group][item level][refine level 1..] (see rules/refine.ts)
  refineChances: Record<string, Record<string, Record<string, { rate: number; price: number; material: number; breakingRate: number; downgrade: number }>>>;
};

export type Stats = { str: number; agi: number; vit: number; int: number; dex: number; luk: number };
export const STAT_KEYS = ["str", "agi", "vit", "int", "dex", "luk"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
