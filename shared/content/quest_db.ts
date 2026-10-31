// Our quests, in rAthena's db/re/quest_db.yml shape: Id, Title, TimeLimit, Targets (Mob + Count, or Id + Race / Size /
// Element / MinLevel / MaxLevel / Location / MapMobTargets filters), Drops (quest-only drops while the quest is held).
// rules/quest.ts parses them like QuestDatabase::parseBodyNode (Mob / Item = OUR names from shared/data, or ids).
// `Info` is what the real client keeps in its own quest tables (description, summary, NPC to report to, rewards): the quest
// window, the tracker and the auto-navigation read it; the NPC script still decides everything (rewards are paid by the
// script, e.g. with functions.ts questReward). Ids: floor N uses N001-N999. Titles and text are our own.
//
// Floor 1, Chapter 1 "The Verdant Floor" (ro/DESIGN.md): 1001-1014, one Main chain from Guide Lio to Warden Orrin's gate.
// Rewards are tuned on the Renewal exp tables (shared/data/jobs.json Novice baseExp / jobExp) so that a new character who plays
// the chain lands on Job Lv 10 (the Fledgling's last job level, the job change level) during the last hunt and on Base Lv 8
// at the end, in 20-30 minutes; the kills supply most of the Job EXP, so the quests give little of it.
import { parseQuestDb, type QuestDbRow } from "../rules/quest.ts";
import type { QuestTask } from "./tasks.ts";
import { FIELD, TOWN } from "../maps.ts";
import { GUILD_ROW, HUNT, SPOT } from "./f1/chapter1.ts";
import { HUNT2, SPOT2 } from "./f2/chapter2.ts";

export type QuestInfoText = {
  /** "Main" = a step of the story chain (the tracker tags it), "Side" (default) = optional work. */
  Type?: "Main" | "Side";
  /** Tracker line while nothing is left but talking to the Report NPC (e.g. "Deliver the crate to ..."). */
  Summary: string;
  /** Quest window text, one paragraph per entry. */
  Description: string[];
  /** NPC id to report to once the objectives are done (tracker: "Report to <name>", navigation target). */
  Report?: string;
  /** Where the targets are, for auto-navigation when none is in sight. */
  Navi?: { map: string; x: number; y: number };
  /** Items to bring: shown with live inventory counts; the NPC checks them with countitem. */
  Items?: { Item: string | number; Count: number }[];
  /** Things to do that are not kills (shared/content/tasks.ts): shown with their live state; the NPC checks the same thing. */
  Tasks?: QuestTask[];
  RewardEXP?: number; RewardJEXP?: number; RewardZeny?: number;
  RewardItems?: { Item: string | number; Count: number }[];
};
export type QuestContent = QuestDbRow & { Info: QuestInfoText };

/** Floor 1's maps (shared/maps.ts): the Verdant Plains west of Hearthmoor, the Whisperwood east of it, and the town. */
const F1 = FIELD;
/** Chapter 1's last step: the base level Warden Orrin asks for (the gate to the floor's rest town, C08). */
export const F1_GATE_LEVEL = 8;

export const QUESTS: QuestContent[] = [
  {
    Id: 1001,
    Title: "Bloom Patrol",
    Targets: [{ Mob: "Puddlebloom", Count: 5 }],
    Info: {
      Type: "Main",
      Summary: "Defeat Puddleblooms",
      Description: [
        "Puddleblooms keep sliding up the road to Hearthmoor's west gate.",
        "Guide Lio asked you to defeat five of them on the Verdant Plains, out the west gate, then report back to him.",
      ],
      Report: "npc_guide",
      Navi: HUNT.blooms,
      RewardEXP: 600, RewardJEXP: 30, RewardZeny: 150,
      RewardItems: [{ Item: "Red Tonic", Count: 3 }],
    },
  },
  {
    Id: 1002,
    Title: "Gel Beads for the Plaza",
    // while the quest is held, every Puddlebloom has an extra 50% chance to put a Gel Bead straight into your bag
    Drops: [{ Mob: "Puddlebloom", Item: "Gel Bead", Rate: 5000 }],
    Info: {
      Type: "Main",
      Summary: "Gather Gel Beads",
      Description: [
        "Mira bottles her tonics with the Gel Beads that Puddleblooms leave behind.",
        "Bring ten Gel Beads to Guide Lio in Hearthmoor's plaza.",
      ],
      Report: "npc_guide",
      Navi: HUNT.blooms,
      Items: [{ Item: "Gel Bead", Count: 10 }],
      RewardEXP: 1200, RewardJEXP: 50, RewardZeny: 300,
      RewardItems: [{ Item: "Orange Tonic", Count: 2 }, { Item: "Blink Feather", Count: 1 }],
    },
  },
  {
    Id: 1003,
    Title: "A Merchant's Thanks",
    Info: {
      Type: "Main",
      Summary: "Talk to Mira the Merchant",
      Description: [
        "Your Gel Beads went straight into Mira's next batch of tonics.",
        "Guide Lio says she wants to thank you herself. She keeps her stall on the east side of Hearthmoor's plaza.",
      ],
      Report: "npc_merchant",
      RewardItems: [{ Item: "Hat", Count: 1 }],
    },
  },
  {
    Id: 1004,
    Title: "Dressed for the Climb",
    Info: {
      Type: "Main",
      Summary: "Show Mira your new Hat",
      Description: [
        "Mira gave you a sturdy Hat. Gear in your bag does nothing until you wear it.",
        "Open your items with Alt+E and double-click the Hat to put it on, then show Mira.",
      ],
      Report: "npc_merchant",
      Tasks: [{ Text: "Wear the Hat (Alt+E, double-click)", Equip: "Hat" }],
      RewardEXP: 400, RewardJEXP: 10, RewardZeny: 100,
      RewardItems: [{ Item: "Red Tonic", Count: 5 }],
    },
  },
  {
    Id: 1005,
    Title: "Tonics for the Watch",
    Info: {
      Type: "Main",
      Summary: "Deliver the Supply Crate to Ranger Vessa",
      Description: [
        "Mira packed a Supply Crate of tonics for the rangers who watch the fields.",
        "Carry it to Ranger Vessa at the watch post on the Verdant Plains, out the west gate.",
      ],
      Report: "npc_ranger",
      RewardEXP: 800, RewardJEXP: 20, RewardZeny: 200,
    },
  },
  {
    Id: 1006,
    Title: "Know Your Strength",
    Info: {
      Type: "Main",
      Summary: "Spend your status points",
      Description: [
        "Ranger Vessa says a climber's strength is in the numbers: every level brings status points to spend.",
        "Open the Status window with Alt+A, raise the stats you like with the + buttons, then talk to Vessa again.",
      ],
      Report: "npc_ranger",
      Tasks: [{ Text: "Spend your status points (Alt+A)", StatusPoint: { Below: 2 } }],
      RewardEXP: 400, RewardJEXP: 10,
      RewardItems: [{ Item: "Orange Tonic", Count: 1 }],
    },
  },
  {
    Id: 1007,
    Title: "Embers in the Grass",
    // any Fire-element monster counts (quest_db Id target + Element filter): the Sootcaps on this field (W01 r2: the Cinderpaws
    // moved to the woods; one killed there still counts)
    Targets: [{ Id: 1, Element: "Fire", Count: 6 }],
    // quest-only drop: the coals they carry, while the quest is held
    Drops: [{ Mob: "Sootcap", Item: "Ember Coal", Rate: 5000 }, { Mob: "Cinderpaw", Item: "Ember Coal", Rate: 5000 }],
    Info: {
      Type: "Main",
      Summary: "Put out the fire-blooded pests",
      Description: [
        "Fire-blooded pests scorch the grass of the Verdant Plains: Sootcaps below the watch post, in the south meadow and up in the north.",
        "Ranger Vessa wants six of them defeated and four of the Ember Coals they carry brought to her.",
      ],
      Report: "npc_ranger",
      Navi: HUNT.sootcaps,
      Items: [{ Item: "Ember Coal", Count: 4 }],
      RewardEXP: 2200, RewardJEXP: 40, RewardZeny: 400,
      RewardItems: [{ Item: "Guard", Count: 1 }],
    },
  },
  {
    Id: 1008,
    Title: "The Old Lookout",
    Info: {
      Type: "Main",
      Summary: "Scout the old lookout",
      Description: [
        "Something big trampled through the ruined lookout west of the watch post last night.",
        "Ranger Vessa asked you to go and see what left those tracks.",
      ],
      Tasks: [{ Text: "Scout the old lookout", Visit: { Map: F1, X: SPOT.lookout.x, Y: SPOT.lookout.y } }],
      RewardEXP: 600,
    },
  },
  {
    Id: 1009,
    Title: "A Trail of Crushed Herbs",
    Info: {
      Type: "Main",
      Summary: "Find Herbalist Tamsin by the lake",
      Description: [
        "At the lookout you found deep hoofprints, a thorny bramble and a dropped bundle of herbs tied with lavender string.",
        "A trail of crushed leaves leads south, to Herbalist Tamsin's camp on the lake shore of the plains.",
      ],
      Report: "npc_herbalist",
    },
  },
  {
    Id: 1010,
    Title: "Rest and Recover",
    Info: {
      Type: "Main",
      Summary: "Rest, then talk to Herbalist Tamsin",
      Description: [
        "The bramble left you scratched up. Tamsin gave you a cup of Herb Tea to drink from your shortcut bar.",
        "Drag the tea onto the shortcut bar and press its key, then sit down with Insert: sitting recovers HP twice as fast.",
      ],
      Report: "npc_herbalist",
      Tasks: [
        { Text: "Drink the Herb Tea from the shortcut bar", Use: "Herb Tea" },
        // basic_skill_check: sitting needs Basic Training Lv 3 (clif.cpp:11741)
        { Text: "Learn Basic Training Lv 3 (Alt+S) to sit", Skill: { Key: "NV_BASIC", Level: 3 } },
        { Text: "Sit down (Insert) until your HP is full", HpFull: true },
      ],
      RewardEXP: 700, RewardJEXP: 10,
      RewardItems: [{ Item: "Red Herb", Count: 5 }],
    },
  },
  {
    Id: 1011,
    Title: "Pests in the Herb Beds",
    Targets: [{ Mob: "Tumhog", Count: 5 }, { Mob: "Loambloom", Count: 2 }],
    Info: {
      Type: "Main",
      Summary: "Defeat the herb-bed pests",
      Description: [
        "The tracks at the lookout were Tumhogs: they root up Tamsin's herb beds, and the Loamblooms of the Whisperwood, east of Hearthmoor, choke what is left.",
        "Defeat five Tumhogs and two Loamblooms, then tell Tamsin.",
      ],
      Report: "npc_herbalist",
      Navi: HUNT.tumhogs,
      RewardEXP: 2800, RewardJEXP: 40, RewardZeny: 500,
      RewardItems: [{ Item: "Yellow Tonic", Count: 2 }],
    },
  },
  {
    Id: 1012,
    Title: "News for Lio",
    Info: {
      Type: "Main",
      Summary: "Tell Guide Lio what you found",
      Description: ["Tamsin's herb beds are safe again. Guide Lio, back in Hearthmoor, will want to hear how the fields are doing."],
      Report: "npc_guide",
      RewardEXP: 800, RewardZeny: 200,
      RewardItems: [{ Item: "Homing Feather", Count: 1 }],
    },
  },
  {
    Id: 1013,
    Title: "The Warden's Gate",
    Info: {
      Type: "Main",
      Summary: "Find Warden Orrin at the south gate",
      Description: [
        "Guide Lio thinks you are ready for more than the plains. The hard roads of this floor start at Hearthmoor's south gate.",
        "Warden Orrin keeps the gate and decides who is ready for them. Go and introduce yourself.",
      ],
      Report: "npc_warden",
    },
  },
  {
    Id: 1014,
    Title: "Proven Climber",
    Info: {
      Type: "Main",
      Summary: "Show yourself to Warden Orrin",
      Description: [
        `The wardens only vouch for climbers of Base Lv ${F1_GATE_LEVEL} or more.`,
        "Hunt in the Whisperwood, east of town, until you reach that level, then show yourself to Warden Orrin at the south gate.",
      ],
      Report: "npc_warden",
      Navi: HUNT.woods,
      Tasks: [{ Text: `Reach Base Lv ${F1_GATE_LEVEL}`, BaseLevel: F1_GATE_LEVEL }],
      RewardEXP: 3000, RewardZeny: 1000,
      RewardItems: [{ Item: "Cutter", Count: 1 }],
    },
  },
  {
    // C04: after Chapter 1, the job change (shared/content/f1/jobs.ts). Completed by the master who changes the job.
    Id: 1015,
    Title: "A Calling",
    Info: {
      Type: "Main",
      Summary: "Choose a job at the guild camp",
      Description: [
        "Drillmaster Kessa says you are a finished Fledgling. The six guild masters keep the guild row, south-east of Hearthmoor's plaza.",
        "Pick a master and pass their test (Job Lv 10 and Basic Training Lv 9 in the Skill window, Alt+S, are needed).",
      ],
      Navi: { map: TOWN, ...GUILD_ROW.center },
      Tasks: [
        { Text: "Reach Job Lv 10", JobLevel: 10 },
        { Text: "Learn Basic Training Lv 9 (Alt+S)", Skill: { Key: "NV_BASIC", Level: 9 } },
      ],
    },
  },
  // C08: Hearthmoor, the floor's rest town (shared/content/f1/town.ts). Main: the steps from Orrin's gate to "A Calling".
  {
    Id: 1016,
    Title: "A Warm Hearth",
    Info: {
      Type: "Main",
      Summary: "Find Hearthkeeper Bren in Hearthmoor",
      Description: [
        "Warden Orrin vouches for you now. He sent you on to the heart of Hearthmoor, the floor's rest town.",
        "Hearthkeeper Bren keeps the town's fire in the plaza: she sets your save point and heals you.",
      ],
      Report: "npc_hearthkeeper",
      RewardZeny: 300,
      RewardItems: [{ Item: "Red Tonic", Count: 5 }],
    },
  },
  {
    Id: 1017,
    Title: "The Fledgling's Last Lesson",
    Info: {
      Type: "Main",
      Summary: "Finish your training, report to Drillmaster Kessa",
      Description: [
        "Every Job Level gives a Fledgling one skill point. Drillmaster Kessa wants all of them in Basic Training (Skill window, Alt+S).",
        "Reach Job Lv 10 by hunting, learn Basic Training Lv 9, then report to her in Hearthmoor's plaza.",
      ],
      Report: "npc_drillmaster",
      Navi: HUNT.woods,
      Tasks: [
        { Text: "Reach Job Lv 10", JobLevel: 10 },
        { Text: "Learn Basic Training Lv 9 (Alt+S)", Skill: { Key: "NV_BASIC", Level: 9 } },
      ],
      RewardEXP: 1500, RewardZeny: 500,
      RewardItems: [{ Item: "Orange Tonic", Count: 3 }],
    },
  },
  // W03: the way down. Warden Orrin breaks the wardens' seal on the stair under the Sunken Mire's keep (f1/stair.ts) for a
  // climber of Base Lv 15+ who clears the Dustcoils off the causeway; then the Mirefall Catacombs (B1-B3, Lv 20-30) are open.
  {
    Id: 1018,
    Title: "The Wardens' Seal",
    Targets: [{ Mob: "Dustcoil", Count: 8 }],
    Info: {
      Type: "Main",
      Summary: "Defeat Dustcoils in the Sunken Mire",
      Description: [
        "Under the Sunken Mire's ruined keep a stair leads down into the Mirefall Catacombs, and the wardens keep it sealed.",
        "Warden Orrin will lift the seal for you if you clear the Dustcoils off the Mire's causeway: defeat eight of them, then report to him at Hearthmoor's south gate.",
      ],
      Report: "npc_warden",
      Navi: HUNT.dustcoils,
      RewardEXP: 9000, RewardJEXP: 4000, RewardZeny: 2000,
      RewardItems: [{ Item: "Yellow Tonic", Count: 5 }],
    },
  },
  // Hearthmoor side work (1101-): Pella's errand, Garr's woodpile
  {
    Id: 1101,
    Title: "Dinner Bell",
    Info: {
      Summary: "Tell Woodcutter Garr his dinner is ready",
      Description: ["Pella the cook has stew on the fire. Woodcutter Garr is chopping up the north street and has lost track of time."],
      Report: "npc_garr",
      RewardEXP: 200, RewardZeny: 100,
    },
  },
  {
    Id: 1102,
    Title: "Sootcaps in the Woodpile",
    Targets: [{ Mob: "Sootcap", Count: 6 }],
    Info: {
      Summary: "Defeat 6 Sootcaps, report to Garr",
      Description: ["Sootcaps from the plains crawl into Woodcutter Garr's woodpile. Defeat six of them on the Verdant Plains, then tell Garr."],
      Report: "npc_garr",
      Navi: HUNT.sootcaps,
      RewardEXP: 900, RewardJEXP: 20, RewardZeny: 300,
      RewardItems: [{ Item: "Blink Feather", Count: 2 }],
    },
  },
  // 2.4.0 pets (f1/pets.ts): Keeper Wren's starter egg
  {
    Id: 1103,
    Title: "A Friend from the Plains",
    Info: {
      Summary: "Bring Keeper Wren two Herb Teas",
      Description: ["Keeper Wren has a Puddlebloom egg waiting for a good home. Puddleblooms love Herb Tea: bring her two (Tilda's Sundries sells it)."],
      Report: "npc_beastkeeper",
      Items: [{ Item: "Herb Tea", Count: 2 }],
      RewardItems: [{ Item: "Puddlebloom Egg", Count: 1 }],
    },
  },
  // 2.5.0 Floor 2, "The Ember Floor" (f2/lanternrest.ts): 2001-2003, one Main chain from the Ascent Stair to the vault's boss. Ids: floor N = N001-N999.
  {
    Id: 2001,
    Title: "A Light on the Landing",
    Info: {
      Type: "Main",
      Summary: "Report to Sentinel Corwin in Lanternrest",
      Description: [
        "You climbed the Ascent Stair out of the Sunken Mire and stand on the Tower's second floor, the Ember Floor.",
        "Sentinel Corwin counts every climber who comes up the stair: find him by the Spire Lodge in Lanternrest.",
      ],
      Report: "npc_f2_sentinel",
      Navi: SPOT2.sentinel,
      RewardEXP: 4000, RewardJEXP: 1200, RewardZeny: 1500,
      RewardItems: [{ Item: "Yellow Tonic", Count: 3 }],
    },
  },
  {
    Id: 2002,
    Title: "Embers on the Terraces",
    Targets: [{ Mob: "Ashbeetle", Count: 6 }],
    Info: {
      Type: "Main",
      Summary: "Defeat Ashbeetles on the Emberlit Terraces",
      Description: [
        "Ashbeetles are crawling out of the old terraces west of Lanternrest's gate.",
        "Sentinel Corwin asked you to defeat six of them on the Emberlit Terraces, then report back to him.",
      ],
      Report: "npc_f2_sentinel",
      Navi: HUNT2.beetles,
      RewardEXP: 24000, RewardJEXP: 7000, RewardZeny: 3000,
      RewardItems: [{ Item: "Orange Tonic", Count: 5 }],
    },
  },
  {
    Id: 2003,
    Title: "Embers of the Vault",
    Targets: [{ Mob: "Devo", Count: 1 }],
    Info: {
      Type: "Main",
      Summary: "Defeat Devo in the Emberhollow Vault",
      Description: [
        "The ash woke something in the Emberhollow Vault under Cinderwatch Heights: a huge horned goat called Devo, who charges at anything that moves.",
        "Take the stair in the Heights' north-east ruin, put him down in his hall at the bottom, then report to Sentinel Corwin.",
      ],
      Report: "npc_f2_sentinel",
      Navi: HUNT2.vault,
      RewardEXP: 60000, RewardJEXP: 20000, RewardZeny: 8000,
      RewardItems: [{ Item: "Yellow Tonic", Count: 10 }],
    },
  },
];

const parsed = parseQuestDb(QUESTS);
/** The quest db the server and client use (s_quest_db per id). */
export const QUEST_DB = parsed.db;
/** Rows rAthena would have skipped (the content test requires none). */
export const QUEST_DB_WARNINGS = parsed.warnings;
export const QUEST_INFO = new Map(QUESTS.map((q) => [q.Id, q.Info]));
