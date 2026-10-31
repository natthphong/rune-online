// Owner's decision for 2.4.0 (tools/rathena/import.ts BOSS_CARD_RATE / MVP_CARD): boss cards drop 1 % (lowest-level boss) .. 0.3 %
// (highest), linear by level; the dungeon MVP's card drops 0.1 %. Rates are x/10000.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOBS } from "./data.ts";
import { ITEMS } from "./items.ts";

const cardRates = (id: number) => MOBS.find((m) => m.id === id)!.drops.filter((d) => ITEMS.get(d.item)!.type === "Card");

test("field boss cards: 100 at Lv27 down to 30 at Lv47, linear in level", () => {
  const bosses = MOBS.filter((m) => m.bossType === "Boss").sort((a, b) => a.level - b.level);
  assert.deepEqual(bosses.map((m) => m.name), ["Croakwarden", "Moonwhisker", "Barkmatron", "Galeskimmer"]);
  for (const m of bosses) {
    const cards = cardRates(m.id);
    assert.equal(cards.length, 1, `${m.name}: one card`);
    assert.equal(ITEMS.get(cards[0].item)!.mobId, m.id);
    assert.equal(cards[0].rate, Math.round(100 - 70 * (m.level - 27) / 20), `${m.name} Lv${m.level}`);
  }
  assert.equal(cardRates(1089)[0].rate, 100);
  assert.equal(cardRates(1091)[0].rate, 30);
});

test("the dungeon MVP (Gloopking) drops its own card at 0.1 %", () => {
  const all = cardRates(3810); // + the legendary card at 0.01 % (cards.test.ts / album.test.ts)
  const cards = all.filter((c) => (ITEMS.get(c.item) as { rarity?: string }).rarity !== "legendary");
  assert.equal(cards.length, 1);
  assert.equal(all.length, 2);
  assert.equal(cards[0].rate, 10);
  const it = ITEMS.get(cards[0].item)!;
  assert.equal(it.name, "Gloopking Card");
  assert.equal(it.mobId, 3810);
  assert.ok(it.bonuses.length > 0 && it.unsupported.length === 0);
});
