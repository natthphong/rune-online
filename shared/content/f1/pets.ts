// 2.4.0 — Keeper Wren, Hearthmoor's beast keeper: explains pets (taming, eggs, hunger and loyalty, the three kinds), sells pet
// supplies through a floating shop (rAthena's pet shop NPCs: npc/merchants/shops.txt "Pet Groomer" stock, opened with callshop like
// Mira's wares), and gives every climber one starter egg through a short errand ("A Friend from the Plains", quest 1103). The egg
// comes from getitem on an egg item, which the server turns into a new pet (buildin_getitem -> pet_create_egg, server/src/pets.ts).
import type { NpcScript, QuestInfo } from "../api.ts";
import { CALLSHOP, QMARK, QTYPE } from "../../rules/script.ts";
import { canCarryRewards, questReady, questReward } from "../functions.ts";
import { TOWN } from "../../maps.ts";

export const PET_NPC = { keeper: "npc_beastkeeper", shop: "f1_pet_shop" } as const;
export const PET_SPOT = { keeper: { map: TOWN, x: 18, y: 27 } } as const;
/** "A Friend from the Plains": bring the keeper two Herb Teas (a Puddlebloom's favourite food), get a Puddlebloom egg. */
export const PQ = { STARTER: 1103 } as const;

const W = "[Keeper Wren]";
export const keeperWren: NpcScript = async (s) => {
  const q = s.isbegin_quest(PQ.STARTER);
  if (q === 1 && questReady(s, PQ.STARTER)) {
    s.mes(W, "Two Herb Teas! Smell that. Now hold out your hands, gently...");
    await s.next();
    if (!canCarryRewards(s, PQ.STARTER)) { s.mes(W, "Your pack is stuffed. Make room for an egg and come back."); return s.close(); }
    s.delitem("Herb Tea", 2);
    s.completequest(PQ.STARTER);
    questReward(s, PQ.STARTER);
    s.mes(W, "A ^4d4dffPuddlebloom Egg^000000. Double-click it (or open your pet window, ^4d4dffAlt+J^000000) and it will hatch.",
      "Keep Herb Tea in your bag: feed it when it gets hungry and it will grow fond of you. Starve it and it ^ff0000runs away for good^000000.");
    return s.close();
  }
  s.mes(W, "Mind the straw. Looking for a companion, climber?");
  for (;;) {
    switch (await s.select("About pets", "Pet supplies", q === 0 ? "I'd like a pet" : "My errand", "Cancel")) {
      case 1:
        s.mes(W, "Use a ^4d4dfftaming treat^000000 and pick a monster: weaker ones are easier to win over. Each kind wants its own treat.",
          "If it takes to you, you get its ^4d4dffegg^000000. Hatch it and it follows you everywhere, even through gates.",
          "Pets get hungry. Feed them their own food: that builds ^4d4dffintimacy^000000. Overfeeding sours it, and hunger drains it.",
          "At zero intimacy a pet leaves and never comes back. A loyal pet gives you a small blessing.",
          "Some pets ^4d4dffbite^000000 what you fight once they truly trust you, others ^4d4dffheal or bless^000000 you. You can tuck a pet back into its egg any time.");
        await s.next();
        continue;
      case 2:
        s.clear();
        s.mes(W, "Treats, food and little trinkets. Have a look.");
        await s.close2();
        s.callshop(PET_NPC.shop, CALLSHOP.BUY);
        return s.end();
      case 3:
        if (q === 0) {
          s.mes(W, "I've a Puddlebloom egg waiting for a good home. Puddleblooms love ^4d4dffHerb Tea^000000.",
            "Bring me two Herb Teas (Tilda sells them next door) and the egg is yours.");
          if ((await s.select("I'll bring them.", "Not now.")) !== 1) { s.mes(W, "The egg will keep."); return s.close(); }
          s.setquest(PQ.STARTER);
          s.mes(W, "Two Herb Teas. Tilda's door is right there.");
          return s.close();
        }
        s.mes(W, q === 1 ? "Two Herb Teas, climber. Tilda's, next door." : "How's your Puddlebloom? Feed it before it sulks.");
        return s.close();
      default:
        return s.close();
    }
  }
};

// only the report mark: the offer stays quiet so the chapter's marks keep pointing at the story (content.test.ts)
export const KEEPER_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.QUEST2, color: QMARK.YELLOW, condition: (v) => questReady(v, PQ.STARTER) },
];
