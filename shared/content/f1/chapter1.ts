// Floor 1, Chapter 1 "The Verdant Floor": the quest ids of the Main chain (shared/content/quest_db.ts 1001-1014), the NPCs that
// run it, and where the chain stands for a character (Guide Lio points you at the next step with it). The step list is in
// ro/DESIGN.md "Floor 1 — Chapter 1".
import type { QuestInfoView } from "../api.ts";
import { FIELD, FOREST, MIRE, TOWN } from "../../maps.ts";
import { TOWN_CELLS } from "../../town.ts";

export const Q = {
  PATROL: 1001, // Lio: defeat 5 Puddleblooms
  BEADS: 1002, // Lio: bring 10 Gel Beads (quest-only drops)
  THANKS: 1003, // talk to Mira (she gives the Hat)
  DRESSED: 1004, // wear the Hat, show Mira
  CRATE: 1005, // deliver Mira's Supply Crate to Ranger Vessa
  STATS: 1006, // spend status points, talk to Vessa
  EMBERS: 1007, // 6 Fire-element monsters + 4 Ember Coals (quest-only drops) for Vessa
  LOOKOUT: 1008, // walk into the old lookout (OnTouch area)
  TRAIL: 1009, // talk to Herbalist Tamsin
  REST: 1010, // drink the Herb Tea from the shortcut bar, sit until HP is full
  PESTS: 1011, // 5 Tumhogs + 2 Loamblooms for Tamsin
  NEWS: 1012, // talk to Lio
  GATE: 1013, // talk to Warden Orrin
  PROVEN: 1014, // reach Base Lv 8, show Orrin: chapter complete
} as const;
/** The chain in order. */
export const CHAPTER1: readonly number[] = Object.values(Q);

export const NPC = {
  guide: "npc_guide", merchant: "npc_merchant", ranger: "npc_ranger", herbalist: "npc_herbalist", warden: "npc_warden",
  lookout: "f1_lookout", miraShop: "f1_mira_shop",
} as const;
/** Where the NPCs of the chain stand (npcs.ts places them; NAVI links point here). W01: the town NPCs stand in Hearthmoor, the field
 *  NPCs (Ranger Vessa's watch post, the old lookout, Herbalist Tamsin's lake camp) on the Verdant Plains west of town. */
export const SPOT = {
  guide: { map: TOWN, ...TOWN_CELLS.guide }, merchant: { map: TOWN, ...TOWN_CELLS.merchant }, warden: { map: TOWN, ...TOWN_CELLS.warden },
  ranger: { map: FIELD, x: 88, y: 31 }, herbalist: { map: FIELD, x: 68, y: 46 }, lookout: { map: FIELD, x: 68, y: 27 },
} as const;
/** Hunting grounds the chapter's dialogs link to (shared/data/spawns.txt zones). */
export const HUNT = {
  blooms: { map: FIELD, x: 90, y: 43 }, // Puddleblooms, by the plains' gate
  sootcaps: { map: FIELD, x: 82, y: 28 }, // Sootcaps, below the watch post
  tumhogs: { map: FIELD, x: 60, y: 56 }, // the Tumhog thickets, west of the lake
  woods: { map: FOREST, x: 16, y: 34 }, // Whisperwood's Dartwings: Lv 5-10, where a Fledgling makes Base Lv 8
  dustcoils: { map: MIRE, x: 30, y: 22 }, // W03: the Sunken Mire's Dustcoils, Warden Orrin's errand before the stair opens
} as const;

/** Hearthmoor's guild row, south-east of the plaza: the six first-job masters (f1/jobs.ts) in two lines of three in the guild hall's
 *  courtyard (center = between the lines, the navigation target; shared/town.ts). */
export const GUILD_ROW = TOWN_CELLS.guild;

/** A clickable place in a dialog line (rAthena <NAVI>[label]<INFO>map,x,y,0,000,0</INFO></NAVI>, doc/script_commands.txt "mes"). */
export const navi = (label: string, x: number, y: number, map: string = FIELD) => `<NAVI>[${label}]<INFO>${map},${x},${y},0,000,0</INFO></NAVI>`;
/** navi() to a SPOT / HUNT place. */
export const naviTo = (label: string, p: { map: string; x: number; y: number }) => navi(label, p.x, p.y, p.map);

/** Where the chain stands: the first quest of the chapter that is not completed (state 0 = not started, 1 = held), or undefined
 *  when the whole chapter is done. */
export function chapter1Step(v: Pick<QuestInfoView, "isbegin_quest">): { id: number; state: number } | undefined {
  for (const id of CHAPTER1) {
    const state = v.isbegin_quest(id);
    if (state !== 2) return { id, state };
  }
  return undefined;
}
