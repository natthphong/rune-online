// Cards — compounding a card into slotted equipment, and the name the carded piece shows. Re-implemented from rAthena:
//   src/map/clif.cpp  clif_use_card (7074)      the list of equipment a card can go into (CZ_REQ_ITEMCOMPOSITION_LIST -> ZC_ITEMCOMPOSITION_LIST)
//   src/map/pc.cpp    pc_insert_card (5596)     the checks and the first free slot (CZ_REQ_ITEMCOMPOSITION -> ZC_ACK_ITEMCOMPOSITION)
//   src/map/status.cpp status_calc_pc_sub "Parse Cards" (4098)  the card scripts run after every worn piece's own script (items.ts gearOf)
//   src/map/mob.cpp   mob_dead drop loop        cards are dropped like any item, with item_rate_card (rules/drops.ts dropGroup "card")
// Cards sit in an equipment row's card[] (MAX_SLOTS 4): the first free one is filled, nothing takes a card out again.
// A card item's Locations decide what it fits (the Leafgrub card = Right_Hand = weapons, the Puddlebloom card = Armor, ...); items.json
// `affix` is the prefix / suffix our own wording gives the carded piece (RO keeps those in client files, not in rAthena).
import type { Item } from "./items.ts";
import { ITEMS, SLOT_LABEL, isEquip, slotsOf } from "./items.ts";

/** MAX_SLOTS (mmo.hpp): the most cards one piece can hold. */
export const MAX_SLOTS = 4;

/** pc.hpp enum equip_pos: the bit of each item_db Location, so "does the card's Location overlap the item's" is the same & test
 *  pc_insert_card makes (item_eq->equip & item_card->equip). Both_Hand = both hand bits, Both_Accessory = both accessory bits. */
const EQP_BIT: Readonly<Record<string, number>> = {
  Head_Low: 0x1, Right_Hand: 0x2, Garment: 0x4, Left_Accessory: 0x8, Armor: 0x10, Left_Hand: 0x20, Shoes: 0x40, Right_Accessory: 0x80,
  Head_Top: 0x100, Head_Mid: 0x200, Ammo: 0x8000,
};
const EQP_BOTH: Readonly<Record<string, number>> = { Both_Hand: 0x2 | 0x20, Both_Accessory: 0x8 | 0x80 };
const EQP_SHIELD = 0x20, EQP_ACC = 0x8 | 0x80;
const eqp = (locations: readonly string[]) => locations.reduce((m, l) => m | (EQP_BIT[l] ?? EQP_BOTH[l] ?? 0), 0);

export const isCard = (it: { type: string }) => it.type === "Card";

/** What the compound rules read of a row of the inventory: the item, whether it is worn, and the cards already in it. */
export type CardRow = { itemId: number; equip: string | null; cards?: readonly number[] };

/** The reason a card can't go into a piece, in pc_insert_card's order (and clif_use_card's filter: a piece failing any of them is not
 *  listed); null = it fits. `identify` / reserved card[0] (forged weapons, pets) don't exist here. */
export function compoundBlock(card: Item, row: CardRow): string | null {
  const it = ITEMS.get(row.itemId);
  if (!it || card.type !== "Card") return "that is not a card";
  if (it.type !== "Weapon" && it.type !== "Armor") return "only weapons and armor take cards"; // item_eq->type != IT_WEAPON / IT_ARMOR
  const piece = eqp(it.locations), cardEqp = eqp(card.locations);
  if ((piece & cardEqp) === 0) return `${card.name} doesn't fit ${it.name}`; // card cannot be compounded on this item type
  if (it.type === "Weapon" && cardEqp === EQP_SHIELD) return "a shield card can't go on a weapon";
  // a card for one accessory side only fits that side's accessory (no accessory equipment exists yet)
  if (it.type === "Armor" && cardEqp & EQP_ACC && (cardEqp & EQP_ACC) !== EQP_ACC && (piece & EQP_ACC) !== (cardEqp & EQP_ACC)) return `${card.name} doesn't fit ${it.name}`;
  if (row.equip) return "take it off first"; // item must be unequipped
  if ((row.cards?.length ?? 0) >= it.slots) return it.slots ? `${it.name} has no free slot` : `${it.name} has no slots`; // no free slots
  return null;
}

/** clif_use_card: the rows of the bag this card can be compounded into (uids in the order given). */
export function cardTargets<R extends CardRow>(card: Item, rows: readonly R[]): R[] {
  return rows.filter((r) => isEquip(ITEMS.get(r.itemId) ?? { type: "" }) && compoundBlock(card, r) === null);
}

/** pc_insert_card's result: the piece's cards with the new one in the first free slot. Call compoundBlock first. */
export const withCard = (cards: readonly number[] | undefined, cardId: number): number[] => [...(cards ?? []), cardId];

const COUNT_WORD = ["", "Double ", "Triple ", "Quadruple "] as const;
/** The name of a piece with its cards, the way RO's client composes it (roBrowser DBManager.getItemName, default branch): every
 *  distinct card in slot order contributes its prefix (before the name, "Double " / "Triple " / "Quadruple " for a repeated card)
 *  or its suffix (after it), then the slot count: "Double Mighty Sword of Insight [3]". `refine` adds RO's leading "+N". */
export function itemDisplayName(it: Pick<Item, "name" | "slots">, cards: readonly number[] = [], refine = 0): string {
  const seen = new Map<number, number>();
  for (const c of cards) seen.set(c, (seen.get(c) ?? 0) + 1);
  let prefix = "", suffix = "";
  for (const [id, n] of seen) {
    const a = ITEMS.get(id)?.affix as { pos: string; text: string } | null | undefined;
    if (!a) continue;
    const word = `${COUNT_WORD[Math.min(n, 4) - 1]}${a.text}`;
    if (a.pos === "suffix") suffix += ` ${word}`; else prefix += `${word} `;
  }
  return `${refine > 0 ? `+${refine} ` : ""}${prefix}${it.name}${suffix}${it.slots ? ` [${it.slots}]` : ""}`;
}

/** Text lines for a card's effect in a tooltip: its item script as plain sentences (the bonuses the rules apply), then what it can't do yet. */
export function cardEffectLines(card: Item): string[] {
  const stat = (b: { type: string; value: number | string; type2?: string }) => describeBonus(b);
  return [...card.bonuses.map(stat), ...card.unsupported.map((u) => `${u} (no effect yet)`)];
}

const BONUS_TEXT: Readonly<Record<string, (v: number, t2?: string) => string>> = {
  bStr: (v) => `STR ${sign(v)}`, bAgi: (v) => `AGI ${sign(v)}`, bVit: (v) => `VIT ${sign(v)}`, bInt: (v) => `INT ${sign(v)}`, bDex: (v) => `DEX ${sign(v)}`, bLuk: (v) => `LUK ${sign(v)}`,
  bAllStats: (v) => `All stats ${sign(v)}`, bMaxHP: (v) => `Max HP ${sign(v)}`, bMaxSP: (v) => `Max SP ${sign(v)}`,
  bMaxHPrate: (v) => `Max HP ${sign(v)}%`, bMaxSPrate: (v) => `Max SP ${sign(v)}%`,
  bBaseAtk: (v) => `ATK ${sign(v)}`, bAtk: (v) => `Weapon ATK ${sign(v)}`, bMatk: (v) => `MATK ${sign(v)}`, bAtkRate: (v) => `ATK ${sign(v)}%`, bMatkRate: (v) => `MATK ${sign(v)}%`,
  bDef: (v) => `DEF ${sign(v)}`, bMdef: (v) => `MDEF ${sign(v)}`, bHit: (v) => `HIT ${sign(v)}`, bFlee: (v) => `FLEE ${sign(v)}`, bFlee2: (v) => `Perfect Dodge ${sign(v)}`,
  bCritical: (v) => `CRIT ${sign(v)}`, bAspdRate: (v) => `ASPD ${sign(v)}%`,
  bAddEle: (v, t) => `${sign(v)}% damage to ${t} monsters`, bAddRace: (v, t) => `${sign(v)}% damage to ${t} monsters`, bAddSize: (v, t) => `${sign(v)}% damage to ${t} monsters`,
  bAddClass: (v, t) => `${sign(v)}% damage to ${t} monsters`, bSubEle: (v, t) => `${sign(v)}% damage taken from ${t}`, bSubRace: (v, t) => `${sign(v)}% damage taken from ${t}`,
  bSubSize: (v, t) => `${sign(v)}% damage taken from ${t}`, bSubClass: (v, t) => `${sign(v)}% damage taken from ${t}`,
};
const sign = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
/** One statement of an item script as a tooltip line ("STR +1"); an unknown bonus keeps its script name. */
export function describeBonus(b: { type: string; value: number | string; type2?: string }): string {
  const f = BONUS_TEXT[b.type];
  if (f && typeof b.value === "number") return f(b.value, b.type2);
  if ((b.type === "bAtkEle" || b.type === "bDefEle") && typeof b.value === "string") return `${b.type === "bAtkEle" ? "Attack" : "Armor"} element: ${b.value}`;
  return `${b.type} ${b.value}${b.type2 ? ` (${b.type2})` : ""}`;
}

/** Where a card goes, for its tooltip: "Weapon", "Armor", "Shoes"... (item_db Locations, RO's "Compound on" line). */
export function cardGoesOn(card: Pick<Item, "locations">): string {
  const slots = [...new Set(slotsOf(card))];
  if ((card.locations as string[]).includes("Right_Hand") && !(card.locations as string[]).includes("Left_Hand")) return "Weapon";
  return slots.map((s) => SLOT_LABEL[s]).join(" / ") || "Equipment";
}
