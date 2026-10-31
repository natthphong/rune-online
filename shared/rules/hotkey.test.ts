// Golden tests for the shortcut window's storage (shared/rules/hotkey.ts), numbers worked out by hand from rAthena:
// mmo.hpp:25-34 (MAX_HOTKEYS 38 = 9 x 4 bars + 2 quickslots), clif.cpp clif_parse_Hotkey (idx >= MAX_HOTKEYS_DB ignored),
// clif_hotkeys_send / clif_parse_HotkeyRowShift (the row shift, char.hotkey_rowshift).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOTKEY_ACTIONS, HOTKEY_BARS, HOTKEY_ROW, MAX_HOTKEYS, QUICKSLOT_FIRST, barOfRow, hotkeyIndex, hotkeyList, isRowShift, rotateBars, seedHotkeys } from "./hotkey.ts";

test("MAX_HOTKEYS: 9 slots x 4 bars + 2 quickslots = 38 (mmo.hpp, PACKETVER >= 20090617)", () => {
  assert.equal(HOTKEY_ROW, 9);
  assert.equal(HOTKEY_BARS, 4);
  assert.equal(MAX_HOTKEYS, 38);
  assert.equal(QUICKSLOT_FIRST, 36); // quickslots are entries 36 and 37
});

test("hotkeyList: always MAX_HOTKEYS entries; old 9-slot saves fill bar 1, the rest is empty", () => {
  const isItem = (id: number) => id === 501 || id === 1201;
  const old = hotkeyList([501, null, 1201, null, null, null, null, null, null], isItem);
  assert.equal(old.length, 38);
  assert.deepEqual(old.slice(0, 3), [501, null, 1201]);
  assert.ok(old.slice(9).every((k) => k === null));
  assert.equal(hotkeyList(undefined, isItem).length, 38);
  assert.equal(hotkeyList("junk", isItem).length, 38);
});

test("hotkeyList: an index >= MAX_HOTKEYS is dropped, unknown or non-integer ids empty the slot (clif_parse_Hotkey)", () => {
  const isItem = (id: number) => id === 501;
  const keys = Array.from({ length: 50 }, () => 501);
  const out = hotkeyList(keys, isItem);
  assert.equal(out.length, 38);
  assert.equal(out[37], 501); // the 2nd quickslot is the last entry kept
  assert.deepEqual(hotkeyList([501, 999, 501.5, "501", -2, null], isItem).slice(0, 6), [501, null, null, null, null, null]);
});

test("row shift: 0..3 only; the arrows rotate one bar and wrap", () => {
  assert.ok([0, 1, 2, 3].every(isRowShift));
  assert.ok(![-1, 4, 1.5, "1", null, undefined].some(isRowShift));
  assert.equal(rotateBars(0, 1), 1);
  assert.equal(rotateBars(3, 1), 0); // down past bar 4 comes back to bar 1
  assert.equal(rotateBars(0, -1), 3); // up from bar 1 goes to bar 4
  assert.equal(rotateBars(2, -1), 1);
});

test("rows show rotated bars; F1-F9 (top row) follow the shift", () => {
  assert.deepEqual([0, 1, 2, 3].map((r) => barOfRow(r, 0)), [0, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map((r) => barOfRow(r, 1)), [1, 2, 3, 0]);
  assert.deepEqual([0, 1, 2, 3].map((r) => barOfRow(r, 3)), [3, 0, 1, 2]);
  assert.equal(hotkeyIndex(0, 0, 0), 0); // F1, no shift
  assert.equal(hotkeyIndex(0, 8, 0), 8); // F9
  assert.equal(hotkeyIndex(0, 0, 1), 9); // F1 after one rotation = bar 2, slot 1
  assert.equal(hotkeyIndex(0, 8, 3), 35); // F9 on bar 4 = the last bar slot before the quickslots
  assert.equal(hotkeyIndex(2, 4, 2), 4); // row 3 at shift 2 shows bar 1 again
});
