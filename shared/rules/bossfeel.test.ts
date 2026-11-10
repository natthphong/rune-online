// 2.7.0 boss feel + the Tower's scaling table: the pure rules behind server/src/boss.ts (areas, hop, rage) and shared/tower.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOSS_MOVES, IDLE_MAX_MS, areaDue, hopCell, inShape, isRaged, lineEnd, ragedMs, safeSpots } from "./bossmoves.ts";
import { MOB_BY_ID } from "./data.ts";
import { TOWER, floorsOpen, hintText, towerHint } from "../tower.ts";

const open = () => true;

test("area shapes: circle, line and sweep with safe circles", () => {
  const c = { shape: "circle" as const, x: 10, y: 10, r: 2 };
  assert.equal(inShape(c, { x: 10, y: 10 }), true);
  assert.equal(inShape(c, { x: 12, y: 10 }), true);
  assert.equal(inShape(c, { x: 12, y: 11 }), true); // 2.24 <= 2.25
  assert.equal(inShape(c, { x: 12, y: 12 }), false); // the corner is outside the disc
  assert.equal(inShape(c, { x: 13, y: 10 }), false);
  const l = { shape: "line" as const, x: 0, y: 0, ex: 10, ey: 0, r: 1 };
  assert.equal(inShape(l, { x: 5, y: 1 }), true);
  assert.equal(inShape(l, { x: 5, y: 2 }), false);
  assert.equal(inShape(l, { x: 11, y: 0 }), true); // the rounded end
  assert.equal(inShape(l, { x: 12, y: 0 }), false);
  const s = { shape: "sweep" as const, x: 20, y: 20, r: 15, safe: [{ x: 25, y: 20, r: 2 }] };
  assert.equal(inShape(s, { x: 20, y: 30 }), true);
  assert.equal(inShape(s, { x: 25, y: 21 }), false); // inside the safe circle
  assert.equal(inShape(s, { x: 28, y: 20 }), true); // just past it
  assert.equal(inShape(s, { x: 20, y: 36 }), false); // beyond the sweep
});

test("area move: cooldown, range, phase and line of sight", () => {
  const splash = BOSS_MOVES.get(3810)!.areas!.find((a) => a.name === "splash")!, rain = BOSS_MOVES.get(3810)!.areas!.find((a) => a.name === "rain")!;
  const o = { now: 5000, readyAt: 4000, dist: 6, hp: 100, maxHp: 100, clearLine: true };
  assert.equal(areaDue(splash, o), true);
  assert.equal(areaDue(splash, { ...o, readyAt: 5001 }), false);
  assert.equal(areaDue(splash, { ...o, dist: 1 }), false); // too close for a leap
  assert.equal(areaDue(splash, { ...o, clearLine: false }), false); // it leaps: needs a clear line
  assert.equal(areaDue(rain, o), false); // phase 2 only
  assert.equal(areaDue(rain, { ...o, hp: 69 }), true);
  assert.equal(areaDue(rain, { ...o, hp: 69, clearLine: false }), true); // the rain falls over walls
});

test("every guardian has a feel row: sight, run, an opener that exists, hops; telegraphs leave time to walk out", () => {
  for (const f of TOWER) {
    const m = BOSS_MOVES.get(f.guardian), def = MOB_BY_ID.get(f.guardian)!;
    assert.ok(m?.feel && m.rage && m.areas?.length, `${def.name}: feel + rage + areas`);
    assert.ok(m.feel.sight >= 10 && m.feel.runPct < 100, def.name);
    assert.ok(m.feel.opener === "charge" ? !!m.charge : m.areas.some((a) => a.name === m.feel!.opener), `${def.name}: opener ${m.feel.opener}`);
    for (const a of m.areas) {
      // a climber walks ~150 ms per cell: the warning must cover walking out from the centre (r + 1 cells) with 250 ms to react
      const need = a.shape === "line" ? 2 : a.shape === "sweep" ? 0 : a.r + 1;
      assert.ok(a.windMs >= need * 150 + 250, `${def.name} ${a.name}: ${a.windMs} ms to leave ${need} cells`);
    }
    // between two swings it stands still less than the idle limit
    assert.ok(def.attackDelay - def.attackMotion <= IDLE_MAX_MS, `${def.name}: ${def.attackDelay - def.attackMotion} ms between swings`);
  }
});

test("rage: under the threshold cooldowns shrink", () => {
  const gk = BOSS_MOVES.get(3810)!;
  assert.equal(isRaged(gk, 30, 100), false);
  assert.equal(isRaged(gk, 29, 100), true);
  assert.equal(isRaged(gk, 0, 100), false);
  assert.equal(ragedMs(9000, gk.rage, true), 5400);
  assert.equal(ragedMs(9000, gk.rage, false), 9000);
});

test("hop: a sidestep to another cell in reach of the target, undefined when boxed in", () => {
  for (let i = 0; i < 50; i++) {
    const c = hopCell(open, { x: 5, y: 5 }, { x: 6, y: 5 }, (n) => i % n)!;
    assert.ok(Math.max(Math.abs(c.x - 6), Math.abs(c.y - 5)) === 1, "adjacent to the target");
    assert.ok(Math.max(Math.abs(c.x - 5), Math.abs(c.y - 5)) >= 2, "a real sidestep, 2+ cells from where it stood");
  }
  assert.equal(hopCell((x, y) => x === 5 && y === 5, { x: 5, y: 5 }, { x: 6, y: 5 }, () => 0), undefined);
  assert.deepEqual(lineEnd({ x: 0, y: 0 }, { x: 3, y: 0 }, 10), { x: 10, y: 0 });
});

test("sweep safe spots: inside the disc, apart from each other, on walkable cells", () => {
  let k = 7;
  const roll = (n: number) => (k = (k * 1103515245 + 12345) >>> 0) % n;
  const spots = safeSpots(open, { x: 50, y: 50 }, 16, 3, 2, roll);
  assert.equal(spots.length, 3);
  for (const s of spots) { const d = Math.hypot(s.x - 50, s.y - 50); assert.ok(d >= 3 && d <= 14); }
  for (const a of spots) for (const b of spots) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 6);
});

test("tower: floor N+1's guardian is clearly harder than floor N's, and harder than it was before 2.7.0", () => {
  for (const f of TOWER) {
    const def = MOB_BY_ID.get(f.guardian)!;
    assert.deepEqual([def.hp, def.atk, def.attackDelay], [f.hp, f.atk, f.attackDelay], `${def.name} takes the table's numbers`);
    if (f.was) assert.ok(f.hp >= f.was.hp * 1.4 && f.atk > f.was.atk && f.attackDelay < f.was.attackDelay, `${def.name} vs 2.6.0`);
  }
  for (let i = 1; i < TOWER.length; i++) {
    const a = TOWER[i - 1], b = TOWER[i];
    assert.equal(b.floor, a.floor + 1);
    assert.ok(b.hp >= a.hp * 1.5 && b.atk >= a.atk * 1.2 && b.attackDelay <= a.attackDelay && b.level > a.level, `floor ${b.floor} vs ${a.floor}`);
    assert.ok(BOSS_MOVES.get(b.guardian)!.areas!.length >= BOSS_MOVES.get(a.guardian)!.areas!.length - 1, "skill set does not shrink");
  }
});

test("tower: floors open one by one; the hint names a direction", () => {
  const vars: Record<string, number> = {};
  const get = (n: string) => vars[n] ?? 0;
  assert.equal(floorsOpen(get), 1);
  vars.tower_f2 = 1;
  assert.equal(floorsOpen(get), 1); // floor 2 cleared without floor 1 does not skip
  vars.tower_f1 = 1;
  assert.equal(floorsOpen(get), 3);
  assert.deepEqual(towerHint(10, 10, 10, 40), { dir: 0, dist: 30 }); // +y = south
  assert.equal(towerHint(10, 10, 40, 10).dir, 2); // east
  assert.equal(towerHint(10, 10, 10, -20).dir, 4); // north
  assert.equal(hintText(towerHint(10, 10, 60, 10)), "far to the east");
  assert.equal(hintText(towerHint(10, 10, 12, 10)), "right here");
});
