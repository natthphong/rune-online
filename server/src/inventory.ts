// Per-character inventory, kept in memory while the character is online and written through to Postgres on every
// change (one promise chain per character, so writes land in order and a crash loses nothing that was confirmed).
// The same chain carries the character's status saves, and the next session of the character waits for it to drain.
import { ITEMS, ammoOffForWeapon, ammoOffWithWeapon, gearOf, maxWeight, slotsOf, type EquipSlot, type Item, type WornItem } from "../../shared/rules/items.ts";
import { checkAddItem, getZeny, inventoryBlank, isStackable, slotsNeeded } from "../../shared/rules/shop.ts";
import { compoundBlock, withCard, MAX_SLOTS } from "../../shared/rules/cards.ts";
import type { JobKey } from "../../shared/rules/data.ts";
import { db } from "./db.ts";

/** One inventory row. cards = the item ids compounded into it, in slot order (inventory.card0..card3; shared/rules/cards.ts). */
export type Stack = { uid: number; itemId: number; amount: number; equip: EquipSlot | null; refine: number; cards: number[]; petId?: number };
export type InvMessage = { items: Stack[]; zeny: number; weight: number; maxWeight: number };

/** One DB write chain per character, shared by every session of it (any room). Inventory rows, zeny and the status save
 *  (MapRoom.save) all queue here, so they land in order and a relog can wait for the previous session's tail. */
const chains = new Map<number, Promise<unknown>>();

function enqueue<T>(charId: number, run: () => Promise<T>): Promise<T> {
  const p = (chains.get(charId) ?? Promise.resolve()).then(run);
  chains.set(charId, p.catch((e) => console.error("[persist]", charId, e)));
  return p;
}

/** Resolves when every write queued for the character so far, by any session, has landed. The character's next session
 *  awaits this before it reads its row: the char-server only answers a new login after the old session's final save
 *  (char.cpp char_auth_ok kicks + refuses while online; char_mapif.cpp chmapif_parse_reqsavechar saves, then sets the
 *  character offline). */
export async function writesSettled(charId: number) {
  for (let tail = chains.get(charId); tail; tail = chains.get(charId)) {
    await tail;
    if (chains.get(charId) === tail) { chains.delete(charId); return; }
  }
}

export class Inventory {
  /** Rows by session key. Every change lands here synchronously (like pc_additem/pc_delitem on sd->inventory), so the
   *  next add/check sees it at once; Postgres follows on the write chain. A loaded row's key is its DB uid; a row added
   *  this session gets the next free key right away and learns its DB uid when its INSERT runs. */
  items = new Map<number, Stack>();
  zeny = 0;
  /** set once the session is gone (MapRoom.evict): later writes are dropped so a stale session can't touch the next one's data */
  private closed = false;
  private dbUid = new Map<number, number>();
  private nextKey = 0;
  readonly charId: number;

  constructor(charId: number) { this.charId = charId; }

  /** Call after writesSettled(charId) and with the zeny read after it (MapRoom.onJoin does both). */
  static async load(charId: number, zeny: number) {
    await writesSettled(charId);
    const inv = new Inventory(charId);
    inv.zeny = Number(zeny);
    const { rows } = await db.query("SELECT uid, item_id, amount, equip, refine, card0, card1, card2, card3, pet_id FROM inventory WHERE char_id = $1", [charId]);
    for (const r of rows) {
      const uid = Number(r.uid);
      inv.nextKey = Math.max(inv.nextKey, uid);
      if (!ITEMS.has(r.item_id)) continue; // item removed from the data set
      inv.items.set(uid, { uid, itemId: r.item_id, amount: r.amount, equip: r.equip, refine: r.refine, cards: [r.card0, r.card1, r.card2, r.card3].filter((c) => c > 0), ...(r.pet_id ? { petId: Number(r.pet_id) } : {}) });
      inv.dbUid.set(uid, uid);
    }
    return inv;
  }

  /** queue a DB write on the character's chain (after everything queued before it, by this or an earlier session) */
  persist(sql: string, args: unknown[]) {
    if (this.closed) return Promise.reject(new Error(`write after session end (char ${this.charId}): ${sql.slice(0, 40)}`));
    return enqueue(this.charId, () => db.query(sql, args));
  }
  private write(sql: string, args: unknown[]) {
    this.persist(sql, args).catch(() => {}); // failures are logged by the chain
  }
  /** queue a write on one row; its DB uid is resolved when the write runs (a new row's INSERT is earlier on the chain) */
  private writeRow(key: number, sql: string, args: unknown[] = []) {
    if (this.closed) return console.error(`[inventory] write after session end (char ${this.charId})`);
    enqueue(this.charId, async () => {
      const uid = this.dbUid.get(key);
      if (uid === undefined) return; // its INSERT failed (already logged)
      return db.query(sql, [uid, ...args]);
    }).catch(() => {});
  }
  /** resolves when every queued write of this character has landed */
  flush() { return writesSettled(this.charId); }
  /** End of session: nothing this object does from now on reaches Postgres (queue the final save before calling it). */
  close() { this.closed = true; }

  weight() {
    let w = 0;
    for (const s of this.items.values()) w += (ITEMS.get(s.itemId)?.weight ?? 0) * s.amount;
    return w;
  }
  equipped(slot: EquipSlot): Stack | undefined {
    for (const s of this.items.values()) {
      if (!s.equip) continue;
      if (s.equip === slot || slotsOf(ITEMS.get(s.itemId)!).includes(slot)) return s;
    }
    return undefined;
  }
  /** The stack pc_additem merges into: the same item, worn or not (bought or looted arrows join the equipped ones). Only
   *  stackable items are looked up, and ammo is the only stackable item that can be worn. */
  findStack(itemId: number) {
    for (const s of this.items.values()) if (s.itemId === itemId) return s;
    return undefined;
  }
  rows(): Stack[] { return [...this.items.values()]; }

  /** Room check before adding (pc_additem's weight test + pc_checkadditem + pc_inventoryblank). Returns a reason when it
   *  doesn't fit. */
  canAdd(item: Item, amount: number, job: JobKey, str: number): string | null {
    if (this.weight() + item.weight * amount > maxWeight(job, str)) return "you are carrying too much";
    const held = this.rows(), chk = checkAddItem(held, item, amount);
    if (chk === "overamount") return "can't carry more of that";
    if (chk === "new" && inventoryBlank(held) < slotsNeeded(item, amount)) return "your bag is full";
    return null;
  }

  /** pc_additem: merges into the existing stack or creates the row(s) now; the DB catches up on the chain.
   *  Callers check canAdd first. */
  add(itemId: number, amount: number) {
    const item = ITEMS.get(itemId)!;
    if (isStackable(item)) {
      const s = this.findStack(itemId);
      if (s) {
        s.amount += amount;
        this.writeRow(s.uid, "UPDATE inventory SET amount = $2 WHERE uid = $1", [s.amount]);
        return;
      }
    }
    // equipment never stacks: one row per piece
    const each = isStackable(item) ? amount : 1;
    for (let i = 0; i < slotsNeeded(item, amount); i++) {
      const key = ++this.nextKey;
      this.items.set(key, { uid: key, itemId, amount: each, equip: null, refine: 0, cards: [] });
      if (this.closed) { console.error(`[inventory] write after session end (char ${this.charId})`); continue; }
      enqueue(this.charId, async () => {
        const res = await db.query("INSERT INTO inventory (char_id, item_id, amount) VALUES ($1, $2, $3) RETURNING uid", [this.charId, itemId, each]);
        this.dbUid.set(key, Number(res.rows[0].uid));
      }).catch(() => {});
    }
  }

  /** pet_get_egg / pet_return_egg (2.4.0): one egg row that points at its pet (rAthena: card0 = CARD0_PET, card1/2 = the pet id).
   *  Returns the row's key. Callers check canAdd first. */
  addEgg(itemId: number, petId: number) {
    const key = ++this.nextKey;
    this.items.set(key, { uid: key, itemId, amount: 1, equip: null, refine: 0, cards: [], petId });
    if (this.closed) { console.error(`[inventory] write after session end (char ${this.charId})`); return key; }
    enqueue(this.charId, async () => {
      const res = await db.query("INSERT INTO inventory (char_id, item_id, amount, pet_id) VALUES ($1, $2, 1, $3) RETURNING uid", [this.charId, itemId, petId]);
      this.dbUid.set(key, Number(res.rows[0].uid));
    }).catch(() => {});
    return key;
  }

  remove(uid: number, amount: number) {
    const s = this.items.get(uid);
    if (!s || amount <= 0 || amount > s.amount) return false;
    s.amount -= amount;
    if (s.amount === 0) {
      this.items.delete(uid);
      this.writeRow(uid, "DELETE FROM inventory WHERE uid = $1");
      void (chains.get(this.charId) ?? Promise.resolve()).then(() => this.dbUid.delete(uid));
    } else {
      this.writeRow(uid, "UPDATE inventory SET amount = $2 WHERE uid = $1", [s.amount]);
    }
    return true;
  }

  /** pc_equipitem: frees every slot the item needs (two-handers take weapon + shield; a piece pushed out keeps the ammo on,
   *  pc_unequipitem flag 4). A new weapon that can't use the worn ammo takes it off (ammo_unequip, pc.cpp:12201-12226). */
  equip(uid: number) {
    const s = this.items.get(uid)!;
    const it = ITEMS.get(s.itemId)!;
    const slots = slotsOf(it);
    for (const slot of slots) {
      const cur = this.equipped(slot);
      if (cur && cur.uid !== uid) this.unequip(cur.uid, true);
    }
    s.equip = slots[0];
    this.writeRow(uid, "UPDATE inventory SET equip = $2 WHERE uid = $1", [s.equip]);
    const ammo = this.equipped("ammo");
    if (it.type === "Weapon" && ammo && ammoOffForWeapon(it.subType ?? "Fist", ITEMS.get(ammo.itemId)!.subType ?? "")) this.unequip(ammo.uid, true);
  }

  /** pc_unequipitem. swap = flag 4 (pushed out by pc_equipitem). Taking off a bow / instrument / whip / gun by request takes the
   *  worn ammo off with it (ammo_unequip, pc.cpp:12461-12479). */
  unequip(uid: number, swap = false) {
    const s = this.items.get(uid);
    if (!s?.equip) return false;
    s.equip = null;
    this.writeRow(uid, "UPDATE inventory SET equip = NULL WHERE uid = $1");
    const it = ITEMS.get(s.itemId)!, ammo = this.equipped("ammo");
    if (!swap && ammo && it.type === "Weapon" && ammoOffWithWeapon(it.subType ?? "Fist")) this.unequip(ammo.uid, true);
    return true;
  }

  /** pc_insert_card (pc.cpp:5596): compound card row `cardUid` into piece row `equipUid`. The checks are shared/rules/cards.ts
   *  compoundBlock (returned as the reason); then the card is deleted (pc_delitem) and its id goes into the first free slot, written
   *  through at once. null = done. */
  insertCard(cardUid: number, equipUid: number): string | null {
    const card = this.items.get(cardUid), piece = this.items.get(equipUid);
    if (!card || !piece || card.amount < 1) return "that item is gone";
    const cardItem = ITEMS.get(card.itemId)!;
    const why = compoundBlock(cardItem, piece);
    if (why) return why;
    const slot = piece.cards.length;
    if (slot >= MAX_SLOTS) return "no free slot";
    this.remove(cardUid, 1);
    piece.cards = withCard(piece.cards, card.itemId);
    this.writeRow(equipUid, `UPDATE inventory SET card${slot} = $2 WHERE uid = $1`, [card.itemId]);
    return null;
  }

  /** successrefitem: the row's refine becomes `level`, written through at once. */
  setRefine(uid: number, level: number) {
    const s = this.items.get(uid);
    if (!s) return;
    s.refine = level;
    this.writeRow(uid, "UPDATE inventory SET refine = $2 WHERE uid = $1", [level]);
  }

  /** pc_payzeny: false (and nothing taken) when the purse is short. */
  payZeny(z: number) {
    if (!(z >= 0) || z > this.zeny) return false;
    this.setZeny(this.zeny - z);
    return true;
  }
  /** pc_getzeny: capped at MAX_ZENY. */
  gainZeny(z: number) { this.setZeny(getZeny(this.zeny, z)); }
  private setZeny(z: number) {
    this.zeny = z;
    this.write("UPDATE characters SET zeny = $2 WHERE id = $1", [this.charId, z]);
  }

  /** Inputs for playerStatus from the worn stacks with their refine (shared/rules/items.ts gearOf: weapon, shield, DEF, refine + script bonuses). */
  gear() {
    const worn: WornItem[] = [];
    for (const s of this.items.values()) if (s.equip) worn.push({ item: ITEMS.get(s.itemId)!, refine: s.refine, cards: s.cards });
    return gearOf(worn);
  }

  message(job: JobKey, str: number): InvMessage {
    return { items: this.rows().map((s) => ({ ...s, cards: [...s.cards] })), zeny: this.zeny, weight: this.weight(), maxWeight: maxWeight(job, str) };
  }
}
