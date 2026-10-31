// Bosses and MVPs — Renewal behaviour re-implemented from rAthena (our own TypeScript, pure functions; server/src/boss.ts owns the room):
//   src/map/mob.cpp  mob_data::get_mvp_player   (the MVP is the attacker with the most damage dealt + taken, mob.cpp:2895)
//   src/map/mob.cpp  mob_dead MVP reward        (MvpExp with the level penalty and attacker bonus, MvpDrops roll; mob.cpp:3437-3537)
//   src/map/mob.cpp  mob_drop_ratio_adjust      (MvpDrops rates after item_rate_mvp / item_drop_mvp_min / _max, mob.cpp:6770)
//   src/map/mob.cpp  MobDatabase::parseBodyNode (MvpExp * mvp_exp_rate, mob.cpp:5090)
//   src/map/mob.cpp  mvptomb_create / _destroy / _delayspawn, npc.cpp run_tomb   (the tomb NPC of a boss_monster line)
//   src/map/mob.cpp  mob_summonslave / mob_countslave / mob_deleteslave          (NPC_SUMMONSLAVE slaves)
//   src/map/mob.cpp  mobskill_use / mobskill_delay                               (the rate / state / condition / delay rules of a mob skill row)
//   src/map/clif.cpp clif_mvp_effect (AREA) / clif_mvp_item / clif_mvp_exp (SELF)  (what the client is told)
// Defaults are the shipped conf/battle (drops.conf, exp.conf, monster.conf, client.conf). The pieces that need the room (the damage
// log, the inventory, the floor, the NPC list, timers) live in server/src/boss.ts; everything here takes plain data and a random source.
import { ITEMS, type Rng } from "./items.ts";
import { EXP_CONF } from "./exp.ts";
import { MAX_EXP, applyRate, levelPenaltyMod } from "./penalty.ts";
import { mobDeadEntries, type DmgLog, type Receiver } from "./dmglog.ts";
import { mobDropAdjust, type BossType } from "./drops.ts";

export const MVP_CONF = {
  mvp_exp_rate: 100, // exp.conf: MvpExp percent (MobDatabase::parseBodyNode)
  item_rate_mvp: 100, // drops.conf: MvpDrops rate percent (mob_drop_ratio_adjust)
  item_drop_mvp_min: 1, item_drop_mvp_max: 10000, // drops.conf: clamp of an adjusted MvpDrops rate
  item_drop_mvp_mode: 0, // 0: the first successful roll in db order, only one prize; 1: same in random order; 2: every successful roll
  mvp_to_loot_priority: false, // drops.conf: the MVP is the loot-priority player instead of the top damage dealer
  drop_rate0item: false, // drops.conf: an adjusted rate of 0 stays 0 (else 1)
  rare_drop_announce: 0, // drops.conf: an MVP prize rolled with a rate <= this (x/10000) is announced server-wide (0 = never)
  mvp_tomb_enabled: true, // monster.conf
  mvp_tomb_delay: 9000, // monster.conf: the tomb shows up this long after the boss died
  mvp_exp_reward_message: true, // client.conf says "no" and then sends the old ZC_MVP_GETTING_SPECIAL_EXP packet (PACKETVER < 20131223);
  //                               we always tell the MVP the amount, as the chat line ("Congratulations! You are the MVP! ...", msg 717)
};
export type MvpConf = typeof MVP_CONF;

/** The boss type the MVP rules look at: only Mvp bosses have an MVP. */
export type MvpMob = { level: number; fixedItemDrop?: boolean; bossType?: string; mvpExp?: number; mvpDrops?: readonly { item: number; rate: number }[] };

/**
 * mob_data::get_mvp_player (mob.cpp:2895-2927): undefined unless the monster is an MVP (MD_MVP). With mvp_to_loot_priority the
 * MVP is just the loot-priority player (`firstCharId`). Otherwise the damage log is walked in order: entries whose character is
 * offline, on another map or dead are skipped, and an entry replaces the leader only when it is strictly higher in
 * dmg + dmg_tanked (so on a tie the older log entry wins). `resolve` = online on this map, like map_charid2sd + sd->m == md->m.
 */
export function mvpPlayer(
  log: DmgLog, bossType: BossType | string, resolve: (charId: number) => Receiver | undefined, firstCharId?: number, conf: MvpConf = MVP_CONF,
): number | undefined {
  if (bossType !== "Mvp") return undefined;
  if (conf.mvp_to_loot_priority) return firstCharId;
  let best = 0, mvp: number | undefined;
  for (const e of log) {
    const r = resolve(e.id);
    if (!r || r.dead) continue; // offline / another map / dead
    const total = Math.min(Number.MAX_SAFE_INTEGER, e.dmg + e.dmgTanked);
    if (best >= total) continue;
    best = total;
    mvp = e.id;
  }
  return mvp;
}

/** MobDatabase::parseBodyNode (mob.cpp:5090): the mob db MvpExp after mvp_exp_rate. */
export const mvpDbExp = (exp: number, conf: MvpConf = MVP_CONF) => Math.trunc(Math.max(0, Math.min(MAX_EXP, (exp * conf.mvp_exp_rate) / 100)));

/**
 * mob_dead MVP EXP (mob.cpp:3445-3465): 0 when the monster has no MvpExp (or the map forbids base EXP); otherwise MvpExp scaled by
 * the MVP's PENALTY_MVP_EXP level penalty (level_penalty.yml has no such table, so 100 %), capped 0..MAX_EXP, plus
 * exp_bonus_attacker % per extra attacker (`count` = the log's online attackers, at most exp_bonus_max_attacker), at least 1.
 */
export function mvpExpReward(
  mob: MvpMob, mvpBaseLevel: number, count: number, opts: { noBaseExp?: boolean } = {}, conf: MvpConf = MVP_CONF, exp = EXP_CONF,
): number {
  const db = mvpDbExp(mob.mvpExp ?? 0, conf);
  if (db <= 0 || opts.noBaseExp) return 0;
  let v = Math.max(0, Math.min(MAX_EXP, applyRate(db, levelPenaltyOf("MvpExp", mvpBaseLevel, mob))));
  if (exp.exp_bonus_attacker > 0 && count > 1) {
    if (count > exp.exp_bonus_max_attacker) count = exp.exp_bonus_max_attacker;
    v += Math.trunc((v * (exp.exp_bonus_attacker * (count - 1))) / 100);
  }
  return Math.max(1, Math.min(MAX_EXP, v));
}
const levelPenaltyOf = (type: "MvpExp" | "MvpDrop", baseLevel: number, mob: MvpMob) => levelPenaltyMod(type, { baseLevel }, mob);

/** The log's `count` for mvpExpReward: attackers online on this map (dead ones included), mob_dead's first loop. */
export const attackerCount = (log: DmgLog, resolve: (charId: number) => Receiver | undefined) => mobDeadEntries(log, resolve).count;

/** mob_drop_ratio_adjust (mob.cpp:6770-6815) for the MvpDrops table: entries with rate 0 (or whose adjusted rate stays 0) are
 *  removed, the rest get mob_drop_adjust(rate, item_rate_mvp, min, max). Unknown items are removed (itemdb_search failure). */
export function mvpDropTable(rows: readonly { item: number; rate: number }[] = [], conf: MvpConf = MVP_CONF) {
  const out: { item: number; rate: number }[] = [];
  for (const r of rows) {
    if (!r.item || !r.rate || !ITEMS.has(r.item) || conf.item_rate_mvp === 0) continue;
    const rate = mobDropAdjust(r.rate, conf.item_rate_mvp, conf.item_drop_mvp_min, conf.item_drop_mvp_max);
    if (rate) out.push({ item: r.item, rate });
  }
  return out;
}

/**
 * mob_dead MVP prize roll (mob.cpp:3467-3537): each entry (db order; shuffled with item_drop_mvp_mode 1) has its table rate scaled by
 * the MVP's PENALTY_MVP_DROP (100 %), capped 0..10000; a rate of 10000 always drops, otherwise `rnd() % 10000 >= rate` skips it
 * (a rate of 0 is 1 unless drop_rate0item). Mode 0 / 1 stop at the first prize, mode 2 gives every one that rolled well.
 * `rate` of a result is the rate it rolled with (rare_drop_announce compares it).
 */
export function rollMvpPrizes(
  table: readonly { item: number; rate: number }[], mvpBaseLevel: number, mob: MvpMob, r: Rng = Math.random, conf: MvpConf = MVP_CONF,
): { item: number; rate: number }[] {
  const penalty = levelPenaltyOf("MvpDrop", mvpBaseLevel, mob);
  const order = [...table];
  if (conf.item_drop_mvp_mode === 1) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const won: { item: number; rate: number }[] = [];
  for (const e of order) {
    if (!e.item || !ITEMS.has(e.item)) continue;
    let temp = Math.max(0, Math.min(10000, applyRate(e.rate, penalty)));
    if (temp !== 10000) {
      if (temp <= 0 && !conf.drop_rate0item) temp = 1;
      if (Math.floor(r() * 10000) >= temp) continue;
    }
    won.push({ item: e.item, rate: temp });
    if (conf.item_drop_mvp_mode !== 2) break;
  }
  return won;
}

/** `rare_drop_announce` (mob.cpp:3510): the MVP prize is announced to the whole server when its rate is at most the setting. */
export const rareDropAnnounced = (rate: number, conf: MvpConf = MVP_CONF) => rate <= conf.rare_drop_announce;

// ---------- tomb ----------
/** mvptomb_create's condition (mob_spawn, mob.cpp:3648): tombs are tied to the SPAWN LINE (`boss_monster`), not to the monster's
 *  mob_db type — a mini boss on a boss_monster line gets one too — and map flag notomb / mvp_tomb_enabled switch them off. */
export const tombWanted = (lineIsBoss: boolean, conf: MvpConf = MVP_CONF, noTomb = false) => conf.mvp_tomb_enabled && lineIsBoss && !noTomb;

/** The killer a tomb names (mob.cpp:3649): the MVP, else the loot-priority player (first_sd), else nobody ("Unknown"). */
export const tombKiller = (mvpName: string | undefined, firstName: string | undefined) => mvpName ?? firstName ?? "";

/** run_tomb (npc.cpp:2184): the tomb dialog, one `mes` page of five lines (msg 657-661). Colours are the dialog's ^RRGGBB codes. */
export function tombLines(mobName: string, killedAt: Date, killer: string): string[] {
  const hh = String(killedAt.getHours()).padStart(2, "0"), mm = String(killedAt.getMinutes()).padStart(2, "0");
  return [`[ ^EE0000${mobName}^000000 ]`, "Has met its demise", `Time of death : ^EE0000${hh}:${mm}^000000`, "Defeated by", `[^EE0000${killer || "Unknown"}^000000]`];
}

// ---------- slaves (NPC_SUMMONSLAVE) ----------
/** One NPC_SUMMONSLAVE row of mob_skill_db as tools/rathena/import.ts writes it (mobs.json `slaves`). */
export type SlaveSkill = {
  state: string; amount: number; rate: number; castTime: number; delay: number; cancelable: boolean; cond: string; condValue: number; ids: readonly number[];
};
/** MOB_SLAVEDISTANCE (mob.hpp:45): slaves appear within, and follow to within, this many cells of the master. */
export const MOB_SLAVEDISTANCE = 2;
/** MIN_MOBLINKTIME-sized grid on which a monster re-checks its idle skills (mob_ai_sub_hard: once per second). */
export const SKILL_CHECK_MS = 1000;

/** mob_summonslave (mob.cpp:3981): the mob ids to spawn, round-robin over the ids; an amount smaller than the id count starts at a
 *  random id (`rndMod(count)` = rnd() % count) and runs that many further, to keep the total. */
export function summonList(ids: readonly number[], amount: number, rndMod: (n: number) => number): number[] {
  const count = ids.length;
  if (count < 1) return [];
  let k = 0;
  if (amount > 0 && amount < count) { k = rndMod(count); amount += k; }
  const out: number[] = [];
  for (; k < amount; k++) out.push(ids[k % count]);
  return out;
}

/** mob_skill_db state names -> our MobState names (mob_setstate skillstate). `any` and `anytarget` are handled by the caller. */
const SKILL_STATE: Record<string, string[]> = {
  idle: ["idle"], walk: ["walk"], loot: ["loot"], attack: ["berserk"], chase: ["rush"],
  follow: [], angry: [], dead: [], // MSS_FOLLOW / MSS_ANGRY (a monster that was not attacked yet) and MSS_DEAD are not modelled: those rows never fire
};

/** status_calc_slave_mode with slaves_inherit_mode 4 (status.cpp:8904): the slave's mode is exactly this, every other bit gone. */
export const SLAVE_MODE = 0x1 /* CANMOVE */ | 0x20 /* NORANDOMWALK */ | 0x80 /* CANATTACK */;
/** MobDatabase / mob_summonslave tries for the slave's free cell: map_search_freecell's default (map.hpp:1166). */
export const FREECELL_TRIES = 50;

/** mob_ai_sub_hard's skill check (mob.cpp:1869-1887): not while the monster is walking; in the attack (berserk) state as soon as its
 *  attack delay is over (ud.attackabletime), otherwise MOB_SKILL_INTERVAL (1000 ms) after the last check. */
export function skillCheckDue(o: { walking: boolean; mobState: string; now: number; attackableAt: number; lastCheck: number }): boolean {
  if (o.walking) return false;
  return o.mobState === "berserk" ? o.now >= o.attackableAt : o.now - o.lastCheck >= SKILL_CHECK_MS;
}
/** mobskill_use state filter (mob.cpp:4310): the row's state is the monster's, `any`, or `anytarget` with a target (not while looting). */
export function skillStateMatches(rowState: string, mobState: string, hasTarget: boolean): boolean {
  if (rowState === "any") return true;
  if (rowState === "anytarget") return hasTarget && mobState !== "loot";
  return (SKILL_STATE[rowState] ?? []).includes(mobState);
}

/** mobskill_use's rate roll (mob.cpp:4320): `rnd() % 10000 > permillage` skips the row, so a rate of 10000 always passes. */
export const skillRateRoll = (rate: number, roll: number) => !(roll > rate);

/** The condition of a slave row (mob.cpp:4355-4362): `slavele N` = at most N slaves alive, `slavelt N` = fewer than N, `always`, and
 *  `onspawn` which only fires from the spawn event (never from the periodic check). */
export function slaveCondition(cond: string, value: number, slaves: number, event: "spawn" | "check"): boolean {
  switch (cond) {
    case "onspawn": return event === "spawn";
    case "always": return event === "check";
    case "slavele": return event === "check" && slaves <= value;
    case "slavelt": return event === "check" && slaves < value;
    default: return false;
  }
}

/** mobskill_delay (mob.cpp:4238-4264): the delay that follows a cast is the FIRST row of the same skill whose state fits the
 *  monster's current state (per skill, not per row) — 0 when none fits. */
export function skillDelayAfter(rows: readonly SlaveSkill[], mobState: string, hasTarget: boolean): number {
  for (const r of rows) if (skillStateMatches(r.state, mobState, hasTarget)) return r.delay;
  return 0;
}

/**
 * mobskill_use for a monster's NPC_SUMMONSLAVE rows (mob.cpp:4290-4360): the first row (file order) whose delay is over, state fits,
 * rate roll passes and condition holds. `roll()` = rnd() % 10000 once per row looked at, like the C++.
 */
export function pickSlaveSkill(
  rows: readonly SlaveSkill[], o: { mobState: string; hasTarget: boolean; slaves: number; event: "spawn" | "check"; now: number; readyAt: number; roll: () => number },
): SlaveSkill | undefined {
  if (o.now < o.readyAt) return undefined;
  for (const r of rows) {
    if (!skillStateMatches(r.state, o.mobState, o.hasTarget)) continue;
    if (!skillRateRoll(r.rate, o.roll())) continue;
    if (slaveCondition(r.cond, r.condValue, o.slaves, o.event)) return r;
  }
  return undefined;
}
