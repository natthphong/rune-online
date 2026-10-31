// Floor 1 — the old lookout: an invisible trigger area (rAthena: a HIDDEN_NPC script with "TriggerX,TriggerY" and an OnTouch
// label, like the Academy's #acKick, npc/re/jobs/novice/academy.txt, which also hurts you with percentheal and points you on).
// Walking in while "The Old Lookout" is held tells what happened here, a bramble snaps at you (percentheal -40: never below
// 1 HP), and the trail leads on to Herbalist Tamsin. Anyone else walks through without a word.
import type { NpcScript } from "../api.ts";
import { ET } from "../../rules/script.ts";
import { questReward } from "../functions.ts";
import { Q } from "./chapter1.ts";

const N = "-! The Old Lookout !-";

export const oldLookout: NpcScript = async (s) => {
  if (s.isbegin_quest(Q.LOOKOUT) !== 1) return s.end();
  s.emotion(ET.SURPRISE, s.playerattached());
  s.mes(N, "Tumbled stones ring the stump of an old watchtower.",
    "The mud around it is churned with deep, split hoofprints. Something heavy came through here, and more than one.");
  await s.next();
  // the scouting is done (its EXP may level you up, which heals you fully), and only then does the bramble bite: you reach
  // Tamsin hurt, whatever level you are
  s.completequest(Q.LOOKOUT);
  questReward(s, Q.LOOKOUT);
  s.setquest(Q.TRAIL);
  s.percentheal(-40, 0);
  s.emotion(ET.HUK, s.playerattached());
  s.mes(N, "Ouch! A thorny bramble snaps shut around your ankle.",
    "Wrenching free, you spot a bundle of herbs caught in the thorns, tied with lavender string.");
  await s.next();
  s.mes(N, "A trail of crushed leaves leads away south, toward the lake.",
    "Whoever dropped these herbs must know these tracks.");
  return s.close();
};
