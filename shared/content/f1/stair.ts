// Floor 1 — the stair under the Sunken Mire's old keep, the way down into the Mirefall Catacombs (W03, shared/maps.ts DUN1..3).
// An invisible NPC on the stair cell with a 3x3 OnTouch area (rAthena: a HIDDEN_NPC script with a trigger area): a climber Warden
// Orrin has let through (permanent variable f1_seal, set when "The Wardens' Seal" is done) goes straight down, like an rAthena
// dungeon gate whose OnTouch does `if (f1_seal) warp "f1_dun01",32,10;`; anyone else finds the wardens' seal on the slab.
// shared/maps.ts lists the stair in WARPS (npc "f1_stair") so navigation routes through it; this script decides.
import type { NpcScript } from "../api.ts";
import { DUNGEON_ENTRY } from "../../maps.ts";
import { SPOT, naviTo } from "./chapter1.ts";

const N = "-! The Sealed Stair !-";

/** "The Wardens' Seal" (quest_db.ts): Warden Orrin's errand that opens the stair. */
export const SEAL = 1018;
/** Permanent character variable: 1 = the wardens broke the seal for this climber (f1/warden.ts). */
export const SEAL_VAR = "f1_seal";
/** Base level Orrin asks before he hands out the errand. */
export const SEAL_LEVEL = 15;

export const sealedStair: NpcScript = async (s) => {
  if (s.get(SEAL_VAR) >= 1) return s.warp(DUNGEON_ENTRY.map, DUNGEON_ENTRY.x, DUNGEON_ENTRY.y);
  s.mes(N, "Worn steps lead down into the dark beneath the ruined keep.",
    "A slab of rune-cut stone lies across them, and the wardens' seal is pressed into its middle.");
  await s.next();
  s.mes(N, "^4d4dffThe way down is not open yet.^000000",
    `Only the wardens can lift the seal. ${naviTo("Warden Orrin", SPOT.warden)} keeps Hearthmoor's south gate.`);
  return s.close();
};
