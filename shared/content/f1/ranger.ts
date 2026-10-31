// Floor 1 — Ranger Vessa at the watch post on the Verdant Plains (west of Hearthmoor). She takes Mira's Supply Crate (a delivery: countitem / delitem like the
// Academy Sailor's lumber, npc/re/jobs/novice/academy.txt), teaches status points by having you spend them (Know Your
// Strength: the Captain's "allocate your stats" lesson, checked with the StatusPoint param), sends you after fire-blooded
// monsters with a quest_db Element target and quest-only Ember Coal drops (Embers in the Grass) and then to the old lookout.
// OnTouch: she spots Mira's crate (npctalk bc_self + emotion, like the Academy staff's OnTouch reactions).
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import { BC, CUTIN, ET, QMARK, QTYPE } from "../../rules/script.ts";
import { canCarryRewards, questReady, questReward, questTasksDone } from "../functions.ts";
import { QUEST_DB } from "../quest_db.ts";
import { HUNT, Q, SPOT, naviTo } from "./chapter1.ts";

const N = "[Ranger Vessa]";
const CRATE = "Supply Crate", COAL = "Ember Coal", COALS = 4;
const FIRE_KILLS = QUEST_DB.get(Q.EMBERS)!.objectives[0].count;
const EAST = naviTo("below the post", HUNT.sootcaps);
const LOOKOUT = naviTo("old lookout", SPOT.lookout);
const face = (s: Script) => s.cutin("ranger_vessa", CUTIN.BOTTOM_RIGHT);

export const rangerVessa: NpcScript = async (s) => {
  face(s);
  if (s.isbegin_quest(Q.CRATE) === 1) return delivery(s);
  if (s.isbegin_quest(Q.STATS) === 1) return stats(s);
  if (questReady(s, Q.EMBERS)) return reportEmbers(s);
  if (s.isbegin_quest(Q.STATS) === 2 && s.isbegin_quest(Q.EMBERS) === 0) return offerEmbers(s);
  if (s.isbegin_quest(Q.EMBERS) === 1) {
    s.mes(N, `Still smoke on the wind. Six fire-blooded pests and ^4d4dff${COALS} Ember Coals^000000, remember?`,
      `You have ^4d4dff${s.countitem(COAL)}^000000 coals. Sootcaps roam ${EAST} and in the south meadow.`);
    return s.close3();
  }
  if (s.isbegin_quest(Q.EMBERS) === 2 && s.isbegin_quest(Q.LOOKOUT) === 0) return sendToLookout(s);
  if (s.isbegin_quest(Q.LOOKOUT) === 1) {
    s.mes(N, `The ${LOOKOUT} is just west of here, among the old stones. Go and see what left those tracks.`);
    return s.close3();
  }
  if (s.isbegin_quest(Q.LOOKOUT) === 2) {
    s.mes(N, "Tumhogs, then. Tamsin's been cursing them all season.", "Good work out there, climber.");
    return s.close3();
  }
  s.mes(N, "This is the plains watch post. From up here I can see all the way to Hearthmoor's walls.",
    "Mira promised me a crate of tonics days ago... If you see her, remind her, would you?");
  return s.close3();
};

/** OnTouch (trigger 4x4): she spots the crate. */
export const rangerVessaTouch: NpcScript = async (s) => {
  if (s.isbegin_quest(Q.CRATE) !== 1 || s.countitem(CRATE) === 0) return;
  s.emotion(ET.SURPRISE);
  s.npctalk("Ranger Vessa : Is that Mira's crate? Over here!", "", BC.SELF);
};

async function delivery(s: Script) {
  if (s.countitem(CRATE) < 1) {
    s.mes(N, "Mira's crate? You don't seem to have it. Did you drop it somewhere?", "Ask Mira, she always packs a spare.");
    return s.close3();
  }
  s.emotion(ET.THANKS);
  s.mes(N, "Mira's tonics! Finally! You have no idea how long my patrol's been running on muddy water.");
  await s.next();
  s.delitem(CRATE, 1);
  s.completequest(Q.CRATE);
  questReward(s, Q.CRATE);
  s.mes(N, "Here, for your trouble.", "...Hold on. Let me get a proper look at you.");
  await s.next();
  s.setquest(Q.STATS);
  if (questTasksDone(s, Q.STATS)) {
    s.mes(N, "Hm! You've already put your status points to work. Good. Most Fledglings forget.");
    await s.next();
    return finishStats(s);
  }
  s.mes(N, `You're carrying ^4d4dff${s.get("StatusPoint")} status points^000000 you haven't spent!`,
    "Every level gives you more. Unspent, they're worth nothing in a fight.");
  await s.next();
  s.cutin("tut_status", CUTIN.MIDDLE_WINDOW);
  s.mes("-! Info !-", "Open the ^4d4dffStatus^000000 window with ^4d4dffAlt+A^000000.",
    "Click the ^4d4dff+^000000 next to a stat to raise it: ^4d4dffSTR^000000 hits harder, ^4d4dffAGI^000000 attacks faster and dodges,",
    "^4d4dffVIT^000000 gives HP, ^4d4dffDEX^000000 makes you hit more often. Higher stats cost more points.");
  await s.next();
  face(s);
  s.mes(N, "Go on, spend them. Then come back and we'll talk about real work.");
  return s.close3();
}

async function stats(s: Script) {
  if (!questTasksDone(s, Q.STATS)) {
    s.emotion(ET.FRET);
    s.mes(N, `You still have ^4d4dff${s.get("StatusPoint")}^000000 status points sitting there.`,
      "^4d4dffAlt+A^000000, then the ^4d4dff+^000000 buttons. Come back when they're spent.");
    return s.close3();
  }
  s.mes(N, "Better! You even stand differently now.");
  await s.next();
  return finishStats(s);
}

async function finishStats(s: Script) {
  if (!canCarryRewards(s, Q.STATS)) {
    s.mes(N, "Your bag's full. Make some room and come back.");
    return s.close3();
  }
  s.completequest(Q.STATS);
  questReward(s, Q.STATS);
  return offerEmbers(s);
}

async function offerEmbers(s: Script) {
  s.mes(N, "Now, real work. See the scorched patches in the grass? That's ^4d4dffSootcaps^000000.",
    "Fire-blooded pests. They carry live coals in them and leave burnt grass wherever they go.");
  await s.next();
  s.mes(N, `Put down ^4d4dff${FIRE_KILLS} fire-blooded pests^000000 and bring me ^4d4dff${COALS} Ember Coals^000000 from them.`,
    "Any fire monster counts. Check one's element by pointing at it.");
  if ((await s.select("Consider it done.", "Not yet.")) === 2) {
    s.clear();
    s.mes(N, "Suit yourself. The grass won't stop burning on its own.");
    return s.close3();
  }
  s.setquest(Q.EMBERS);
  s.clear();
  s.mes(N, `Sootcaps roam the grass ${EAST}, in the south meadow and up in the north meadow.`,
    "Mind the coals, they're hot.");
  return s.close3();
}

async function reportEmbers(s: Script) {
  s.mes(N, "Four Ember Coals, still glowing. And the smoke's thinning already. Nice work.");
  await s.next();
  if (!canCarryRewards(s, Q.EMBERS)) {
    s.mes(N, "Your bag's full. Make some room and come back.");
    return s.close3();
  }
  s.delitem(COAL, COALS);
  s.completequest(Q.EMBERS);
  questReward(s, Q.EMBERS);
  s.mes(N, "Take my old ^4d4dffGuard^000000. A shield for your free hand. Wear it, like Mira's hat.");
  await s.next();
  return sendToLookout(s);
}

async function sendToLookout(s: Script) {
  s.mes(N, "One more thing. Last night something big came crashing through the ^4d4dffold lookout^000000, west of here.",
    "I couldn't leave my post. Would you go and take a look?");
  s.setquest(Q.LOOKOUT);
  await s.next();
  s.mes(N, `It's the ring of old stones by the ${LOOKOUT}. Just walk in and have a look around.`);
  return s.close3();
}

/** questinfo: "?" while she is the next stop of a held quest, "!" when she has new work for you. */
export const RANGER_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.CRATE) === 1 },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.STATS) === 1 && questTasksDone(v, Q.STATS) },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => questReady(v, Q.EMBERS) },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.STATS) === 2 && v.isbegin_quest(Q.EMBERS) === 0 },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.EMBERS) === 2 && v.isbegin_quest(Q.LOOKOUT) === 0 },
];
