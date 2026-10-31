// Golden tests for npc.ts — worked out by hand from rAthena npc.cpp npc_checknear (npc.cpp:2157-2160: reject when
// bl->x < sd->x-AREA_SIZE-1 or bl->x > sd->x+AREA_SIZE+1, same for y; area_size 14 in conf/battle/client.conf:39)
// and the buy/sell result paths in clif.cpp clif_parse_NpcBuyListSend / clif_parse_NpcSellListSend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AREA_SIZE, NPC_CHECKNEAR_RANGE, buyGate, npcCheckNear, sellGate } from "./npc.ts";

const NPC = { x: 34, y: 30 };

test("AREA_SIZE 14 -> npc_checknear reach 15", () => {
  assert.equal(AREA_SIZE, 14);
  assert.equal(NPC_CHECKNEAR_RANGE, 15);
});

test("npc_checknear: square of AREA_SIZE+1 around the player's cell", () => {
  assert.equal(npcCheckNear({ x: 34, y: 30 }, NPC), true); // same cell
  assert.equal(npcCheckNear({ x: 26, y: 21 }, NPC), true); // Chebyshev 9 (critic B05 probe 5): opens, no walk
  assert.equal(npcCheckNear({ x: 19, y: 30 }, NPC), true); // 34 > 19+15? no (34 == 34) -> accepted
  assert.equal(npcCheckNear({ x: 18, y: 30 }, NPC), false); // 34 > 18+15 = 33 -> rejected
  assert.equal(npcCheckNear({ x: 49, y: 15 }, NPC), true); // corner (15,15): square, not circle
  assert.equal(npcCheckNear({ x: 49, y: 14 }, NPC), false); // 30 > 14+15 = 29
  assert.equal(npcCheckNear({ x: 50, y: 30 }, NPC), false); // 34 < 50-14-1 = 35
  assert.equal(npcCheckNear({ x: 30, y: 30 }, NPC, 2), false); // area_size 2 -> reach 3, dx 4
});

test("buy gate: no session -> PURCHASE_FAIL_MONEY, out of range -> PURCHASE_FAIL_COUNT", () => {
  assert.equal(buyGate(false, true), "money");
  assert.equal(buyGate(false, false), "money"); // npc_shopid is checked first (clif.cpp), npc_checknear never runs
  assert.equal(buyGate(true, false), "count");
  assert.equal(buyGate(true, true), "ok");
});

test("sell gate: no session or out of range -> result 1", () => {
  assert.equal(sellGate(false, true), false);
  assert.equal(sellGate(true, false), false);
  assert.equal(sellGate(true, true), true);
});
