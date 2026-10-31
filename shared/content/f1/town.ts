// Floor 1 — Hearthmoor, the floor's rest town (C08). No monsters. The Hearthkeeper keeps the climbers' save point (rAthena's
// Kafra "Save" service: npc/kafras/functions_kafras.txt F_KafraSave -> savepoint) and a fireside heal (the town healers of
// npc/re/other/healer.txt: free for Novices, a small fee for everyone else, percentheal 100,100). The Drillmaster finishes the
// Fledgling's training (the Novice Training Grounds' skill lesson: spend every job level's skill point on Basic Training, up to
// Lv 9, which F_CanChangeJob requires) and hands over "A Calling". Two townsfolk give side work (a talk errand, a field hunt).
// W01: Hearthmoor is the floor's hub: new climbers start here, and a gate on each side leads to a field (shared/maps.ts WARPS).
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import { ET, QMARK, QTYPE } from "../../rules/script.ts";
import { MAPID } from "../../rules/status.ts";
import { canCarryRewards, questReady, questReward, questTasksDone } from "../functions.ts";
import { TOWN, TOWN_SAVE } from "../../maps.ts";
import { TOWN_CELLS } from "../../town.ts";
import { HUNT, Q, naviTo } from "./chapter1.ts";
import { CALLING, CAMP } from "./jobs.ts";

/** Hearthmoor's quests: the Main steps after Chapter 1 (1016-1017, then C04's "A Calling" 1015) and the town's side work. */
export const TQ = { HEARTH: 1016, LESSON: 1017, DINNER: 1101, SOOT: 1102 } as const;
/** Where the town's NPCs stand on f1_town01 (57x57, W01 r2: shared/town.ts, each at its building's door: the hearth chapel, the
 *  shops, the inn, the woodpile, the training yard). Guide Lio, Mira and Warden Orrin stand there too (f1/chapter1.ts SPOT), the
 *  guild masters in the guild hall's courtyard (f1/jobs.ts). */
export const TOWN_SPOT = {
  hearthkeeper: { x: TOWN_SAVE.x, y: TOWN_SAVE.y - 2 }, tools: TOWN_CELLS.tools, arms: TOWN_CELLS.arms, refiner: TOWN_CELLS.refiner,
  drillmaster: TOWN_CELLS.drillmaster, pella: TOWN_CELLS.pella, garr: TOWN_CELLS.garr, merrit: TOWN_CELLS.merrit,
} as const;
export const TOWN_NPC = {
  hearthkeeper: "npc_hearthkeeper", tools: "town_tools", arms: "town_arms", refiner: "npc_refiner", drillmaster: "npc_drillmaster",
  pella: "npc_pella", garr: "npc_garr", merrit: "npc_merrit",
} as const;
/** The heal fee for climbers past the Fledgling job (healer.txt charges everyone; our Novices rest for free). */
export const HEAL_FEE = 50;
const isNovice = (s: Pick<Script, "get">) => s.get("BaseJob") === MAPID.Novice;
const FIELD_HUNT = naviTo("Whisperwood", HUNT.woods);

// ---------- Hearthkeeper Bren: save point, fireside heal, the first stop in town (Main 1016) ----------
const B = "[Hearthkeeper Bren]";
export const hearthkeeper: NpcScript = async (s) => {
  if (s.isbegin_quest(TQ.HEARTH) === 1) {
    s.mes(B, "Ah, Orrin's climber! He sent word from the south gate. Welcome to the fire of ^4d4dffHearthmoor^000000.",
      "Warm beds, a fire that never goes out, and a shop or two. Your hearth is here: should you fall out there,",
      "you'll wake beside this fire instead of in the fields. You can always come back and set it again.");
    await s.next();
    if (!canCarryRewards(s, TQ.HEARTH)) { s.mes(B, "Your pack's too full for a welcome gift. Lighten it and come back."); return s.close(); }
    s.completequest(TQ.HEARTH);
    questReward(s, TQ.HEARTH);
    if (s.isbegin_quest(CALLING) === 0 && s.isbegin_quest(TQ.LESSON) === 0) {
      s.setquest(TQ.LESSON);
      s.mes(B, "One more thing: the ^4d4dffDrillmaster^000000 by the south-west corner of the plaza finishes every Fledgling's training.",
        "The guild masters won't look at you before she's done with you.");
      await s.next();
    }
  } else {
    s.mes(B, "Welcome back to the fire, climber. What will it be?");
    await s.next();
  }
  const c = await s.select("Set my hearth here", "Rest by the fire", "Cancel");
  if (c === 1) {
    s.savepoint(TOWN, TOWN_SAVE.x, TOWN_SAVE.y); // F_KafraSave
    s.mes(B, "Done. Your ^4d4dffsave point^000000 is Hearthmoor now. Mind how you go.");
    return s.close();
  }
  if (c === 2) {
    if (!isNovice(s)) {
      if (s.get("Zeny") < HEAL_FEE) { s.mes(B, `A seat by the fire is ^4d4dff${HEAL_FEE} zeny^000000 for a guild climber. Come back with the coin.`); return s.close(); }
      s.set("Zeny", s.get("Zeny") - HEAL_FEE);
    }
    s.percentheal(100, 100);
    s.emotion(ET.SMILE);
    s.mes(B, isNovice(s) ? "Sit, sit. Fledglings rest for free at my fire." : "There. Good as new.");
    return s.close();
  }
  return s.close();
};
export const HEARTHKEEPER_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(TQ.HEARTH) === 1 },
];

// ---------- Drillmaster Kessa: the Fledgling's last lesson (Main 1017) -> "A Calling" ----------
const D = "[Drillmaster Kessa]";
export const drillmaster: NpcScript = async (s) => {
  const lesson = s.isbegin_quest(TQ.LESSON);
  if (lesson === 1 && !questTasksDone(s, TQ.LESSON)) {
    s.mes(D, "So Bren sent you. Good. Every Job Level a Fledgling earns gives one ^4d4dffskill point^000000.",
      "Open the Skill window (^4d4dffAlt+S^000000) and put them all into ^4d4dffBasic Training^000000: it takes nine.");
    await s.next();
    s.mes(D, `Right now: Job Lv ^4d4dff${s.get("JobLevel")}^000000, Basic Training Lv ^4d4dff${s.getskilllv("NV_BASIC")}^000000.`,
      `Reach ^4d4dffJob Lv 10^000000 and ^4d4dffBasic Training Lv 9^000000. Hunting earns Job EXP: try the ${FIELD_HUNT} out past the east gate.`);
    return s.close3();
  }
  if (lesson === 1) {
    if (!canCarryRewards(s, TQ.LESSON)) { s.mes(D, "Your pack's full. Make room for your reward first."); return s.close3(); }
    s.emotion(ET.BEST);
    s.completequest(TQ.LESSON);
    questReward(s, TQ.LESSON);
    s.mes(D, "Basic Training Lv 9, Job Lv 10. That's a finished Fledgling. Well done.");
    await s.next();
    if (s.isbegin_quest(CALLING) === 0) s.setquest(CALLING);
    s.mes(D, "Now choose a real job. The six guild masters keep the guild row, south-east of the plaza.",
      `Talk to any of them and pass their test. ${naviTo("Guild row", { map: TOWN, ...CAMP.center })}`);
    return s.close();
  }
  s.mes(D, isNovice(s) ? "Keep your Basic Training up and your tonics close, Fledgling." : "A guild climber now. Don't forget your Skill window: every job level is another point.");
  return s.close();
};
export const DRILLMASTER_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(TQ.LESSON) === 1 && questTasksDone(v, TQ.LESSON) },
];

// ---------- Pella the cook: "Dinner Bell" (side, talk errand to Garr) ----------
const P = "[Pella]";
export const pella: NpcScript = async (s) => {
  const q = s.isbegin_quest(TQ.DINNER);
  if (q === 0) {
    s.mes(P, "Stew's on, and that great lump of a woodcutter is still out by the north street chopping.",
      "Would you tell ^4d4dffGarr^000000 his dinner's ready? My legs aren't what they were.");
    const c = await s.select("I'll tell him.", "Not now.");
    if (c !== 1) { s.mes(P, "Suit yourself, dear."); return s.close(); }
    s.setquest(TQ.DINNER);
    s.mes(P, "Bless you. He's just up the north street, past the plaza.");
    return s.close();
  }
  s.mes(P, q === 1 ? "Found Garr yet? North street, past the plaza. Follow the sound of the axe." : "The stew? Secret's a pinch of ember salt. Don't tell Bren.");
  return s.close();
};
export const PELLA_QUESTINFO: QuestInfo[] = [
  // offered to climbers who walked the road (Chapter 1 done), like the level-gated "!" of the town quest givers
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.PROVEN) === 2 && v.isbegin_quest(TQ.DINNER) === 0 },
];

// ---------- Woodcutter Garr: takes Pella's message, then "Sootcaps in the Woodpile" (side, kill) ----------
const G = "[Woodcutter Garr]";
export const garr: NpcScript = async (s) => {
  if (s.isbegin_quest(TQ.DINNER) === 1) {
    s.completequest(TQ.DINNER);
    questReward(s, TQ.DINNER);
    s.mes(G, "Dinner? Already? Ha! Thanks for the walk, climber. Here, for your trouble.");
    await s.next();
  }
  const q = s.isbegin_quest(TQ.SOOT);
  if (q === 0) {
    s.mes(G, "Mind, there's a real job if you want one. The ^4d4dffSootcaps^000000 on the plains crawl into my woodpile and rot it.",
      `Thin out six of them and I'll pay you. ${naviTo("Verdant Plains", HUNT.sootcaps)}`);
    const c = await s.select("I'll do it.", "Not now.");
    if (c !== 1) { s.mes(G, "Offer stands."); return s.close(); }
    s.setquest(TQ.SOOT);
    s.mes(G, "Good. Six Sootcaps. Out the west gate, they're all over the plains.");
    return s.close();
  }
  if (q === 1 && !questReady(s, TQ.SOOT)) {
    s.mes(G, "Still Sootcaps in my woodpile. Six, I said.");
    return s.close();
  }
  if (q === 1) {
    if (!canCarryRewards(s, TQ.SOOT)) { s.mes(G, "Your pack's full. Make room."); return s.close(); }
    s.completequest(TQ.SOOT);
    questReward(s, TQ.SOOT);
    s.emotion(ET.BEST);
    s.mes(G, "Six! The woodpile thanks you, and so do I.");
    return s.close();
  }
  s.mes(G, "The wood's dry, the fire's hot. Good days.");
  return s.close();
};
export const GARR_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(TQ.DINNER) === 1 },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => questReady(v, TQ.SOOT) },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(TQ.DINNER) === 2 && v.isbegin_quest(TQ.SOOT) === 0 },
];

// ---------- Old Merrit: a townsfolk with hints ----------
const M = "[Old Merrit]";
export const merrit: NpcScript = async (s) => {
  s.mes(M, "Eh? A new face. Let an old climber tell you three things.");
  await s.next();
  s.mes(M, "One: ^4d4dffBren^000000 by the fire sets your save point. Fall in the field and you wake here.",
    "Two: ^4d4dffTilda^000000 sells tonics, feathers and arrows; ^4d4dffGarrow^000000 sells blades and armour.",
    "Three: a ^4d4dffHoming Feather^000000 takes you back to your save point from anywhere. Keep one.");
  await s.next();
  s.mes(M, "And the gates: ^4d4dffwest^000000 to the gentle plains, ^4d4dffeast^000000 to the woods, ^4d4dffnorth^000000 up the crags,",
    "and ^4d4dffsouth^000000 to the Mire. Go west first, and south last.");
  return s.close();
};

/** Hearthmoor's shops (rAthena "shop" NPCs, opened by a click): the tool shop and the arms dealer. Mira's field stock split by type. */
export const toolStock = (items: { id: number; type: string }[]) => items.filter((i) => i.type === "Healing" || i.type === "DelayConsume" || i.type === "Ammo").map((i) => i.id);
export const armsStock = (items: { id: number; type: string }[]) => items.filter((i) => i.type === "Weapon" || i.type === "Armor").map((i) => i.id);
