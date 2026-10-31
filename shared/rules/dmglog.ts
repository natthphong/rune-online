// Monster damage log and how a kill is shared out, re-implemented from rAthena (Renewal):
//   src/map/mob.cpp  mob_log_damage            (who hit / was hit by the monster, DAMAGELOG_SIZE FIFO)
//   src/map/status.cpp status_damage            (which amount gets logged: raw damage, or real damage on exp_calc_type 1)
//   src/map/mob.cpp  mob_dead                   (eligible entries, loot priority, per-attacker EXP share + bonus)
//   src/map/mob.cpp  MobDatabase::parseBodyNode (base_exp_rate / job_exp_rate applied to the mob db)
// The log is plain data: the server keeps one per monster (server-only), the rules here never touch room state.
import { EXP_CONF } from "./exp.ts";
import { applyExpPenalty, levelPenaltyMod, MAX_EXP, type PenaltyMapFlags } from "./penalty.ts";

/** rAthena map.hpp DAMAGELOG_SIZE: entries kept per monster; a new attacker beyond that pushes out the oldest. */
export const DAMAGELOG_SIZE = 20;

/** s_dmglog flag (MDLF_*): normal = the character itself; self = damage the monster "lost" before a revive (mob_revive).
 *  Homunculus / pet / mercenary shares (MDLF_HOMUN / MDLF_PET) get their own flag values once those units exist. */
export type DmgLogFlag = "normal" | "self";

/** s_dmglog (mob.hpp): `id` is the character id (char_id), so a character who relogs onto the map is the same attacker. */
export type DmgLogEntry = { id: number; flag: DmgLogFlag; dmg: number; dmgTanked: number };
export type DmgLog = DmgLogEntry[];

/** drops.conf first_attack_loot_bonus: extra loot-priority damage (percent of the total) for the first entry in the log. */
export const LOOT_CONF = { first_attack_loot_bonus: 30 };

/** mob_log_damage (mob.cpp:2672): add `damage` dealt to / `tanked` taken from the monster to the attacker's entry, creating it
 *  at the newest end (dropping the oldest when the log is full). Negative values (absorbed) are ignored. A 0/0 interaction
 *  is still logged for a player (players are always DEFAULT_ENEMY_TYPE), so it counts as an attacker. */
export function mobLogDamage(log: DmgLog, id: number, damage: number, tanked = 0, flag: DmgLogFlag = "normal") {
  if (damage < 0 || tanked < 0 || !id) return;
  const e = log.find((x) => x.id === id && x.flag === flag);
  if (e) { e.dmg = Math.min(MAX_EXP, e.dmg + damage); e.dmgTanked = Math.min(MAX_EXP, e.dmgTanked + tanked); return; }
  if (log.length >= DAMAGELOG_SIZE) log.shift();
  log.push({ id, flag, dmg: damage, dmgTanked: tanked });
}

/** status_damage (status.cpp:1492, 1620-1626): the amount passed to mob_damage. The monster loses at most its current HP, but
 *  the log gets the ORIGINAL damage (overkill included) unless exp_calc_type is 1, which needs the real damage. */
export const loggedDamage = (damage: number, hpBefore: number, conf = EXP_CONF) =>
  conf.exp_calc_type === 1 ? Math.min(damage, hpBefore) : damage;

/** MobDatabase::parseBodyNode (mob.cpp:5077 / 5086): mob db EXP after exp.conf base_exp_rate / job_exp_rate. */
export const mobDbExp = (exp: number, rate: number) => Math.trunc(Math.max(0, Math.min(MAX_EXP, (exp * rate) / 100)));

/** What mob_dead needs to know about the character behind a log entry (map_charid2sd + sd->m == md->m + pc_isdead).
 *  undefined = offline or on another map. */
export type Receiver = { baseLevel: number; dead: boolean };

/** mob_dead first loop (mob.cpp:2985-3005): `count` = entries whose character is online on this map (dead ones and
 *  self-damage included), `total` = damage of every entry (offline ones included), `eligible[i]` = entry i may receive
 *  EXP/loot (online, on this map, alive; tmpsd[i]). */
export function mobDeadEntries(log: DmgLog, resolve: (id: number) => Receiver | undefined) {
  let count = 0, total = 0;
  const eligible: boolean[] = [];
  for (const e of log) {
    total = Math.min(MAX_EXP, total + e.dmg);
    eligible.push(false);
    if (e.flag === "self") { count++; continue; }
    const r = resolve(e.id);
    if (!r) continue;
    count++;
    if (r.dead) continue;
    eligible[eligible.length - 1] = true;
  }
  return { count, total, eligible };
}

/** mob_dead loot priority (mob.cpp:3008-3054): eligible characters ranked by damage, the first entry in the log getting
 *  `first_attack_loot_bonus`% of the total damage on top (integer division, int64). Returns up to 3 char ids
 *  [first_sd, second_sd, third_sd] — the owners of the dropped items' pickup priority. */
export function lootOwners(log: DmgLog, resolve: (id: number) => Receiver | undefined, conf = LOOT_CONF): number[] {
  const { total, eligible } = mobDeadEntries(log, resolve);
  const loot: { id: number; dmg: number }[] = [];
  log.forEach((e, i) => {
    if (!eligible[i]) return;
    const l = loot.find((x) => x.id === e.id);
    if (l) l.dmg += e.dmg; else loot.push({ id: e.id, dmg: e.dmg });
  });
  if (!loot.length) return [];
  loot[0].dmg += Math.trunc((total * conf.first_attack_loot_bonus) / 100);
  return loot.sort((a, b) => b.dmg - a.dmg).slice(0, 3).map((x) => x.id); // std::sort is not stable; ties are rare
}

/** Map flags that touch kill EXP: MF_NOBASEEXP / MF_NOJOBEXP, MF_BEXP / MF_JEXP (percent, default 100) + the Renewal
 *  penalty switches. */
export type ExpMapFlags = PenaltyMapFlags & { noBaseExp?: boolean; noJobExp?: boolean; bexp?: number; jexp?: number };

export type ExpMob = { level: number; baseExp: number; jobExp: number; hp: number };
export type ExpShare = { id: number; base: number; job: number };

/**
 * mob_dead EXP distribution (mob.cpp:3073-3219) for every eligible entry, in log order:
 *   per = dmg / total_damage (exp_calc_type 0/2; type 1 or no damage at all: dmg / max_hp), capped at 1;
 *   count > 1 -> per += per * (min(count, exp_bonus_max_attacker) - 1) * exp_bonus_attacker / 100;
 *   exp = cap(db_exp * per * bonus% * map%, 1, MAX_EXP)  (a logged attacker with 0 damage still gets 1);
 *   then the receiver's Renewal level penalty (applyExpPenalty) right before pc_gainexp.
 * exp_calc_type 2 first doubles the first entry's damage (and adds it to the total) when count > 1.
 * `bonus` is the common bonus on top of every share (SC_RICHMANKIM, Star Gladiator feel, mobs_level_up), 100 = none.
 * Homunculus / pet shares are not modelled yet. A party with even EXP share takes the shares BEFORE the level penalty
 * (mobDeadShares + rules/party.ts partyExpAggregate); everything else is paid as returned here.
 */
export function mobDeadExp(
  log: DmgLog,
  mob: ExpMob,
  resolve: (id: number) => Receiver | undefined,
  conf = EXP_CONF,
  map: ExpMapFlags = {},
  bonus = 100,
): ExpShare[] {
  return mobDeadShares(log, mob, resolve, conf, map, bonus).map((s) => ({ id: s.id, ...penalized(s, resolve(s.id)!, mob, map) }));
}

/** The Renewal level penalty a receiver's share gets right before pc_gainexp (mob.cpp:3203-3211 / party.cpp:1276-1283). */
export function penalized(s: { base: number; job: number }, r: { baseLevel: number }, mob: ExpMob, map: ExpMapFlags = {}) {
  return applyExpPenalty(s.base, s.job, levelPenaltyMod("Exp", { baseLevel: r.baseLevel }, mob, map));
}

/** mob_dead's per-entry `base_exp` / `job_exp` (mob.cpp:3073-3165), before the receiver's level penalty: what a party with
 *  even EXP share adds up (pt[].base_exp) and what mobDeadExp pays directly after the penalty. */
export function mobDeadShares(
  log: DmgLog,
  mob: ExpMob,
  resolve: (id: number) => Receiver | undefined,
  conf = EXP_CONF,
  map: ExpMapFlags = {},
  bonus = 100,
): ExpShare[] {
  const dmg = log.map((e) => e.dmg);
  let { count, total, eligible } = mobDeadEntries(log, resolve);
  if (conf.exp_calc_type === 2 && count > 1 && dmg.length) { total = Math.min(MAX_EXP, total + dmg[0]); dmg[0] = Math.min(MAX_EXP, dmg[0] * 2); }
  const baseDb = mobDbExp(mob.baseExp, conf.base_exp_rate), jobDb = mobDbExp(mob.jobExp, conf.job_exp_rate);
  const out: ExpShare[] = [];
  for (let i = 0; i < log.length; i++) {
    if (!eligible[i]) continue;
    let per = conf.exp_calc_type === 1 || total === 0 ? dmg[i] / mob.hp : dmg[i] / total;
    if (per > 1) per = 1;
    // (count -= md->state.rebirth: no monster revives yet)
    if (count > 1 && conf.exp_bonus_attacker) {
      if (count > conf.exp_bonus_max_attacker) count = conf.exp_bonus_max_attacker;
      per += (per * ((count - 1) * conf.exp_bonus_attacker)) / 100;
    }
    const share = (db: number, off: boolean | undefined, mapRate = 100) =>
      off || !db ? 0 : Math.trunc(Math.max(1, Math.min(MAX_EXP, applyRateD(applyRateD(applyRate2(db, per, 1), bonus), mapRate))));
    const base = share(baseDb, map.noBaseExp, map.bexp), job = share(jobDb, map.noJobExp, map.jexp);
    if (!base && !job) continue;
    out.push({ id: log[i].id, base, job });
  }
  return out;
}

/** utils.hpp apply_rate on a double (mob_dead's `double exp`): no integer truncation. */
const applyRateD = (val: number, rate: number) => (rate === 100 ? val : val > 100000 ? (val / 100) * rate : (val * rate) / 100);

/** utils.hpp apply_rate2(val, rate, per) with a fractional rate (mob_dead passes the share as the rate and 1 as `per`). */
const applyRate2 = (val: number, rate: number, per: number) =>
  rate === per ? val : val > 100000 ? Math.trunc(val / per) * rate : (val * rate) / per;
