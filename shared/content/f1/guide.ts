// Floor 1 — Guide Lio, the newcomer's guide in Hearthmoor's plaza, where new climbers arrive (W01: the town is the hub). Written like an rAthena NPC script (compare
// npc/re/jobs/novice/novice.txt's tutorial guide and the Academy staff of npc/re/jobs/novice/academy.txt): cutin + paged
// mes / next, a select menu, quests through setquest / checkquest / completequest, rewards through getexp / Zeny / getitem,
// a collect quest checked with countitem / delitem, questinfo icons ("!" new work, "?" ready to report), an OnTouch greeting
// (npctalk + emotion, like the Academy's Wounded Swordsman) and expressions (guide_lio / _cheer / _think cutins).
// He opens Chapter 1 (Bloom Patrol, Gel Beads), hands the player on to Mira, hears the news at the end and sends the player to
// Warden Orrin's gate; in between he points at whatever step the chain is on.
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import { BC, CUTIN, ET, QMARK, QTYPE } from "../../rules/script.ts";
import { canCarryRewards, questReward } from "../functions.ts";
import { HUNT, Q, SPOT, chapter1Step, naviTo } from "./chapter1.ts";

export const Q_PATROL = Q.PATROL; // Bloom Patrol: defeat 5 Puddleblooms
export const Q_BEADS = Q.BEADS; // Gel Beads for the Plaza: bring 10 Gel Beads
const GEL = "Gel Bead";
const BEADS = 10;
const N = "[Guide Lio]";
const BLOOMS = naviTo("on the Verdant Plains", HUNT.blooms);
const MIRA = naviTo("Mira's stall", SPOT.merchant);
const face = (s: Script, mood: "" | "cheer" | "think" = "") => s.cutin(mood ? `guide_lio_${mood}` : "guide_lio", CUTIN.BOTTOM_RIGHT);

export const guideLio: NpcScript = async (s) => {
  face(s);
  // finished work comes first, like the quest NPCs of the original
  if (s.checkquest(Q.PATROL, "HUNTING") === 2) return reportPatrol(s);
  if (s.isbegin_quest(Q.BEADS) === 1 && s.countitem(GEL) >= BEADS) return reportBeads(s);
  if (s.isbegin_quest(Q.NEWS) === 1) return reportNews(s);
  if (s.get("f1_guide") === 0) {
    s.mes(N, "Whoa, a new face! Welcome to the ^4d4dffVerdant Floor^000000, the very first floor of the Tower.");
    await s.next();
    s.mes(N, "I'm Lio. I show new climbers the ropes before they head for the stairs.", "Come talk to me whenever you're not sure what to do next!");
    await s.next();
    s.set("f1_guide", 1);
  }
  for (;;) {
    s.mes(N, "So, what can I do for you?");
    const pick = await s.select("Where am I?", "Any work for me?", "Goodbye.");
    s.clear();
    if (pick === 1) await whereAmI(s);
    else if (pick === 2) return work(s);
    else {
      s.mes(N, "Take care out there!");
      return s.close3();
    }
  }
};

/** OnTouch (trigger 3x3 around him; a new character spawns inside it): call the newcomer over, like the Academy's Wounded
 *  Swordsman calls for help; later, a wave when he has news for you. */
export const guideLioTouch: NpcScript = async (s) => {
  if (s.get("f1_guide") === 0 && s.isbegin_quest(Q.PATROL) === 0) {
    s.emotion(ET.SURPRISE);
    s.npctalk("Guide Lio : Hey, newcomer! Over here!", "", BC.SELF);
  } else if (s.isbegin_quest(Q.NEWS) === 1) {
    s.emotion(ET.DELIGHT);
    s.npctalk("Guide Lio : You're back! Tell me everything!", "", BC.SELF);
  }
};

async function whereAmI(s: Script) {
  s.mes(N, "This is the ^4d4dffVerdant Floor^000000 of the Tower, the first of its hundred floors.",
    "Every floor has a rest town like Hearthmoor, hunting fields behind its gates, a dungeon, and a guardian watching the stairs up.");
  await s.next();
  s.mes(N, "Out the ^4d4dffwest gate^000000 lie the Verdant Plains, full of weak monsters. Perfect practice!",
    "The other gates lead to tougher fields: the east woods, the north highlands, and the mire to the south.",
    "^4d4dffMira^000000, right over there, sells tonics and buys whatever you bring back.");
  await s.next();
  s.mes("-! Info !-", "Click the ground to walk and click a monster to fight it.",
    "Press ^4d4dffInsert^000000 to sit down and recover faster.", "Press ^4d4dffAlt+U^000000 to open your quest log.");
  await s.next();
}

async function work(s: Script) {
  const patrol = s.isbegin_quest(Q.PATROL), beads = s.isbegin_quest(Q.BEADS);
  if (patrol === 0) return offerPatrol(s);
  if (patrol === 1) {
    s.mes(N, `The Puddleblooms are still out there, ${BLOOMS}.`, "Come back once you've beaten five of them!");
    return s.close3();
  }
  if (beads === 0) return offerBeads(s);
  if (beads === 1) {
    s.mes(N, `You have ^4d4dff${s.countitem(GEL)}^000000 of ${BEADS} Gel Beads so far.`, `Puddleblooms ${BLOOMS} drop them. Keep at it!`);
    return s.close3();
  }
  if (s.isbegin_quest(Q.THANKS) === 0) return sendToMira(s);
  return pointOn(s);
}

async function offerPatrol(s: Script) {
  s.mes(N, "Work? You bet! ^4d4dffPuddleblooms^000000 keep sliding up the road to the west gate.", "Squishy water-flowers... harmless alone, but there are dozens of them.");
  await s.next();
  s.mes(N, `Could you thin them out? Defeat ^4d4dff5 Puddleblooms^000000 ${BLOOMS}, then come back to me.`);
  if ((await s.select("Leave it to me!", "Maybe later.")) === 2) {
    s.clear();
    s.mes(N, "No rush. I'll be right here.");
    return s.close3();
  }
  s.setquest(Q.PATROL);
  s.clear();
  s.mes(N, "Great! I've written it in your quest log.", "Your progress shows on the right side of the screen. Click it and you'll walk straight there.");
  await s.next();
  s.mes("-! Info !-", "You received the quest ^4d4dff[Bloom Patrol]^000000.", "Open the quest log with ^4d4dffAlt+U^000000.");
  return s.close3();
}

async function reportPatrol(s: Script) {
  face(s, "cheer");
  s.mes(N, "You're back! The west road is already quieter. Nicely done!");
  await s.next();
  if (!canCarryRewards(s, Q.PATROL)) {
    s.mes(N, "Your bag is too full for your reward. Make some room and come back!");
    return s.close3();
  }
  s.completequest(Q.PATROL);
  questReward(s, Q.PATROL);
  face(s);
  s.mes(N, "Here, take these. A tonic or two helps when a fight goes badly.");
  await s.next();
  return offerBeads(s);
}

async function offerBeads(s: Script) {
  s.mes(N, "Now for something trickier. Puddleblooms leave ^4d4dffGel Beads^000000 behind, and Mira bottles her tonics with them.");
  await s.next();
  s.mes(N, `Bring me ^4d4dff${BEADS} Gel Beads^000000 and I'll make it worth your while.`,
    "While you're on it, the blooms will drop beads straight into your bag more often.");
  if ((await s.select("I'll gather them.", "Not now.")) === 2) {
    s.clear();
    s.mes(N, "Alright. Ask me again any time.");
    return s.close3();
  }
  s.setquest(Q.BEADS);
  s.clear();
  s.mes(N, "Thanks! Click the beads they drop to pick them up.", `You'll find plenty of Puddleblooms ${BLOOMS}.`);
  return s.close3();
}

async function reportBeads(s: Script) {
  face(s, "cheer");
  s.mes(N, `${BEADS} Gel Beads, sparkling clean! Mira's going to be thrilled.`);
  await s.next();
  if (!canCarryRewards(s, Q.BEADS)) {
    s.mes(N, "Your bag is too full for your reward. Make some room and come back!");
    return s.close3();
  }
  s.delitem(GEL, BEADS);
  s.completequest(Q.BEADS);
  questReward(s, Q.BEADS);
  s.setquest(Q.THANKS);
  face(s);
  s.mes(N, "Here's your share. You're a real climber now!");
  await s.next();
  s.mes(N, `Oh! Mira wants to thank you herself. Go and see her ${MIRA}, right across the plaza.`);
  return s.close3();
}

/** The beads are done but the hand-over to Mira never happened (an old save): give it now. */
async function sendToMira(s: Script) {
  s.setquest(Q.THANKS);
  s.mes(N, `Mira has been asking about you. Go and see her ${MIRA}, she wants to thank you herself.`);
  return s.close3();
}

/** Lio knows the whole chapter: he points at the step the character is on. */
async function pointOn(s: Script) {
  const step = chapter1Step(s);
  const at = step?.id;
  if (at === undefined) {
    s.mes(N, "You've done everything this floor's fields can teach you. I'm proud of you!",
      `Warden Orrin at the ${naviTo("south gate", SPOT.warden)} keeps the road to the Sunken Mire and what lies under it.`);
    return s.close3();
  }
  if (at === Q.THANKS || at === Q.DRESSED) s.mes(N, `Mira is waiting for you ${MIRA}.`);
  else if (at === Q.CRATE && step!.state === 0) s.mes(N, `Mira had another favour to ask you ${MIRA}.`);
  else if (at <= Q.EMBERS) s.mes(N, `Ranger Vessa keeps watch ${naviTo("on the Verdant Plains", SPOT.ranger)}, out the west gate. She's counting on you!`);
  else if (at === Q.LOOKOUT) {
    face(s, "think");
    s.mes(N, `Something trampled the ${naviTo("old lookout", SPOT.lookout)}? Hmm... go and look, but mind your step.`);
  } else if (at <= Q.PESTS) s.mes(N, `Herbalist Tamsin camps ${naviTo("by the lake", SPOT.herbalist)} on the Verdant Plains. She knows every plant on this floor.`);
  else s.mes(N, `Warden Orrin keeps the ${naviTo("south gate", SPOT.warden)}. Show him what you've learned!`);
  return s.close3();
}

async function reportNews(s: Script) {
  face(s, "think");
  s.mes(N, "Tumhogs trampling the old lookout, brambles, and Tamsin's herb beds dug up?", "And you sorted all of it out?");
  await s.next();
  face(s, "cheer");
  s.mes(N, "Then the fields are in good hands. You've grown a lot since you got here!");
  await s.next();
  if (!canCarryRewards(s, Q.NEWS)) {
    s.mes(N, "Your bag is too full for your reward. Make some room and come back!");
    return s.close3();
  }
  s.completequest(Q.NEWS);
  questReward(s, Q.NEWS);
  s.setquest(Q.GATE);
  face(s);
  s.mes(N, "That ^4d4dffHoming Feather^000000 takes you straight back to your save point, wherever you are.");
  await s.next();
  s.mes(N, "You're ready for more than the plains. Warden Orrin keeps the ^4d4dffsouth gate^000000, where the hard roads of this floor begin.",
    `He decides who is ready for them. Go and introduce yourself: ${naviTo("south gate", SPOT.warden)}.`);
  return s.close3();
}

/** questinfo: "?" when a task is ready to report, "!" when he has new work for you. */
export const GUIDE_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.checkquest(Q.PATROL, "HUNTING") === 2 },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.BEADS) === 1 && v.countitem(GEL) >= BEADS },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.NEWS) === 1 },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.PATROL) === 0 },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.PATROL) === 2 && v.isbegin_quest(Q.BEADS) === 0 },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.BEADS) === 2 && v.isbegin_quest(Q.THANKS) === 0 },
];
