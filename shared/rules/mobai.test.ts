// Golden tests for the monster AI decisions (shared/rules/mobai.ts), values worked out by hand from rAthena mob.cpp /
// unit.cpp / battle.cpp / status.cpp and db/re/mob_db.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMap } from "../map.ts";
import { MOB_BY_ID } from "./data.ts";
import {
  MD, MONSTER_CONF, addLoot, battleCheckRange, canChangeTarget, canReach, hasMode, isChasing, mobCanSee, nextWalkTime, pickAggroTarget,
  pickLoot, randomWalkOffsets, walkpathTime,
} from "./mobai.ts";

function openMap(w: number, h: number, blocked: [number, number][] = []): GameMap {
  const m: GameMap = { w, h, height: new Float32Array(w * h), kind: new Uint8Array(w * h), blocked: new Uint8Array(w * h), props: [] };
  for (const [x, y] of blocked) m.blocked[y * w + x] = 1;
  return m;
}

test("mob_db modes: Ai 02 = MONSTER_TYPE_02 0x83, Ai 01 = 0x81; SkillRange 10 / ChaseRange 12", () => {
  const p = MOB_BY_ID.get(1002)!; // Ai: 02
  assert.equal(p.mode, 0x83);
  assert.ok(hasMode(p.mode, MD.CANMOVE) && hasMode(p.mode, MD.LOOTER) && hasMode(p.mode, MD.CANATTACK));
  assert.ok(!hasMode(p.mode, MD.AGGRESSIVE));
  const t = MOB_BY_ID.get(1063)!; // Ai: 01
  assert.equal(t.mode, 0x81);
  assert.ok(!hasMode(t.mode, MD.LOOTER));
  assert.deepEqual([p.skillRange, p.chaseRange, p.range], [10, 12, 1]);
});

test("status_check_visibility: ChaseRange measured from the monster, square distance", () => {
  assert.equal(mobCanSee({ x: 0, y: 0 }, { x: 12, y: 12 }, 12), true); // 17 cells Euclidean, still 12 square
  assert.equal(mobCanSee({ x: 0, y: 0 }, { x: 13, y: 0 }, 12), false);
  assert.equal(mobCanSee({ x: 20, y: 20 }, { x: 8, y: 25 }, 12), true);
});

test("battle_check_range: square for monsters, client circle for players, clear line beyond 1 cell", () => {
  const m = openMap(20, 20);
  assert.equal(battleCheckRange(m, { x: 5, y: 5 }, { x: 6, y: 6 }, 1), true);
  assert.equal(battleCheckRange(m, { x: 5, y: 5 }, { x: 7, y: 5 }, 1), false);
  assert.equal(battleCheckRange(openMap(20, 20, [[6, 5]]), { x: 5, y: 5 }, { x: 7, y: 5 }, 2), false); // wall on the line
  assert.equal(battleCheckRange(m, { x: 5, y: 5 }, { x: 7, y: 7 }, 2), true); // square 2
  assert.equal(battleCheckRange(m, { x: 5, y: 5 }, { x: 7, y: 7 }, 2, true), true); // client: trunc(sqrt(8) - 0.1) = 2
  assert.equal(battleCheckRange(m, { x: 5, y: 5 }, { x: 8, y: 8 }, 3), true); // square 3
  assert.equal(battleCheckRange(m, { x: 5, y: 5 }, { x: 8, y: 8 }, 3, true), false); // client: trunc(sqrt(18) - 0.1) = 4
  assert.equal(battleCheckRange(m, { x: 0, y: 0 }, { x: 15, y: 0 }, 15), false); // beyond area_size 14
});

test("unit_can_reach_bl: destination is the cell beside the target facing the monster", () => {
  const m = openMap(30, 10);
  assert.deepEqual(canReach(m, { x: 2, y: 2 }, { x: 10, y: 2 }, 12), { x: 9, y: 2 });
  assert.equal(canReach(m, { x: 2, y: 2 }, { x: 10, y: 2 }, 5), undefined); // range check (square) first
  // facing cell blocked: first passable of dirx/diry order, dir 0 = (0,+1) -> target - (0,1)
  assert.deepEqual(canReach(openMap(30, 10, [[9, 2]]), { x: 2, y: 2 }, { x: 10, y: 2 }, 12), { x: 10, y: 1 });
  const boxed = openMap(30, 10, [[9, 1], [10, 1], [11, 1], [9, 2], [11, 2], [9, 3], [10, 3], [11, 3]]);
  assert.equal(canReach(boxed, { x: 2, y: 2 }, { x: 10, y: 2 }, 0), undefined); // no free neighbour
  assert.deepEqual(canReach(m, { x: 4, y: 4 }, { x: 4, y: 4 }, 1), { x: 4, y: 4 });
});

test("mob_can_changetarget (monster_ai 0)", () => {
  const passive = 0x81, type04 = 0x3885; // MONSTER_TYPE_04: ... | CHANGETARGETMELEE 0x1000 | CHANGETARGETCHASE 0x2000
  assert.equal(canChangeTarget("idle", passive, false), true);
  assert.equal(canChangeTarget("walk", passive, false), true);
  assert.equal(canChangeTarget("loot", passive, false), true);
  assert.equal(canChangeTarget("rush", passive, false), false);
  assert.equal(canChangeTarget("rush", type04, false), true);
  assert.equal(canChangeTarget("berserk", passive, true), false);
  assert.equal(canChangeTarget("berserk", type04, false), false); // only the special normal-attacked event
  assert.equal(canChangeTarget("berserk", type04, true), true);
  assert.deepEqual([isChasing("rush"), isChasing("loot"), isChasing("berserk"), isChasing("idle")], [true, true, false, false]);
});

test("mob_ai_sub_hard_activesearch: closest unit in SkillRange with a clear line; first wins ties; TARGETWEAK", () => {
  const m = openMap(40, 40);
  const mob = { x: 10, y: 10, level: 10, mode: 0x3885, range2: 10, range3: 12, walking: false };
  const c = (id: string, x: number, y: number, level = 1) => ({ id, x, y, level });
  assert.equal(pickAggroTarget(m, mob, [c("far", 13, 10), c("near", 10, 12), c("tie", 12, 10)]), "near");
  assert.equal(pickAggroTarget(m, mob, [c("a", 12, 10), c("b", 10, 8)]), "a");
  assert.equal(pickAggroTarget(m, mob, [c("out", 21, 10)]), undefined); // 11 > SkillRange 10
  assert.equal(pickAggroTarget(openMap(40, 40, [[12, 10]]), mob, [c("behind wall", 14, 10)]), undefined);
  const weak = { ...mob, mode: mob.mode | MD.TARGETWEAK };
  assert.equal(pickAggroTarget(m, weak, [c("lv5", 11, 10, 5), c("lv4", 14, 10, 4)]), "lv4"); // 5 >= 10 - 5 skipped
});

test("mob_ai_sub_hard_lootsearch: reachable items in loot_range 12, lowest id first (monster_loot_search_type 1)", () => {
  const m = openMap(40, 40);
  const mob = { x: 10, y: 10 };
  const items = [{ n: 5, x: 13, y: 10 }, { n: 2, x: 18, y: 10 }, { n: 1, x: 23, y: 10 }]; // n=1 is 13 cells away
  assert.equal(pickLoot(m, mob, items)?.n, 2);
  assert.equal(pickLoot(m, mob, items, { ...MONSTER_CONF, monster_loot_search_type: 0 })?.n, 5);
  assert.equal(pickLoot(m, mob, []), undefined);
  assert.deepEqual(addLoot([1, 2, 3], 4, 3), [2, 3, 4]); // monster_loot_type 0: a full bag drops the oldest
  assert.deepEqual(addLoot([1, 2], 3, 3), [1, 2, 3]);
});

test("mob_randomwalk probe order: 15x15 square from rnd(), 7-cell jumps per rdir, every offset once", () => {
  // r = 0: dx = 0 % 15 - 7 = -7, dy = 0 / 15 % 15 - 7 = -7; rdir 0 adds 7 to dx, wrapping into dy
  assert.deepEqual(randomWalkOffsets(0, 0).slice(0, 8).map(({ dx, dy }) => [dx, dy]),
    [[-7, -7], [0, -7], [7, -7], [-1, 0], [6, 0], [-2, 7], [5, 7], [-3, -1]]);
  // r = 1000: 1000 % 15 = 10 -> dx 3; 1000 / 15 = 66, 66 % 15 = 6 -> dy -1; rdir 3 subtracts 7 from dy:
  // -8 < -7 wraps to dy 7 and moves dx by -7 -> (-4, 7), then (-4, 0)
  assert.deepEqual(randomWalkOffsets(1000, 3).slice(0, 3).map(({ dx, dy }) => [dx, dy]), [[3, -1], [-4, 7], [-4, 0]]);
  for (let rdir = 0; rdir < 4; rdir++) {
    const all = randomWalkOffsets(12345, rdir);
    assert.equal(all.length, 225);
    assert.equal(new Set(all.map(({ dx, dy }) => `${dx},${dy}`)).size, 225);
    assert.ok(all.every(({ dx, dy }) => Math.abs(dx) <= 7 && Math.abs(dy) <= 7));
  }
});

test("random walk timing: next walk 4000-4999 ms after the walk ends (unit_get_walkpath_time)", () => {
  // speed 400: a diagonal cell 400 * 14 / 10 = 560, a straight one 400
  assert.equal(walkpathTime({ x: 0, y: 0 }, [{ x: 1, y: 1 }, { x: 2, y: 1 }], 400), 960);
  assert.equal(walkpathTime({ x: 0, y: 0 }, [{ x: 1, y: 1 }], 150), 210);
  assert.equal(nextWalkTime(1000, 12345, 960), 1000 + 345 + 4000 + 960);
  assert.equal(nextWalkTime(0, 999), 4999); // first walk after spawn (mob_spawn)
});
