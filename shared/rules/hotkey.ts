// The shortcut window's storage (hotkeys), re-implemented from rAthena:
//   src/common/mmo.hpp:25-34  MAX_HOTKEYS: 27 = 9 x 3 bars (PACKETVER < 20090603), 36 = 9 x 4 bars (< 20090617), and for
//                             every later client 38 = "9 skills x 4 bars & 2 Quickslots"; struct hotkey { id, lv, type } :555
//   src/map/clif.cpp          clif_hotkeys_send:11217 sends the whole list plus `rotate` = sd->status.hotkey_rowshift at
//                             login; clif_parse_HotkeyRowShift:11248 stores the shift the client picks with the window's
//                             up/down arrows; clif_parse_Hotkey:11266 stores one slot and ignores an index >= MAX_HOTKEYS_DB
//   src/char/char.cpp:314     hotkey_rowshift is saved on the character row (the slots themselves in the `hotkey` table)
// A slot holds an item id (struct hotkey type 0) or, for the basic actions the game supports, a negative action id (our own
// stand-in for the client-side "/sit" shortcut the original lets you drag onto the bar); skill slots (type 1, id + lv) join
// when skills exist. The window
// (client) shows 1-4 rows of 9: row r shows bar (r + shift) mod 4, F1-F9 always fire the top row, so rotating the bars is
// how a player pages another bar onto F1-F9. The two quickslots are the last two entries of the list.
import { ITEMS } from "./items.ts";
import { SKILLS } from "./skill.ts";

/** Slots per bar (one row of the window, F1-F9). */
export const HOTKEY_ROW = 9;
/** Bars of 9 the window can show and rotate through. */
export const HOTKEY_BARS = 4;
/** The quickslot box beside the window. */
export const HOTKEY_QUICKSLOTS = 2;
/** mmo.hpp MAX_HOTKEYS for every client since 2009-06-17: 9 x 4 bars + 2 quickslots = 38. */
export const MAX_HOTKEYS = HOTKEY_ROW * HOTKEY_BARS + HOTKEY_QUICKSLOTS;
/** Index of the first quickslot (36): the quickslots follow the four bars. */
export const QUICKSLOT_FIRST = HOTKEY_ROW * HOTKEY_BARS;

export type HotkeyList = (number | null)[];

/** Basic actions a slot can hold: negative ids so they never collide with an item id. The client performs them (Insert = sit). */
export const HOTKEY_ACTIONS = { sit: -1 } as const;
export const isHotkeyAction = (id: number) => id === HOTKEY_ACTIONS.sit;
/** Skill slots (struct hotkey type 1: skill id + the level to use, clif_parse_Hotkey) share the number list: a skill slot is
 *  -(SKILL_HOTKEY_BASE + id * 100 + lv), below every action id. */
export const SKILL_HOTKEY_BASE = 1000;
export const skillHotkey = (id: number, lv: number) => -(SKILL_HOTKEY_BASE + id * 100 + lv);
/** The skill and level a slot holds, or null for an item / action / empty slot. */
export function hotkeySkill(k: number | null | undefined): { id: number; lv: number } | null {
  if (typeof k !== "number" || k > -SKILL_HOTKEY_BASE) return null;
  const v = -k - SKILL_HOTKEY_BASE;
  return { id: Math.trunc(v / 100), lv: v % 100 };
}

/**
 * A stored or received slot list as the server keeps it: exactly MAX_HOTKEYS entries. Entries past MAX_HOTKEYS are
 * dropped (clif_parse_Hotkey returns for idx >= MAX_HOTKEYS_DB), missing ones are empty, and a slot that is not a known
 * item id is empty. Older saves (9 slots) load into bar 1 with the rest empty.
 */
export function hotkeyList(keys: unknown, isItem: (id: number) => boolean = (id) => ITEMS.has(id), isSkill: (id: number) => boolean = (id) => SKILLS.has(id)): HotkeyList {
  const src = Array.isArray(keys) ? keys : [];
  return Array.from({ length: MAX_HOTKEYS }, (_, i) => {
    const k: unknown = src[i];
    if (typeof k !== "number" || !Number.isInteger(k)) return null;
    const sk = hotkeySkill(k);
    if (sk) return sk.lv >= 1 && isSkill(sk.id) ? k : null;
    return isHotkeyAction(k) || isItem(k) ? k : null;
  });
}

/** char.hotkey_rowshift as we keep it: how many bars the window is rotated by, 0..HOTKEY_BARS-1. */
export const isRowShift = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < HOTKEY_BARS;

/** The window's up (-1) / down (+1) arrows: rotate by one bar, wrapping around. */
export const rotateBars = (shift: number, step: number) => (((shift + step) % HOTKEY_BARS) + HOTKEY_BARS) % HOTKEY_BARS;

/** The bar window row `row` (0 = top, the F1-F9 row) shows at a given shift. */
export const barOfRow = (row: number, shift: number) => (row + shift) % HOTKEY_BARS;

/** List index of slot `col` (0-8) on window row `row`: F1-F9 are hotkeyIndex(0, 0..8, shift). */
export const hotkeyIndex = (row: number, col: number, shift: number) => barOfRow(row, shift) * HOTKEY_ROW + col;

/**
 * A new character's bar (clif_hotkeys_send sends whatever the char server stored; rAthena starts empty, but its starter kit
 * is dropped on the bar by the client's first-login macro, so ours seeds it): bar 1 (F1-F9) gets what the character owns and
 * can use, consumables first (F1 = the potion), then the sit action, then the gear it can swap. Only EMPTY slots are filled
 * and nothing already on any bar is placed twice, so a player's own layout is never overwritten.
 * `owned` is the item ids in the inventory in priority order (consumables before gear).
 */
export function seedHotkeys(current: HotkeyList, owned: readonly number[], consumable: (id: number) => boolean): HotkeyList {
  const out = current.slice();
  const placed = new Set(out.filter((k): k is number => k !== null));
  const want = [...owned.filter(consumable), HOTKEY_ACTIONS.sit, ...owned.filter((id) => !consumable(id))];
  for (const id of want) {
    if (placed.has(id)) continue;
    const at = Array.from({ length: HOTKEY_ROW }, (_, c) => hotkeyIndex(0, c, 0)).find((i) => out[i] === null);
    if (at === undefined) break;
    out[at] = id;
    placed.add(id);
  }
  return out;
}
