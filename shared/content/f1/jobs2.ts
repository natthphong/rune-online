// 2.5.0 — the Guild Grandmaster in Hearthmoor's guild row: one NPC that changes a first job into either of its two second jobs.
// A short port of rAthena's Renewal 2nd-job NPCs (npc/re/jobs/2-1/*.txt, 2-2/*.txt), our own names and lines: the class check
// (BaseClass = the first job, Class = that first job itself, not yet a 2nd job), the requirement every one of them shares (JobLevel >= 40;
// the remaining skill points must be spent: "SkillPoint > 0 -> come back after using them"), Bard / Dancer by gender (Sex), then
// `jobchange` (pc_jobchange: job level 1, skills kept, change_level_2nd stored) and a small gift. The quests of the original
// (item turn-ins, tests, mazes) are cut down to a question, like our first-job masters (f1/jobs.ts).
import type { NpcScript, QuestInfo, Script } from "../api.ts";
import type { FirstJob, JobKey } from "../../rules/data.ts";
import { JOBS } from "../../rules/data.ts";
import { JOBL_UPPER, MAPID, isSecondJob, isTrans, jobOfMapid } from "../../rules/status.ts";
import { ET, QMARK, QTYPE } from "../../rules/script.ts";

export const GRANDMASTER = { npc: "npc_job_grandmaster", name: "Guild Grandmaster Aldric", sprite: "npc_warden" } as const;
/** rAthena's 2nd-job NPCs: Job Level 40 at least (50 = the "full" path, more skill points kept for the 2nd job). */
export const SECOND_JOB_MIN_JOBLV = 40;

/** Each first job's two paths (2-1 then 2-2) with a line about each. Bard is male only, Dancer female only. */
export const PATHS: Record<FirstJob, { job: JobKey; about: string; gender?: "M" | "F"; gift: { item: string; count: number }[] }[]> = {
  Swordman: [
    { job: "Knight", about: "Lancers ride to the front with a lance or a greatblade: Impale, Rolling Smash and Greatblade Haste.", gift: [{ item: "Pike", count: 1 }] },
    { job: "Crusader", about: "Templars hold the line with shield and faith: Shield Bash, Sacred Cross and the Radiant Cross.", gift: [{ item: "Pike", count: 1 }] },
  ],
  Mage: [
    { job: "Wizard", about: "Magi call down storms: Blizzard, Starfall, the Thunderstorm Rite and Earthbreaker.", gift: [] },
    { job: "Sage", about: "Scholars study magic itself: they edge weapons with the elements and unweave enemy spells.", gift: [] },
  ],
  Archer: [
    { job: "Hunter", about: "Trackers lay traps and fly a hawk: Earth Mine, Leg Snare and Hawk Dive.", gift: [{ item: "Arrow", count: 300 }] },
    { job: "Bard", gender: "M", about: "Balladeers fight with chords and play songs that quicken a whole party.", gift: [{ item: "Arrow", count: 300 }] },
    { job: "Dancer", gender: "F", about: "Danseuses fight with a whip and dance to sharpen their friends' aim.", gift: [{ item: "Arrow", count: 300 }] },
  ],
  Acolyte: [
    { job: "Priest", about: "Oracles heal and shield a party: Hallowed Ground, Shield of Faith, the hymns, and Holy Seal against the dead.", gift: [] },
    { job: "Monk", about: "Ascetics gather spirit orbs and strike with bare fists: Orb Shot, Palm Breaker and the Final Fist.", gift: [] },
  ],
  Merchant: [
    { job: "Blacksmith", about: "Forgewrights know weapons: Battle Rush, True Edge, Overdrive and the Quake Hammer.", gift: [] },
    { job: "Alchemist", about: "Apothecaries brew: Acid Flask and Fire Flask for their foes, potions for their friends.", gift: [] },
  ],
  Thief: [
    { job: "Assassin", about: "Shades strike from the dark with claws: Blur Strikes, Ambush Fang and a Toxic Edge.", gift: [] },
    { job: "Rogue", about: "Brigands stab you in the back and walk off with your weapon: Backstab, Ambush Raid, Unweapon.", gift: [] },
  ],
};
const FIRST: FirstJob[] = ["Swordman", "Mage", "Archer", "Acolyte", "Merchant", "Thief"];
const title = (job: JobKey) => JOBS[job].name;
/** The first job a character is (Class == its first job's id), or undefined for a Novice / 2nd job / transcendent. */
const firstOf = (cls: number): FirstJob | undefined => FIRST.find((j) => MAPID[j] === cls || (MAPID[j] | JOBL_UPPER) === cls);

export const grandmaster: NpcScript = async (s: Script) => {
  const N = `[${GRANDMASTER.name}]`;
  s.mes(N, "Every master on this row answers to me. When a first job has learned all it can, I open the next door.");
  await s.next();
  const first = firstOf(s.get("Class"));
  if (!first) {
    if (s.get("Class") === MAPID.Novice) s.mes(N, "First choose a guild. Talk to the masters around me.");
    else s.mes(N, "You have already walked through my door. Go and make your guild proud.");
    return s.close();
  }
  // after a rebirth (a High first job) the only road is the transcendent version of the past life's 2nd job (ADVJOB, valkyrie.txt)
  const reborn = (s.get("Class") & JOBL_UPPER) !== 0, adv = s.get("ADVJOB");
  const advJob = reborn && adv ? jobOfMapid(adv, s.get("Sex") === 0) : undefined;
  const paths = reborn
    ? (advJob ? [{ job: advJob, about: `The ${title(advJob)} is the road your past life prepared for you.`, gift: [] }] : [])
    : PATHS[first].filter((p) => !p.gender || (p.gender === "M") === (s.get("Sex") === 1));
  if (!paths.length) { s.mes(N, "I can't see the road of your past life. Speak to the Keeper of the Second Dawn."); return s.close(); }
  const pick = await s.select(...paths.map((p) => `Tell me about the ${title(p.job)}s.`), ...paths.map((p) => `I want to become a ${title(p.job)}.`), "Nothing, thanks.");
  if (pick >= 1 && pick <= paths.length) {
    s.mes(N, paths[pick - 1].about);
    return s.close();
  }
  const path = paths[pick - paths.length - 1];
  if (!path) return s.close();
  if (s.get("JobLevel") < SECOND_JOB_MIN_JOBLV) { // the Renewal 2nd-job NPCs: JobLevel < 40 -> not yet (a High first job too)
    s.emotion(ET.SWEAT);
    s.mes(N, `Not yet. A ${title(path.job)} must first reach ^4d4dffJob Lv ${SECOND_JOB_MIN_JOBLV}^000000 as a ${title(first)}.`,
      `Job Lv 50 is better still: the more you learned as a ${title(first)}, the more you keep.`);
    return s.close();
  }
  if (s.get("SkillPoint") > 0) { // "use up your skill points first"
    s.mes(N, "You still have unspent skill points. Spend them in the Skill window (^4d4dffAlt+S^000000), then come back.");
    return s.close();
  }
  s.mes(N, `Do you want to become a ^4d4dff${title(path.job)}^000000 now? Your skills stay with you, and your job level starts again at 1.`);
  await s.next();
  if (await s.select("Yes, I'm ready.", "Let me think again.") !== 1) {
    s.mes(N, "Come back when you're sure.");
    return s.close();
  }
  if (path.gift.length) {
    const [g, ...more] = path.gift;
    if (!s.checkweight(g.item, g.count, ...more.flatMap((k) => [k.item, k.count]))) {
      s.mes(N, "Your bag is too full for my gift. Make some room first.");
      return s.close();
    }
  }
  if (!s.jobchange(path.job)) return s.close();
  for (const g of path.gift) s.getitem(g.item, g.count);
  s.emotion(ET.BEST);
  s.mes(N, `From today you are a ^4d4dff${title(path.job)}^000000. Your new skills are waiting in the Skill window.`);
  return s.close();
};

/** A green "!" over the Grandmaster while a first job is at Job Lv 40+ (QTYPE.JOB). */
export const GRANDMASTER_QUESTINFO: QuestInfo[] = [
  { icon: QTYPE.JOB, color: QMARK.GREEN, condition: (v) => firstOf(v.get("Class")) !== undefined && v.get("JobLevel") >= SECOND_JOB_MIN_JOBLV },
];

// ---------- the rebirth (npc/jobs/valkyrie.txt + the Juno library fee) ----------
export const REBIRTH = { npc: "npc_rebirth", name: "Keeper of the Second Dawn", sprite: "npc_guide" } as const;
/** The fee of the book that opens the way (npc/jobs/valkyrie.txt: Zeny >= 1285000). */
export const REBIRTH_FEE = 1285000;
/**
 * valkyrie.txt: a 2nd job at Base Lv 99 / Job Lv 50 with no skill points left pays the fee, its future job is remembered
 * (`ADVJOB`, the class id + JOBL_UPPER), then `jobchange Job_Novice_High; resetlvl 1;` — base and job level 1, stats 1 with 100 status
 * points, every skill gone. The first-job masters then take it back on its old road as a High first job, and the Grandmaster on to
 * the transcendent 2nd job.
 */
export const rebirth: NpcScript = async (s: Script) => {
  const N = `[${REBIRTH.name}]`;
  const cls = s.get("Class"), job = jobOfMapid(cls, s.get("Sex") === 0);
  s.mes(N, "Those who have walked the whole of their road may begin it again, stronger. That is the Second Dawn.");
  await s.next();
  if (!job || !isSecondJob(job) || isTrans(job)) {
    s.mes(N, isTrans(job ?? "Novice") || cls === MAPID.Novice_High ? "You have already seen the Second Dawn. Walk on." : "Come back when you have mastered a second job: Base Lv 99 and Job Lv 50.");
    return s.close();
  }
  if (s.get("BaseLevel") < 99 || s.get("JobLevel") < 50) {
    s.mes(N, `A ${title(job)} must reach ^4d4dffBase Lv 99^000000 and ^4d4dffJob Lv 50^000000 first.`);
    return s.close();
  }
  if (s.get("SkillPoint") > 0) { s.mes(N, "Spend every skill point you have first."); return s.close(); }
  if (s.get("Zeny") < REBIRTH_FEE) { s.mes(N, `The book of the Second Dawn costs ^4d4dff${REBIRTH_FEE.toLocaleString("en")} zeny^000000.`); return s.close(); }
  s.mes(N, "You will start again as a High Fledgling at level 1, your skills forgotten, your body stronger (+25% HP and SP) with 100 status points.",
    `Your road will lead to the ^4d4dff${title(jobOfMapid(cls | JOBL_UPPER, s.get("Sex") === 0)!)}^000000. Do you want this?`);
  await s.next();
  if (await s.select("Yes, begin again.", "Not yet.") !== 1) return s.close();
  s.set("Zeny", s.get("Zeny") - REBIRTH_FEE);
  s.set("ADVJOB", cls | JOBL_UPPER);
  if (!s.jobchange("Novice_High")) return s.close();
  s.resetlvl(1);
  s.emotion(ET.BEST);
  s.mes(N, "Welcome to your Second Dawn, High Fledgling. Train as before, then visit the master of your old road.");
  return s.close();
};
