// The tomb lifecycle of server/src/boss.ts (mob.cpp mvptomb_create / _setdelayspawn / _delayspawn / _destroy) on a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tombs, bossKindOf, BOSS_KIND, type Tomb } from "./tombs.ts";

function rig() {
  let now = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const shown: string[] = [], hidden: string[] = [];
  const tombs = new Tombs({
    show: (t) => shown.push(t.id),
    hide: (t) => hidden.push(t.id),
    later: (fn, ms) => { const t = { at: now + ms, fn, dead: false }; timers.push(t); return { clear: () => { t.dead = true; } }; },
  }, 9000);
  const advance = (ms: number) => { now += ms; for (const t of timers) if (!t.dead && t.at <= now) { t.dead = true; t.fn(); } };
  return { tombs, shown, hidden, advance };
}
const info = (killer = "Ann") => ({ mobName: "Gloopking", x: 10, y: 12, killedAt: new Date(2026, 9, 23, 3, 7), killer });

test("tomb: appears mvp_tomb_delay (9 s) after the death, not before, and is clickable only then", () => {
  const { tombs, shown, advance } = rig();
  const t = tombs.create("m1", info());
  assert.equal(t.id, "tomb_m1");
  assert.equal(tombs.visible(t.id), undefined);
  advance(8999);
  assert.deepEqual(shown, []);
  advance(1);
  assert.deepEqual(shown, ["tomb_m1"]);
  assert.equal(tombs.visible("tomb_m1")?.killer, "Ann");
  assert.equal(tombs.visible("tomb_nope"), undefined);
});

test("tomb: removed when the boss spawns again; one that never showed never will", () => {
  const { tombs, shown, hidden, advance } = rig();
  tombs.create("m1", info());
  advance(9000);
  tombs.destroy("m1"); // mob_spawn -> mvptomb_destroy
  assert.deepEqual(hidden, ["tomb_m1"]);
  assert.equal(tombs.visible("tomb_m1"), undefined);
  assert.equal(tombs.size, 0);
  // died again and respawned inside the 9 s: the pending show is cancelled, nothing to hide
  tombs.create("m1", info("Bob"));
  advance(4000);
  tombs.destroy("m1");
  advance(60000);
  assert.deepEqual(shown, ["tomb_m1"]);
  assert.deepEqual(hidden, ["tomb_m1"]);
  tombs.destroy("m1"); // destroying nothing is fine
});

test("tomb: a new death replaces the old tomb of the same boss (mvptomb_create destroys the earlier one first)", () => {
  const { tombs, shown, hidden, advance } = rig();
  const a: Tomb = tombs.create("m1", info("Ann"));
  advance(9000);
  const b: Tomb = tombs.create("m1", info("Bob"));
  assert.deepEqual(hidden, ["tomb_m1"]);
  assert.notEqual(a, b);
  advance(9000);
  assert.deepEqual(shown, ["tomb_m1", "tomb_m1"]);
  assert.equal(tombs.visible("tomb_m1")?.killer, "Bob");
  assert.equal(tombs.size, 1);
  // two bosses, two tombs
  tombs.create("m2", info("Cy"));
  assert.equal(tombs.size, 2);
});

test("boss kind on the wire: Mvp 2, Boss 1, ordinary 0", () => {
  assert.equal(bossKindOf({ bossType: "Mvp" }), BOSS_KIND.mvp);
  assert.equal(bossKindOf({ bossType: "Boss" }), BOSS_KIND.boss);
  assert.equal(bossKindOf({ bossType: "None" }), BOSS_KIND.none);
});
