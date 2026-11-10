// Floor 3 — Witherwick, the Blighted Shire (2.7.0; the map in shared/floor3.ts, the Tower rule in shared/tower.ts).
//   f2_stair3      the stair up at the top of Lanternrest's north street: a scripted door (like the Ascent Stair, f2/ascent.ts) that
//                  opens for climbers whose party felled floor 2's guardian (the permanent variable tower_f2, set by server/src/tower.ts);
//   npc_f3_keeper  Sister Odile at the survivors' camp: the floor's save point, and she tells what happened here;
//   f3_gate        the sealed gate to floor 4 in the chapel ruin: opens (tower_f3) for the party that fells Morrowgast. Floor 4 is
//                  not built yet, so an open gate only says so.
import type { NpcScript } from "../api.ts";
import { F3_ARRIVAL, F3_SAVE } from "../../floor3.ts";
import { towerFloor } from "../../tower.ts";

export const NPC3 = { stair: "f2_stair3", keeper: "npc_f3_keeper", gate: "f3_gate" } as const;
/** Set on a climber's first arrival on floor 3. */
export const F3_VAR = "f3_visit";
const F2 = towerFloor(2)!, F3 = towerFloor(3)!;

export const stairToFloor3: NpcScript = async (s) => {
  const N = "-! The Stair to Floor 3 !-";
  if (s.get(F2.clearVar) < 1) {
    s.mes(N, "A stair of black iron climbs out of Lanternrest's north wall into the dark. A chain of ember-light hangs across it.",
      "^4d4dffThe way up is sealed.^000000 It opens for the party that fells ^ff4d4dDevo^000000, the Ember Floor's guardian, in the Emberhollow Vault.");
    return s.close();
  }
  s.set(F3_VAR, 1);
  return s.warp(F3_ARRIVAL.map, F3_ARRIVAL.x, F3_ARRIVAL.y);
};

export const sisterOdile: NpcScript = async (s) => {
  const N = "[Sister Odile]";
  s.mes(N, "You came up the iron stair? Then keep your voice down. This was Witherwick, a market village.",
    "Three witches took the chapel one winter and cooked something in it. It got into the wells.");
  await s.next();
  for (;;) {
    s.mes(N, "What do you need, climber?");
    const c = await s.select("Save here", "What walks out there?", "How do I leave this floor?", "Nothing");
    if (c === 1) {
      s.savepoint(F3_SAVE.map, F3_SAVE.x, F3_SAVE.y);
      s.mes(N, "The camp fire will remember you. If you fall, you wake here.");
      await s.next();
    } else if (c === 2) {
      s.mes(N, "The villagers who drank: ^4d4dffPlaguewalkers^000000. Their hounds: ^4d4dffRotfangs^000000. The witches' wardens still keep the lanes.",
        "And the alderman. They made him last and biggest: ^ff4d4dMorrowgast^000000. He never stays in one place. He ^ff4d4druns at whatever he sees^000000.",
        "Watch the ground. When it glows, move.");
      await s.next();
      s.mes(N, "One more thing. Something with horns and a scythe keeps the graveyard, north-east. When it lifts the scythe, ^4d4dfffind a pale circle^000000 and stand in it.");
      await s.next();
    } else if (c === 3) {
      s.mes(N, "Down: the stair you came by, at the south road's end.",
        "Up: the gate in the chapel ruin, north of the green. It opens for those who put Morrowgast back in the ground.");
      await s.next();
    } else return s.close();
  }
};

export const gateToFloor4: NpcScript = async (s) => {
  const N = "-! The Chapel Gate !-";
  if (s.get(F3.clearVar) < 1) {
    s.mes(N, "Behind the chapel's broken altar a gate of pale stone stands shut. Witch-marks crawl over it.",
      "^4d4dffThe way up is sealed.^000000 It opens for the party that fells ^ff4d4dMorrowgast^000000, this floor's guardian. He roams the shire.");
    return s.close();
  }
  s.mes(N, "The witch-marks are burnt out and the gate stands open for you. Cold air comes down the stair behind it.",
    "^4d4dffFloor 3 is cleared.^000000 The fourth floor is still being built: the stair ends in fog, for now.");
  return s.close();
};
