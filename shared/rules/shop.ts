// NPC shop + inventory capacity rules — Renewal behaviour re-implemented from rAthena pc.cpp (pc_checkadditem,
// pc_inventoryblank, pc_payzeny, pc_getzeny) and npc.cpp (npc_buylist, npc_selllist). Pure functions: the server applies
// the result to its in-memory inventory, the client may use them for display.
import { INVENTORY_SLOTS, ITEMS, MAX_STACK, isEquip, type Item } from "./items.ts";

/** mmo.hpp MAX_ZENY (INT_MAX). */
export const MAX_ZENY = 2_147_483_647;
/** clif packets carry buy/sell amounts as uint16. */
const MAX_LINE_AMOUNT = 0xffff;

/** What the rules need to know about one inventory row. */
export type HeldRow = { itemId: number; amount: number; equip: string | null };

/** itemdb_isstackable2 -> item_data::isStackable (itemdb.cpp:4932): weapons/armor (and pet eggs/armor, shadow gear — not in our
 *  data yet) never stack. Everything else does, ammo included although it is worn (isEquip). */
export const isStackable = (it: Item) => (!isEquip(it) || it.type === "Ammo") && !/^pet(egg|armor)$/i.test(it.type); // 2.4.0: IT_PETEGG / IT_PETARMOR

/** item_data::inventorySlotNeeded: a stackable item takes one row, every non-stackable piece takes its own. */
export const slotsNeeded = (it: Item, amount: number) => (isStackable(it) ? 1 : amount);

export type AddCheck = "exist" | "new" | "overamount";
/** pc_checkadditem (pc.cpp): would `amount` more of `it` merge into an existing stack, need a new row, or pass MAX_AMOUNT?
 *  `pending` = amount of this item already promised earlier in the same transaction (0 for a single add). The stack may be worn
 *  (equipped arrows): pc_checkadditem / pc_additem match on the item alone, so bought arrows join the equipped ones. */
export function checkAddItem(held: readonly HeldRow[], it: Item, amount: number, pending = 0): AddCheck {
  if (amount > MAX_STACK) return "overamount";
  if (!isStackable(it)) return "new";
  const s = held.find((r) => r.itemId === it.id);
  if (s) return amount + pending > MAX_STACK - s.amount ? "overamount" : "exist";
  return amount + pending > MAX_STACK ? "overamount" : "new";
}

/** pc_inventoryblank: free inventory rows. */
export const inventoryBlank = (held: readonly HeldRow[]) => Math.max(0, INVENTORY_SLOTS - held.length);

/** pc_getzeny: gains are clamped so the purse never passes MAX_ZENY. Returns the new zeny. */
export const getZeny = (zeny: number, gain: number) => zeny + Math.max(0, Math.min(gain, MAX_ZENY - zeny));

/** e_purchase_result (npc.hpp). */
export type BuyResult = "ok" | "money" | "weight" | "count";
export type BuyLine = { itemId: number; amount: number };

/** npc_buylist (npc.cpp): validates the whole list before anything changes hands. Any unknown/unsold item or malformed
 *  amount fails the purchase (PURCHASE_FAIL_COUNT); equipment is clamped to 1 piece per line; a stack that would pass
 *  MAX_AMOUNT is a weight failure checked per line, then zeny, total weight and free rows (summed over all lines).
 *  Deviation: the MAX_AMOUNT check counts earlier lines of the same item too (rAthena checks each line alone, then
 *  pc_additem silently drops the overflow after the zeny is taken). */
export function buyList(
  raw: readonly unknown[], shopIds: readonly number[], held: readonly HeldRow[], zeny: number, weight: number, maxWeight: number,
): { result: BuyResult; lines: BuyLine[]; cost: number } {
  const lines: BuyLine[] = [], fail = (result: BuyResult) => ({ result, lines: [], cost: 0 });
  if (!raw.length) return fail("count");
  let cost = 0, w = 0, newRows = 0;
  const pending = new Map<number, number>();
  for (const l of raw as { itemId?: unknown; amount?: unknown }[]) {
    const id = Number(l?.itemId);
    let amount = Number(l?.amount);
    if (!shopIds.includes(id)) return fail("count"); // no such item in shop
    const it = ITEMS.get(id);
    if (!it) return fail("count"); // item no longer in itemdb
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_LINE_AMOUNT) return fail("count");
    if (!isStackable(it) && amount > 1) amount = 1; // "hexed packet": one piece of equipment per line
    const chk = checkAddItem(held, it, amount, pending.get(id) ?? 0);
    if (chk === "overamount") return fail("weight");
    if (chk === "new") newRows += slotsNeeded(it, amount); // per line, like rAthena's new_ (a repeated new item counts twice)
    pending.set(id, (pending.get(id) ?? 0) + amount);
    cost += it.buy * amount;
    w += it.weight * amount;
    lines.push({ itemId: id, amount });
  }
  if (cost > zeny) return fail("money");
  if (w + weight > maxWeight) return fail("weight");
  if (inventoryBlank(held) < newRows) return fail("count");
  return { result: "ok", lines, cost };
}

export type SellLine = { row: number; amount: number };
/** npc_selllist (npc.cpp) + pc_can_sell_item (pc.cpp): every line is checked before any item is deleted; one bad line
 *  (unknown row, bad amount, more than held, equipped) rejects the whole list. The gain is capped at MAX_ZENY.
 *  Lines naming the same row are summed so the list can't sell a row twice. `rows` maps the client's row key to the row. */
export function sellList(raw: readonly unknown[], rows: ReadonlyMap<number, HeldRow>): { ok: boolean; lines: SellLine[]; gain: number } {
  const fail = { ok: false, lines: [], gain: 0 };
  if (!raw.length) return fail;
  const want = new Map<number, number>();
  for (const l of raw as { uid?: unknown; amount?: unknown }[]) {
    const key = Number(l?.uid), amount = Number(l?.amount);
    const r = rows.get(key);
    if (!r || !Number.isInteger(amount) || amount < 1 || amount > MAX_LINE_AMOUNT) return fail;
    if (r.equip) return fail; // pc_can_sell_item: item->equip > 0
    const total = (want.get(key) ?? 0) + amount;
    if (total > r.amount) return fail;
    want.set(key, total);
  }
  let gain = 0;
  for (const [key, amount] of want) gain += (ITEMS.get(rows.get(key)!.itemId)?.sell ?? 0) * amount;
  return { ok: true, lines: [...want].map(([row, amount]) => ({ row, amount })), gain: Math.min(gain, MAX_ZENY) };
}
