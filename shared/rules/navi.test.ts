// Client navigation (shared/navi.ts): the route may be longer than any single click, but every request the client sends must
// be one the server accepts as a normal walk (shared/map.ts walkPath = unit_walktoxy's checks: path within MAX_WALKPATH,
// at most max_walk_path 17 cells, a clear straight line past OFFICIAL_WALKPATH 14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_WALK_PATH, generateMap, walkPath, walkable } from "../map.ts";
import { naviNextStep, naviRoute, nearestWalkable } from "../navi.ts";

const MAP = generateMap(1337); // the field every room runs today (MAP_SEED 1337)

/** Walk a route the way the client does: request, arrive at the requested cell, request again. */
function drive(from: { x: number; y: number }, to: { x: number; y: number }) {
  const route = naviRoute(MAP, from.x, from.y, to.x, to.y);
  const requests: { x: number; y: number; len: number }[] = [];
  let at = from;
  for (let guard = 0; guard < 100; guard++) {
    const step = naviNextStep(MAP, route, at);
    if (!step) break;
    const len = walkPath(MAP, at.x, at.y, step.x, step.y).length;
    requests.push({ x: step.x, y: step.y, len });
    at = step;
  }
  return { route, requests, end: at };
}

test("a cross-map route is walked as accepted clicks of at most max_walk_path cells", () => {
  const from = { x: 32, y: 32 }; // plaza / save point
  for (const corner of [{ x: 52, y: 52 }, { x: 12, y: 12 }, { x: 52, y: 12 }, { x: 12, y: 52 }]) {
    const to = nearestWalkable(MAP, corner.x, corner.y)!;
    const { route, requests, end } = drive(from, to);
    assert.ok(route.length > MAX_WALK_PATH, `route to ${to.x},${to.y} needs several requests (${route.length} cells)`);
    assert.deepEqual({ x: end.x, y: end.y }, to, `reached ${to.x},${to.y}`);
    for (const r of requests) {
      assert.ok(r.len > 0, `request ${r.x},${r.y} accepted by walkPath`);
      assert.ok(r.len <= MAX_WALK_PATH, `request ${r.x},${r.y} is ${r.len} cells`);
    }
    assert.ok(requests.length >= 2);
  }
});

test("route cells are walkable and diagonals never cut a blocked corner (path.cpp allowed_dirs)", () => {
  const to = nearestWalkable(MAP, 52, 52)!;
  const route = naviRoute(MAP, 32, 32, to.x, to.y);
  let px = 32, py = 32;
  for (const c of route) {
    assert.ok(walkable(MAP, c.x, c.y));
    const dx = c.x - px, dy = c.y - py;
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1);
    if (dx && dy) assert.ok(walkable(MAP, px + dx, py) && walkable(MAP, px, py + dy));
    px = c.x; py = c.y;
  }
});

test("no route to a blocked cell; off-route characters get no step (plan again)", () => {
  let blocked: { x: number; y: number } | undefined;
  for (let y = 0; y < MAP.h && !blocked; y++) for (let x = 0; x < MAP.w && !blocked; x++) if (!walkable(MAP, x, y)) blocked = { x, y };
  assert.ok(blocked);
  assert.deepEqual(naviRoute(MAP, 32, 32, blocked!.x, blocked!.y), []);
  const route = naviRoute(MAP, 32, 32, 32, 20);
  assert.equal(naviNextStep(MAP, route, { x: 50, y: 50 }), null);
  assert.equal(naviNextStep(MAP, route, route[route.length - 1]), null); // arrived
});
