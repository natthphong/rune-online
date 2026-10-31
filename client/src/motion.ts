// Where a unit is drawn between the server's 20 Hz patches (patch 2.2.1). The server stays authoritative: it sends the cell a
// unit stands on, how far it has come into the next one (sx / sy, 16ths of a cell) and its facing; this only fills the 50 ms
// between two patches. While a unit walks it keeps going toward the cell it is stepping into (the cell `dir` points at) at its
// measured speed — dead reckoning, like the original client playing a walk packet's path itself — and a patch that disagrees
// with the guess is blended in over ~70 ms instead of snapping. It never runs past the stepping cell unless the caller knows
// the cell after it (the local player: the same path search the server runs, toward the cell it was sent to), and then by at
// most one patch worth of walking, so a unit that stops does not overshoot and slide back. The old smoothing (two chained easings toward the last patch) drew walkers ~0.5 cells
// (~80 ms) behind the server and turned them ~100 ms after it.
//
// Pure (no three.js) so a bench can replay recorded patch traces through it.

/** server dir 0..7 (RO order, 0 = +y, clockwise: shared/protocol.ts dirFromDelta) -> cell step */
const STEP = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
/** default walk speed before one is measured: DEFAULT_WALK_SPEED 150 ms per cell */
const SPEED0 = 1 / 150;
/** how fast a disagreeing patch is blended in (1/s) */
const SETTLE = 14;
/** further than this from the guess (cells), a patch is taken as it is (warp, knockback, respawn) */
const SNAP = 2.5;

export type Motion = {
  /** last patch: drawn spot (cell + sub-cell), the cell it stands on, the cell it steps into (undefined = standing), when */
  px: number; py: number; cx: number; cy: number; nx?: number; ny?: number; at: number;
  /** the cell after the stepping one, when known (local player) */
  ax?: number; ay?: number;
  /** measured walk speed, cells per ms */
  speed: number;
  /** correction still being blended in (drawn - guess) */
  ex: number; ey: number;
  /** what stepMotion returned last */
  x: number; y: number;
};

export function newMotion(x: number, y: number, now: number): Motion {
  return { px: x, py: y, cx: Math.round(x), cy: Math.round(y), at: now, speed: SPEED0, ex: 0, ey: 0, x, y };
}

/** the dead-reckoned spot at `now`: toward the stepping cell, then (when known) one patch worth toward the cell after it */
function guess(m: Motion, now: number) {
  if (m.nx === undefined || m.ny === undefined) return { x: m.px, y: m.py };
  const dx = m.nx - m.px, dy = m.ny - m.py, left = Math.hypot(dx, dy), go = m.speed * Math.max(0, now - m.at);
  if (go <= left) return left < 1e-6 ? { x: m.px, y: m.py } : { x: m.px + (dx / left) * go, y: m.py + (dy / left) * go };
  if (m.ax === undefined || m.ay === undefined) return { x: m.nx, y: m.ny };
  const ex = m.ax - m.nx, ey = m.ay - m.ny, len = Math.hypot(ex, ey), on = Math.min(go - left, m.speed * 50, len);
  return { x: m.nx + (ex / len) * on, y: m.ny + (ey / len) * on };
}

/** a patch arrived: cell (cx, cy) + sub-cell offset (sx, sy), facing `dir`, `moving` = a step timer runs; `after` = the cell
 *  the walk goes to from the stepping cell, if the caller knows it */
export function patchMotion(m: Motion, cx: number, cy: number, sx: number, sy: number, dir: number, moving: boolean, now: number,
  after?: (nx: number, ny: number) => { x: number; y: number } | undefined) {
  const drawn = stepMotion(m, 0, now); // where it is drawn right now, with the old guess
  const x = cx + sx, y = cy + sy;
  const prev = m.nx !== undefined ? { x: m.px, y: m.py, at: m.at } : undefined;
  m.px = x; m.py = y; m.cx = cx; m.cy = cy; m.at = now;
  if (moving) {
    const s = STEP[((dir % 8) + 8) % 8];
    m.nx = cx + s[0]; m.ny = cy + s[1];
    const a = after?.(m.nx, m.ny);
    m.ax = a?.x; m.ay = a?.y;
    // speed from two walking patches in a row, blended slowly (a turn between them reads a little short)
    if (prev && now - prev.at > 20 && now - prev.at < 200) {
      const v = Math.hypot(x - prev.x, y - prev.y) / (now - prev.at);
      if (v > SPEED0 * 0.2 && v < SPEED0 * 4) m.speed += (v - m.speed) * 0.3;
    }
  } else { m.nx = m.ny = m.ax = m.ay = undefined; }
  const g = guess(m, now);
  m.ex = drawn.x - g.x; m.ey = drawn.y - g.y;
  if (Math.hypot(m.ex, m.ey) > SNAP) m.ex = m.ey = 0;
}

/** advance the blend by `dt` seconds and return where to draw the unit at `now` (ms) */
export function stepMotion(m: Motion, dt: number, now: number) {
  const k = Math.exp(-dt * SETTLE);
  m.ex *= k; m.ey *= k;
  const g = guess(m, now);
  m.x = g.x + m.ex; m.y = g.y + m.ey;
  return m;
}

/** the cell the local player last asked to walk to (Msg.move: a click, auto-navigation); undefined after a request that makes
 *  the server walk somewhere else (attack, pickup, skill), so the guess then only runs straight on */
let goal: { x: number; y: number } | undefined;
export function setWalkGoal(c?: { x: number; y: number }) { goal = c && { x: c.x, y: c.y }; }
export const walkGoal = () => goal;
