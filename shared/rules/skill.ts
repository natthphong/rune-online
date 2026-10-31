// Skills: the skill tree, skill points, requirements, cast time, delays and the damage / heal numbers of the skills we run,
// re-implemented from rAthena (Renewal, RENEWAL_CAST): src/map/pc.cpp (pc_calc_skilltree, pc_calc_skilltree_normalize_job_sub,
// pc_calc_skillpoint, pc_skillup, pc_checkskill), src/map/skill.cpp (skill_get_*, skill_get_range2, skill_castfix,
// skill_vfcastfix, skill_delayfix, skill_calc_heal, skill_check_condition_castbegin / _castend), src/map/unit.cpp
// (unit_set_castdelay), src/map/battle.cpp (battle_range_type, is_attack_hitting) and the per-skill classes in
// src/map/skills/<class>/*.cpp (calculateSkillRatio / modifyHitRate). Data: shared/data/skills.json + skill_tree.json, imported
// from db/re/skill_db.yml + skill_tree.yml by tools/rathena/import.ts. conf values are named after their conf/battle keys.
import skillsJson from "../data/skills.json" with { type: "json" };
import treeJson from "../data/skill_tree.json" with { type: "json" };
import { JOBS, type Element, type JobKey } from "./data.ts";
import { firstJobOf, isNoviceClass, isSecondJob, isTrans } from "./status.ts";
import { BF, type MagicSkillHit, type WeaponSkillHit } from "./battle.ts";
import { NEVER_MISS_2, PASSIVE_IMPL_2, SKILL_USE_2, hits2, ratio2, type Ctx2, type SkillUse2 } from "./skills2.ts";

/** One skills.json row (tools/rathena/import.ts writes it; per-level arrays are 1..maxLevel). */
export type Skill = {
  id: number; key: string; name: string; maxLevel: number; type: string | null; target: string;
  range: number[]; hit: string; hitCount: number[]; element: string[]; splash: number[]; knockback: number[];
  castTime: number[]; fixedCastTime: number[]; delay: number[]; walkDelay: number[]; cooldown: number[]; duration1: number[]; duration2: number[];
  castCancel: boolean; castDefenseReduction: number; castTimeFlags: string[]; castDelayFlags: string[]; damageFlags: string[]; flags: string[];
  sp: number[]; hp: number[]; zeny: number[]; hpRateCost: number[]; spRateCost: number[];
  weapons: string[] | null; ammo: string[] | null; ammoAmount: number[]; status: string | null;
};
const ROWS = skillsJson as unknown as Skill[];
export const SKILLS = new Map<number, Skill>(ROWS.map((s) => [s.id, s]));
/** rAthena's internal skill names (SM_BASH ...) -> id: code reads skills by these keys, players only ever see `name`. */
export const SKILL_ID: Record<string, number> = Object.fromEntries(ROWS.map((s) => [s.key, s.id]));
type TreeRow = { id: number; maxLevel: number; requires: { id: number; level: number }[]; baseLevel: number; jobLevel: number };
const TREES = treeJson as Record<string, { inherit: string[]; tree: TreeRow[] }>;

/** conf/battle/skill.conf + player.conf defaults (battle.cpp battle_data[]). */
export const SKILL_CONF = {
  player_skillup_limit: true, // skillup_limit: the Novice tree must be finished (9 points) before the first job's skills can rise
  basic_skill_check: true, // Basic Skill levels gate sitting, emotions, trading, parties ... and the job change
  vcast_stat_scale: 530, // RENEWAL_CAST: variable cast reduced by sqrt((DEX * 2 + INT) / 530)
  default_fixed_castrate: 20, // a skill whose FixedCastTime is negative: 20 % of its cast time is fixed
  cast_rate: 100,
  delay_rate: 100,
  delay_dependon_dex: false,
  delay_dependon_agi: false,
  castrate_dex_scale: 150,
  min_skill_delay_limit: 100,
  max_heal: 9999, max_heal_lv: 11,
  skill_add_range: 0, // added to every skill's range (skill_get_range2 isServer: capped at 14)
};
/** skill.hpp:201 SECURITY_CASTTIME: the extra canact delay set at cast start and removed at cast end. */
export const SECURITY_CASTTIME = 100;

/** skill_get_lv(skill_id, lv, arr): a per-level value; levels above the table use its last entry. */
export const skillLv = (arr: readonly number[], lv: number) => arr[Math.min(Math.max(lv, 1), arr.length) - 1] ?? 0;
export const skillOf = (id: number) => SKILLS.get(id);

/** Learned skill levels of a character: skill id -> level (sd->status.skill[].lv with flag SKILL_FLAG_PERMANENT). */
export type Learned = Record<number, number>;

// ---------- the tree ----------

/** SkillTreeDatabase::loadingFinished: a job's tree = its own rows + every inherited job's rows (recursively, Exclude rows
 *  left out by the importer). Rows keep the order skill_tree.yml lists them in, the inherited ones first. */
export function treeRows(job: string): TreeRow[] {
  const t = TREES[job];
  if (!t) return [];
  const out: TreeRow[] = [];
  const seen = new Set<number>();
  for (const parent of t.inherit) for (const r of treeRows(parent)) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
  for (const r of t.tree) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
  return out;
}

/** 2.5.0: the tabs of the skill window: every job whose tree a job inherits (skill_tree.yml Inherit, first job first) + the job itself,
 *  those with rows of their own only (Knight: Novice, Swordman, Knight). */
export function treeChain(job: string): string[] {
  const t = TREES[job];
  if (!t) return [job];
  const out: string[] = [];
  for (const p of t.inherit) for (const j of treeChain(p)) if (!out.includes(j)) out.push(j);
  if (!out.includes(job) && t.tree.length) out.push(job);
  return out;
}

/** pc_calc_skillpoint (pc.cpp:2518): skill points spent = the sum of learned levels (quest / wedding skills are not in our trees). */
export const skillPointsSpent = (learned: Learned) => Object.values(learned).reduce((a, b) => a + (b > 0 ? b : 0), 0);

/** pc_calc_skilltree_normalize_job_sub (pc.cpp:2893) for a first job: with player_skillup_limit, a character that has spent fewer
 *  points than the Novice's max job level - 1 (9: all of Basic Skill) only gets the Novice tree. */
export function normalizeJob(job: JobKey, learned: Learned, conf = SKILL_CONF, change2nd = 0): JobKey {
  if (!conf.player_skillup_limit || isNoviceClass(job)) return job;
  let points = skillPointsSpent(learned);
  if (points < JOBS.Novice.maxJobLevel - 1) return isTrans(job) ? "Novice_High" : "Novice";
  points -= JOBS.Novice.maxJobLevel - 1;
  // 2.5.0, the 1st-class job level check (pc.cpp:2910-2928): a 2nd job that has spent fewer than change_level_2nd - 1 points past the
  // Novice's (the job level it changed at, the 1st job's max job level when unset) keeps its 1st job's tree; the Rebirth mask is kept
  if (isSecondJob(job)) {
    const first = firstJobOf(job), lvl = change2nd || JOBS[first].maxJobLevel;
    if (points < lvl - 1) return isTrans(job) ? (`${first}_High` as JobKey) : first;
  }
  return job;
}

/** One skill as the skill window lists it (clif_skillinfoblock): its id, learned level, the tree's max for the job, and whether
 *  the character may raise it now (`upgradable` of clif_skillup: in the tree, prerequisites met, below the max). */
export type SkillEntry = { id: number; lv: number; maxLevel: number; upgradable: boolean; later?: boolean };

/**
 * pc_calc_skilltree (pc.cpp:2601) + clif_skillinfoblock: the skills a character has access to. The tree of the normalized job;
 * a row joins once every prerequisite's learned level reaches its need and the base / job level requirements are met, repeated
 * until nothing changes (a row unlocked by another row's... no row unlocks another without points, but the loop is the C++'s).
 * `all` = the whole tree of the actual job for the window (locked rows included, available = false).
 */
export function skillTree(job: JobKey, learned: Learned, baseLevel: number, jobLevel: number, conf = SKILL_CONF, change2nd = 0) {
  const norm = normalizeJob(job, learned, conf, change2nd);
  const rows = treeRows(norm);
  const known = new Set<number>();
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) {
      if (known.has(r.id)) continue;
      if (r.requires.some((q) => (known.has(q.id) ? learned[q.id] ?? 0 : 0) < q.level)) continue;
      if (baseLevel < r.baseLevel || jobLevel < r.jobLevel) continue;
      known.add(r.id);
      changed = true;
    }
  }
  return { job: norm, known, rows };
}

/** pc_checkskill (pc.cpp): the level a character can use a skill at — 0 unless the skill is in its current tree. */
export function checkSkill(job: JobKey, learned: Learned, baseLevel: number, jobLevel: number, id: number, change2nd = 0) {
  return skillTree(job, learned, baseLevel, jobLevel, SKILL_CONF, change2nd).known.has(id) ? learned[id] ?? 0 : 0;
}

/** The skill window's list: every row of the actual job's tree (inherited Novice rows first), with what pc_calc_skilltree
 *  makes available. A learned skill of a row the normalized tree hides keeps its level but shows as not upgradable. */
export function skillList(job: JobKey, learned: Learned, baseLevel: number, jobLevel: number, points: number, change2nd = 0): SkillEntry[] {
  const t = skillTree(job, learned, baseLevel, jobLevel, SKILL_CONF, change2nd);
  return treeRows(job).map((r) => {
    const lv = learned[r.id] ?? 0;
    return { id: r.id, lv, maxLevel: r.maxLevel, upgradable: points > 0 && t.known.has(r.id) && lv < r.maxLevel && skillLearnable(r.id), ...(skillReady(r.id) ? {} : { later: true }) };
  });
}

/** pc_skillup (pc.cpp:9129): a point goes into the skill when the character has one, the skill is in its tree now and below
 *  the tree's max level (skill_tree_get_max for its class). null = done, else why not. */
export function skillUpBlock(job: JobKey, learned: Learned, baseLevel: number, jobLevel: number, points: number, id: number, change2nd = 0): string | null {
  if (points <= 0) return "no skill points";
  if (!skillLearnable(id)) return "it isn't available yet (coming later)";
  const row = treeRows(job).find((r) => r.id === id);
  if (!row) return "not in your skill tree";
  if (!skillTree(job, learned, baseLevel, jobLevel, SKILL_CONF, change2nd).known.has(id)) return "its requirements aren't met";
  if ((learned[id] ?? 0) >= row.maxLevel) return "already at its maximum level";
  return null;
}

// ---------- Basic Skill gates (basic_skill_check) ----------
/** Basic Skill levels the client actions need (clif.cpp): trade 1 (12517), emotions 2 (11638), sit 3 (11741), chat room 4 (12380),
 *  party create 7 (13808); the job change NPCs ask for 9 (npc/other/Global_Functions.txt F_CanChangeJob). */
export const BASIC_SKILL_NEED = { trade: 1, emotion: 2, sit: 3, chat: 4, partyCreate: 7, jobChange: 9 } as const;
export const basicSkillOk = (basicLv: number, need: number, conf = SKILL_CONF) => !conf.basic_skill_check || basicLv >= need;

// ---------- range ----------
/** skill_get_range2 (skill.cpp:324) for a player, server side: a negative range is its absolute value (skillrange_from_weapon 0),
 *  + Far Sight's level for INF2_ALTERRANGEVULTURE skills, + skill_add_range, capped at 14. */
export function skillRange(s: Skill, lv: number, learned: Learned = {}, conf = SKILL_CONF) {
  let range = skillLv(s.range, lv);
  if (range < 0) range = -range;
  range += conf.skill_add_range;
  if (range > 14) range = 14;
  if (s.flags.includes("AlterRangeVulture")) range += learned[SKILL_ID.AC_VULTURE] ?? 0;
  return range;
}
/** battle_range_type (battle.cpp:2671) for a player's skill: a skill range below 4 is BF_SHORT, else BF_LONG (skillrange_by_distance
 *  doesn't include BL_PC). */
export const skillRangeType = (range: number) => (range < 4 ? BF.SHORT : BF.LONG);

// ---------- requirements (skill_check_condition_castbegin / _castend) ----------
/** The USESKILL_FAIL_* a cast can stop with, and the text the client shows for it (msgstringtable). */
export const SKILL_FAIL = {
  level: "You haven't learned that skill.",
  sp: "Not enough SP.",
  hp: "Not enough HP.",
  zeny: "Not enough zeny.",
  weapon: "You can't use this skill with that weapon.",
  ammo: "You need the right ammunition equipped.",
  weight: "You are carrying too much (90%+ weight).",
  range: "Your target is out of range.",
  target: "That's not a valid target.",
  delay: "You can't use skills yet.",
  cooldown: "That skill isn't ready yet.",
  basic: "Your Basic Training level is too low.",
  status: "You can't use skills in this condition.", // sc->cant.cast: Stone, Freeze, Stun, Sleep, Silence (status_check_skilluse)
  failed: "The skill has failed.", // a status skill that did not take (resisted, immune)
} as const;
export type SkillFail = keyof typeof SKILL_FAIL;

/** skill_get_requirement (skill.cpp) without the cost bonuses (bUseSPrate ... not imported): SP / HP / zeny of a level. */
export const skillCost = (s: Skill, lv: number) => ({ sp: skillLv(s.sp, lv), hp: skillLv(s.hp, lv), zeny: skillLv(s.zeny, lv), ammo: s.ammo ? Math.max(1, skillLv(s.ammoAmount, lv)) : 0 });

/** skill_check_condition_castbegin / _castend for a player, the parts our skills use: HP above the cost (hp <= cost fails,
 *  skill.cpp USESKILL_FAIL_HP_INSUFFICIENT), SP, zeny, the weapon type (Requires.Weapon; "Fist" = bare hands), the ammo
 *  (Requires.Ammo: the worn ammo subtype and AmmoAmount), the SC_WEIGHT90 gate (shared/rules/weight.ts blocksSkillCast,
 *  passed in as `overweight`). null = the cast may go on. */
export function skillCondition(s: Skill, lv: number, u: { hp: number; sp: number; zeny: number; weaponType: string; ammo: { subType: string | null; amount: number } | null; overweight: boolean }): SkillFail | null {
  const c = skillCost(s, lv);
  if (u.overweight) return "weight";
  if (c.hp > 0 && u.hp <= c.hp) return "hp";
  if (u.sp < c.sp) return "sp";
  if (u.zeny < c.zeny) return "zeny";
  if (s.weapons && !s.weapons.includes(u.weaponType)) return "weapon";
  if (s.ammo && (!u.ammo || !s.ammo.includes(u.ammo.subType ?? "") || u.ammo.amount < c.ammo)) return "ammo";
  return null;
}

// ---------- time ----------
/** skill_castfix + skill_vfcastfix (skill.cpp:10122, 10253; RENEWAL_CAST) for a player without cast bonuses or status changes:
 *  base = CastTime x cast_rate / 100; a negative FixedCastTime takes default_fixed_castrate % of it as the fixed part; the variable
 *  part x (1 - sqrt((DEX x 2 + INT) / vcast_stat_scale)) unless the skill ignores DEX (CastTimeFlags IgnoreDex); int(variable, min
 *  0) + max(fixed, 0), truncated. */
export function castTime(s: Skill, lv: number, st: { dex: number; int: number }, conf = SKILL_CONF) {
  let time = skillLv(s.castTime, lv);
  if (conf.cast_rate !== 100) time = (time * conf.cast_rate) / 100;
  time = Math.max(Math.trunc(time), 0); // skill_castfix returns an int
  let fixed = skillLv(s.fixedCastTime, lv);
  if (fixed < 0) {
    if (conf.default_fixed_castrate > 0) {
      fixed = Math.trunc((time * conf.default_fixed_castrate) / 100);
      time = (time * (100 - conf.default_fixed_castrate)) / 100;
    } else fixed = 0;
  }
  if (!s.castTimeFlags.includes("IgnoreDex")) time = time * (1 - Math.sqrt(Math.fround((st.dex * 2 + st.int) / conf.vcast_stat_scale)));
  return Math.trunc(Math.max(Math.trunc(time), 0) + Math.max(fixed, 0));
}

/** skill_delayfix (skill.cpp:10385) for a player without delay bonuses: AfterCastActDelay (a negative one = |delay| + amotion),
 *  delay_dependon_dex / _agi off by default, x delay_rate / 100, min 0. */
export function afterCastDelay(s: Skill, lv: number, amotion: number, conf = SKILL_CONF) {
  let time = skillLv(s.delay, lv);
  if (time < 0) time = -time + amotion;
  if (conf.delay_rate !== 100) time = (time * conf.delay_rate) / 100;
  return Math.max(Math.trunc(time), 0);
}

/** skill_get_cooldown / pc_get_skillcooldown (no cooldown bonuses): ms the skill stays blocked after it is used (skill_blockpc_start). */
export const skillCooldown = (s: Skill, lv: number) => skillLv(s.cooldown, lv);
/** skill_get_walkdelay: AfterCastWalkDelay, the walk delay after the skill (unit_set_walkdelay in skill_castend_*). */
export const skillWalkDelay = (s: Skill, lv: number) => skillLv(s.walkDelay, lv);

/** unit_set_castdelay (unit.cpp:1981) at cast start: canact_tick = max(canact_tick, tick + max(cast, min_skill_delay_limit))
 *  + SECURITY_CASTTIME (cast = 0 when the skill has no CastTime at all, unit.cpp:2524). */
export const castStartCanact = (canact: number, tick: number, cast: number, conf = SKILL_CONF) =>
  Math.max(canact, tick + Math.max(cast, conf.min_skill_delay_limit)) + SECURITY_CASTTIME;
/** skill_castend_id / _pos (skill.cpp:5083): canact_tick = max(tick + skill_delayfix, canact_tick - SECURITY_CASTTIME). */
export const castEndCanact = (canact: number, tick: number, delay: number) => Math.max(tick + delay, canact - SECURITY_CASTTIME);

// ---------- what each skill does ----------
/** How the server runs a skill we implement (skill_castend_damage_id / _nodamage_id / _pos per skill). Skills without a row show
 *  in the tree and can be learned, but using them answers "not available yet". */
export type SkillUse =
  | { kind: "weapon" } // skill_attack(BF_WEAPON) on the target
  | { kind: "magic" } // skill_attack(BF_MAGIC) on the target
  | { kind: "selfSplash" } // castend_nodamage on self -> every enemy in splash range of the caster (map_foreachinshootrange)
  | { kind: "groundSplash" } // castend_pos: every enemy in splash range of the cell (SkillImplRecursiveDamageSplash)
  | { kind: "heal" } // AL_HEAL: heals the target, damages an Undead-element one (skill_castend_id)
  | { kind: "status" } // sc_start / status_change_end on the target: buffs, debuffs, cures (status_change.ts SKILL_SC / SKILL_CURE)
  | SkillUse2; // 2.5.0: the 2nd-job kinds (shared/rules/skills2.ts)
export const SKILL_USE: Record<string, SkillUse> = {
  SM_BASH: { kind: "weapon" }, SM_MAGNUM: { kind: "selfSplash" },
  MG_FIREBOLT: { kind: "magic" }, MG_COLDBOLT: { kind: "magic" }, MG_LIGHTNINGBOLT: { kind: "magic" },
  MG_NAPALMBEAT: { kind: "magic" }, MG_SOULSTRIKE: { kind: "magic" },
  AC_DOUBLE: { kind: "weapon" }, AC_SHOWER: { kind: "groundSplash" },
  AL_HEAL: { kind: "heal" },
  MC_MAMMONITE: { kind: "weapon" },
  TF_POISON: { kind: "weapon" },
  // B14: the statuses (shared/rules/status_change.ts): Provoke / Endure / Improve Concentration / Increase AGI / Decrease AGI / Angelus /
  // Blessing / Cure / Detoxify / Stone Curse apply or end a status; Frost Diver is a cold bolt whose hit may freeze
  SM_PROVOKE: { kind: "status" }, SM_ENDURE: { kind: "status" }, AC_CONCENTRATION: { kind: "status" }, AL_INCAGI: { kind: "status" },
  AL_DECAGI: { kind: "status" }, AL_ANGELUS: { kind: "status" }, AL_BLESSING: { kind: "status" }, AL_CURE: { kind: "status" },
  TF_DETOXIFY: { kind: "status" }, MG_STONECURSE: { kind: "status" },
  MG_FROSTDIVER: { kind: "magic" },
  ...SKILL_USE_2, // 2.5.0: the 2nd-job and transcendent skills (shared/rules/skills2.ts)
};
export const skillUse = (s: Skill): SkillUse | undefined => SKILL_USE[s.key];

/** Passive skills whose effect is wired (status.ts Passives / battle.ts passiveMastery + passiveDefense / items.ts weight + heal):
 *  every other passive is "coming later" like an unimplemented active skill. Our own gate (rAthena has every skill working). */
export const PASSIVE_IMPL: ReadonlySet<string> = new Set([
  "NV_BASIC", "AC_OWL", "AC_VULTURE", "TF_MISS", "SM_SWORD", "SM_TWOHAND", "SM_RECOVERY", "MG_SRECOVERY", "AL_DP", "AL_DEMONBANE",
  ...PASSIVE_IMPL_2,
]);
/** A skill that does something now: one the server can run, or a passive with its hook. Anything else is locked in the window,
 *  takes no skill points and has its spent points refunded at login (refundUnready). */
export const skillReady = (id: number) => { const s = SKILLS.get(id); return !!s && (s.key in SKILL_USE || PASSIVE_IMPL.has(s.key)); };
/** 2.5.0: skills whose effect isn't modelled yet but that some working skill needs as a prerequisite (skill_tree.yml Requires, any
 *  job): they take points like rAthena (so the tree stays the original one), stay flagged "later" and can't be used. */
export const PREREQ_ONLY: ReadonlySet<number> = (() => {
  const out = new Set<number>();
  for (const job of Object.keys(TREES)) {
    const by = new Map(treeRows(job).map((r) => [r.id, r]));
    const walk = (id: number) => { for (const q of by.get(id)?.requires ?? []) { if (!skillReady(q.id) && !out.has(q.id)) out.add(q.id); walk(q.id); } };
    for (const r of by.values()) if (skillReady(r.id)) walk(r.id);
  }
  return out;
})();
/** A skill points can go into. 2.5.0: every skill of the trees, like rAthena — the 2nd-job change (and the rebirth) require every
 *  skill point spent and pc_calc_skilltree_normalize_job keeps the first job's tree until change_level_2nd - 1 points are in it, which a
 *  Peddler (most of its tree not modelled yet) could never reach otherwise. A skill whose effect isn't modelled stays flagged "later"
 *  (the window says "Effect later") and can't be used; PREREQ_ONLY lists the ones a working skill needs. */
export const skillLearnable = (id: number) => SKILLS.has(id);
/** Levels spent in skills that can't take points (pc_resetskill for those ids only): id -> points to hand back. */
export function refundUnready(learned: Learned): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, lv] of Object.entries(learned)) if (lv > 0 && !skillLearnable(Number(id))) out[Number(id)] = lv;
  return out;
}
/** Learned levels -> the Passives status_calc_pc reads (pc_checkskill of each). */
export function passivesOf(lv: (key: string) => number) {
  return {
    owl: lv("AC_OWL"), vulture: lv("AC_VULTURE"), miss: lv("TF_MISS"), sword: lv("SM_SWORD"), twohand: lv("SM_TWOHAND"),
    recovery: lv("SM_RECOVERY"), srecovery: lv("MG_SRECOVERY"), dp: lv("AL_DP"), demonbane: lv("AL_DEMONBANE"),
    extra: Object.fromEntries(PASSIVE_IMPL_2.map((k) => [k, lv(k)]).filter(([, v]) => (v as number) > 0)) as Record<string, number>, // 2.5.0 passives
  };
}
/** status.cpp:3678: MC_INCCARRY adds 2000 max weight per level. */
export const incCarryWeight = (lv: number) => 2000 * lv;

/** battle_check_undead (battle.cpp; undead_detect_type 0): the defense element is Undead. */
export const isUndead = (t: { element: string }) => t.element === "Undead";

/** Context a skill ratio reads: inner = Flame Burst's inner 3x3 (wd->miscflag 1), undead = the target is Undead (Spirit Lance). */
export type RatioCtx = { inner?: boolean; undead?: boolean; size?: string } & Ctx2;
/**
 * battle_calc_attack_skill_ratio / the magic skillratio: 100 + each skill's calculateSkillRatio (src/map/skills/<class>/*.cpp):
 * SM_BASH +30 x lv (bash.cpp), MG_FROSTDIVER +10 x lv (frostdiver.cpp), SM_MAGNUM +20 x lv inner 3x3 / +10 x lv outer (magnum.cpp), MG_NAPALMBEAT -30 + 10 x lv (napalmbeat.cpp),
 * MG_SOULSTRIKE +5 x lv vs Undead (soulstrike.cpp), the bolts 100 (firebolt.cpp ...), AC_DOUBLE +10 x (lv - 1) (doublestrafe.cpp),
 * AC_SHOWER +50 + 10 x lv (arrowshower.cpp RENEWAL), MC_MAMMONITE +50 x lv (mammonite.cpp), TF_POISON 100 (envenom.cpp).
 */
export function skillRatio(key: string, lv: number, ctx: RatioCtx = {}) {
  switch (key) {
    case "SM_BASH": return 100 + 30 * lv;
    case "SM_MAGNUM": return 100 + (ctx.inner ? 20 : 10) * lv;
    case "MG_NAPALMBEAT": return 100 - 30 + 10 * lv;
    case "MG_FROSTDIVER": return 100 + 10 * lv; // frostdiver.cpp
    case "MG_SOULSTRIKE": return 100 + (ctx.undead ? 5 * lv : 0);
    case "AC_DOUBLE": return 100 + 10 * (lv - 1);
    case "AC_SHOWER": return 100 + 50 + 10 * lv;
    case "MC_MAMMONITE": return 100 + 50 * lv;
    default: return ratio2(key, lv, ctx) ?? 100;
  }
}
/** modifyHitRate of the skill (applied to the final hitrate before the cap): SM_BASH +5 % x lv (bash.cpp), SM_MAGNUM +10 % x lv
 *  (magnum.cpp). */
export function skillHitRate(key: string, lv: number): ((hitrate: number) => number) | undefined {
  if (key === "SM_BASH") return (h) => h + Math.trunc((h * 5 * lv) / 100);
  if (key === "SM_MAGNUM") return (h) => h + Math.trunc((h * 10 * lv) / 100);
  return undefined;
}
/** skill_get_ele: the skill's element at this level; "Weapon" (and "Endowed") = the weapon's own (undefined here). */
export function skillElement(s: Skill, lv: number): Element | undefined {
  const e = s.element[Math.min(Math.max(lv, 1), s.element.length) - 1] as string;
  return e === "Weapon" || e === "Endowed" ? undefined : (e as Element);
}
/** skill_get_num: hits of the skill at this level (HitCount; 0 counts as 1). */
export const skillHits = (s: Skill, lv: number) => Math.max(1, Math.abs(skillLv(s.hitCount, lv)));

/** The WeaponSkillHit battle.ts playerAttack takes for a weapon skill: ratio, hits, element, range type (from the skill's range),
 *  ammo use, modifyHitRate and Envenom's 15 x lv mastery ATK (battle.cpp:3812). */
export function weaponSkillHit(s: Skill, lv: number, learned: Learned, ctx: RatioCtx = {}): WeaponSkillHit {
  return {
    ratio: skillRatio(s.key, lv, ctx), div: hits2(s.key, ctx.size) ?? skillHits(s, lv), element: skillElement(s, lv),
    range: skillRangeType(skillRange(s, lv, learned)), usesArrow: !!s.ammo,
    hitRate: skillHitRate(s.key, lv), // Far Sight's Renewal hit bonus is the attacker's status vultureHit (every player attack)
    hitBonus: NEVER_MISS_2.has(s.key) || s.damageFlags.includes("IgnoreFlee") ? 1000 : 0, // DamageFlags IgnoreFlee: the hit roll can't fail
    masteryAtk: s.key === "TF_POISON" ? 15 * lv : 0,
  };
}
/** The MagicSkillHit battle.ts magicAttack takes for a magic skill. */
export function magicSkillHit(s: Skill, lv: number, learned: Learned, ctx: RatioCtx = {}): MagicSkillHit {
  return {
    ratio: skillRatio(s.key, lv, ctx), div: skillHits(s, lv), element: skillElement(s, lv) ?? "Neutral",
    range: skillRangeType(skillRange(s, lv, learned)), ignoreDefense: s.damageFlags.includes("IgnoreDefense"),
  };
}

/**
 * skill_calc_heal (skill.cpp:518, RENEWAL) for AL_HEAL without heal bonuses or status changes: level >= max_heal_lv -> max_heal;
 * else (BaseLevel + INT) / 5 x 30 x lv / 10 (integer steps), halved when `heal` is false (the damage against Undead, battle.cpp:5888)
 * or the target is a mercenary, then + a roll of the caster's MATK without equipment MATK bonuses: status_base_matk_min/max
 * (shared/rules/status.ts matkStatus) +/- the weapon MATK variance (rhw.matk * wlv / 10), overrefine min +1 / max + (overrefine - 1),
 * min + rnd() % (max - min).
 */
export function healAmount(lv: number, src: { level: number; int: number; matkStatus: number; rhw: { matk: number; wlv: number }; overrefine: number }, heal = true, r: () => number = Math.random, conf = SKILL_CONF) {
  if (lv >= conf.max_heal_lv) return conf.max_heal;
  let hp = Math.trunc(Math.trunc((Math.trunc((src.level + src.int) / 5) * 30 * lv) / 10));
  if (!heal) hp = Math.trunc(hp / 2);
  let min = src.matkStatus, max = src.matkStatus;
  if (src.rhw.matk > 0) {
    const v = Math.trunc((src.rhw.matk * src.rhw.wlv) / 10);
    min += src.rhw.matk - v; max += src.rhw.matk + v;
  }
  if (src.overrefine > 0) { min++; max += src.overrefine - 1; }
  hp += max > min ? min + Math.floor(r() * (max - min)) : min;
  return hp;
}

/** Cells of a splash around (x, y): skill_get_splash = the SplashArea radius, a square of side 2r+1 (map_foreachinshootrange /
 *  map_foreachinallarea with x - r .. x + r). */
export const inSplash = (cx: number, cy: number, r: number, x: number, y: number) => Math.abs(x - cx) <= r && Math.abs(y - cy) <= r;
