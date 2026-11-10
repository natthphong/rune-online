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
/**
 * 2.7.0 "boss feel": a telegraphed area move. The ground warning (Msg.bossTele) shows for windMs, then everyone still inside takes
 * the normal attack's damage x dmgRate (it cannot be dodged by Flee, only by walking out), a knockback away from the centre and an
 * optional stun / slow. Shapes: "circle" (centre = the target's cell locked at the telegraph, or the boss's own cell), "line" (from the
 * boss through the target, `length` cells, half-width r), "sweep" (a disc of radius r around the boss minus `safe` circles of safeR).
 */
export type BossArea = {
  name: string; shape: "circle" | "line" | "sweep"; at: "target" | "self"; r: number;
  /** used when the target is within [minRange, maxRange] cells (Chebyshev) */
  minRange: number; maxRange: number;
  windMs: number; cooldownMs: number; jitterMs: number; dmgRate: number;
  /** ms the boss itself stands winding up (default windMs); shorter = it casts and fights on while the warning runs */
  castMs?: number;
  knockback?: number; stunMs?: number; slowLv?: number; slowMs?: number;
  /** only under this % of max HP (a later phase's move) */
  hpBelow?: number;
  /** circle at the target: the boss jumps onto the centre at the impact */
  leap?: boolean;
  /** several circles: `count` in all, the others scattered within `spread` cells of the target, one every stepMs */
  count?: number; spread?: number; stepMs?: number;
  /** line: its length in cells */
  length?: number;
  /** sweep: how many safe circles and their radius */
  safe?: number; safeR?: number;
  /** a chat line when it starts (the ultimate's warning) */
  text?: string;
};
/** Aggro on sight + never idle (server/src/boss.ts tick): `sight` cells of view (a player seen is targeted at once, Msg.bossAggro),
 *  `runPct` % of the walk time while it has a target (it runs), `opener` = the move used at once on a new target ("charge" or an area
 *  name), `gcdMs` = the least time between two moves, `hopMs` = a reposition hop around its target every so often (and whenever it would
 *  stand idle longer than IDLE_MAX_MS). */
export type BossFeel = { sight: number; runPct: number; opener?: string; gcdMs: number; hopMs: number };
/** Enrage under `below` % of max HP: cooldowns, attack delay and walk time shrink to these %. */
export type BossRage = { below: number; cdPct: number; aspdPct: number; walkPct: number };
/** A boss with a target never stands idle longer than this (ms): the AI hops instead. */
export const IDLE_MAX_MS = 550;
export type BossMoves = {
  spit?: BossSpit; split?: readonly BossSplit[];
  charge?: BossCharge; headbutt?: BossHeadbutt; shouts?: readonly BossShout[];
  /** under this % of max HP the charge cooldown shrinks to ratePct */
  rageBelow?: number;
  feel?: BossFeel; rage?: BossRage; areas?: readonly BossArea[];
};

/** Puddlebloom (1002): the little jelly the Gloopking sheds. */
const PUDDLEBLOOM = 1002;
/** Cragcub (1107): the floor-1 wolf cub, the "kid" Devo calls (a small young beast, low level). */
const KID = 1107;
/** Devo's mob id (tools/rathena/import.ts DEVO_ID), floor 2's dungeon MVP. */
export const DEVO = 3999;

export const BOSS_MOVES: ReadonlyMap<number, BossMoves> = new Map<number, BossMoves>([
  [3810, { // Gloopking, floor 1 MVP (catacombs B3)
    spit: { minRange: 3, maxRange: 10, cooldownMs: 3000, jitterMs: 1500, flightMsPerCell: 90, dmgRate: 100, slowLv: 3, slowMs: 4000 },
    feel: { sight: 12, runPct: 70, opener: "splash", gcdMs: 1400, hopMs: 3200 },
    rage: { below: 30, cdPct: 60, aspdPct: 75, walkPct: 85 },
    areas: [
      // Royal Splash: it leaps at where its target stands and lands on it
      { name: "splash", shape: "circle", at: "target", r: 2, minRange: 2, maxRange: 10, windMs: 1100, cooldownMs: 9000, jitterMs: 2000, dmgRate: 220, knockback: 2, leap: true },
      // Gel Burst: it swells and bursts, throwing everyone in melee back (then spits / leaps after them)
      { name: "burst", shape: "circle", at: "self", r: 3, minRange: 0, maxRange: 2, windMs: 850, cooldownMs: 7500, jitterMs: 2000, dmgRate: 170, knockback: 3 },
      // Gel Rain (under 70 %): six globs fall around the target one after another, each slows
      { name: "rain", shape: "circle", at: "target", r: 1, minRange: 0, maxRange: 10, windMs: 1000, castMs: 500, cooldownMs: 14000, jitterMs: 3000, dmgRate: 140, slowLv: 3, slowMs: 3000, hpBelow: 70, count: 6, spread: 4, stepMs: 220 },
    ],
    split: [
      { hpBelow: 50, ids: [PUDDLEBLOOM], amount: 4, text: "Gloopking quivers and splits apart!" },
      { hpBelow: 25, ids: [PUDDLEBLOOM], amount: 5, text: "Gloopking bursts into a swarm of jellies!" },
    ],
  }],
  [DEVO, { // Devo, floor 2 MVP (Emberhollow Vault): a big horned goat that rams
    charge: { minRange: 4, maxRange: 10, cooldownMs: 7000, jitterMs: 2500, ratePct: 55, windMs: 800, dashMsPerCell: 55, dmgRate: 180, knockback: 3, stunMs: 1500 },
    headbutt: { cooldownMs: 4500, windMs: 450, dmgRate: 170, knockback: 2 },
    feel: { sight: 12, runPct: 78, opener: "charge", gcdMs: 1200, hopMs: 3500 },
    rage: { below: 30, cdPct: 55, aspdPct: 70, walkPct: 85 },
    areas: [
      // Quake Stomp: a shockwave around itself, throws and stuns whoever stays close
      { name: "stomp", shape: "circle", at: "self", r: 3, minRange: 0, maxRange: 3, windMs: 900, cooldownMs: 11000, jitterMs: 2000, dmgRate: 200, knockback: 3, stunMs: 1000 },
      // Rift Line (under 75 %): the ground splits in a line through its target
      { name: "quake", shape: "line", at: "self", r: 1, minRange: 2, maxRange: 9, windMs: 1000, cooldownMs: 13000, jitterMs: 3000, dmgRate: 230, stunMs: 800, hpBelow: 75, length: 10 },
    ],
    split: [{ hpBelow: 50, ids: [KID], amount: 3, text: "Devo bleats and the kids come running!", key: "boss.devo.kids", kind: "stomp" }],
    shouts: [{ hpBelow: 25, text: "Devo is enraged!", key: "boss.devo.rage", kind: "roar" }],
    rageBelow: 50,
  }],
  [4310, { // Morrowgast, floor 3's guardian (shared/floor3.ts): roams Witherwick, the widest skill set of the three floors
    feel: { sight: 12, runPct: 72, opener: "plague", gcdMs: 1000, hopMs: 3000 },
    rage: { below: 35, cdPct: 50, aspdPct: 70, walkPct: 80 },
    areas: [
      // Gravebound Leap: it jumps onto a target that keeps its distance
      { name: "splash", shape: "circle", at: "target", r: 2, minRange: 4, maxRange: 11, windMs: 900, cooldownMs: 10000, jitterMs: 2000, dmgRate: 250, knockback: 2, leap: true },
      // Plague Burst: a cloud bursts under the target, slowing whoever breathes it
      { name: "plague", shape: "circle", at: "target", r: 3, minRange: 3, maxRange: 11, windMs: 1200, cooldownMs: 8000, jitterMs: 2000, dmgRate: 190, slowLv: 5, slowMs: 4000 },
      // Alderman's Cleave: a line through the target
      { name: "cleave", shape: "line", at: "self", r: 1, minRange: 0, maxRange: 5, windMs: 800, cooldownMs: 6000, jitterMs: 1500, dmgRate: 210, length: 7 },
      // Grave Quake: a shockwave around itself
      { name: "stomp", shape: "circle", at: "self", r: 4, minRange: 0, maxRange: 3, windMs: 1050, cooldownMs: 12000, jitterMs: 2000, dmgRate: 240, knockback: 4, stunMs: 1200 },
      // Witchfire Rain (under 60 %): eight fires fall around the target
      { name: "rain", shape: "circle", at: "target", r: 2, minRange: 0, maxRange: 11, windMs: 1100, castMs: 500, cooldownMs: 15000, jitterMs: 3000, dmgRate: 170, hpBelow: 60, count: 8, spread: 6, stepMs: 180 },
    ],
    split: [
      { hpBelow: 50, ids: [4301], amount: 4, text: "Morrowgast tolls the dead bell: the villagers rise!", kind: "roar" },
      { hpBelow: 25, ids: [4301, 4305], amount: 5, text: "Morrowgast tears the graves open!", kind: "roar" },
    ],
  }],
  [4311, { // Ashgrim, floor 3's mini-boss: a horned goat-demon with a scythe. Its ultimate reaps almost the whole field.
    charge: { minRange: 4, maxRange: 10, cooldownMs: 9000, jitterMs: 2500, ratePct: 60, windMs: 700, dashMsPerCell: 50, dmgRate: 170, knockback: 3, stunMs: 1000 },
    feel: { sight: 12, runPct: 75, opener: "cleave", gcdMs: 1100, hopMs: 3200 },
    rage: { below: 30, cdPct: 60, aspdPct: 75, walkPct: 85 },
    areas: [
      // The Long Harvest (under 75 %): the scythe sweeps a disc 16 cells wide; only the three pale circles are safe. 4.5 s to reach one.
      { name: "reap", shape: "sweep", at: "self", r: 16, minRange: 0, maxRange: 12, windMs: 4500, cooldownMs: 38000, jitterMs: 6000, dmgRate: 600, hpBelow: 75, safe: 3, safeR: 2,
        text: "Ashgrim raises its scythe to the sky. RUN to a pale circle!" },
      // Scythe Cleave: a line through the target
      { name: "cleave", shape: "line", at: "self", r: 1, minRange: 0, maxRange: 4, windMs: 750, cooldownMs: 5500, jitterMs: 1500, dmgRate: 200, length: 6 },
    ],
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

// ---------- 2.7.0: telegraphed area moves, aggro on sight, the idle watchdog ----------
export type Shape = { shape: "circle" | "line" | "sweep"; x: number; y: number; r: number; ex?: number; ey?: number; safe?: readonly { x: number; y: number; r: number }[] };
/** How far past its radius a shape still catches a cell's centre (cells). */
const EDGE = 0.25;
/** Whether a unit on cell `c` is inside the shape (the same geometry the client draws, protocol.ts BossTeleEvent). */
export function inShape(s: Shape, c: Cell): boolean {
  const d = Math.hypot(c.x - s.x, c.y - s.y);
  if (s.shape === "circle") return d <= s.r + EDGE;
  if (s.shape === "sweep") return d <= s.r + EDGE && !(s.safe ?? []).some((z) => Math.hypot(c.x - z.x, c.y - z.y) <= z.r + EDGE);
  const ex = s.ex ?? s.x, ey = s.ey ?? s.y, lx = ex - s.x, ly = ey - s.y, len2 = lx * lx + ly * ly;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - s.x) * lx + (c.y - s.y) * ly) / len2));
  return Math.hypot(c.x - (s.x + lx * t), c.y - (s.y + ly * t)) <= s.r + EDGE;
}
/** Whether an area move may start: cooldown over, its phase reached, the target in range (and a clear line for a leap / line). */
export function areaDue(a: BossArea, o: { now: number; readyAt: number; dist: number; hp: number; maxHp: number; clearLine: boolean }): boolean {
  if (o.now < o.readyAt || o.dist < a.minRange || o.dist > a.maxRange) return false;
  if (a.hpBelow !== undefined && o.hp * 100 >= a.hpBelow * o.maxHp) return false;
  return a.leap || a.shape === "line" ? o.clearLine : true;
}
/** A cooldown once enraged (rage.cdPct %), else as is. */
export const ragedMs = (ms: number, rage: BossRage | undefined, raged: boolean) => (rage && raged ? Math.round((ms * rage.cdPct) / 100) : ms);
/** Under rage.below % of max HP (strictly, alive). */
export const isRaged = (m: BossMoves, hp: number, maxHp: number) => !!m.rage && maxHp > 0 && hp > 0 && hp * 100 < m.rage.below * maxHp;
/** The far end of a "line" move: from the boss `a` through the target `t`, `length` cells long (not clipped by walls: the ground
 *  splits under them too). */
export function lineEnd(a: Cell, t: Cell, length: number): Cell {
  const dx = t.x - a.x, dy = t.y - a.y, n = Math.hypot(dx, dy) || 1;
  return { x: Math.round(a.x + (dx / n) * length), y: Math.round(a.y + (dy / n) * length) };
}
/**
 * Where a boss hops to reposition around its target: a walkable cell 1-2 cells (Chebyshev) from the target, not the cell it stands on,
 * at least 2 cells from where it is now when there is one (a real sidestep), picked by `roll`. Undefined = boxed in.
 */
export function hopCell(walkable: (x: number, y: number) => boolean, here: Cell, target: Cell, roll: (n: number) => number, reach = 1): Cell | undefined {
  const near: Cell[] = [], far: Cell[] = [];
  for (let dy = -reach - 1; dy <= reach + 1; dy++) for (let dx = -reach - 1; dx <= reach + 1; dx++) {
    const c = { x: target.x + dx, y: target.y + dy }, d = Math.max(Math.abs(dx), Math.abs(dy));
    if (d < 1 || d > reach || !walkable(c.x, c.y) || (c.x === here.x && c.y === here.y)) continue;
    (Math.max(Math.abs(c.x - here.x), Math.abs(c.y - here.y)) >= 2 ? far : near).push(c);
  }
  const pool = far.length ? far : near;
  return pool.length ? pool[roll(pool.length)] : undefined;
}
/** `count` safe circles for a sweep: walkable cells between 3 and r - 2 cells from the centre, at least 2 * safeR + 2 apart. */
export function safeSpots(walkable: (x: number, y: number) => boolean, c: Cell, r: number, count: number, safeR: number, roll: (n: number) => number): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = [];
  for (let tries = 0; tries < 400 && out.length < count; tries++) {
    const x = c.x - r + roll(2 * r + 1), y = c.y - r + roll(2 * r + 1), d = Math.hypot(x - c.x, y - c.y);
    if (d < 3 || d > r - 2 || !walkable(x, y)) continue;
    if (out.some((z) => Math.hypot(z.x - x, z.y - y) < 2 * safeR + 2)) continue;
    out.push({ x, y, r: safeR });
  }
  return out;
}
