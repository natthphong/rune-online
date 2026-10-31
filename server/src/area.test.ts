// clif_send area targets (server/src/area.ts) vs rAthena clif.cpp:477-530 + clif_send_sub 401-445. Hand-checked against the C++:
//   AREA*  map_foreachinallarea(bl->x-AREA_SIZE, bl->y-AREA_SIZE, bl->x+AREA_SIZE, bl->y+AREA_SIZE): x0 <= x <= x1 and
//          y0 <= y <= y1 (map.cpp:874), AREA_SIZE = area_size 14 (conf/battle/client.conf:39)
//   AREA_CHAT_WOC  the same with AREA_SIZE - 5 = 9, without the source (bl == src_bl) and without chat-room sitters
//   AREA_WOS       without the source; AREA keeps it; SELF only the source
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaRange, areaReceivers } from "./area.ts";

const src = { id: "me", x: 30, y: 30 };
const at = (x: number, y: number) => ({ x, y });
const players: [string, { x: number; y: number }][] = [
  ["me", at(30, 30)],
  ["corner14", at(44, 16)], // dx 14, dy -14: the square's corner is inside
  ["edge15", at(45, 30)], // dx 15: outside
  ["far", at(50, 30)], // 20 cells away
  ["five", at(35, 33)], // 5 cells
  ["nine", at(21, 39)], // dx -9, dy 9: inside the chat area
  ["ten", at(30, 40)], // dy 10: outside the chat area, inside AREA
];

test("area_size 14: square distance, edge included (map_foreachinallarea x0..x1 / y0..y1)", () => {
  assert.equal(areaRange("AREA"), 14);
  assert.equal(areaRange("AREA_CHAT_WOC"), 9);
  assert.deepEqual(areaReceivers("AREA", src, players), ["me", "corner14", "five", "nine", "ten"]);
});

test("AREA_WOS / AREA_WOC leave the source out (clif_send_sub bl == src_bl); AREA keeps it", () => {
  assert.deepEqual(areaReceivers("AREA_WOS", src, players), ["corner14", "five", "nine", "ten"]);
  assert.deepEqual(areaReceivers("AREA_WOC", src, players), ["corner14", "five", "nine", "ten"]); // no chat rooms yet
});

test("AREA_CHAT_WOC: AREA_SIZE - 5 = 9 cells, without the speaker", () => {
  assert.deepEqual(areaReceivers("AREA_CHAT_WOC", src, players), ["five", "nine"]);
});

test("SELF: only the source player; a monster source reaches nobody", () => {
  assert.deepEqual(areaReceivers("SELF", src, players), ["me"]);
  assert.deepEqual(areaReceivers("SELF", { id: "m12", x: 30, y: 30 }, players), []);
});

test("a monster source: every player around it (clif_damage on a monster target, mob death)", () => {
  // from (50,30): corner14 dx -6 dy -14, edge15 dx -5, far 0 are in; five dx -15, me / ten dx -20, nine dx -29 are out
  assert.deepEqual(areaReceivers("AREA", { id: "m12", x: 50, y: 30 }, players), ["corner14", "edge15", "far"]);
});

test("area_size from the conf: a smaller area shrinks every area target", () => {
  assert.deepEqual(areaReceivers("AREA", src, players, { area_size: 5 }), ["me", "five"]);
  assert.deepEqual(areaReceivers("AREA_CHAT_WOC", src, players, { area_size: 5 }), []); // 0 cells, the speaker left out
});
