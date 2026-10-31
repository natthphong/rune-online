// Floor 2 — Lanternrest, the Ember Floor's rest town (2.5.0). No monsters.
// Lamplighter Isolde keeps the lanterns and the climbers' save point (rAthena's Kafra "Save" service, F_KafraSave -> savepoint) and a
// rest by the lantern fire (percentheal 100,100 for HEAL_FEE zeny, like the town healers of npc/re/other/healer.txt). Sentinel Corwin
// runs the floor's Main chain: "A Light on the Landing" (arrive), "Embers on the Terraces" (6 Ashbeetles), "Embers of the Vault"
// (the vault's boss). Marrow's Provisions is a plain shop NPC (npcs.ts).
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import { BC, ET, QMARK, QTYPE } from "../../rules/script.ts";
import { canCarryRewards, questReady, questReward } from "../functions.ts";
import { HEAL_FEE } from "../f1/town.ts";
import { naviTo } from "../f1/chapter1.ts";
import { F2_SAVE } from "../../maps.ts";
import { F2_VAULT_VAR, HUNT2, Q2, SPOT2 } from "./chapter2.ts";

// ---------- Lamplighter Isolde: save point and a rest ----------
const I = "[Lamplighter Isolde]";
export const lamplighterIsolde: NpcScript = async (s) => {
  s.mes(I, "Mind the lanterns, climber. Every one on this floor is lit by hand, and every one is mine to keep burning.",
    "Anything I can do for you?");
  await s.next();
  const c = await s.select("Set my hearth here", "Rest by the lanterns", "Cancel");
  if (c === 1) {
    s.savepoint(F2_SAVE.map, F2_SAVE.x, F2_SAVE.y); // F_KafraSave
    s.mes(I, "Done. If the Heights take you, you will wake beside my lanterns in ^4d4dffLanternrest^000000.");
    return s.close();
  }
  if (c === 2) {
    if (s.get("Zeny") < HEAL_FEE) { s.mes(I, `A rest by the lanterns is ^4d4dff${HEAL_FEE} zeny^000000. Come back with the coin.`); return s.close(); }
    s.set("Zeny", s.get("Zeny") - HEAL_FEE);
    s.percentheal(100, 100);
    s.emotion(ET.SMILE);
    s.mes(I, "There. The ember glow sees to the rest.");
    return s.close();
  }
  return s.close();
};

// ---------- Sentinel Corwin: the floor's Main chain ----------
const C = "[Sentinel Corwin]";
const TERRACES = naviTo("Emberlit Terraces", HUNT2.beetles);
const VAULT = naviTo("the Emberhollow Vault", HUNT2.vault);

export const sentinelCorwin: NpcScript = async (s) => {
  if (s.isbegin_quest(Q2.ARRIVE) !== 2) return arrive(s);
  if (s.isbegin_quest(Q2.TERRACES) === 0) return offerTerraces(s);
  if (s.isbegin_quest(Q2.TERRACES) === 1) return terraces(s);
  if (s.isbegin_quest(Q2.VAULT) === 0) return offerVault(s);
  if (s.isbegin_quest(Q2.VAULT) === 1) return vault(s);
  s.mes(C, "The vault is quiet, and the Heights are quieter. Lanternrest owes you more than I can pay.",
    "Whatever climbs the next stair will have the floor's blessing, when the stair opens.");
  return s.close3();
};

/** OnTouch (trigger 4x4): the sentinel hails a newcomer who has not reported yet. */
export const sentinelCorwinTouch: NpcScript = async (s) => {
  if (s.isbegin_quest(Q2.ARRIVE) !== 1) return;
  s.emotion(ET.QUESTION);
  s.npctalk("Sentinel Corwin : You there! Up from the Mire, are you?", "", BC.SELF);
};

async function arrive(s: Script) {
  s.mes(C, "Easy. You're through the Ascent Stair, so you're on the second floor: ^4d4dffLanternrest^000000, the Ember Floor.",
    "I am Corwin. I stand sentinel at the foot of the stair and I count every climber who comes up it.");
  await s.next();
  if (s.isbegin_quest(Q2.ARRIVE) === 0) s.setquest(Q2.ARRIVE);
  if (!canCarryRewards(s, Q2.ARRIVE)) { s.mes(C, "Your pack's full. Make room and come back."); return s.close3(); }
  s.completequest(Q2.ARRIVE);
  questReward(s, Q2.ARRIVE);
  s.mes(C, "Lamplighter Isolde keeps the save point by the Lantern House, Marrow sells tonics, and the crystal on the plaza",
    "will carry you down to Hearthmoor and back whenever you like. Spend a night, climber. Then we talk work.");
  await s.next();
  return offerTerraces(s);
}

async function offerTerraces(s: Script) {
  s.mes(C, "The ^4d4dffAshbeetles^000000 are crawling out of the old terraces west of the town gate, closer every night.",
    `Cut six of them down on ${TERRACES} and I'll see you paid.`);
  const c = await s.select("I'll do it.", "Not now.");
  if (c !== 1) { s.mes(C, "The offer stands."); return s.close(); }
  s.setquest(Q2.TERRACES);
  s.mes(C, "Good. Out the west gate. Mind the Cinderboughs further in: burning trees that walk, and they hit hard.");
  return s.close();
}

async function terraces(s: Script) {
  if (!questReady(s, Q2.TERRACES)) {
    s.mes(C, `Six Ashbeetles on ${TERRACES}, climber. West gate, then follow the road.`);
    return s.close3();
  }
  if (!canCarryRewards(s, Q2.TERRACES)) { s.mes(C, "Your pack's full. Make room first."); return s.close3(); }
  s.emotion(ET.BEST);
  s.completequest(Q2.TERRACES);
  questReward(s, Q2.TERRACES);
  s.mes(C, "Six. The terraces breathe easier. Here, for your trouble.");
  await s.next();
  return offerVault(s);
}

async function offerVault(s: Script) {
  s.mes(C, "That's the symptom. The cause is under the Heights: the ^4d4dffEmberhollow Vault^000000, where the floor's old furnaces still burn.",
    `Something grew there, a huge horned goat the ash woke. Past the stair in the north-east ruin, ${VAULT}.`);
  await s.next();
  s.mes(C, "Put ^4d4dffDevo^000000 down and the Heights are ours again. Take tonics. He charges in a straight line: step aside, and mind the kids he calls.");
  const c = await s.select("I'll end him.", "Not yet.");
  if (c !== 1) { s.mes(C, "Don't wait too long. The embers are not patient."); return s.close(); }
  s.setquest(Q2.VAULT);
  s.mes(C, "Cinderwatch Heights lies east of the town. The ruin with the stair is at its north-east end.");
  return s.close();
}

async function vault(s: Script) {
  if (!questReady(s, Q2.VAULT)) {
    s.mes(C, `Devo is still alive in ${VAULT}. East gate, the Heights, the ruin in the north-east, and the stair down.`);
    return s.close3();
  }
  if (!canCarryRewards(s, Q2.VAULT)) { s.mes(C, "Your pack's full. Make room first."); return s.close3(); }
  s.emotion(ET.BEST);
  s.completequest(Q2.VAULT);
  s.set(F2_VAULT_VAR, 1);
  questReward(s, Q2.VAULT);
  s.mes(C, "She's down! The furnaces are cooling; I can feel it from here. Lanternrest will not forget this.");
  await s.next();
  s.mes("-! Floor 2 complete !-", "^4d4dffThe Ember Floor^000000",
    "The Heights are quiet. The stair to the third floor will open in a later release.");
  return s.close();
}

/** questinfo: "!" when work is on offer, "?" when there is something to report. */
export const SENTINEL_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q2.ARRIVE) === 1 },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => questReady(v, Q2.TERRACES) || questReady(v, Q2.VAULT) },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q2.ARRIVE) === 2 && (v.isbegin_quest(Q2.TERRACES) === 0 || (v.isbegin_quest(Q2.TERRACES) === 2 && v.isbegin_quest(Q2.VAULT) === 0)) },
];
