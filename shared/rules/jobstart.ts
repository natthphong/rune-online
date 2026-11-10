// A character that starts as a first job (Make Character's job cards, POST /api/characters `job`; 2.7.0). The state it begins with is
// what the game's own job change leaves (server/src/skills.ts jobChange = pc_jobchange): job set, Job Lv 1, Basic Training 9
// like a graduate of the Fledgling's training, a starter weapon of the guild master's family (f1/jobs.ts MASTERS kit), plus a
// gift of 3 skill levels in the job's signature active skills (all of them implemented, none a "coming later" row) so the shortcut
// bar is useful from the first second. The skills are written with the character (api.ts), the weapon at the first login
// (MapRoom.enter, with the Fledgling kit), the bar slots F1... hold the skills (hotkey.ts skillHotkey; the potions follow them).
import type { FirstJob } from "./data.ts";
import { skillHotkey, type HotkeyList, MAX_HOTKEYS } from "./hotkey.ts";
import { SKILL_ID } from "./skill.ts";

export const START_BASIC = 9; // NV_BASIC level of a finished Fledgling (F_CanChangeJob)
/** `level` = the Base Level the character starts at: weapons have a minimum base level (item_db EquipLevelMin: Sword 2, Club 2, Axe 3,
 *  Bow 4 ...), so a start is at the lowest level that can wear its weapon (Mage and Thief: 1); its status points are statPointsAt(level). */
export type JobStart = { level: number; skills: [key: string, level: number][]; kit: { item: string; count: number }[]; zeny?: number };
export const JOB_START: Record<FirstJob, JobStart> = {
  Swordman: { level: 2, skills: [["SM_BASH", 3]], kit: [{ item: "Sword", count: 1 }] }, // Crushing Blow 3
  Mage: { level: 1, skills: [["MG_FIREBOLT", 2], ["MG_COLDBOLT", 1]], kit: [{ item: "Rod", count: 1 }] }, // Flame Bolt 2, Frost Bolt 1
  Archer: { level: 4, skills: [["AC_DOUBLE", 3]], kit: [{ item: "Bow", count: 1 }, { item: "Arrow", count: 200 }] }, // Twin Shot 3
  Acolyte: { level: 2, skills: [["AL_HEAL", 3]], kit: [{ item: "Club", count: 1 }] }, // Heal 3
  Merchant: { level: 3, skills: [["MC_MAMMONITE", 3]], kit: [{ item: "Axe", count: 1 }], zeny: 1000 }, // Coin Strike 3 costs 300 zeny a cast: seed coin
  Thief: { level: 1, skills: [["TF_POISON", 3]], kit: [{ item: "Cutter", count: 1 }] }, // Venom Edge 3 (the master's Dirk needs Base Lv 12)
};
export const jobStart = (job: string): JobStart | undefined => (JOB_START as Record<string, JobStart | undefined>)[job];

/** The `skill` rows (id, level) a job start writes: Basic Training 9 and the starter skills. */
export const startSkillRows = (job: FirstJob): [id: number, lv: number][] =>
  [[SKILL_ID.NV_BASIC, START_BASIC], ...JOB_START[job].skills.map(([k, lv]): [number, number] => [SKILL_ID[k], lv])];

/** The shortcut list a job start begins with: the starter skills on the first slots (F1, F2...), the rest empty. */
export function startHotkeys(job: FirstJob): HotkeyList {
  const list: HotkeyList = Array.from({ length: MAX_HOTKEYS }, () => null);
  JOB_START[job].skills.forEach(([k, lv], i) => { list[i] = skillHotkey(SKILL_ID[k], lv); });
  return list;
}
