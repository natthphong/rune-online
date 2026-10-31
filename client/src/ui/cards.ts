// The card compound window (clif_use_card -> ZC_ITEMCOMPOSITION_LIST, clif_parse_InsertCard -> pc_insert_card): a card double-clicked
// in the bag (or fired from a shortcut slot) asks the server for the pieces it fits (Msg.useItem on a card answers with Msg.cardList);
// the player picks one here and the server compounds it for good (cards can't be taken out), answers with Msg.cardAck and the bag.
// Rules and names: shared/rules/cards.ts. The server decides everything; this window only shows its list.
import "./cards.css";
import { ITEMS } from "../../../shared/rules/items.ts";
import { itemDisplayName } from "../../../shared/rules/cards.ts";
import type { CardAckEvent, CardListEvent, InvEvent } from "../../../shared/protocol.ts";
import { play } from "../audio.ts";
import { inspectCard } from "./cardart.ts";
import { toggle } from "./windows.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Stack = InvEvent["items"][number];

export type CardView = {
  insert: (card: number, equip: number) => void;
  inventory: () => InvEvent;
  icon: (itemId: number) => HTMLElement;
  log: (text: string) => void;
};
let view: CardView;
let open: { card: number; targets: number[] } | null = null;
let chosen: number | null = null;

/** Small squares for a piece's slots, filled for the cards inside (empty element when the piece has no slots). */
export function pips(slots: number, filled: number): HTMLElement {
  const el = document.createElement("span");
  el.className = "pips";
  for (let i = 0; i < slots; i++) el.append(Object.assign(document.createElement("i"), { className: i < filled ? "on" : "" }));
  return el;
}

function render() {
  const win = $("w-card");
  if (!open) return toggle(win, false);
  const inv = view.inventory();
  const card = inv.items.find((s) => s.uid === open!.card);
  if (!card) { open = null; return toggle(win, false); } // the card is gone (sold, dropped, used up)
  $("card-intro").textContent = `Choose the gear to compound ${ITEMS.get(card.itemId)!.name} into.`;
  const peek = document.createElement("button"); // look at the card's picture
  peek.type = "button"; peek.className = "btn"; peek.textContent = "Inspect card"; peek.addEventListener("click", () => inspectCard(card.itemId));
  $("card-intro").append(" ", peek);
  const list = $("card-list");
  list.innerHTML = "";
  for (const uid of open.targets) {
    const st = inv.items.find((s) => s.uid === uid);
    if (!st) continue;
    const it = ITEMS.get(st.itemId)!;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `card-row${chosen === uid ? " on" : ""}`;
    const text = document.createElement("span");
    text.textContent = itemDisplayName(it, st.cards, st.refine);
    const free = document.createElement("small");
    free.textContent = `${it.slots - st.cards.length} of ${it.slots} slots free`;
    text.append(free);
    row.append(view.icon(st.itemId), text, pips(it.slots, st.cards.length));
    row.addEventListener("click", () => { chosen = uid; render(); });
    row.addEventListener("dblclick", () => { chosen = uid; ok(); });
    list.append(row);
  }
  ($("card-ok") as HTMLButtonElement).disabled = chosen === null;
  if (win.hidden) toggle(win, true);
}
function ok() {
  if (!open || chosen === null) return;
  view.insert(open.card, chosen);
  ($("card-ok") as HTMLButtonElement).disabled = true; // one answer per request: the ack closes the window
}

/** Msg.cardList: open the window on the pieces the server listed. */
export function openCardList(m: CardListEvent) {
  open = { card: m.card, targets: m.targets };
  chosen = m.targets.length === 1 ? m.targets[0] : null;
  render();
}
/** Msg.cardAck: the answer to a compound request. The new bag follows as Msg.inv. */
export function cardAck(m: CardAckEvent) {
  open = null; chosen = null;
  toggle($("w-card"), false);
  if (m.ok) { view.log("The card sinks into the gear with a soft glow."); play("sfx", "levelup", 0.5); }
  else { view.log(`Can't compound: ${m.text ?? "it failed"}.`); play("sfx", "error", 0.5); }
}
/** The bag changed: keep the list honest (a listed piece may be gone). */
export function refreshCards(_inv: InvEvent) { if (open) render(); }

export function initCards(v: CardView) {
  view = v;
  $("card-ok").addEventListener("click", ok);
  $("w-card").querySelector("[data-close]")?.addEventListener("click", () => { open = null; chosen = null; });
}
export type { Stack };
