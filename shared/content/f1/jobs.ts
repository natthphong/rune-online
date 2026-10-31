// Floor 1 — the guild camp by the east gate: one master per first job, who changes a Fledgling's job (C04). Modelled on rAthena's
// Renewal job change NPCs (npc/re/jobs/1-1/*.txt: a menu "about the job / become one / cancel", BaseJob must be Job_Novice, the
// F_CanChangeJob check `!basicskillcheck() || getskilllv("NV_BASIC") > 8` of npc/other/Global_Functions.txt, then
// callfunc "Job_Change" = jobchange + a starter weapon), with our own names and lines, and a one-question test in the spirit of
// the pre-Renewal quizzes. W01: the masters keep the guild row in Hearthmoor, south-east of the plaza (CAMP, map f1_town01).
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import type { FirstJob, JobKey } from "../../rules/data.ts";
import { JOBS } from "../../rules/data.ts";
import { MAPID } from "../../rules/status.ts";
import { ET, QMARK, QTYPE } from "../../rules/script.ts";
import { questTasksDone } from "../functions.ts";
import { GUILD_ROW } from "./chapter1.ts";

/** Quest 1015 "A Calling": the Main step after Chapter 1 (shared/content/quest_db.ts), set by Warden Orrin, completed by the job change. */
export const CALLING = 1015;
/** Where the masters stand on f1_town01: the guild row (f1/chapter1.ts GUILD_ROW). */
export const CAMP = GUILD_ROW;

type Master = {
  job: FirstJob; npc: string; name: string; sprite: string;
  about: string[]; question: string; options: string[]; answer: number; // 1-based like select()
  kit: { item: string; count: number }[]; // the starter weapon (rAthena: getitem N_Falchion ... after Job_Change)
};
export const MASTERS: Master[] = [
  {
    job: "Swordman", npc: "npc_job_swordman", name: "Vanguard Master Brannoc", sprite: "npc_warden",
    about: ["Vanguards stand in front. We take the blows so the others don't have to, and we hit back harder.",
      "Your first lessons: ^4d4dffCrushing Blow^000000, a heavy single strike, and later ^4d4dffFlame Burst^000000, a blast of fire around you."],
    question: "A friend is surrounded and you're the only one with a shield. What does a Vanguard do?",
    options: ["Wait until it's safe.", "Step in front and draw them off.", "Shout for help and run."], answer: 2,
    kit: [{ item: "Sword", count: 1 }],
  },
  {
    job: "Mage", npc: "npc_job_mage", name: "Arcanist Master Ysolde", sprite: "npc_herbalist",
    about: ["An Arcanist bends the elements into bolts. Fire, frost and thunder, each strong against something.",
      "Spells take time to cast and a hit can break your focus, so stand back and let your friends hold the line."],
    question: "A beast of water charges you. Which bolt do you cast?",
    options: ["Frost Bolt.", "Thunder Dart.", "Flame Bolt."], answer: 2,
    kit: [{ item: "Rod", count: 1 }],
  },
  {
    job: "Archer", npc: "npc_job_archer", name: "Fletcher Master Kestrel", sprite: "npc_ranger",
    about: ["Fletchers strike from afar. Keep your distance, keep your quiver full, and nothing touches you.",
      "^4d4dffTwin Shot^000000 looses two arrows at once. Every shot uses arrows, so carry plenty."],
    question: "What does a Fletcher need besides a bow?",
    options: ["Arrows, worn in the ammo slot.", "A shield.", "Nothing at all."], answer: 1,
    kit: [{ item: "Bow", count: 1 }, { item: "Arrow", count: 200 }],
  },
  {
    job: "Acolyte", npc: "npc_job_acolyte", name: "Cleric Master Aurel", sprite: "npc_guide",
    about: ["Clerics mend. A party with a Cleric walks further and comes home whole.",
      "^4d4dffHeal^000000 closes wounds, and it burns the walking dead instead of mending them."],
    question: "A companion is badly hurt in the middle of a fight. What comes first?",
    options: ["Finish the fight.", "Heal them.", "Loot the monsters."], answer: 2,
    kit: [{ item: "Club", count: 1 }],
  },
  {
    job: "Merchant", npc: "npc_job_merchant", name: "Peddler Master Tobin", sprite: "npc_merchant",
    about: ["Peddlers carry more, buy cheaper and sell dearer. And when trouble comes, we fight with coin.",
      "^4d4dffCoin Strike^000000 puts zeny behind every blow: it costs coin, and it hits very hard."],
    question: "Your pack is almost full and you find more loot. What does a Peddler do?",
    options: ["Leave it behind.", "Sell what's cheap and carry what's worth more.", "Throw everything away."], answer: 2,
    kit: [{ item: "Axe", count: 1 }],
  },
  {
    job: "Thief", npc: "npc_job_thief", name: "Prowler Master Sable", sprite: "npc_ranger",
    about: ["Prowlers are quick and quiet. We strike twice before the other side has blinked.",
      "^4d4dffVenom Edge^000000 coats your blade in poison for one nasty cut."],
    question: "Speed or armour: which keeps a Prowler alive?",
    options: ["Heavy armour.", "Speed and dodging.", "Neither, just luck."], answer: 2,
    kit: [{ item: "Dirk", count: 1 }],
  },
];

const title = (job: JobKey) => JOBS[job].name;

/** One master's script (npc/re/jobs/1-1/<job>.txt pattern). */
export const jobMaster = (m: Master): NpcScript => async (s: Script) => {
  const N = `[${m.name}]`;
  s.mes(N, `Welcome to the guild row. I train the ${title(m.job)}s of this floor.`);
  await s.next();
  const pick = await s.select(`What do ${title(m.job)}s do?`, `I want to become a ${title(m.job)}.`, "Nothing, thanks.");
  if (pick === 1) {
    s.mes(N, ...m.about);
    return s.close();
  }
  if (pick !== 2) return s.close();
  s.mes(N);
  // 2.5.0: a High Fledgling (rebirth, f1/jobs2.ts) may only take up the first job of its past life (ADVJOB, npc/jobs/valkyrie.txt)
  const high = s.get("Class") === MAPID.Novice_High, adv = s.get("ADVJOB");
  if (high && adv && (adv & 0xff) !== MAPID[m.job]) {
    s.mes(N, "I can see the road you walked in your past life, and it was not ours. Go to the master of that road.");
    return s.close();
  }
  if (s.get("BaseJob") !== MAPID.Novice) { // BaseJob != Job_Novice
    if (s.get("BaseJob") === MAPID[m.job]) s.mes(N, `You're already a ${title(m.job)}. Go and prove it in the fields.`);
    else s.mes(N, "You've already chosen another path. A climber walks one road at a time.");
    return s.close();
  }
  if (s.basicskillcheck() && s.getskilllv("NV_BASIC") <= 8) { // F_CanChangeJob
    s.emotion(ET.SWEAT);
    s.mes(N, `Not yet. A ${title(m.job)} must first finish the Fledgling's training: ^4d4dffJob Lv 10^000000 and ^4d4dffBasic Training Lv 9^000000.`,
      "Spend your skill points in the Skill window (^4d4dffAlt+S^000000), then come back.");
    return s.close();
  }
  s.mes(N, "Your training checks out. One question before I take you on:", `^4d4dff${m.question}^000000`);
  await s.next();
  const a = await s.select(...m.options);
  s.mes(N);
  if (a !== m.answer) {
    s.emotion(ET.QUESTION);
    s.mes(N, `That's not how a ${title(m.job)} thinks. Mull it over and come back to me.`);
    return s.close();
  }
  s.mes(N, `Right answer. Do you want to become a ${title(m.job)} now? There's no going back.`);
  await s.next();
  if (await s.select("Yes, I'm ready.", "Let me think again.") !== 1) {
    s.mes(N, "Choosing a job is a big step. Take your time.");
    return s.close();
  }
  const [first, ...more] = m.kit;
  if (!s.checkweight(first.item, first.count, ...more.flatMap((k) => [k.item, k.count]))) {
    s.mes(N, "Your bag is too full for the gift I have for you. Make some room first.");
    return s.close();
  }
  if (!s.jobchange(high ? (`${m.job}_High` as JobKey) : m.job)) return s.close(); // Job_Change -> jobchange (Job_Swordman_High ... after a rebirth)
  for (const k of m.kit) s.getitem(k.item, k.count);
  if (s.isbegin_quest(CALLING) === 1) s.completequest(CALLING);
  s.emotion(ET.BEST);
  s.mes(N, `Congratulations! From today you are a ^4d4dff${title(m.job)}^000000.`,
    "Your new skills are waiting in the Skill window (^4d4dffAlt+S^000000): spend your points there, drag a skill onto the shortcut bar and use it with its key.");
  return s.close();
};

/** questinfo: a green "!" (QTYPE.JOB) over every master while a Fledgling holds "A Calling" with its training done. */
export const MASTER_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.JOB, color: QMARK.GREEN, condition: (v) => v.get("BaseJob") === MAPID.Novice && v.isbegin_quest(CALLING) === 1 && questTasksDone(v, CALLING) },
];
