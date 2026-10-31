// Party rules, re-implemented from rAthena (Renewal):
//   src/map/party.cpp     party_create (name), party_exp_share (even split + party_even_share_bonus), party_share_loot (random pick)
//   src/char/int_party.cpp party_check_exp_share / int_party_check_lv (the even-share level range of the ONLINE members)
//   src/map/mob.cpp       mob_dead (pt[]: shares of members of an even-share party are added up per party, before the penalty)
//   conf/battle/party.conf, conf/inter_athena.conf party_share_level
// Pure functions: server/src/party.ts keeps the parties, MapRoom pays the EXP.
import { MAX_EXP } from "./penalty.ts";
import type { ExpShare } from "./dmglog.ts";

/** mmo.hpp MAX_PARTY: members per party. */
export const MAX_PARTY = 12;
/** mmo.hpp NAME_LENGTH 24: a party name is at most 23 characters. */
export const PARTY_NAME_MAX = 23;

export const PARTY_CONF = {
  party_share_level: 15, // inter_athena.conf: max base level gap between online members for even EXP share
  party_even_share_bonus: 0, // party.conf: % more EXP per extra member sharing (0 = official)
  party_update_interval: 1000, // party.conf: ms between position (and hp_mode) updates to members (party_send_xy_timer)
  change_party_leader_samemap: true, // party.conf: the new leader must be on the leader's map
  block_account_in_same_party: true, // party.conf: two characters of one account can't be in one party
  invite_timeout: 30_000, // ours: rAthena keeps sd->party_invite until answered; a client that never answers would block invites
};

/** party_create (party.cpp:144): safestrncpy to NAME_LENGTH, trim; empty = refused. Returns the name to use or undefined. */
export function partyName(raw: unknown): string | undefined {
  const name = String(raw ?? "").slice(0, PARTY_NAME_MAX).trim();
  return name ? name : undefined;
}

/** party_check_exp_share (int_party.cpp:341): even share is allowed with fewer than 2 members online, or when the base levels
 *  of the online members are at most party_share_level apart (offline members don't count, int_party_check_lv). */
export function partyCheckExpShare(onlineLevels: readonly number[], conf = PARTY_CONF): boolean {
  if (onlineLevels.length < 2) return true;
  return Math.max(...onlineLevels) - Math.min(...onlineLevels) <= conf.party_share_level;
}

/** mob_dead (mob.cpp:3167-3229): the receivers whose party has even EXP share pay nothing directly; their (pre-penalty) shares
 *  are added up per party (capped at MAX_EXP) and handed to party_exp_share. `partyOf` = the receiver's party id when that party
 *  shares EXP evenly, else undefined. */
export function partyExpAggregate(shares: readonly ExpShare[], partyOf: (charId: number) => number | undefined) {
  const direct: ExpShare[] = [], parties: { partyId: number; base: number; job: number }[] = [];
  for (const s of shares) {
    const pid = partyOf(s.id);
    if (pid === undefined) { direct.push(s); continue; }
    const t = parties.find((x) => x.partyId === pid);
    if (t) { t.base = Math.min(MAX_EXP, t.base + s.base); t.job = Math.min(MAX_EXP, t.job + s.job); }
    else parties.push({ partyId: pid, base: s.base, job: s.job });
  }
  return { direct, parties };
}

/** party_exp_share (party.cpp:1238-1270): the party's EXP divided among the `count` members on the monster's map who are alive
 *  (integer division, t_exp), then party_even_share_bonus% more per extra member. The Renewal level penalty is applied per
 *  member afterwards (rules/dmglog.ts penalized). count < 1 = nobody gets anything. */
export function partyExpSplit(base: number, job: number, count: number, conf = PARTY_CONF) {
  if (count < 1) return { base: 0, job: 0 };
  base = Math.floor(base / count); job = Math.floor(job / count);
  if (conf.party_even_share_bonus && count > 1) {
    const bonus = 100 + conf.party_even_share_bonus * (count - 1);
    if (base) base = Math.trunc(Math.max(0, Math.min(MAX_EXP, (base * bonus) / 100)));
    if (job) job = Math.trunc(Math.max(0, Math.min(MAX_EXP, (job * bonus) / 100)));
  }
  return { base, job };
}

/** party_share_loot random pick (party.cpp:1336-1355): a random candidate (online on the picker's map, alive); one who can't
 *  carry it (pc_additem fails) is swapped out with the last candidate and the draw repeats. undefined = nobody could take it:
 *  the picker gets it as a plain pickup. `rnd(n)` = rnd_value(0, n - 1). */
export function partyLootPick<T>(candidates: readonly T[], canTake: (c: T) => boolean, rnd: (n: number) => number): T | undefined {
  const c = [...candidates];
  let count = c.length;
  while (count > 0) {
    const i = rnd(count);
    if (canTake(c[i])) return c[i];
    c[i] = c[count - 1];
    count--;
  }
  return undefined;
}
