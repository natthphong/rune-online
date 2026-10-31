// Floor 1 — Forgemaster Brann, Hearthmoor's refiner (next to Garrow's Arms). Ported line by line from rAthena's refiner
// (npc/merchants/refine.txt `refinemain`, with the metal salesman Christopher's purify menu of the same file): pick a worn piece, hear
// the ore and fee, get the "it could be destroyed" warning when the chance is below 100, pay, then successrefitem / failedrefitem.
// Chances, fees and ores are refine.yml's Normal rows (shared/rules/refine.ts); a failure destroys the piece and its cards, like
// the original at these levels. Up to +10: the +11 and up refiner (Carnium / Bradium ores) is not part of this game yet.
// Brann also sells the ores (Rough Ore, Bright Ore, Forgesteel, Starsteel) so the crafting loop closes inside the town, and
// purifies 5 Forgesteel / Starsteel Chunks into one ore (Christopher's "Purify Rough Ores").
import type { NpcScript, Script } from "../api.ts";
import { CALLSHOP, ET } from "../../rules/script.ts";
import { ITEMS, type EquipSlot } from "../../rules/items.ts";
import { REFINE_COST, NPC_MAX_REFINE } from "../../rules/refine.ts";

export const BRANN_ORE_SHOP = "town_ore_shop";
export const ORES = ["Rough Ore", "Bright Ore", "Forgesteel", "Starsteel"] as const;
/** EQI order of refinemain's .@indices that this game has (head top, armor, shield, weapon, garment, shoes, head mid, head low). */
const PARTS: [EquipSlot, string][] = [["headTop", "Upper Head"], ["armor", "Armor"], ["shield", "Shield"], ["weapon", "Weapon"], ["garment", "Garment"], ["shoes", "Shoes"], ["headMid", "Middle Head"], ["headLow", "Lower Head"]];
const N = "[Forgemaster Brann]";
const PURIFY = 5; // rough stones per ore

const rand = (n: number) => Math.floor(Math.random() * n); // rand(n): 0..n-1
const comma = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); // F_InsertComma

export const forgemasterBrann: NpcScript = async (s) => {
  s.mes(N, "Welcome to the forge. Bring me a piece you're wearing and the right ore, and I'll temper it.", "Or tell me what else you need.");
  await s.next();
  switch (await s.select("Refine my equipment", "Buy ore", "Purify rough stones", "Cancel")) {
    case 1: return refine(s);
    case 2:
      s.mes(N, "Good ore, honest prices.");
      await s.close2();
      s.callshop(BRANN_ORE_SHOP, CALLSHOP.BUY);
      return s.end();
    case 3: return purify(s);
  }
  return s.close();
};

// Christopher's case 4: five rough stones make one ore
async function purify(s: Script) {
  s.mes(N, `I make one refined ore out of ${PURIFY} rough chunks. Which one do you want?`);
  await s.next();
  const pick = await s.select("Make Forgesteel", "Make Starsteel", "Cancel");
  const [stone, ore] = pick === 1 ? ["Forgesteel Chunk", "Forgesteel"] : ["Starsteel Chunk", "Starsteel"];
  if (pick === 3) { s.mes(N, "Come back whenever you need."); return s.close(); }
  if (s.countitem(stone) < PURIFY) { s.mes(N, `I told you, I need ${PURIFY} ${stone}s for one ${ore}.`); return s.close(); }
  if (!s.checkweight(ore, 1)) { s.mes(N, "Your pack has no room for it. Make some space first."); return s.close(); }
  s.delitem(stone, PURIFY);
  s.getitem(ore, 1);
  s.mes(N, `Here is a ${ore} for you.`);
  return s.close();
}

// refinemain
async function refine(s: Script) {
  s.mes(N, "I'm the armsmith. I can refine any weapon or armor you wear.", "Which piece shall I look at?");
  await s.next();
  // empty entries are hidden but keep their number; a two-hander fills both hands and is listed once, as the weapon
  const menu = PARTS.map(([part, label]) => {
    if (!s.getequipisequiped(part) || (part === "shield" && s.getequipid("weapon") === s.getequipid("shield"))) return "";
    return `${label} - [${s.getequipname(part)}]`;
  });
  if (menu.every((m) => !m)) { s.mes(N, "I don't think I can refine anything you have..."); return s.close(); }
  const part = PARTS[(await s.select(...menu)) - 1][0];
  if (!s.getequipisequiped(part)) { s.mes(N, "You're not wearing anything there that I can refine."); s.emotion(ET.FRET); return s.close(); }
  if (!s.getequipisenableref(part)) { s.mes(N, "I don't think I can refine this item at all..."); return s.close(); }
  const level = s.getequiprefinerycnt(part);
  if (level >= NPC_MAX_REFINE) { s.mes(N, "I can't refine this any more. This is as refined as it gets!"); return s.close(); }
  const itemId = s.getequipid(part);
  const price = s.getequiprefinecost(part, REFINE_COST.ZENY), material = s.getequiprefinecost(part, REFINE_COST.MATERIAL_ID);
  if (!material) { s.mes(N, "That one needs an ore I don't have here."); return s.close(); }
  const ore = oreName(material);
  const weapon = s.getequipweaponlv(part) > 0;
  s.mes(N, `To refine this I need one ^003366${ore}^000000 and a service fee of ^003366${comma(price)}^000000 zeny.`, "Do you really wish to continue?");
  await s.next();
  if ((await s.select("Yes", "No")) === 2) { s.mes(N, "Yeah... there's no need to rush. Take your time."); return s.close(); }
  if (s.getequippercentrefinery(part) < 100) {
    s.mes(N, "Oh no! If I continue to refine this, there's a risk it could", weapon ? "be destroyed, and you'd ^FF0000lose the weapon^000000, any ^FF0000cards in it^000000," : "be destroyed! That means that ^FF0000this equipment^000000, and ^FF0000any cards^000000",
      "or any added special properties.");
    await s.next();
    s.mes(N, "I can't make it any clearer.", `Once ${weapon ? "a weapon" : "a piece of armor"} is destroyed, there's no getting it back.`, "Do you still want to refine?");
    await s.next();
    if ((await s.select("Yes", "No")) === 2) { s.mes(N, "I completely agree... I might be a great refiner, but sometimes even I make mistakes."); return s.close(); }
  }
  if (s.countitem(material) < 1 || s.get("Zeny") < price) {
    s.mes(N, `You don't seem to have enough zeny or ${ore}...`, "Go get some more. I'll be here all day if you need me.");
    return s.close();
  }
  s.set("Zeny", s.get("Zeny") - price);
  s.delitem(material, 1);
  // anti-hack (F_IsEquipIDHack / F_IsEquipRefineHack): the piece must still be the one that was quoted
  if (s.getequipid(part) !== itemId || s.getequiprefinerycnt(part) !== level) {
    s.mes(N, "Wait a second... Do you think I'm stupid?!", "You switched the item while I wasn't looking! Get out of here!");
    s.emotion(ET.FRET);
    return s.close();
  }
  if (s.getequippercentrefinery(part) <= rand(100)) {
    s.failedrefitem(part);
    s.emotion(rand(5) ? ET.HUK : ET.MONEY);
    s.mes(N, ["OH! MY GOD! Damn it! Not again! I'm terribly sorry, but practice makes perfect. Um, right? Heh heh...",
      "Nooooooo! It broke! I-I'm sorry!", "Crap! It couldn't take much more tempering! Sorry about this..."][rand(3)]);
    return s.close();
  }
  s.successrefitem(part);
  s.emotion(ET.SMILE);
  s.mes(N, ["Perfect! Heh heh! Once again, flawless work from the master~",
    "Success...! Yet again, my talent truly shines today.", "Heh heh! I'm all done. No doubt, my work is to your satisfaction."][rand(3)]);
  return s.close();
}

/** The ore's item name for the dialog (the item id the refine table names). */
const oreName = (id: number) => ITEMS.get(id)?.name ?? "ore";
