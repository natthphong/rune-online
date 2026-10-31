// Floor 1 — Herbalist Tamsin on the lake shore of the Verdant Plains, south of the old lookout. She teaches two habits by having you do them (Rest and
// Recover: drink her Herb Tea from the shortcut bar, like the Academy staff's "drink the apple juice I gave you" countitem(531)
// check, then sit with Insert until HP is full, checked with the Hp / MaxHp params; the F12 shortcut lesson of Instructor Brade,
// npc/re/jobs/novice/novice.txt, explained on a tutorial page) and sends you after the pests of her herb beds: a quest with two
// kill objectives (Tumhog x5, Loambloom x2). Then back to Guide Lio with the news.
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import { BC, CUTIN, ET, QMARK, QTYPE } from "../../rules/script.ts";
import { canCarryRewards, questReady, questReward, questTasksDone } from "../functions.ts";
import { HUNT, Q, SPOT, naviTo } from "./chapter1.ts";

const N = "[Herbalist Tamsin]";
const TEA = "Herb Tea";
const TUMHOGS = naviTo("Tumhog thickets", HUNT.tumhogs);
const LIO = naviTo("Hearthmoor plaza", SPOT.guide);
const face = (s: Script) => s.cutin("herbalist_tamsin", CUTIN.BOTTOM_RIGHT);

export const herbalistTamsin: NpcScript = async (s) => {
  face(s);
  if (s.isbegin_quest(Q.TRAIL) === 1) return meet(s);
  if (s.isbegin_quest(Q.REST) === 1) return rest(s);
  if (questReady(s, Q.PESTS)) return reportPests(s);
  if (s.isbegin_quest(Q.REST) === 2 && s.isbegin_quest(Q.PESTS) === 0) return offerPests(s);
  if (s.isbegin_quest(Q.PESTS) === 1) {
    s.mes(N, "Five Tumhogs and two Loamblooms, dear. The Tumhogs root in the thickets west of my lake,",
      `the Loamblooms stand in the Whisperwood, east of Hearthmoor. ${TUMHOGS}`);
    return s.close3();
  }
  if (s.isbegin_quest(Q.PESTS) === 2) {
    s.mes(N, "My beds are green again, thanks to you. Mind the brambles on your way out!");
    return s.close3();
  }
  s.mes(N, "Mind the beds, dearie. Those are moonwort seedlings.",
    "If you ever come across herbs tied with lavender string, they're mine. I drop them all over this floor.");
  return s.close3();
};

/** OnTouch (trigger 4x4): she recognises her herbs. */
export const herbalistTamsinTouch: NpcScript = async (s) => {
  if (s.isbegin_quest(Q.TRAIL) !== 1) return;
  s.emotion(ET.SURPRISE);
  s.npctalk("Herbalist Tamsin : Goodness, are those my herbs?", "", BC.SELF);
};

async function meet(s: Script) {
  s.mes(N, "My herb bundle! I dropped it running from those beasts last night. Thank you, dear.");
  await s.next();
  s.emotion(ET.SWEAT);
  s.mes(N, "Oh, but you're all scratched up. That's my bramble snare, I set them around the lookout to keep the beasts off my beds.",
    "Here, sit down and drink this. Tamsin's own Herb Tea.");
  await s.next();
  if (!s.checkweight(TEA, 1)) {
    s.mes(N, "Your bag is too full for even a cup of tea! Make some room and come back.");
    return s.close3();
  }
  s.completequest(Q.TRAIL);
  s.getitem(TEA, 1);
  s.setquest(Q.REST);
  s.cutin("tut_hotkey", CUTIN.MIDDLE_WINDOW);
  s.mes("-! Info !-", "Drag the ^4d4dffHerb Tea^000000 from your items (^4d4dffAlt+E^000000) onto the ^4d4dffshortcut bar^000000 at the bottom of the screen.",
    "Press its key to use it: ^4d4dffF1^000000 for the first slot, ^4d4dffF2^000000 for the next. Tonics work the same way.");
  await s.next();
  s.cutin("tut_sit", CUTIN.MIDDLE_WINDOW);
  s.mes("-! Info !-", "Press ^4d4dffInsert^000000 to sit down. Sitting recovers HP and SP twice as fast.",
    "Press ^4d4dffInsert^000000 again to stand up. You can't walk while sitting.",
    "Sitting takes ^4d4dffBasic Training Lv 3^000000: open your Skill window (^4d4dffAlt+S^000000) and spend your skill points with ^4d4dff+^000000.");
  await s.next();
  face(s);
  s.mes(N, "Drink up, then sit and rest until you're whole again. Then we'll talk about those tracks.");
  return s.close3();
}

async function rest(s: Script) {
  if (!questTasksDone(s, Q.REST)) {
    s.emotion(ET.SWEAT);
    if (s.countitem(TEA) > 0) s.mes(N, "Drink your tea first, dear! Put it on your shortcut bar and press its key, F1 for the first slot.");
    else if (s.getskilllv("NV_BASIC") < 3) s.mes(N, "You'll want to sit, and that takes ^4d4dffBasic Training Lv 3^000000. Open your Skill window with ^4d4dffAlt+S^000000 and put your points in.");
    else s.mes(N, `Still pale! Sit down with ^4d4dffInsert^000000 and rest until you're whole again. (HP ${s.get("Hp")} / ${s.get("MaxHp")})`);
    return s.close3();
  }
  s.mes(N, "There's colour in your cheeks again. Nothing beats a cup of tea and a sit-down.");
  await s.next();
  if (!canCarryRewards(s, Q.REST)) {
    s.mes(N, "Your bag is too full, dear. Make some room and come back.");
    return s.close3();
  }
  s.completequest(Q.REST);
  questReward(s, Q.REST);
  s.mes(N, "Take some Red Herbs for the road. Chew one when a fight goes sour.");
  await s.next();
  return offerPests(s);
}

async function offerPests(s: Script) {
  s.mes(N, "Now, those tracks at the lookout. Split hooves, deep in the mud... Tumhogs!",
    "They root up my herb beds every night, and the Loamblooms from the far woods choke whatever's left.");
  await s.next();
  s.mes(N, "Could you drive them off? ^4d4dff5 Tumhogs^000000 and ^4d4dff2 Loamblooms^000000 should teach the rest a lesson.");
  if ((await s.select("I'll protect your herbs.", "Maybe later.")) === 2) {
    s.clear();
    s.mes(N, "Of course, dear. The beds have survived worse.");
    return s.close3();
  }
  s.setquest(Q.PESTS);
  s.clear();
  s.mes(N, `Tumhogs root in the ${TUMHOGS} west of my lake; Loamblooms stand in the Whisperwood, out Hearthmoor's east gate.`,
    "They're tougher than the blooms by the road. Keep a tonic on your shortcut bar!");
  return s.close3();
}

async function reportPests(s: Script) {
  s.emotion(ET.DELIGHT);
  s.mes(N, "Not a single Tumhog in my beds last night! You've a gift, dear.");
  await s.next();
  if (!canCarryRewards(s, Q.PESTS)) {
    s.mes(N, "Your bag is full. Make some room and come back.");
    return s.close3();
  }
  s.completequest(Q.PESTS);
  questReward(s, Q.PESTS);
  s.setquest(Q.NEWS);
  s.mes(N, `Now go and tell young Lio in the ${LIO}. He worries about every new climber like a mother hen.`);
  return s.close3();
}

/** questinfo: "?" while she is the next stop of a held quest, "!" when she has new work for you. */
export const HERBALIST_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.TRAIL) === 1 },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.REST) === 1 && questTasksDone(v, Q.REST) },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => questReady(v, Q.PESTS) },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.REST) === 2 && v.isbegin_quest(Q.PESTS) === 0 },
];
