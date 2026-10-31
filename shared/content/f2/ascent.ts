// Floor 2 — the Ascent Stair and the warp crystals.
// The Ascent Stair: a pale spiral stair in the Sunken Mire's drowned chapel, an invisible NPC on its cell with a 3x3 OnTouch area (like
// the sealed stair, f1/stair.ts, which it sits beside): a climber the wardens vouched for (f1_seal, Warden Orrin's seal quest) who is
// Base Lv F2_GATE_LEVEL or more goes up to Lanternrest; anyone else is told what is missing. Arriving sets f2_visit (the crystals work)
// and starts "A Light on the Landing".
// The warp crystals (one in each town, rAthena's Kafra warp service without the fee): a floor's town can be reached from any other
// floor's town the climber has already stood in.
import type { NpcScript } from "../api.ts";
import { F2_ARRIVAL, TOWN } from "../../maps.ts";
import { F2_TOWN } from "../../floor2.ts";
import { SEAL_VAR } from "../f1/stair.ts";
import { SPOT, naviTo } from "../f1/chapter1.ts";
import { CRYSTAL_LANDING, F2_GATE_LEVEL, F2_VAR, Q2 } from "./chapter2.ts";

const N = "-! The Ascent Stair !-";

export const ascentStair: NpcScript = async (s) => {
  if (s.get(SEAL_VAR) < 1) {
    s.mes(N, "A spiral of pale stone climbs out of the drowned chapel and into the dark above.",
      "A bar of rune-light lies across its first step, and it will not lift for you.");
    await s.next();
    s.mes(N, "^4d4dffThe way up is not open yet.^000000",
      `Only climbers the wardens vouch for may pass. ${naviTo("Warden Orrin", SPOT.warden)} keeps Hearthmoor's south gate.`);
    return s.close();
  }
  if (s.get("BaseLevel") < F2_GATE_LEVEL) {
    s.mes(N, "The rune-light across the first step reads your measure and finds it short.",
      `The upper floor asks ^4d4dffBase Lv ${F2_GATE_LEVEL}^000000. You are Base Lv ^4d4dff${s.get("BaseLevel")}^000000.`,
      "Hunt the catacombs below the keep a while longer.");
    return s.close();
  }
  s.set(F2_VAR, 1);
  if (s.isbegin_quest(Q2.ARRIVE) === 0) s.setquest(Q2.ARRIVE);
  return s.warp(F2_ARRIVAL.map, F2_ARRIVAL.x, F2_ARRIVAL.y);
};

/** A warp crystal in `here`'s town ("f1" Hearthmoor / "f2" Lanternrest): dark until the climber has stood on floor 2. */
export const warpCrystal = (here: "f1" | "f2"): NpcScript => async (s) => {
  const C = "[Warp Crystal]";
  if (s.get(F2_VAR) < 1) {
    s.mes(C, "A tall crystal, dark and cold. Rune-lines run up it from the floor, and none of them are lit.",
      "It wakes for climbers who have stood on the floor above.");
    return s.close();
  }
  s.mes(C, "The crystal hums and its runes light one by one. It remembers every floor town you have stood in.",
    "Where to?");
  const to = here === "f1" ? CRYSTAL_LANDING[F2_TOWN] : CRYSTAL_LANDING[TOWN];
  const c = await s.select(here === "f1" ? "Lanternrest (Floor 2)" : "Hearthmoor (Floor 1)", "Cancel");
  if (c !== 1) return s.close();
  return s.warp(to.map, to.x, to.y);
};
