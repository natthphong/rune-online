// Client navigation (RO's navigation system / the quest tracker's auto-walk): the client plans the whole route over the map
// and walks it as a series of ordinary walk requests, each one a click the server accepts unchanged (unit_walktoxy via
// shared/map.ts walkPath: findPath within MAX_WALKPATH, at most max_walk_path cells, a clear line past OFFICIAL_WALKPATH).
// The server never sees anything but normal `move` intents, so its walk rules (and speed) apply to every step.
import { MAX_WALK_PATH, walkPath, walkable, type GameMap } from "./map.ts";

type Cell = { x: number; y: number };
const DIRS: readonly [number, number, number][] = [
  [1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14],
];

/** A* over the whole map (no MAX_WALKPATH limit), 8 directions with the path.cpp rule that a diagonal needs both orthogonal
 *  cells passable, costs 10 / 14. Returns the cells after `from` up to `to`, [] when unreachable or `to` is blocked. */
export function naviRoute(m: GameMap, fx: number, fy: number, tx: number, ty: number): Cell[] {
  if (!walkable(m, tx, ty) || fx < 0 || fy < 0 || fx >= m.w || fy >= m.h) return [];
  if (fx === tx && fy === ty) return [];
  const n = m.w * m.h, g = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  const h = (x: number, y: number) => { const dx = Math.abs(tx - x), dy = Math.abs(ty - y); return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy); };
  const open: number[] = []; // binary heap of cell indexes by f
  const f = new Float64Array(n);
  const push = (i: number) => {
    open.push(i);
    for (let k = open.length - 1; k > 0;) { const p = (k - 1) >> 1; if (f[open[p]] <= f[open[k]]) break; [open[p], open[k]] = [open[k], open[p]]; k = p; }
  };
  const pop = () => {
    const top = open[0], last = open.pop()!;
    if (open.length) {
      open[0] = last;
      for (let k = 0; ;) {
        const l = 2 * k + 1, r = l + 1;
        let s = k;
        if (l < open.length && f[open[l]] < f[open[s]]) s = l;
        if (r < open.length && f[open[r]] < f[open[s]]) s = r;
        if (s === k) break;
        [open[s], open[k]] = [open[k], open[s]]; k = s;
      }
    }
    return top;
  };
  const start = fy * m.w + fx, goal = ty * m.w + tx;
  g[start] = 0; f[start] = h(fx, fy); push(start);
  while (open.length) {
    const cur = pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === goal) break;
    const x = cur % m.w, y = (cur - x) / m.w;
    for (const [dx, dy, c] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!walkable(m, nx, ny)) continue;
      if (dx && dy && (!walkable(m, x + dx, y) || !walkable(m, x, y + dy))) continue;
      const ni = ny * m.w + nx, ng = g[cur] + c;
      if (ng < g[ni]) { g[ni] = ng; parent[ni] = cur; f[ni] = ng + h(nx, ny); push(ni); }
    }
  }
  if (!done[goal]) return [];
  const out: Cell[] = [];
  for (let k = goal; k !== start; k = parent[k]) out.push({ x: k % m.w, y: Math.floor(k / m.w) });
  return out.reverse();
}

/** The next walk request along `route` from the cell the character stands on: the farthest route cell within max_walk_path
 *  cells ahead of the closest route cell that walkPath accepts from `from` (exactly the server's check). null = none (the
 *  character left the route: plan again). */
export function naviNextStep(m: GameMap, route: readonly Cell[], from: Cell): (Cell & { index: number }) | null {
  if (!route.length) return null;
  let at = -1, best = Infinity;
  for (let i = 0; i < route.length; i++) {
    const d = Math.max(Math.abs(route[i].x - from.x), Math.abs(route[i].y - from.y));
    if (d < best || (d === best && i > at)) { best = d; at = i; }
  }
  if (best > 2) return null;
  const last = route.length - 1;
  if (at === last && best === 0) return null; // arrived
  for (let i = Math.min(last, at + MAX_WALK_PATH); i > at || (i === at && best > 0); i--) {
    const c = route[i];
    if (walkPath(m, from.x, from.y, c.x, c.y).length) return { ...c, index: i };
  }
  return null;
}

/** The walkable cell nearest to (x, y) (itself when walkable), searching rings out to `r` cells; null when none. */
export function nearestWalkable(m: GameMap, x: number, y: number, r = 4): Cell | null {
  for (let d = 0; d <= r; d++) {
    for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
      if (walkable(m, x + dx, y + dy)) return { x: x + dx, y: y + dy };
    }
  }
  return null;
}
