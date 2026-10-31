import { test } from "node:test";
import assert from "node:assert/strict";
import { BOSS_MOVES, DEVO, chargeCooldown, chargeDue, chargeLane, headbuttDue, inLaneReach, isEnraged, knockbackCell, rateDamage, spitDamage, spitDue, spitFlightMs, splitsDue } from "./bossmoves.ts";
import { MOB_BY_ID } from "./data.ts";

const gk = BOSS_MOVES.get(3810)!;

test("boss moves: every row names real monsters", () => {
  for (const [id, m] of BOSS_MOVES) {
    assert.ok(MOB_BY_ID.has(id), `boss ${id}`);
    for (const r of m.split ?? []) for (const s of r.ids) assert.ok(MOB_BY_ID.has(s), `slave ${s}`);
  }
});

test("boss spit: only beyond melee, within range, in sight, after the cooldown", () => {
  const s = gk.spit!, o = { now: 10000, readyAt: 9000, dist: 5, clearLine: true };
  assert.equal(spitDue(s, o), true);
  assert.equal(spitDue(s, { ...o, dist: 2 }), false); // melee range: the normal attack
  assert.equal(spitDue(s, { ...o, dist: 3 }), true);
  assert.equal(spitDue(s, { ...o, dist: 9 }), true);
  assert.equal(spitDue(s, { ...o, dist: 10 }), false);
  assert.equal(spitDue(s, { ...o, dist: undefined }), false); // no target
  assert.equal(spitDue(s, { ...o, clearLine: false }), false); // a wall in between
  assert.equal(spitDue(s, { ...o, readyAt: 10001 }), false); // cooling down
  assert.equal(spitFlightMs(s, 1), 250);
  assert.equal(spitFlightMs(s, 9), 810);
  assert.equal(spitDamage(s, 0), 0);
  assert.equal(spitDamage(s, 340), 340);
});

test("boss split: each threshold fires once, a big hit fires both", () => {
  const rows = gk.split!, fired = new Set<number>();
  assert.deepEqual(splitsDue(rows, 70000, 140000, fired), []); // exactly 50 %: not below
  assert.deepEqual(splitsDue(rows, 69999, 140000, fired), [0]);
  fired.add(0);
  assert.deepEqual(splitsDue(rows, 60000, 140000, fired), []); // already split
  assert.deepEqual(splitsDue(rows, 30000, 140000, fired), [1]);
  assert.deepEqual(splitsDue(rows, 20000, 140000, new Set()), [0, 1]);
  assert.deepEqual(splitsDue(rows, 0, 140000, new Set()), []); // dead: no split
});

// ---------- Devo (3999): charge, headbutt, kids at 50 %, enrage at 25 % ----------
const devo = BOSS_MOVES.get(DEVO)!;
const open = () => true;

test("Devo is a floor-2 MVP with the three goat moves, kids from a real low-level species", () => {
  const def = MOB_BY_ID.get(DEVO)!;
  assert.equal(def.name, "Devo");
  assert.equal(def.bossType, "Mvp");
  assert.ok(def.level >= 34 && def.level <= 48);
  assert.ok(devo.charge && devo.headbutt && devo.split?.length === 1 && devo.shouts?.length === 1);
  assert.equal(devo.split![0].amount, 3);
  assert.equal(devo.charge!.knockback, 3);
  assert.equal(devo.headbutt!.knockback, 2);
  assert.equal(devo.charge!.windMs, 800);
  assert.ok(MOB_BY_ID.get(devo.split![0].ids[0])!.level < 20);
});

test("charge: target 4-10 cells away, in sight, after the cooldown", () => {
  const c = devo.charge!, o = { now: 10000, readyAt: 9000, dist: 6, clearLine: true };
  assert.equal(chargeDue(c, o), true);
  assert.equal(chargeDue(c, { ...o, dist: 3 }), false);
  assert.equal(chargeDue(c, { ...o, dist: 4 }), true);
  assert.equal(chargeDue(c, { ...o, dist: 10 }), true);
  assert.equal(chargeDue(c, { ...o, dist: 11 }), false);
  assert.equal(chargeDue(c, { ...o, clearLine: false }), false);
  assert.equal(chargeDue(c, { ...o, readyAt: 10001 }), false);
  assert.equal(chargeDue(c, { ...o, dist: undefined }), false);
});

test("charge cooldown shrinks when enraged; enrage is strictly under the threshold", () => {
  const c = devo.charge!;
  assert.equal(chargeCooldown(c, 0, false), 9000);
  assert.equal(chargeCooldown(c, 3000, false), 12000);
  assert.equal(chargeCooldown(c, 0, true), 4950);
  assert.equal(isEnraged(devo, 100000, 200000), false); // exactly 50 %
  assert.equal(isEnraged(devo, 99999, 200000), true);
  assert.equal(isEnraged(devo, 0, 200000), false);
  assert.equal(isEnraged(BOSS_MOVES.get(3810)!, 1, 200000), false); // Gloopking has no rage
});

test("charge lane: straight line through the target, two cells past it, stopping before a wall", () => {
  const lane = chargeLane(open, { x: 10, y: 10 }, { x: 15, y: 10 }, 2);
  assert.deepEqual(lane.map((c) => c.x), [11, 12, 13, 14, 15, 16, 17]);
  assert.ok(lane.every((c) => c.y === 10));
  const diag = chargeLane(open, { x: 0, y: 0 }, { x: 4, y: 4 }, 1);
  assert.deepEqual(diag[diag.length - 1], { x: 5, y: 5 });
  const walled = chargeLane((x) => x < 13, { x: 10, y: 10 }, { x: 15, y: 10 }, 2);
  assert.deepEqual(walled.map((c) => c.x), [11, 12]);
  assert.deepEqual(chargeLane(open, { x: 3, y: 3 }, { x: 3, y: 3 }, 2), []);
  assert.equal(inLaneReach({ x: 5, y: 5 }, { x: 6, y: 4 }), true);
  assert.equal(inLaneReach({ x: 5, y: 5 }, { x: 7, y: 5 }), false); // a player who stepped 2 cells off the lane is missed
});

test("knockback: straight away from the pusher, stopping before a wall", () => {
  assert.deepEqual(knockbackCell(open, { x: 5, y: 5 }, { x: 6, y: 5 }, 3), { x: 9, y: 5 });
  assert.deepEqual(knockbackCell(open, { x: 5, y: 5 }, { x: 6, y: 6 }, 2), { x: 8, y: 8 });
  assert.deepEqual(knockbackCell(open, { x: 5, y: 5 }, { x: 4, y: 5 }, 2), { x: 2, y: 5 });
  assert.deepEqual(knockbackCell((x) => x < 8, { x: 5, y: 5 }, { x: 6, y: 5 }, 3), { x: 7, y: 5 });
  assert.deepEqual(knockbackCell((x) => x < 7, { x: 5, y: 5 }, { x: 6, y: 5 }, 3), { x: 6, y: 5 }); // against a wall: stays
  assert.deepEqual(knockbackCell(open, { x: 5, y: 5 }, { x: 5, y: 5 }, 1), { x: 6, y: 5 }); // same cell: some direction
});

test("headbutt: only adjacent, after the cooldown; damage is the attack x rate", () => {
  const h = devo.headbutt!, o = { now: 10000, readyAt: 9000, dist: 1 };
  assert.equal(headbuttDue(h, o), true);
  assert.equal(headbuttDue(h, { ...o, dist: 2 }), false);
  assert.equal(headbuttDue(h, { ...o, readyAt: 10001 }), false);
  assert.equal(headbuttDue(h, { ...o, dist: undefined }), false);
  assert.equal(rateDamage(220, 100), 220);
  assert.equal(rateDamage(220, 0), 0);
  assert.equal(rateDamage(1, 10), 1);
});

test("Devo's kids come once below 50 %, the enrage shout once below 25 %", () => {
  const max = 200000, fired = new Set<number>(), shouted = new Set<number>();
  assert.deepEqual(splitsDue(devo.split!, 100000, max, fired), []);
  assert.deepEqual(splitsDue(devo.split!, 99999, max, fired), [0]);
  fired.add(0);
  assert.deepEqual(splitsDue(devo.split!, 40000, max, fired), []);
  assert.deepEqual(splitsDue(devo.shouts!, 60000, max, shouted), []);
  assert.deepEqual(splitsDue(devo.shouts!, 49999, max, shouted), [0]);
  assert.deepEqual(splitsDue(devo.shouts!, 49999, max, new Set([0])), []);
});
