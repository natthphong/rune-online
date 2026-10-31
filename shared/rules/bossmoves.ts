// Our own floor-boss moves (not an rAthena port; kept data-driven, keyed by mob id, for future floor bosses):
//   spit   a ranged glob at the boss's target when it stands beyond melee reach but within sight: the boss's normal attack
//          damage (battle rules' mobAttack) after the glob's flight, plus an optional short Decrease AGI (the slow);
//   split  once per HP threshold (in % of max HP, highest first) the boss summons its row of slaves around itself with the
//          NPC_SUMMONSLAVE machinery (server/src/boss.ts summon), so they follow, share its target and die with it.
//   charge    (Devo) a telegraphed straight dash at a target 4-10 cells away: the end cell is locked when the telegraph starts (a player
//             who steps out of the lane in time is missed); everyone the boss passes takes damage, a knockback along the dash and a stun;
//   headbutt  (Devo) a melee hit every few seconds: heavy damage and a short knockback;
//   shout     a chat line (+ cue) once per HP threshold; `rageBelow` = under that % of max HP the boss charges more often.
// The server runs them in BossSystem.tick (server/src/boss.ts); the client draws Msg.bossSpit / Msg.bossSplit (client/src/ui/boss.ts).

export type BossSpit = {
  /** cells (Chebyshev, like rAthena's distance): no spit closer than minRange (melee does the work) or farther than maxRange */
  minRange: number; maxRange: number;
  /** ms between two spits, rolled in [cooldownMs, cooldownMs + jitterMs] */
  cooldownMs: number; jitterMs: number;
  /** ms the glob flies per cell (the client draws the arc in the same time) */
  flightMsPerCell: number;
  /** % of the normal attack's damage */
  dmgRate: number;
  /** a short slow on a hit: Decrease AGI at this level for slowMs (0 = none) */
  slowLv: number; slowMs: number;
};
/** `key` = a client locale key for `text` (the English fallback); `kind` = the cue the client draws (default: the jelly burst). */
export type BossSplit = { hpBelow: number; ids: readonly number[]; amount: number; text: string; key?: string; kind?: BossCue };
export type BossCue = "jelly" | "stomp" | "roar";
export type BossShout = { hpBelow: number; text: string; key?: string; kind?: BossCue };
export type BossCharge = {
  /** cells (Chebyshev) to the target: no charge closer than minRange or farther than maxRange */
  minRange: number; maxRange: number;
  /** ms between two charges, rolled in [cooldownMs, cooldownMs + jitterMs]; x ratePct / 100 once enraged */
  cooldownMs: number; jitterMs: number; ratePct: number;
  /** the telegraph before the dash, and the dash's ms per cell */
  windMs: number; dashMsPerCell: number;
  /** % of the normal attack's damage; the knockback (cells, along the dash) and the stun (ms) of everyone hit */
  dmgRate: number; knockback: number; stunMs: number;
};
export type BossHeadbutt = { cooldownMs: number; windMs: number; dmgRate: number; knockback: number };
export type BossMoves = {
  spit?: BossSpit; split?: readonly BossSplit[];
  charge?: BossCharge; headbutt?: BossHeadbutt; shouts?: readonly BossShout[];
  /** under this % of max HP the charge cooldown shrinks to ratePct */
  rageBelow?: number;
};

/** Puddlebloom (1002): the little jelly the Gloopking sheds. */
const PUDDLEBLOOM = 1002;
/** Cragcub (1107): the floor-1 wolf cub, the "kid" Devo calls (a small young beast, low level). */
const KID = 1107;
/** Devo's mob id (tools/rathena/import.ts DEVO_ID), floor 2's dungeon MVP. */
export const DEVO = 3999;

export const BOSS_MOVES: ReadonlyMap<number, BossMoves> = new Map<number, BossMoves>([
  [3810, { // Gloopking, floor 1 MVP (catacombs B3)
    spit: { minRange: 3, maxRange: 9, cooldownMs: 4000, jitterMs: 2000, flightMsPerCell: 90, dmgRate: 100, slowLv: 3, slowMs: 4000 },
    split: [
      { hpBelow: 50, ids: [PUDDLEBLOOM], amount: 4, text: "Gloopking quivers and splits apart!" },
      { hpBelow: 25, ids: [PUDDLEBLOOM], amount: 5, text: "Gloopking bursts into a swarm of jellies!" },
    ],
  }],
  [DEVO, { // Devo, floor 2 MVP (Emberhollow Vault): a big horned goat that rams
    charge: { minRange: 4, maxRange: 10, cooldownMs: 9000, jitterMs: 3000, ratePct: 55, windMs: 800, dashMsPerCell: 55, dmgRate: 150, knockback: 3, stunMs: 1500 },
    headbutt: { cooldownMs: 6000, windMs: 450, dmgRate: 170, knockback: 2 },
    split: [{ hpBelow: 50, ids: [KID], amount: 3, text: "Devo bleats and the kids come running!", key: "boss.devo.kids", kind: "stomp" }],
    shouts: [{ hpBelow: 25, text: "Devo is enraged!", key: "boss.devo.rage", kind: "roar" }],
    rageBelow: 50,
  }],
]);

/** Whether a boss spits now: its cooldown is over, it has a target in [minRange, maxRange] and the straight line to it is clear. */
export function spitDue(s: BossSpit, o: { now: number; readyAt: number; dist: number | undefined; clearLine: boolean }): boolean {
  return o.dist !== undefined && o.now >= o.readyAt && o.dist >= s.minRange && o.dist <= s.maxRange && o.clearLine;
}

/** The glob's flight time over `dist` cells (at least 250 ms so the arc is seen). */
export const spitFlightMs = (s: BossSpit, dist: number) => Math.max(250, Math.round(dist * s.flightMsPerCell));

/** The spit's damage from the normal attack's damage (at least 1 when the attack connected). */
export const spitDamage = (s: BossSpit, dmg: number) => (dmg <= 0 ? 0 : Math.max(1, Math.trunc((dmg * s.dmgRate) / 100)));

/**
 * The split rows to fire now: every row whose threshold the boss's HP has dropped under and that has not fired yet (`fired` = row
 * indexes already used; the caller adds the returned ones). A big hit that crosses two thresholds fires both. HP back over a
 * threshold does not re-arm it: each row fires once per life.
 */
export function splitsDue(rows: readonly { hpBelow: number }[], hp: number, maxHp: number, fired: ReadonlySet<number>): number[] {
  if (maxHp <= 0 || hp <= 0) return [];
  const out: number[] = [];
  rows.forEach((r, i) => { if (!fired.has(i) && hp * 100 < r.hpBelow * maxHp) out.push(i); });
  return out;
}

// ---------- charge / headbutt (Devo) ----------
const sgn = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export type Cell = { x: number; y: number };

/** Whether a boss charges now: cooldown over, a target in [minRange, maxRange] and the straight line to it clear. */
export function chargeDue(c: BossCharge, o: { now: number; readyAt: number; dist: number | undefined; clearLine: boolean }): boolean {
  return o.dist !== undefined && o.now >= o.readyAt && o.dist >= c.minRange && o.dist <= c.maxRange && o.clearLine;
}
/** Next charge delay: the rolled cooldown (`roll` in [0, jitterMs]), shorter once enraged. */
export const chargeCooldown = (c: BossCharge, roll: number, enraged: boolean) => Math.round((c.cooldownMs + roll) * (enraged ? c.ratePct / 100 : 1));
/** Under rageBelow % of max HP (strictly under, like a split row). */
export const isEnraged = (m: BossMoves, hp: number, maxHp: number) => m.rageBelow !== undefined && maxHp > 0 && hp > 0 && hp * 100 < m.rageBelow * maxHp;
/** Whether the headbutt is due: cooldown over and the target adjacent (Chebyshev 1). */
export const headbuttDue = (h: BossHeadbutt, o: { now: number; readyAt: number; dist: number | undefined }) => o.dist !== undefined && o.now >= o.readyAt && o.dist <= 1;
/** A move's damage from the normal attack's damage (0 stays 0, else at least 1). */
export const rateDamage = (ratePct: number, dmg: number) => (dmg <= 0 ? 0 : Math.max(1, Math.trunc((dmg * ratePct) / 100)));

/**
 * The charge's lane: from `a` straight at `t` (8-way line, Bresenham), `extra` cells past the target, never into a wall. The cells
 * after `a` only; it ends one cell short of an unwalkable one, so a lane may be shorter than asked (or empty).
 */
export function chargeLane(walkable: (x: number, y: number) => boolean, a: Cell, t: Cell, extra: number): Cell[] {
  const dx = t.x - a.x, dy = t.y - a.y, n = Math.max(Math.abs(dx), Math.abs(dy));
  if (n === 0) return [];
  const out: Cell[] = [];
  for (let i = 1; i <= n + extra; i++) {
    const c = { x: a.x + Math.round((dx * i) / n), y: a.y + Math.round((dy * i) / n) };
    if (!walkable(c.x, c.y)) break;
    out.push(c);
  }
  return out;
}
/** Whether a unit on `c` is in the way of a boss standing on `at` (the boss's cell and its neighbours). */
export const inLaneReach = (at: Cell, c: Cell) => Math.max(Math.abs(c.x - at.x), Math.abs(c.y - at.y)) <= 1;

/** Where a knockback of `n` cells from `from` (the pusher's cell) lands `to`: straight away, stopping before a wall. */
export function knockbackCell(walkable: (x: number, y: number) => boolean, from: Cell, to: Cell, n: number): Cell {
  let dx = sgn(to.x - from.x), dy = sgn(to.y - from.y);
  if (dx === 0 && dy === 0) dx = 1;
  let c = { ...to };
  for (let i = 0; i < n; i++) {
    const nx = c.x + dx, ny = c.y + dy;
    if (!walkable(nx, ny)) break;
    c = { x: nx, y: ny };
  }
  return c;
}
