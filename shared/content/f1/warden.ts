// Floor 1 — Warden Orrin at Hearthmoor's south gate, where the road to the Sunken Mire (the floor's hardest field, Lv 15-20) and the
// sealed stair beneath it begins. Chapter 1 ends with him, at a level gate: he takes in climbers of Base Lv F1_GATE_LEVEL or more
// (Proven Climber; checked with the BaseLevel param like the level checks of the Academy's Captain, `BaseLevel < 15`). W01: the
// gate itself is an ordinary warp (anyone may walk the south road); Orrin's word is what the proven climbers earn, and after the
// chapter he sends them to the Hearthkeeper (A Warm Hearth) on the way to their first job. W03: he also holds the wardens' seal on
// the stair under the Mire's keep; at Base Lv SEAL_LEVEL he hands out "The Wardens' Seal" (clear the Mire's Dustcoils) and, when it
// is done, sets the permanent f1_seal that lets the stair take the climber down into the Mirefall Catacombs (f1/stair.ts).
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import { BC, CUTIN, ET, QMARK, QTYPE } from "../../rules/script.ts";
import { canCarryRewards, questReward, questTasksDone } from "../functions.ts";
import { F1_GATE_LEVEL } from "../quest_db.ts";
import { HUNT, Q, naviTo } from "./chapter1.ts";
import { MIRE_STAIR, MIRE_STAIR_IN } from "../../maps.ts";
import { CALLING } from "./jobs.ts";
import { TQ } from "./town.ts";
import { SEAL, SEAL_LEVEL, SEAL_VAR } from "./stair.ts";

const N = "[Warden Orrin]";
const WOODS = naviTo("Whisperwood", HUNT.woods);
const DUSTCOILS = naviTo("the Mire's causeway", HUNT.dustcoils);
const STAIR = naviTo("the stair under the old keep", { map: MIRE_STAIR.map, x: MIRE_STAIR_IN.x, y: MIRE_STAIR_IN.y });
const face = (s: Script) => s.cutin("warden_orrin", CUTIN.BOTTOM_RIGHT);

export const wardenOrrin: NpcScript = async (s) => {
  face(s);
  if (s.isbegin_quest(Q.GATE) === 1) return meet(s);
  if (s.isbegin_quest(Q.PROVEN) === 1) return proven(s);
  if (s.isbegin_quest(Q.PROVEN) === 2) return theRoad(s);
  s.mes(N, "Mind yourself, climber. Past this gate runs the road to the ^4d4dffSunken Mire^000000, and the old stair down under it.",
    "The wardens only vouch for proven climbers. Learn the gentler fields first. Guide Lio will tell you when you're ready.");
  return s.close3();
};

/** OnTouch (trigger 5x5): he hails the climber Lio sent. */
export const wardenOrrinTouch: NpcScript = async (s) => {
  if (s.isbegin_quest(Q.GATE) !== 1) return;
  s.emotion(ET.QUESTION);
  s.npctalk("Warden Orrin : You there! Lio's climber, is it?", "", BC.SELF);
};

async function meet(s: Script) {
  s.mes(N, "So you're the one Lio keeps going on about. Brambles, Tumhogs, fire-pests... not bad for a Fledgling.");
  await s.next();
  s.mes(N, "This gate opens onto the road to the ^4d4dffSunken Mire^000000. Black water, walking dead, and a stair the wardens keep sealed.",
    `Before I vouch for anyone, the wardens' rule is simple: ^4d4dffBase Lv ${F1_GATE_LEVEL}^000000 or more.`);
  s.completequest(Q.GATE);
  s.setquest(Q.PROVEN);
  await s.next();
  return proven(s);
}

async function proven(s: Script) {
  if (!questTasksDone(s, Q.PROVEN)) {
    s.mes(N, `You're Base Lv ^4d4dff${s.get("BaseLevel")}^000000. Come back at ^4d4dffBase Lv ${F1_GATE_LEVEL}^000000.`,
      `The ${WOODS} past the east gate makes good practice.`);
    return s.close3();
  }
  s.emotion(ET.BEST);
  s.mes(N, `Base Lv ${s.get("BaseLevel")}. You carry yourself like a climber now. Lio was right about you.`);
  await s.next();
  if (!canCarryRewards(s, Q.PROVEN)) {
    s.mes(N, "Your pack's full to bursting. Lighten it and come back.");
    return s.close3();
  }
  s.completequest(Q.PROVEN);
  questReward(s, Q.PROVEN);
  s.mes(N, "The wardens' gift to every climber who earns their word: a proper ^4d4dffCutter^000000, and coin for the inn.");
  await s.next();
  s.mes("-! Chapter 1 complete !-", "^4d4dffThe Verdant Floor^000000",
    "You learned the fields of the first floor, and the wardens vouch for you on every road out of Hearthmoor.");
  await s.next();
  return theRoad(s);
}

/** After the chapter (C08, W01): the next Main step is the Hearthkeeper by the town's fire (save point), then the Drillmaster and
 *  the guild masters. Orrin hands it over and points at the south road for later. */
async function theRoad(s: Script) {
  if (s.isbegin_quest(CALLING) === 0 && s.isbegin_quest(TQ.HEARTH) === 0) { // C08: the next Main step, Hearthmoor (f1/town.ts)
    s.mes(N, "Go and find ^4d4dffHearthkeeper Bren^000000 by the fire in the plaza. She'll set your save point,",
      "and the town's Drillmaster will finish your Fledgling training before the guild masters give you a real job.");
    s.setquest(TQ.HEARTH);
    await s.next();
  }
  if (s.isbegin_quest(SEAL) === 2) return openStair(s);
  if (s.isbegin_quest(SEAL) === 1) return sealErrand(s);
  if (s.get("BaseLevel") >= SEAL_LEVEL) return offerSeal(s);
  s.mes(N, `The south road is yours whenever you want it. But the Mire is no place below ^4d4dffBase Lv ${SEAL_LEVEL}^000000,`,
    "and the stair under the old keep stays sealed. Nobody goes down there. Not yet.");
  return s.close3();
}

/** W03: Base Lv 15+: the stair can be opened for you, after one job on the Mire. */
async function offerSeal(s: Script) {
  s.mes(N, `Base Lv ${s.get("BaseLevel")}... You've grown, climber. Then hear this.`,
    "Under the Sunken Mire's keep a stair goes down to the ^4d4dffMirefall Catacombs^000000. Old tunnels, bones, and things that hate the light.",
    "The wardens keep it sealed. I can lift the seal for you, but first prove you can hold the Mire.");
  await s.next();
  s.mes(N, `Dustcoils have taken the causeway. Clear ^4d4dff8 of them^000000 off ${DUSTCOILS} and come back to me.`);
  s.setquest(SEAL);
  return s.close3();
}

async function sealErrand(s: Script) {
  if (s.checkquest(SEAL, "HUNTING") !== 2) {
    s.mes(N, `The Dustcoils are still on ${DUSTCOILS}. Eight of them, climber. Then we talk about the stair.`);
    return s.close3();
  }
  if (!canCarryRewards(s, SEAL)) {
    s.mes(N, "Your pack's full to bursting. Lighten it and come back.");
    return s.close3();
  }
  s.emotion(ET.BEST);
  s.completequest(SEAL);
  s.set(SEAL_VAR, 1);
  questReward(s, SEAL);
  s.mes(N, "The causeway's clear. Good work. Hold still.", "...There. The wardens' seal answers to you now: the slab will let you pass.");
  await s.next();
  return openStair(s);
}

/** After the errand: the way down is open (the stair reads f1_seal). */
async function openStair(s: Script) {
  s.mes(N, `${STAIR} is open to you. Three levels of catacombs, each deeper and worse than the last,`,
    "and something big and wet at the bottom that the old wardens never killed. Go down ready, and come back up alive.");
  return s.close3();
}

/** questinfo: "?" while he is the next stop: meeting him, and the level check once you have the level. */
export const WARDEN_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.GATE) === 1 },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.PROVEN) === 1 && questTasksDone(v, Q.PROVEN) },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.PROVEN) === 2 && v.isbegin_quest(CALLING) === 0 && v.isbegin_quest(TQ.HEARTH) === 0 }, // the road to give
  // W03: the seal: "!" once you have the level, "?" when the Dustcoils are done
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(SEAL) === 1 && v.checkquest(SEAL, "HUNTING") === 2 },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.PROVEN) === 2 && v.isbegin_quest(SEAL) === 0 && v.get("BaseLevel") >= SEAL_LEVEL },
];
