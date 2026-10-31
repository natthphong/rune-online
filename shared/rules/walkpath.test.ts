// Golden tests for path_search (A*), path_search_long (path.cpp) and the walk-request checks of unit_walktoxy (unit.cpp).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_WALKPATH, MAX_WALK_PATH, OFFICIAL_WALKPATH, findPath, generateMap, pathSearchLong, walkPath, walkable, type GameMap } from "../map.ts";

function openMap(w: number, h: number, blocked: [number, number][] = []): GameMap {
  const m: GameMap = { w, h, height: new Float32Array(w * h), kind: new Uint8Array(w * h), blocked: new Uint8Array(w * h), props: [] };
  for (const [x, y] of blocked) m.blocked[y * w + x] = 1;
  return m;
}

test("conf values: max_walk_path 17, OFFICIAL_WALKPATH 14", () => {
  assert.equal(MAX_WALK_PATH, 17);
  assert.equal(OFFICIAL_WALKPATH, 14);
});

test("path_search_long steps (0,0)->(4,2) through (1,0),(2,1),(3,1)", () => {
  // dx=4 dy=2 weight=4: wx hits 4 every step, wy every 2nd step -> (1,0) (2,1) (3,1) (4,2)
  assert.equal(pathSearchLong(openMap(8, 8), 0, 0, 4, 2), true);
  assert.equal(pathSearchLong(openMap(8, 8, [[2, 1]]), 0, 0, 4, 2), false);
  assert.equal(pathSearchLong(openMap(8, 8, [[1, 1]]), 0, 0, 4, 2), true); // not on the line
  assert.equal(pathSearchLong(openMap(8, 8, [[4, 2]]), 0, 0, 4, 2), true); // end cells are not checked
  assert.equal(pathSearchLong(openMap(8, 8, [[2, 1]]), 4, 2, 0, 0), false); // swapped so x grows
});

test("max_walk_path: 17 cells walk, 18 are refused", () => {
  const m = openMap(40, 10);
  assert.equal(walkPath(m, 5, 5, 22, 5).length, 17);
  assert.deepEqual(walkPath(m, 5, 5, 23, 5), []);
});

test("OFFICIAL_WALKPATH: more than 14 cells around an obstacle are refused", () => {
  // wall x=12, y=3..7; no corner cutting, so the detour crosses at y=8: (5,5)->(11,8) 6, ->(13,8) 2, ->(20,5) 7 = 15
  const wall: [number, number][] = [3, 4, 5, 6, 7].map((y) => [12, y]);
  const m = openMap(40, 14, wall);
  assert.equal(findPath(m, 5, 5, 20, 5).length, 15);
  assert.deepEqual(walkPath(m, 5, 5, 20, 5), []); // 15 > 14 and the line hits (12,5)
  assert.equal(walkPath(m, 5, 5, 19, 5).length, 14); // 14 cells: allowed even with the line blocked
  assert.equal(walkPath(openMap(40, 14), 5, 5, 20, 5).length, 15); // clear line: up to 17
});

test("seed 1337: (32,32)->(50,32) is 18 cells, refused", () => {
  const m = generateMap(1337);
  assert.equal(findPath(m, 32, 32, 50, 32).length, 18);
  assert.deepEqual(walkPath(m, 32, 32, 50, 32), []);
});

// ---------- path_search (path.cpp:258) ----------
// Hand traces: f = g + 10*(|dx|+|dy|) with g += 10 / 14; neighbours pushed (+1,-1) (+1,0) (+1,+1) (0,+1) (-1,+1) (-1,0)
// (-1,-1) (0,-1) into the BHEAP_PUSH2/POP2 heap (f_cost only; POP2 sifts to the smaller child, the right one on ties).
const cells = (p: { x: number; y: number }[]) => p.map((c) => `${c.x},${c.y}`).join(" ");

test("path_search (5,5)->(8,6) on open ground takes the diagonal first", () => {
  // pop (5,5): heap 34(6,6) 40(5,6) 40(6,5) 54(6,4) 54(4,6) 60(4,5) 74(4,4) 60(5,4)
  // pop (6,6) g14: (7,6) f=24+10=34 rises to the top; pop (7,6) g24: (8,6) f=34+0 -> top; pop target.
  // (the old octile A* walked (6,5) (7,5) (8,6): diagonal last)
  assert.equal(cells(findPath(openMap(40, 12), 5, 5, 8, 6)), "6,6 7,6 8,6");
});

test("path_search (5,5)->(2,7): diagonal first going west too", () => {
  // pop (5,5): (4,6) f=14+30=44 on top; pop (4,6) g14: (3,7) f=28+10=38 beats (4,7) 44 and (3,6) 44;
  // pop (3,7) g28: (2,7) f=38; pop target.
  assert.equal(cells(findPath(openMap(40, 12), 5, 5, 2, 7)), "4,6 3,7 2,7");
});

test("path_search corner rule: no diagonal past a blocked orthogonal cell", () => {
  // (6,5) blocked: from (5,5) the (+1,+1) step needs both (6,5) and (5,6) passable, so it goes (5,6) first.
  assert.equal(cells(findPath(openMap(12, 12, [[6, 5]]), 5, 5, 6, 6)), "5,6 6,6");
  // blocked target and out-of-map start are refused; an unchecked (blocked) start cell is fine
  assert.deepEqual(findPath(openMap(12, 12, [[6, 6]]), 5, 5, 6, 6), []);
  assert.deepEqual(findPath(openMap(12, 12), -1, 5, 6, 6), []);
  assert.equal(cells(findPath(openMap(12, 12, [[5, 5]]), 5, 5, 6, 5)), "6,5");
});

test("map_getcellp: the last row and column are never passable", () => {
  const m = openMap(10, 10);
  assert.equal(walkable(m, 8, 8), true);
  assert.equal(walkable(m, 9, 5), false);
  assert.equal(walkable(m, 5, 9), false);
  assert.deepEqual(findPath(m, 5, 5, 9, 5), []);
});

test("path_search refuses a route longer than MAX_WALKPATH (32) even when reachable", () => {
  assert.equal(MAX_WALKPATH, 32);
  // 30x20 map (every touched cell inside a 32x32 window, so no calc_index collision is possible); wall y=8, x=0..24.
  // (2,6)->(2,10) must pass (25,8): at least 23 + 23 = 46 cells > 32 -> false.
  const wall: [number, number][] = [];
  for (let x = 0; x <= 24; x++) wall.push([x, 8]);
  const m = openMap(30, 20, wall);
  assert.deepEqual(findPath(m, 2, 6, 2, 10), []);
  // (20,6)->(20,10) goes round the same wall end in 12 cells
  assert.equal(cells(findPath(m, 20, 6, 20, 10)), "21,7 22,7 23,7 24,7 25,7 25,8 25,9 24,10 23,10 22,10 21,10 20,10");
});

test("path_search calc_index collisions: (x+1,y-1) aliasing a known node aborts the search", () => {
  // calc_index = (x + 32y) & 1023, so (x+32, y-1) shares a slot with (x, y). Walking east along y=2 from (2,2),
  // the start expansion filled (1,2). Popping (32,2) then pushes (33,1) -> slot of (1,2) is taken -> path_search false.
  const m = openMap(40, 8);
  assert.equal(findPath(m, 2, 2, 32, 2).length, 30); // target popped before (32,2) is expanded
  assert.deepEqual(findPath(m, 2, 2, 33, 2), []); // 31 cells, but rAthena fails here
  // an empty slot reads as cell (0,0) "processed before" with g 0, so (0,0) is never added as a new node
  assert.deepEqual(findPath(openMap(10, 10), 2, 2, 0, 0), []);
  assert.equal(cells(findPath(openMap(10, 10), 2, 2, 0, 1)), "1,1 0,1");
});

test("seed 1337 routes (cross-checked with an independent line-by-line port of path_search)", () => {
  const m = generateMap(1337);
  assert.equal(cells(findPath(m, 34, 28, 37, 29)), "35,29 36,29 37,29"); // old A*: 35,28 36,28 37,29
  assert.equal(cells(findPath(m, 16, 25, 22, 19)), "17,25 18,25 19,24 20,24 21,24 22,23 22,22 22,21 22,20 22,19"); // old: 8 cells
  assert.equal(findPath(m, 13, 28, 29, 21).length, 20); // > max_walk_path 17: the click is refused (old A*: 16, walked)
  assert.deepEqual(walkPath(m, 13, 28, 29, 21), []);
});

test("path_search invariants on seed 1337: every route is a legal walk of at most 32 cells", () => {
  const m = generateMap(1337);
  let rnd = 99, found = 0;
  const r = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
  for (let i = 0; i < 4000; i++) {
    const fx = Math.floor(r() * 64), fy = Math.floor(r() * 64), tx = fx + Math.floor(r() * 41) - 20, ty = fy + Math.floor(r() * 41) - 20;
    if (!walkable(m, fx, fy)) continue;
    const p = findPath(m, fx, fy, tx, ty);
    if (!p.length) continue;
    found++;
    assert.ok(p.length <= MAX_WALKPATH);
    assert.deepEqual(p[p.length - 1], { x: tx, y: ty });
    let px = fx, py = fy;
    for (const c of p) {
      const dx = c.x - px, dy = c.y - py;
      assert.ok(Math.max(Math.abs(dx), Math.abs(dy)) === 1 && walkable(m, c.x, c.y));
      if (dx && dy) assert.ok(walkable(m, px + dx, py) && walkable(m, px, py + dy), "corner cut");
      px = c.x; py = c.y;
    }
  }
  assert.ok(found > 1000);
});
