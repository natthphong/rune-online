// Golden tests for shared/rules/walk.ts, worked out by hand from rAthena src/map/unit.cpp (unit_walktoxy 841-913,
// unit_walktoxy_sub 254-306, unit_walktoxy_nextcell 226-238, unit_stop_walking 1695-1757, unit_stop_walking_soon 1636-1690,
// unit_set_walkdelay 2003-2061, unit_data::update_pos 1532-1585) and conf/battle (client.conf max_walk_path 17,
// battle.conf attack_walk_delay).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BL } from "./battle.ts";
import type { GameMap } from "../map.ts";
import {
  USW, WALK_CONF, attackWalkDelay, delayedWalkAt, exactCell, pastHalfStep, searchPath, skillWalkDelay, stepProgress, stepTime,
  stopSoonRemain, walkRequestPath, walkSubPath, cellStackExceeded, nearbyFreecell, westClickBlocked,
} from "./walk.ts";
import { pcDefersAttack, stepActionDelay } from "./unit.ts";

function openMap(w: number, h: number, blocked: [number, number][] = []): GameMap {
  const m: GameMap = { w, h, height: new Float32Array(w * h), kind: new Uint8Array(w * h), blocked: new Uint8Array(w * h), props: [] };
  for (const [x, y] of blocked) m.blocked[y * w + x] = 1;
  return m;
}
const c = (x: number, y: number) => ({ x, y });

test("USW flags = e_unit_stop_walking (unit.hpp:104-109)", () => {
  assert.deepEqual(USW, { NONE: 0, FIXPOS: 1, MOVE_ONCE: 2, MOVE_FULL_CELL: 4, FORCE_STOP: 8, RELEASE_TARGET: 16 });
});

test("stepTime: speed ms a cell, a diagonal speed * 14 / 10 in integer math (unit_walktoxy_nextcell)", () => {
  assert.equal(stepTime(150, c(5, 5), c(6, 5)), 150); // DEFAULT_WALK_SPEED: a Novice's straight step
  assert.equal(stepTime(150, c(5, 5), c(5, 4)), 150);
  assert.equal(stepTime(150, c(5, 5), c(6, 6)), 210); // 150 * 14 / 10
  assert.equal(stepTime(400, c(5, 5), c(4, 6)), 560); // a speed-400 monster (Puddlebloom)
  assert.equal(stepTime(200, c(5, 5), c(4, 4)), 280);
  assert.equal(stepTime(175, c(5, 5), c(6, 4)), 245); // 2450 / 10
  assert.equal(stepTime(133, c(5, 5), c(6, 6)), 186); // 1862 / 10 = 186.2 -> 186
  // six cells east take 150 each: the cell changes at +150 +300 ... +900; six diagonal cells at +210 ... +1260
  let t = 0; const east: number[] = [], diag: number[] = [];
  for (let i = 0; i < 6; i++) east.push(t += stepTime(150, c(i, 0), c(i + 1, 0)));
  t = 0;
  for (let i = 0; i < 6; i++) diag.push(t += stepTime(150, c(i, i), c(i + 1, i + 1)));
  assert.deepEqual(east, [150, 300, 450, 600, 750, 900]);
  assert.deepEqual(diag, [210, 420, 630, 840, 1050, 1260]);
});

test("walk request vs unit_walktoxy_sub: max_walk_path 17 only on the request, OFFICIAL_WALKPATH on both", () => {
  assert.equal(WALK_CONF.max_walk_path, 17);
  const open = openMap(60, 12);
  assert.equal(walkRequestPath(open, c(5, 5), c(22, 5))!.length, 17); // 17 cells: accepted
  assert.equal(walkRequestPath(open, c(5, 5), c(23, 5)), null); // 18 > max_walk_path: refused
  assert.equal(walkSubPath(open, c(5, 5), c(23, 5))!.length, 18); // the re-search when a step ends has no 17-cell limit
  assert.equal(walkSubPath(open, c(5, 5), c(30, 5))!.length, 25); // only path_search's own limits (MAX_WALKPATH, node table)
  assert.equal(walkRequestPath(open, c(5, 5), c(30, 5)), null);
  // wall x=12, y=3..7: the detour to (20,5) is 15 cells (> 14) with the straight line through (12,5) blocked
  const wall = openMap(40, 14, [3, 4, 5, 6, 7].map((y) => [12, y] as [number, number]));
  assert.equal(walkRequestPath(wall, c(5, 5), c(20, 5)), null);
  assert.equal(walkSubPath(wall, c(5, 5), c(20, 5)), null); // OFFICIAL_WALKPATH holds for the re-search too
  assert.equal(walkRequestPath(wall, c(5, 5), c(19, 5))!.length, 14); // 14 cells: allowed with the line blocked
  assert.equal(walkRequestPath(wall, c(5, 5), c(20, 5), true)!.length, 15); // NPCs skip both checks (bl->type != BL_NPC)
});

test("path_search's same-cell case: path_len 0 (the request is accepted), unless the cell is impassable", () => {
  const m = openMap(10, 10, [[3, 3]]);
  assert.deepEqual(searchPath(m, c(5, 5), c(5, 5)), []);
  assert.deepEqual(walkRequestPath(m, c(5, 5), c(5, 5)), []);
  assert.equal(searchPath(m, c(3, 3), c(3, 3)), null); // map_getcellp(x1, y1) is checked even for the start cell as target
  assert.equal(searchPath(m, c(5, 5), c(3, 3)), null);
});

test("flag 4: a walk request within the walk delay runs at canmove_tick + 1, if that is less than 2 s away", () => {
  assert.equal(delayedWalkAt(1590, 1000), 1591); // a Novice's swing at 1000, amotion 590: the walk starts at 1591
  assert.equal(delayedWalkAt(1000, 1000), undefined); // DIFF_TICK = 0: not delayed, walks now
  assert.equal(delayedWalkAt(900, 1000), undefined);
  assert.equal(delayedWalkAt(2999, 1000), 3000); // 1999 ms ahead: still delayed
  assert.equal(delayedWalkAt(3000, 1000), undefined); // 2000 ms ahead: not delayed (unit_can_move then refuses it)
});

test("unit_set_walkdelay type 1: canmove = tick + delay, never shortened; bosses ignore it; attack_walk_delay for players", () => {
  assert.equal(skillWalkDelay(0, 1000, 590), 1590);
  assert.equal(skillWalkDelay(2000, 1000, 590), 2000); // DIFF_TICK(canmove, tick + delay) > 0: kept
  assert.equal(skillWalkDelay(1590, 1000, 590), 1590);
  assert.equal(skillWalkDelay(1200, 1000, 590), 1590); // a shorter one is replaced
  assert.equal(skillWalkDelay(0, 1000, 590, true), 0); // MD_STATUSIMMUNE monster: skill-induced delay ignored
  assert.equal(skillWalkDelay(500, 1000, 0), 500); // delay <= 0: nothing
  assert.equal(attackWalkDelay(BL.PC), true);
  assert.equal(attackWalkDelay(BL.MOB), false); // monsters: their AI already pauses for amotion (mob_set_delay)
});

test("USW_MOVE_FULL_CELL: the step finishes when its timer is due within td->data / 2", () => {
  assert.equal(pastHalfStep(1150, 150, 1075), true); // 75 left of 150
  assert.equal(pastHalfStep(1150, 150, 1074), false); // 76 left
  assert.equal(pastHalfStep(1210, 210, 1105), true); // diagonal: 105 = 210 / 2
  assert.equal(pastHalfStep(1210, 210, 1104), false);
  assert.equal(pastHalfStep(1175, 175, 1088), true); // 175 / 2 = 87 (integer): 87 left
  assert.equal(pastHalfStep(1175, 175, 1087), false); // 88 left
});

test("update_pos: the exact cell crosses the border half way through the step (sub-cell 24 + dir * 16 * percent)", () => {
  assert.equal(stepProgress(1150, 150, 1075), 0.5);
  assert.equal(stepProgress(1150, 150, 900), 0);
  assert.equal(stepProgress(1150, 150, 1200), 1);
  // east: 24 + 16 * 0.5 = 32 > 31 -> x + 1; 24 + 16 * 0.49 = 31.84 -> 31 -> same cell
  assert.deepEqual(exactCell(c(10, 10), c(11, 10), 0.5), c(11, 10));
  assert.deepEqual(exactCell(c(10, 10), c(11, 10), 0.49), c(10, 10));
  // west: 24 - 8 = 16 is still this cell; 24 - 16 * 0.51 = 15.84 -> 15 < 16 -> x - 1
  assert.deepEqual(exactCell(c(10, 10), c(9, 10), 0.5), c(10, 10));
  assert.deepEqual(exactCell(c(10, 10), c(9, 10), 0.51), c(9, 10));
  assert.deepEqual(exactCell(c(10, 10), c(11, 11), 0.5), c(11, 11)); // a diagonal crosses on both axes at once
  assert.deepEqual(exactCell(c(10, 10), c(11, 10), 1), c(11, 10)); // cell_percent >= 1: exactly one cell moved
  assert.deepEqual(exactCell(c(10, 10), c(11, 10), 0), c(10, 10));
});

test("unit_stop_walking_soon: what is left under one cell, else 1 more cell, 2 once across the border", () => {
  assert.equal(stopSoonRemain(0, 1, false), 1); // last step running: finish it
  assert.equal(stopSoonRemain(1, 1, false), 0); // walk already over
  assert.equal(stopSoonRemain(0, 5, false), 1);
  assert.equal(stopSoonRemain(0, 5, true), 2);
  assert.equal(stopSoonRemain(3, 5, true), 2); // path_pos 3 + 2 = path_len: nothing to shorten
  assert.equal(stopSoonRemain(4, 5, true), 1); // path_pos + 1 >= path_len: path_len - path_pos
});

test("unit_attack step action: during a step the attack waits unless the target is within battle_check_range(range - 1)", () => {
  const m = openMap(40, 40);
  // Knife (range 1): range - 1 = 0 on the client's circular distance -> only the same or an orthogonally adjacent cell
  assert.equal(pcDefersAttack(m, c(14, 20), c(15, 20), 1, true), false); // distance_client(1,0) = trunc(0.9) = 0: attack now
  assert.equal(pcDefersAttack(m, c(13, 20), c(15, 20), 1, true), true); // (2,0) = trunc(1.9) = 1 > 0: remembered
  assert.equal(pcDefersAttack(m, c(14, 20), c(15, 21), 1, true), true); // (1,1) = trunc(1.314) = 1 > 0
  assert.equal(pcDefersAttack(m, c(13, 20), c(15, 20), 1, false), false); // standing: the attack timer runs at once
  // range 2: (2,0) -> 1 <= 1 now; (2,1) -> trunc(2.136) = 2 > 1 remembered
  assert.equal(pcDefersAttack(m, c(13, 20), c(15, 20), 2, true), false);
  assert.equal(pcDefersAttack(m, c(13, 20), c(15, 21), 2, true), true);
  // bow range 9: (9,0) -> trunc(8.9) = 8 <= 8; (10,0) -> 9 > 8
  assert.equal(pcDefersAttack(m, c(10, 10), c(19, 10), 9, true), false);
  assert.equal(pcDefersAttack(m, c(10, 10), c(20, 10), 9, true), true);
});

test("unit_walktoxy_timer: a step action is retried half the finished step later (speed / 2, diagonal speed*14/10/2)", () => {
  assert.equal(stepActionDelay(150), 75); // a Novice's straight step
  assert.equal(stepActionDelay(210), 105); // 150 * 14 / 10 / 2
  assert.equal(stepActionDelay(400), 200);
  assert.equal(stepActionDelay(175), 87); // integer division
});

test("official_cell_stack_limit 1: more than one standing unit on the cell where a walk ends moves it on", () => {
  assert.equal(WALK_CONF.official_cell_stack_limit, 1); // conf/battle/misc.conf:103
  assert.equal(cellStackExceeded(1), false); // only the unit that just stopped
  assert.equal(cellStackExceeded(2), true);
  assert.equal(cellStackExceeded(5, { ...WALK_CONF, official_cell_stack_limit: 0 }), false); // 0 = off
});

test("clif_parse_WalkToXY: a click one cell west onto a cell with a standing unit is dropped", () => {
  assert.equal(westClickBlocked(c(21, 20), c(20, 20), 1), true);
  assert.equal(westClickBlocked(c(21, 20), c(20, 20), 0), false); // free cell
  assert.equal(westClickBlocked(c(19, 20), c(20, 20), 1), false); // one cell east: allowed (the walk end moves it on)
  assert.equal(westClickBlocked(c(21, 20), c(20, 21), 1), false); // diagonal
  assert.equal(westClickBlocked(c(21, 20), c(20, 20), 1, { ...WALK_CONF, official_cell_stack_limit: 0 }), false);
});

test("map_nearby_freecell: first free passable neighbour in one of two orders (NE E SE S N SW W NW / SW W NW N S NE E SE)", () => {
  const occ = (cells: [number, number][]) => (x: number, y: number) => cells.filter(([a, b]) => a === x && b === y).length;
  const m = openMap(10, 10);
  assert.deepEqual(nearbyFreecell(m, 5, 5, occ([[5, 5]]), 0), c(6, 6)); // DIR_NORTHEAST = (+1, +1)
  assert.deepEqual(nearbyFreecell(m, 5, 5, occ([[5, 5]]), 1), c(4, 4)); // DIR_SOUTHWEST = (-1, -1)
  assert.deepEqual(nearbyFreecell(m, 5, 5, occ([[5, 5], [6, 6]]), 0), c(6, 5)); // NE taken -> EAST
  assert.deepEqual(nearbyFreecell(openMap(10, 10, [[6, 6], [6, 5]]), 5, 5, occ([[5, 5]]), 0), c(6, 4)); // walls -> SOUTHEAST
  assert.deepEqual(nearbyFreecell(m, 5, 5, occ([]), 0), c(5, 5)); // a free cell is itself
  const ring: [number, number][] = [[5, 5], [4, 4], [4, 5], [4, 6], [5, 4], [5, 6], [6, 4], [6, 5], [6, 6]];
  assert.equal(nearbyFreecell(m, 5, 5, occ(ring), 1), null);
});
