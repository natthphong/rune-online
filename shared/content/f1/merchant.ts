// Floor 1 — Mira the Merchant. A talking shopkeeper like rAthena's Johanna (npc/re/merchants/eden_market.txt): a greeting,
// a select("Buy", "Sell", "Cancel") menu, then close2 + callshop "<floating shop>",1 / 2 opens the buy or the sell list of her
// floating shop (map "-", f1_mira_shop in npcs.ts). Quest steps come first: she thanks you for the Gel Beads with a Hat
// (Chapter 1: A Merchant's Thanks), checks that you wear it with isequipped (Dressed for the Climb, after Instructor Brade's
// equipment lesson in npc/re/jobs/novice/novice.txt) and sends a Supply Crate to Ranger Vessa (Tonics for the Watch).
// OnTouch: now and then she calls out her wares (npctalk bc_self, like the Rockridge bakery owner).
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import { BC, CALLSHOP, CUTIN, ET, QMARK, QTYPE } from "../../rules/script.ts";
import { canCarryRewards, questReward, questTasksDone } from "../functions.ts";
import { NPC, Q, SPOT, naviTo } from "./chapter1.ts";

const N = "[Mira]";
const CRATE = "Supply Crate";
const VESSA = naviTo("watch post", SPOT.ranger);
const face = (s: Script) => s.cutin("mira", CUTIN.BOTTOM_RIGHT);

export const miraMerchant: NpcScript = async (s) => {
  face(s);
  if (s.isbegin_quest(Q.THANKS) === 1) return thanks(s);
  if (s.isbegin_quest(Q.DRESSED) === 1 && questTasksDone(s, Q.DRESSED)) return dressed(s);
  if (s.isbegin_quest(Q.DRESSED) === 2 && s.isbegin_quest(Q.CRATE) === 0) return offerCrate(s);
  if (s.isbegin_quest(Q.CRATE) === 1 && s.countitem(CRATE) === 0) return newCrate(s);
  s.mes(N, "Welcome, welcome! Tonics, feathers, a sturdy blade for the road...", "What'll it be, dear?");
  if (s.isbegin_quest(Q.DRESSED) === 1) s.mes("And do put on that ^4d4dffHat^000000 I gave you! ^4d4dffAlt+E^000000, then double-click it.");
  switch (await s.select("Buy", "Sell", "Cancel")) {
    case 1:
      s.clear();
      s.mes(N, "Take your time, dear. Everything's fresh!");
      await s.close2();
      s.cutin("", CUTIN.CLEAR);
      s.callshop(NPC.miraShop, CALLSHOP.BUY);
      return s.end();
    case 2:
      s.clear();
      s.mes(N, "Let's see what you've dragged out of the fields!");
      await s.close2();
      s.cutin("", CUTIN.CLEAR);
      s.callshop(NPC.miraShop, CALLSHOP.SELL);
      return s.end();
    default:
      s.clear();
      s.mes(N, "Come back any time!");
      return s.close3();
  }
};

/** OnTouch (trigger 3x3): a sales call now and then. */
export const miraTouch: NpcScript = async (s) => {
  if (Math.random() >= 0.35) return;
  const lines = ["Tonics! Fresh tonics!", "Blink Feathers! Lost in the fields? Hop somewhere else!", "Selling your loot? Mira pays fair!"];
  s.npctalk(`Mira : ${lines[Math.floor(Math.random() * lines.length)]}`, "", BC.SELF);
};

async function thanks(s: Script) {
  s.emotion(ET.DELIGHT);
  s.mes(N, "There you are! Ten Gel Beads, every one of them sparkling. That's a whole batch of tonics!");
  await s.next();
  s.mes(N, "A climber needs a proper hat. This one kept my head dry through three rainy seasons.", "Go on, it's yours.");
  await s.next();
  if (!canCarryRewards(s, Q.THANKS)) {
    s.mes(N, "Oh dear, your bag is stuffed full. Make some room and come back!");
    return s.close3();
  }
  s.completequest(Q.THANKS);
  questReward(s, Q.THANKS);
  s.setquest(Q.DRESSED);
  s.cutin("tut_equip", CUTIN.MIDDLE_WINDOW);
  s.mes("-! Info !-", "Gear in your bag does nothing until you wear it.",
    "Open your items with ^4d4dffAlt+E^000000 and ^4d4dffdouble-click^000000 the Hat to put it on.",
    "What you wear is listed in the Equipment window (^4d4dffAlt+Q^000000).");
  await s.next();
  face(s);
  s.mes(N, "Try it on, then come and show me!");
  return s.close3();
}

async function dressed(s: Script) {
  s.emotion(ET.DELIGHT);
  s.mes(N, "Oh, look at you! Now you look like a real climber.");
  await s.next();
  if (!canCarryRewards(s, Q.DRESSED)) {
    s.mes(N, "Your bag is full, dear. Make some room and come back!");
    return s.close3();
  }
  s.completequest(Q.DRESSED);
  questReward(s, Q.DRESSED);
  s.mes(N, "A few Red Tonics, on the house. Put them on your shortcut bar, you'll be glad you did.");
  await s.next();
  return offerCrate(s);
}

async function offerCrate(s: Script) {
  s.mes(N, "Now, one more favour. ^4d4dffRanger Vessa^000000 watches the Verdant Plains from her post past the west gate.",
    "She's been waiting all week for a crate of my tonics.");
  await s.next();
  s.mes(N, "Would you carry it to her?");
  if ((await s.select("I'll take it to her.", "Not right now.")) === 2) {
    s.clear();
    s.mes(N, "Alright. It'll be right here when you're ready.");
    return s.close3();
  }
  s.clear();
  if (!s.checkweight(CRATE, 1)) {
    s.mes(N, "Your bag is too full to take the crate. Make some room first!");
    return s.close3();
  }
  s.getitem(CRATE, 1);
  s.setquest(Q.CRATE);
  s.mes(N, `Here it is. Out the west gate, past the Puddlebloom meadow, and north: you'll find Vessa at the ${VESSA}.`,
    "Tell her Mira says hello!");
  return s.close3();
}

/** The crate quest is held but the crate is gone (sold, dropped...): she packs another, like the Sailor's repair quest re-gives. */
async function newCrate(s: Script) {
  s.emotion(ET.SWEAT);
  s.mes(N, "You lost the crate? Oh, never mind, I packed a spare.");
  if (!s.checkweight(CRATE, 1)) {
    s.mes(N, "...but your bag is too full. Make some room and come back!");
    return s.close3();
  }
  s.getitem(CRATE, 1);
  s.mes(N, `Ranger Vessa is at the ${VESSA}. Off you go!`);
  return s.close3();
}

/** questinfo: "?" while she has something for you on a held quest, "!" when she has a new favour. */
export const MERCHANT_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.THANKS) === 1 },
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.DRESSED) === 1 && questTasksDone(v, Q.DRESSED) },
  { icon: QTYPE.QUEST, color: QMARK.YELLOW, condition: (v) => v.isbegin_quest(Q.DRESSED) === 2 && v.isbegin_quest(Q.CRATE) === 0 },
];
