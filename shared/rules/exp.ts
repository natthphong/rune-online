// EXP, levels and stat points, re-implemented from rAthena src/map/pc.cpp (pc_gainexp, pc_checkbaselevelup,
// pc_checkjoblevelup, pc_nextbaseexp/pc_nextjobexp, pc_gets_status_point, PC_STATUS_POINT_COST RENEWAL_STAT).
import { JOBS, TABLES, type JobKey, type StatKey } from "./data.ts";

export const MAX_LEVEL_BASE_EXP = 99_999_999; // rAthena const.hpp
export const MAX_LEVEL_JOB_EXP = 999_999_999;

/** pc_nextbaseexp (pc.cpp:8644): at max base level the "next" EXP is MAX_LEVEL_BASE_EXP; a missing table row is 0. */
export const nextBaseExp = (job: JobKey, level: number) => level >= JOBS[job].maxBaseLevel ? MAX_LEVEL_BASE_EXP : JOBS[job].baseExp[level - 1] ?? 0;
/** pc_nextjobexp (pc.cpp:8670): same for job level with MAX_LEVEL_JOB_EXP. */
export const nextJobExp = (job: JobKey, jobLevel: number) => jobLevel >= JOBS[job].maxJobLevel ? MAX_LEVEL_JOB_EXP : JOBS[job].jobExp[jobLevel - 1] ?? 0;

/** The gain pc_gainexp reports to the client (clif_displayexp): 0 for a part whose level was already maxed before the gain
 *  (flag&4 base / flag&8 job, pc.cpp:8466-8469, 8526-8529). Call with the progress BEFORE gainExp. */
export function displayedGain(p: Pick<Progress, "job" | "level" | "jobLevel">, base: number, job: number) {
  const j = JOBS[p.job];
  return { base: p.level >= j.maxBaseLevel ? 0 : base, job: p.jobLevel >= j.maxJobLevel ? 0 : job };
}

/** Total stat points owned at a base level (statpoint.yml). Characters start with every stat at 1. */
export const statPointsAt = (level: number) => TABLES.statpoint[level - 1] ?? 0;

/** Renewal cost to raise a stat from `value` to `value + 1`. */
export const statCost = (value: number) => (value < 100 ? 2 + Math.trunc((value - 1) / 10) : 16 + 4 * Math.trunc((value - 100) / 5));

/** Per-job stat cap (pc_maxparameter: job_stats.yml MaxStats, else conf max_parameter; imported into jobs.json). */
export const maxStat = (job: JobKey, stat: StatKey) => JOBS[job].maxStats[stat];

/** pc_statusup(+1): refused at the job's cap (pc_maxparameterincrease) or without enough points. */
export function canRaise(job: JobKey, stat: StatKey, value: number, points: number) {
  return value < maxStat(job, stat) && points >= statCost(value);
}

/** pc_need_status_point(sd, type, 1) (pc.cpp:8809): the cost the Status window shows beside a stat (clif_initialstatus
 *  standardStr.., SP_USTR.. in clif_updatestatus); 0 once the job's cap is reached ("Official servers show '0' when max is reached"). */
export const needStatusPoint = (job: JobKey, stat: StatKey, value: number) => (value >= maxStat(job, stat) ? 0 : statCost(value));

/** pc_statusup(sd,type,increase) planning: pc_maxparameterincrease lowers `amount` to what the points and the job cap
 *  allow (pc_need_status_point summed per step); amount 0 = refused (the caller replies clif_statusupack(false)). */
export function planStatUp(job: JobKey, stat: StatKey, value: number, points: number, amount = 1) {
  const want = Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0;
  let n = 0, cost = 0;
  const cap = maxStat(job, stat);
  while (n < want && value + n < cap && cost + statCost(value + n) <= points) cost += statCost(value + n++);
  return { amount: n, cost };
}

export type Progress = { job: JobKey; level: number; exp: number; jobLevel: number; jobExp: number; statPoints: number; skillPoints: number };

/** EXP battle config, named after rAthena conf/battle/exp.conf keys (defaults = the shipped conf). */
export const EXP_CONF = {
  multi_level_up: false,
  multi_level_up_base: 0, // >0: from this base level on, overflow is capped again even if multi_level_up is on
  multi_level_up_job: 0,
  base_exp_rate: 100, // percent, applied to mob db BaseExp (mob.cpp:5077); see rules/dmglog.ts mobDbExp
  job_exp_rate: 100,
  exp_calc_type: 0 as 0 | 1 | 2, // 0 = share of total damage, 1 = share of max HP, 2 = like 0 but first attacker counts double
  exp_bonus_attacker: 25, // +% share per extra attacker (count - 1)
  exp_bonus_max_attacker: 12, // attackers counted at most for that bonus
  max_exp_gain_rate: 0, // per mille of the next level's EXP one gain may give at most (0 = no cap); see capExpGain
};

/**
 * pc_gainexp's max_exp_gain_rate step (pc.cpp:8495-8507): with the conf on, one gain of each part is cut to
 * max_exp_gain_rate/1000 of that part's next-level EXP (pc_nextbaseexp / pc_nextjobexp before the gain, so MAX_LEVEL_*_EXP
 * at max level). Like the C++ the ratio is a float (`(float)exp / (float)next`) compared with the double rate/1000., and the
 * cap is the double product cast to an integer. Quest EXP (exp_flag 1) is capped too; only param EXP (exp_flag&2) skips it.
 */
export function capExpGain(p: Pick<Progress, "job" | "level" | "jobLevel">, base: number, job: number, conf: Pick<typeof EXP_CONF, "max_exp_gain_rate"> = EXP_CONF) {
  const rate = conf.max_exp_gain_rate;
  if (!rate || (!base && !job)) return { base, job };
  const cap = (exp: number, next: number) =>
    next > 0 && Math.fround(Math.fround(exp) / Math.fround(next)) > rate / 1000 ? Math.trunc((rate / 1000) * next) : exp;
  return { base: cap(base, nextBaseExp(p.job, p.level)), job: cap(job, nextJobExp(p.job, p.jobLevel)) };
}

/** Adds EXP and applies every level-up it causes (pc_gainexp -> pc_checkbaselevelup / pc_checkjoblevelup).
 *  With multi_level_up off (default) the carried remainder is capped at next-1 (pc.cpp:8254-8256, 8329-8331),
 *  so one kill can never give two levels. At max level the EXP keeps accumulating up to the MAX_LEVEL_*_EXP cap. */
export function gainExp(p: Progress, base: number, job: number,
  conf: Pick<typeof EXP_CONF, "multi_level_up" | "multi_level_up_base" | "multi_level_up_job"> = EXP_CONF) {
  let baseUps = 0, jobUps = 0;
  const j = JOBS[p.job];
  p.exp += base;
  for (let need = nextBaseExp(p.job, p.level); need > 0 && p.exp >= need && p.level < j.maxBaseLevel; need = nextBaseExp(p.job, p.level)) {
    p.exp -= need;
    if ((!conf.multi_level_up || (conf.multi_level_up_base > 0 && p.level >= conf.multi_level_up_base)) && p.exp > need - 1) p.exp = need - 1;
    p.statPoints += statPointsAt(p.level + 1) - statPointsAt(p.level);
    p.level++;
    baseUps++;
  }
  if (p.level >= j.maxBaseLevel) p.exp = Math.min(p.exp, MAX_LEVEL_BASE_EXP);
  p.jobExp += job;
  for (let need = nextJobExp(p.job, p.jobLevel); need > 0 && p.jobExp >= need && p.jobLevel < j.maxJobLevel; need = nextJobExp(p.job, p.jobLevel)) {
    p.jobExp -= need;
    if ((!conf.multi_level_up || (conf.multi_level_up_job > 0 && p.jobLevel >= conf.multi_level_up_job)) && p.jobExp > need - 1) p.jobExp = need - 1;
    p.jobLevel++;
    p.skillPoints++;
    jobUps++;
  }
  if (p.jobLevel >= j.maxJobLevel) p.jobExp = Math.min(p.jobExp, MAX_LEVEL_JOB_EXP);
  return { baseUps, jobUps };
}
