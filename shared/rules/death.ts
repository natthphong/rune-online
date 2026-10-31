// Death / respawn rules, re-implemented from rAthena:
//   src/map/status.cpp status_calc_pc "RESPAWN HP/SP" (base_status->hp / ->sp for a respawn)
//   src/map/pc.cpp pc_setrestartvalue (type&1: hp=1 then status_heal(+hp), SP raised only if lower; else saved as-is)
//   src/map/pc.cpp pc_dead penalty block + pc_lostexp (death_penalty_type 1/2)
// Config keys are named after conf/battle/player.conf and exp.conf (defaults = the shipped conf).
import { JOBS, type JobKey } from "./data.ts";
import { nextBaseExp, nextJobExp } from "./exp.ts";

export const DEATH_CONF = {
  restart_hp_rate: 0, // player.conf
  restart_sp_rate: 0,
  death_penalty_type: 1, // exp.conf: 0 off, 1 % of next level EXP, 2 % of current EXP
  death_penalty_base: 100, // in 1/10000 (100 = 1%)
  death_penalty_job: 100,
  death_penalty_maxlv: 0, // bit 1: also at max base level, bit 2: also at max job level
};

/** Respawn base HP/SP of status_calc_pc (what is saved for a character that logs out dead). A Novice with
 *  restart_hp_rate < 50 gets max_hp/2 (integer division); everyone else max_hp * rate / 100. Both minimum 1. */
export function restartBase(job: JobKey, maxHp: number, maxSp: number, conf = DEATH_CONF) {
  let hp = job === "Novice" && conf.restart_hp_rate < 50 ? Math.trunc(maxHp / 2) : Math.trunc(maxHp * conf.restart_hp_rate / 100);
  if (!hp) hp = 1;
  let sp = Math.trunc(maxSp * conf.restart_sp_rate / 100);
  if (!sp) sp = 1;
  return { hp, sp };
}

/** pc_setrestartvalue(type 3) as used by pc_respawn: HP = 1 + base respawn HP (status_heal after hp=1), capped at
 *  max; SP only rises to the base respawn SP, never drops. */
export function restartValues(job: JobKey, maxHp: number, maxSp: number, curSp: number, conf = DEATH_CONF) {
  const b = restartBase(job, maxHp, maxSp, conf);
  return { hp: Math.min(maxHp, 1 + b.hp), sp: Math.min(maxSp, Math.max(curSp, b.sp)) };
}

/** pc_dead EXP penalty. Novices are exempt. Per kind: skipped at max level (unless death_penalty_maxlv bit set);
 *  type 1 = trunc(next EXP * rate/10000.), type 2 = trunc(current EXP * rate/10000.); capped at current EXP. */
export function deathPenalty(p: { job: JobKey; level: number; exp: number; jobLevel: number; jobExp: number }, conf = DEATH_CONF) {
  if (!conf.death_penalty_type || p.job === "Novice") return { base: 0, job: 0 };
  const j = JOBS[p.job];
  const calc = (rate: number, next: number, cur: number) => {
    if (rate <= 0) return 0;
    const v = Math.trunc((conf.death_penalty_type === 1 ? next : cur) * (rate / 10000));
    return Math.min(cur, v);
  };
  const base = (conf.death_penalty_maxlv & 1 || p.level < j.maxBaseLevel) ? calc(conf.death_penalty_base, nextBaseExp(p.job, p.level), p.exp) : 0;
  const job = (conf.death_penalty_maxlv & 2 || p.jobLevel < j.maxJobLevel) ? calc(conf.death_penalty_job, nextJobExp(p.job, p.jobLevel), p.jobExp) : 0;
  return { base, job };
}
