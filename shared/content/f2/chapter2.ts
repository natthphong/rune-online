// Floor 2 of the Tower (2.5.0), "The Ember Floor": the quest ids of its Main chain (shared/content/quest_db.ts 2001-2003), the
// permanent variables, the level gate of the Ascent Stair and where the floor's NPCs and hunting grounds are. Floor N uses quest ids
// N001-N999 (floor 1: 1001-1999). The story is in docs/TOWER_STORY.md.
import { F2_DUN, F2_FIELD1, F2_TOWN, T2_CELLS } from "../../floor2.ts";
import { TOWN } from "../../maps.ts";

/** Base level the Ascent Stair asks for (besides the wardens' seal, f1_seal): the catacombs below end at Lv 30, the Ember Floor's monsters run from Lv 32 to 45. */
export const F2_GATE_LEVEL = 30;
/** Permanent character variable: 1 = this climber has stood on floor 2 (the warp crystals of both towns work for them). */
export const F2_VAR = "f2_visit";
/** Permanent character variable: 1 = the vault's boss is down ("Embers of the Vault" done; the stair to floor 3 opens in a later release). */
export const F2_VAULT_VAR = "f2_vault";

export const Q2 = {
  ARRIVE: 2001, // arrive on floor 2, report to Sentinel Corwin
  TERRACES: 2002, // 6 Ashbeetles on the Emberlit Terraces
  VAULT: 2003, // Devo in the Emberhollow Vault
} as const;
export const CHAPTER2: readonly number[] = Object.values(Q2);

export const NPC2 = {
  keeper: "npc_f2_keeper", sentinel: "npc_f2_sentinel", shop: "f2_shop", crystal: "f2_crystal", crystal1: "f1_crystal", ascent: "f1_ascent",
} as const;
/** Where floor 2's NPCs stand on Lanternrest (shared/floor2.ts T2_CELLS). */
export const SPOT2 = {
  keeper: { map: F2_TOWN, ...T2_CELLS.keeper }, sentinel: { map: F2_TOWN, ...T2_CELLS.sentinel }, shop: { map: F2_TOWN, ...T2_CELLS.shop },
  crystal: { map: F2_TOWN, ...T2_CELLS.crystal },
} as const;
/** Hearthmoor's warp crystal (on the plaza, north-east of the fountain). */
export const CRYSTAL1 = { map: TOWN, x: 30, y: 22 } as const;
/** Where a crystal puts the climber down: two cells south of itself. */
export const CRYSTAL_LANDING = {
  [TOWN]: { map: TOWN, x: CRYSTAL1.x, y: CRYSTAL1.y + 2 },
  [F2_TOWN]: { map: F2_TOWN, x: T2_CELLS.crystal.x, y: T2_CELLS.crystal.y + 2 },
} as const;
export const HUNT2 = {
  beetles: { map: F2_FIELD1, x: 56, y: 24 }, // the Terraces' Ashbeetles
  vault: { map: F2_DUN, x: 31, y: 34 }, // the vault: the middle cave, on the way to the boss hall
} as const;
