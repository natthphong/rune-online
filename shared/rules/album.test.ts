// Golden tests for the card album pool (shared/rules/album.ts): which cards are in it, how the weights split, never the legendary card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEMS } from "./items.ts";
import { BOSS_WEIGHT, NORMAL_WEIGHT, albumPool, pickAlbumCard, rarityOf } from "./album.ts";

const cards = [...ITEMS.values()].filter((i) => i.type === "Card");
const pool = albumPool();

test("the pool holds every card but the legendary one, normal cards at 100 and boss cards at 20", () => {
  const legendary = cards.filter((c) => rarityOf(c) === "legendary");
  assert.equal(legendary.length, 1, "exactly one legendary card");
  assert.equal(pool.length, cards.length - 1);
  assert.ok(!pool.some(([id]) => id === legendary[0].id));
  for (const [id, w] of pool) assert.equal(w, rarityOf(ITEMS.get(id)!) === "boss" ? BOSS_WEIGHT : NORMAL_WEIGHT);
  assert.ok(pool.filter(([, w]) => w === BOSS_WEIGHT).length >= 10, "the boss cards are in");
  assert.ok(BOSS_WEIGHT < NORMAL_WEIGHT);
});

test("every slot has cards in the pool", () => {
  const loc = (id: number) => (ITEMS.get(id)!.locations as string[]).join("+");
  const seen = new Set(pool.map(([id]) => loc(id)));
  for (const l of ["Right_Hand", "Armor", "Left_Hand", "Garment", "Shoes", "Head_Low+Head_Mid+Head_Top", "Both_Accessory"]) assert.ok(seen.has(l), l);
});

test("a draw follows the weights: the first / last entry at the ends, a boss card about BOSS/NORMAL as often", () => {
  assert.equal(pickAlbumCard(0), pool[0][0]);
  assert.equal(pickAlbumCard(0.9999999), pool[pool.length - 1][0]);
  const total = pool.reduce((s, [, w]) => s + w, 0);
  // walking the roll across the pool in 1/total steps lands on each entry exactly weight times
  const hits = new Map<number, number>();
  for (let i = 0; i < total; i++) { const id = pickAlbumCard((i + 0.5) / total); hits.set(id, (hits.get(id) ?? 0) + 1); }
  for (const [id, w] of pool) assert.equal(hits.get(id), w);
  const boss = [...hits].filter(([id]) => rarityOf(ITEMS.get(id)!) === "boss").reduce((s, [, n]) => s + n, 0);
  assert.equal(boss / total, pool.filter(([, w]) => w === BOSS_WEIGHT).length * BOSS_WEIGHT / total);
});

test("random draws never give the legendary card and give boss cards rarely", () => {
  const legendary = cards.find((c) => rarityOf(c) === "legendary")!.id;
  let boss = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) { const id = pickAlbumCard(Math.random()); assert.notEqual(id, legendary); if (rarityOf(ITEMS.get(id)!) === "boss") boss++; }
  assert.ok(boss / N < 0.08 && boss / N > 0.01, `boss share ${boss / N}`);
});

test("the album item drops from the mini-bosses (2.5 %), Gloopking (10 %) and level 20+ monsters (0.05 %), the legendary card only from Gloopking at 0.01 %", async () => {
  const { MOBS } = await import("./data.ts");
  const album = [...ITEMS.values()].find((i) => i.id === 616)!;
  assert.deepEqual(album.effect, { album: true });
  const legendary = cards.find((c) => rarityOf(c) === "legendary")!.id;
  for (const m of MOBS.filter((m) => !(m as { petOnly?: boolean }).petOnly)) { // legendary pets' species never drop
    const a = m.drops.find((d) => d.item === 616), l = m.drops.find((d) => d.item === legendary);
    const mvp = m.id === 3810 || m.id === 3999, mini = [1089, 1090, 1091, 1093].includes(m.id);
    assert.equal(a?.rate, mvp ? 1000 : mini ? 250 : m.level >= 20 ? 5 : undefined, m.name);
    assert.equal(l?.rate, m.id === 3810 ? 1 : undefined, m.name);
  }
});
