// Golden tests for shop.ts — expectations worked out by hand from rAthena pc.cpp (pc_checkadditem, pc_inventoryblank,
// pc_getzeny) and npc.cpp (npc_buylist, npc_selllist). Item numbers from shared/data/items.json:
// 501 Red Tonic buy 10 / sell 5 / weight 70, 502 Orange Tonic 50/25/100, 503 Yellow Tonic 180/90/130,
// 569 Starter Tonic 0/0/10, 1201 Knife 50/25/400 (equipment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEMS } from "./items.ts";
import { MAX_ZENY, buyList, checkAddItem, getZeny, inventoryBlank, sellList, type HeldRow } from "./shop.ts";

const SHOP = [501, 502, 503, 1201];
const BIG = 1_000_000;
const knives = (n: number): HeldRow[] => Array.from({ length: n }, () => ({ itemId: 1201, amount: 1, equip: null }));

test("pc_checkadditem: exist / new / overamount at MAX_AMOUNT 30000", () => {
  const held: HeldRow[] = [{ itemId: 501, amount: 29_999, equip: null }];
  assert.equal(checkAddItem(held, ITEMS.get(501)!, 1), "exist");
  assert.equal(checkAddItem(held, ITEMS.get(501)!, 2), "overamount"); // 2 > 30000 - 29999
  assert.equal(checkAddItem(held, ITEMS.get(502)!, 30_000), "new");
  assert.equal(checkAddItem(held, ITEMS.get(502)!, 30_001), "overamount"); // amount > MAX_AMOUNT
  assert.equal(checkAddItem(held, ITEMS.get(1201)!, 1), "new"); // equipment never stacks
});

test("pc_inventoryblank: 100 rows minus held", () => {
  assert.equal(inventoryBlank(knives(98)), 2);
  assert.equal(inventoryBlank(knives(100)), 0);
});

test("npc_buylist: free rows are summed over the whole list", () => {
  // 98 rows, three new stackables need 3 rows > 2 blank -> PURCHASE_FAIL_COUNT
  const lines = [501, 502, 503].map((itemId) => ({ itemId, amount: 1 }));
  assert.equal(buyList(lines, SHOP, knives(98), BIG, 0, BIG).result, "count");
  assert.equal(buyList(lines.slice(0, 2), SHOP, knives(98), BIG, 0, BIG).result, "ok");
  // merging into an existing stack needs no row; a new knife does (100 rows held -> 0 blank)
  assert.equal(buyList([{ itemId: 1201, amount: 1 }, { itemId: 501, amount: 1 }], SHOP, [...knives(99), { itemId: 501, amount: 1, equip: null }], BIG, 0, BIG).result, "count");
  assert.equal(buyList([{ itemId: 501, amount: 1 }], SHOP, [...knives(99), { itemId: 501, amount: 1, equip: null }], BIG, 0, BIG).result, "ok");
});

test("npc_buylist: OVERAMOUNT is a weight failure checked before zeny", () => {
  const held: HeldRow[] = [{ itemId: 501, amount: 29_999, equip: null }];
  assert.equal(buyList([{ itemId: 501, amount: 2 }], SHOP, held, 0, 0, BIG).result, "weight");
  assert.equal(buyList([{ itemId: 501, amount: 1 }], SHOP, held, 0, 0, BIG).result, "money");
});

test("npc_buylist: zeny, then weight (w + sd->weight > max_weight)", () => {
  assert.equal(buyList([{ itemId: 501, amount: 1 }], SHOP, [], 9, 0, BIG).result, "money");
  assert.equal(buyList([{ itemId: 501, amount: 1 }], SHOP, [], 10, 0, 69).result, "weight");
  const ok = buyList([{ itemId: 501, amount: 3 }, { itemId: 502, amount: 2 }], SHOP, [], 130, 0, 410);
  assert.deepEqual(ok, { result: "ok", lines: [{ itemId: 501, amount: 3 }, { itemId: 502, amount: 2 }], cost: 130 }); // 3*10 + 2*50; 3*70 + 2*100 = 410
});

test("npc_buylist: equipment is clamped to one piece per line", () => {
  assert.deepEqual(buyList([{ itemId: 1201, amount: 3 }], SHOP, [], 200, 0, BIG), { result: "ok", lines: [{ itemId: 1201, amount: 1 }], cost: 50 });
});

test("npc_buylist: any line not in the shop or malformed fails the whole list", () => {
  assert.equal(buyList([{ itemId: 502, amount: 0 }, { itemId: 99999, amount: 1 }, { itemId: 501, amount: 1 }], SHOP, [], BIG, 0, BIG).result, "count");
  assert.equal(buyList([{ itemId: 2301, amount: 1 }], SHOP, [], BIG, 0, BIG).result, "count"); // real item, not sold here
  assert.equal(buyList([{ itemId: 501, amount: 1.5 }], SHOP, [], BIG, 0, BIG).result, "count");
  assert.equal(buyList([], SHOP, [], BIG, 0, BIG).result, "count");
});

test("npc_selllist: one invalid or equipped line rejects the whole list", () => {
  const rows = new Map<number, HeldRow>([
    [1, { itemId: 501, amount: 5, equip: null }],
    [2, { itemId: 1201, amount: 1, equip: "weapon" }],
    [3, { itemId: 569, amount: 5, equip: null }],
  ]);
  assert.equal(sellList([{ uid: 1, amount: 1 }, { uid: 2, amount: 1 }], rows).ok, false); // pc_can_sell_item: equip > 0
  assert.equal(sellList([{ uid: 1, amount: 6 }], rows).ok, false);
  assert.equal(sellList([{ uid: 1, amount: 3 }, { uid: 1, amount: 3 }], rows).ok, false); // same row twice: 6 > 5
  assert.equal(sellList([{ uid: 9, amount: 1 }], rows).ok, false);
  assert.deepEqual(sellList([{ uid: 1, amount: 4 }, { uid: 3, amount: 5 }], rows), { ok: true, lines: [{ row: 1, amount: 4 }, { row: 3, amount: 5 }], gain: 20 });
});

test("pc_getzeny: the purse caps at MAX_ZENY", () => {
  assert.equal(getZeny(2_147_483_600, 5000), MAX_ZENY);
  assert.equal(getZeny(100, 20), 120);
  assert.equal(getZeny(MAX_ZENY, 1), MAX_ZENY);
});
