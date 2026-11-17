// 2.9.0 the roaming mini-bosses and the Tower's own species (shared/minibosses.ts, shared/floor3.ts, shared/rules/bossmoves.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MINIS, MINI_MOBS, miniOf } from "../minibosses.ts";
import { F3_MOBS } from "../floor3.ts";
import { TOWER } from "../tower.ts";
import { artOf } from "../mobart.ts";
import { MOB_BY_ID } from "./data.ts";
import { BOSS_MOVES, ringCells, safeNearPlayers } from "./bossmoves.ts";

test("mini-bosses: one row per floor, stronger floor by floor, each floor's guardian still the stronger boss", () => {
  for (const mini of MINIS) {
    const rows = ([1, 2, 3] as const).map((f) => MOB_BY_ID.get(mini.ids[f])!);
    assert.ok(rows.every(Boolean), mini.key);
    for (let i = 1; i < 3; i++) {
      assert.ok(rows[i].hp > rows[i - 1].hp && rows[i].atk > rows[i - 1].atk && rows[i].level > rows[i - 1].level, `${mini.key} floor ${i + 1} > floor ${i}`);
    }
    rows.forEach((r, i) => assert.ok(TOWER[i].hp > r.hp, `floor ${i + 1}'s guardian outlasts ${mini.key}`));
    rows.forEach((r) => assert.equal(r.bossType, "Boss"));
  }
});

test("Ceruleen turns at 50 % into its own floor's phase-2 row; Ashgrim's Long Harvest covers almost the whole map", () => {
  const c = MINIS.find((m) => m.key === "ceruleen")!;
  for (const f of [1, 2, 3] as const) {
    const tr = BOSS_MOVES.get(c.ids[f])!.transform!;
    assert.equal(tr.hpBelow, 50);
    assert.equal(tr.to, c.phase2![f]);
    assert.deepEqual([miniOf(tr.to)?.floor, miniOf(tr.to)?.phase], [f, 2]);
    assert.equal(MOB_BY_ID.get(tr.to)!.hp, MOB_BY_ID.get(c.ids[f])!.hp, "the same HP pool");
  }
  const reap = BOSS_MOVES.get(4311)!.areas!.find((a) => a.name === "reap")!;
  assert.ok(reap.shape === "sweep" && reap.r >= 40 && reap.windMs >= 5000 && (reap.safe ?? 0) >= 3 && reap.safeNear! <= 10);
});

test("the Long Harvest gives every player under it a safe circle a short run away", () => {
  const open = () => true, players = [{ x: 30, y: 30 }, { x: 80, y: 70 }, { x: 62, y: 40 }];
  let seed = 7;
  const roll = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const safe = safeNearPlayers(open, { x: 60, y: 60 }, 50, players, 8, 5, 2.5, roll);
  assert.ok(safe.length >= players.length && safe.length <= 5);
  for (const p of players) assert.ok(safe.some((z) => Math.hypot(z.x - p.x, z.y - p.y) <= 11), `a circle near ${p.x},${p.y}`);
  for (const z of safe) assert.ok(Math.hypot(z.x - 60, z.y - 60) >= 4, "not on the boss");
  assert.equal(ringCells({ x: 10, y: 10 }, 5, 10).length, 10);
});

test("every Tower species and mini-boss form is drawn with its own sheets", () => {
  const anim = JSON.parse(readFileSync(new URL("../../client/public/sprites/anim/index.json", import.meta.url), "utf8")) as string[];
  for (const m of [...F3_MOBS, ...MINI_MOBS]) {
    const a = artOf(m.id);
    assert.ok(anim.includes(`mob_${a}_move`) && anim.includes(`mob_${a}_act`), `${m.name} (${m.id}) -> mob_${a}`);
    assert.ok(a !== m.base, `${m.name} has art of its own, not its base species'`);
  }
});
