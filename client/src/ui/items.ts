// Item windows: Inventory (Alt+E), Equipment (Alt+Q), NPC shop, the shortcut window (hotkeys, F1–F9), item tooltips.
// The server is authoritative; these windows render the last `inv` snapshot and send intents.
import { INVENTORY_SLOTS, ITEMS, SLOTS, SLOT_LABEL, isEquip, isUsable, weightPct, NATURAL_HEAL_WEIGHT, MAJOR_OVERWEIGHT, type EquipSlot, type Item } from "../../../shared/rules/items.ts";
import type { HotkeysMsg, InvEvent, ShopEvent } from "../../../shared/protocol.ts";
import {
  HOTKEY_ACTIONS, HOTKEY_BARS, HOTKEY_QUICKSLOTS, HOTKEY_ROW, MAX_HOTKEYS, QUICKSLOT_FIRST, barOfRow, hotkeyIndex, hotkeyList, isHotkeyAction, isRowShift, rotateBars, type HotkeyList,
} from "../../../shared/rules/hotkey.ts";
import { cardEffectLines, cardGoesOn, isCard, itemDisplayName } from "../../../shared/rules/cards.ts";
import { GRADE_COLOR, GRADE_LABEL, itemGrade } from "../../../shared/rules/grade.ts";
import { onLangChange, t } from "../i18n.ts";
import { MOB_BY_ID } from "../../../shared/rules/data.ts";
import { play } from "../audio.ts";
import { toggle } from "./windows.ts";
import { cardAck, initCards, openCardList, pips, refreshCards } from "./cards.ts";
import { hotkeySkill } from "../../../shared/rules/hotkey.ts";
import { inspectCard } from "./cardart.ts";
import { beginSkill, skillIconEl, skillTip } from "./skills.ts"; // skill slots (C04): icon, tooltip, use

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Stack = InvEvent["items"][number];

export type ItemHooks = {
  use: (uid: number) => void;
  equip: (uid: number) => void;
  unequip: (uid: number) => void;
  buy: (npc: string, items: { itemId: number; amount: number }[]) => void;
  sell: (npc: string, items: { uid: number; amount: number }[]) => void;
  hotkeys: (m: HotkeysMsg) => void; // slot list and/or bar rotation
  sit: () => void; // the sit action slot
  preview: (cv: HTMLCanvasElement) => void; // draw the player into the equipment window
  quit?: (npc: string) => void; // the shop list window was closed by the player (CZ_NPC_TRADE_QUIT)
  insertCard?: (card: number, equip: number) => void; // CZ_REQ_ITEMCOMPOSITION: compound `card` into the piece `equip` (ui/cards.ts)
  log?: (text: string) => void; // a system line in the chat log
};
let hooks: ItemHooks;
let inv: InvEvent = { items: [], zeny: 0, weight: 0, maxWeight: 1 };
let hotkeys: HotkeyList = Array(MAX_HOTKEYS).fill(null);
let rowShift = 0;
let tab: "item" | "equip" | "etc" | "fav" = "item";

// ---------- icons ----------
let atlas: { size: number; cols: number; names: Record<string, number> } | null = null;
fetch("/icons/items.json").then((r) => r.json()).then((a) => { atlas = a; renderAll(); }).catch(() => {});
const TYPE_COLOR: Record<string, string> = { Healing: "#e2574c", Usable: "#e8a33d", DelayConsume: "#7cb7ff", Weapon: "#9aa3b5", Armor: "#8a6a4a", Ammo: "#c2a46a", Etc: "#a6b07a" };

/** An item icon at `px` (32 in windows, 24 in the shortcut window like the original's icons), with an amount badge > 1. */
export function iconEl(itemId: number, amount?: number, px = 32) {
  const it = ITEMS.get(itemId);
  const el = document.createElement("div");
  el.className = "icon";
  const grade = it ? itemGrade(it) : "common";
  if (grade !== "common") el.dataset.grade = grade; // frame colour (style.css .icon[data-grade])
  const idx = it && atlas ? atlas.names[it.name] : undefined;
  if (idx !== undefined && atlas) {
    const s = px / atlas.size;
    el.style.backgroundImage = "url(/icons/items.png)";
    el.style.backgroundSize = `${atlas.cols * atlas.size * s}px auto`;
    el.style.backgroundPosition = `-${(idx % atlas.cols) * px}px -${Math.floor(idx / atlas.cols) * px}px`;
  } else { // placeholder until the icon sheet is generated
    el.classList.add("ph");
    el.style.background = TYPE_COLOR[it?.type ?? "Etc"] ?? "#999";
    el.textContent = (it?.name ?? "?").slice(0, 2);
  }
  if (px !== 32) el.style.width = el.style.height = `${px}px`;
  if (amount !== undefined && amount > 1) {
    const n = document.createElement("b");
    n.textContent = String(amount);
    el.append(n);
  }
  return el;
}

// ---------- tooltip ----------
const GOLD = "color:#e2b43a;text-shadow:0 0 4px rgba(255,205,80,.55)"; // legendary cards (items.json rarity) show their name in gold
const goldName = (it: Item) => ((it as { rarity?: string }).rarity === "legendary" ? `<span style="${GOLD}">${it.name}</span>` : it.name);
const gradeName = (it: Item, text: string, dark = true) => { // the item's name in its grade colour (plain for common)
  const g = itemGrade(it);
  return g === "common" ? text : `<span style="color:${GRADE_COLOR[g][dark ? "dark" : "light"]}">${text}</span>`;
};
function describe(it: Item, st?: Stack) {
  const lines = [`<b>${isEquip(it) ? gradeName(it, itemDisplayName(it, st?.cards, st?.refine)) : goldName(it)}</b>`];
  if (itemGrade(it) !== "common") lines.push(`<span class="gradeline" style="color:${GRADE_COLOR[itemGrade(it)].dark}">${t("item.grade", { grade: GRADE_LABEL[itemGrade(it)] })}</span>`); // "+4 Double Mighty Sword of Insight [3]" (cards.ts)
  if (it.type === "Weapon") lines.push(t("item.weapon", { sub: it.subType ?? "", lv: it.weaponLevel }), `ATK ${it.atk}${it.range > 1 ? ` · ${t("item.range", { n: it.range })}` : ""}`);
  else if (it.type === "Armor") lines.push(`${t("item.armor")} · ${it.locations.map((l) => l.replace("_", " ")).join(", ")}`, `DEF ${it.def}`);
  else if (it.type === "Ammo") lines.push(`${t("ui.ammo")} · ${it.subType}`, `ATK ${it.atk}`);
  else if (isCard(it)) { // a card: where it goes, what it does, who dropped it
    if ((it as { rarity?: string }).rarity === "legendary") lines.push(`<span style="${GOLD}">${t("item.legendary")}</span>`);
    const mob = it.mobId ? MOB_BY_ID.get(it.mobId) : undefined;
    lines.push(t("item.card_on", { on: cardGoesOn(it) }), ...cardEffectLines(it).map((l) => `<span class="cardfx">${l}</span>`));
    if (mob) lines.push(`<span class="muted">${t("item.dropped_by", { name: mob.name, lv: mob.level })}</span>`);
  } else lines.push(it.type === "Etc" ? t("item.material") : it.type);
  if (isEquip(it) && it.slots) { // one line per slot: the card inside (and what it does) or empty
    for (let i = 0; i < it.slots; i++) {
      const c = st?.cards?.[i] ? ITEMS.get(st.cards[i]) : undefined;
      lines.push(c ? `<span class="cardline">${goldName(c)} · ${cardEffectLines(c).join(", ") || t("item.no_effect")}</span>` : `<span class="cardline empty">${t("item.slot_empty", { n: i + 1 })}</span>`);
    }
  }
  const eff = it.effect as { heal?: number[]; teleport?: string; album?: boolean } | null;
  if (eff?.album) lines.push(t("item.album"));
  if (eff?.heal) lines.push(`${t("item.restores")} ${eff.heal[0]}–${eff.heal[1]} HP${eff.heal[3] ? `, ${eff.heal[2]}–${eff.heal[3]} SP` : ""}`);
  if (eff?.teleport) lines.push(t(eff.teleport === "save" ? "item.tp_save" : "item.tp_random"));
  if (isEquip(it)) lines.push(`${t("item.usable_by")} ${(it.jobs as string[]).length >= 7 ? t("item.all_jobs") : (it.jobs as string[]).join(", ")}${it.equipLevel ? ` · Lv ${it.equipLevel}+` : ""}`);
  lines.push(`<span class="muted">${t("item.weight_sell", { w: it.weight / 10, z: it.sell })}</span>`);
  return lines.join("<br>");
}
function tip(el: HTMLElement, it: Item, st?: Stack) {
  el.addEventListener("pointerenter", (e) => {
    const t = $("item-tip");
    t.innerHTML = describe(it, st);
    t.hidden = false;
    t.style.left = `${Math.min(innerWidth - 230, e.clientX + 14)}px`;
    t.style.top = `${Math.min(innerHeight - 120, e.clientY + 12)}px`;
  });
  el.addEventListener("pointerleave", () => ($("item-tip").hidden = true));
}

// ---------- inventory ----------
const tabOf = (it: Item) => (isEquip(it) ? "equip" : isUsable(it) || it.type === "Healing" || it.type === "Usable" || it.type === "DelayConsume" ? "item" : "etc");

function renderInventory() {
  const grid = $("inv-grid");
  grid.innerHTML = "";
  const onBars = new Set(hotkeys.filter((k): k is number => k != null && !isHotkeyAction(k))); // the Fav tab: whatever sits on a shortcut bar
  const list = inv.items.filter((s) => !s.equip && (tab === "fav" ? onBars.has(s.itemId) : tabOf(ITEMS.get(s.itemId)!) === tab)).sort((a, b) => a.itemId - b.itemId);
  for (const st of list) {
    const it = ITEMS.get(st.itemId)!;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "slotcell";
    cell.append(iconEl(st.itemId, st.amount));
    if (it.slots && isEquip(it)) cell.append(pips(it.slots, st.cards.length)); // the piece's card slots, filled for the cards inside
    cell.draggable = true;
    cell.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/item", String(st.itemId)));
    cell.addEventListener("dblclick", () => (isEquip(it) ? hooks.equip(st.uid) : hooks.use(st.uid)));
    cell.addEventListener("contextmenu", (e) => { e.preventDefault(); if (isCard(it)) inspectCard(st.itemId); else assignHotkey(st.itemId); }); // right-click a card = look at its picture
    tip(cell, it, st);
    grid.append(cell);
  }
  for (let i = list.length; i < Math.max(36, Math.ceil(list.length / 6) * 6); i++) grid.append(Object.assign(document.createElement("div"), { className: "slotcell empty" }));
  for (const b of document.querySelectorAll<HTMLButtonElement>("#inv-tabs button")) b.classList.toggle("on", b.dataset.tab === tab);
  const pct = weightPct(inv.weight, inv.maxWeight);
  const w = $("inv-weight");
  w.textContent = t("inv.weight", { cur: Math.floor(inv.weight / 10), max: Math.floor(inv.maxWeight / 10) });
  w.className = pct >= MAJOR_OVERWEIGHT ? "over90" : pct >= NATURAL_HEAL_WEIGHT ? "over70" : "";
  $("inv-count").textContent = `Items ${inv.items.length} / ${INVENTORY_SLOTS}`;
  $("inv-zeny").textContent = `${inv.zeny.toLocaleString()} z`;
}

// ---------- equipment ----------
function renderEquip() {
  for (const slot of SLOTS) {
    const cell = $(`eq-${slot}`);
    cell.innerHTML = "";
    const st = inv.items.find((s) => s.equip && (s.equip === slot || (slot === "shield" && s.equip === "weapon" && (ITEMS.get(s.itemId)!.locations as string[]).includes("Both_Hand"))));
    const label = document.createElement("small");
    label.textContent = SLOT_LABEL[slot as EquipSlot];
    if (st) {
      const it = ITEMS.get(st.itemId)!;
      const n = slot === "ammo" ? st.amount : undefined; // a worn ammo stack shows how many are left
      const name = Object.assign(document.createElement("span"), { textContent: n ? `${it.name} ×${n}` : itemDisplayName(it, st.cards, st.refine) });
      if (itemGrade(it) !== "common") name.style.color = GRADE_COLOR[itemGrade(it)].light;
      if (st.refine) name.className = "refined"; // "+4 ..." names stand out like the original's refine colour
      cell.append(iconEl(st.itemId, n, 24), name);
      if (it.slots) cell.append(pips(it.slots, st.cards.length));
      cell.ondblclick = () => hooks.unequip(st.uid);
      cell.onpointerenter = null;
      tip(cell, it, st);
      cell.classList.add("worn");
    } else {
      const glyph = document.createElement("i"); // our own slot-type glyph (CSS mask, .eq-slot .glyph-<slot>)
      glyph.className = `glyph glyph-${slot}`;
      cell.append(glyph, label);
      cell.ondblclick = null;
      cell.classList.remove("worn");
    }
  }
  hooks.preview($<HTMLCanvasElement>("eq-preview"));
}

// ---------- hotkeys: the shortcut window ----------
// 4 bars of 9 + 2 quickslots, stored on the server (shared/rules/hotkey.ts). The window shows 1–4 rows (drag its bottom
// edge, or F12 cycles 1–4 rows and hidden like the original), its ▲/▼ rotate which bar each row shows (kept per character
// like rAthena's hotkey_rowshift) and F1–F9 fire the top row. Drop an item on a slot, drag between slots to swap,
// right-click to clear.
const ROWS_KEY = "ro.ui.hotbarRows";
const DEFAULT_ROWS = 1; // the original opens with one row; the pager / drag grip / F12 bring the other bars out
let rows = DEFAULT_ROWS;
try {
  const v = Number(localStorage.getItem(ROWS_KEY) ?? DEFAULT_ROWS);
  if (Number.isInteger(v) && v >= 0 && v <= HOTKEY_BARS) rows = v;
} catch { /* private mode */ }

const sendHotkeys = () => hooks.hotkeys({ keys: hotkeys, rowShift });
function setHotkey(i: number, id: number | null) {
  hotkeys = hotkeys.map((k, j) => (j === i ? id : k));
  sendHotkeys();
  renderHotbar();
}
/** Right-click in the inventory: the first empty slot in window order (the F1–F9 row first, then the rows below it). */
function assignHotkey(itemId: number) {
  for (let r = 0; r < HOTKEY_BARS; r++) for (let c = 0; c < HOTKEY_ROW; c++) {
    const i = hotkeyIndex(r, c, rowShift);
    if (hotkeys[i] === null) { setHotkey(i, itemId); play("sfx", "click", 0.4); return; }
  }
}
function useHotkey(i: number) {
  const id = hotkeys[i];
  if (id == null) return;
  const sk = hotkeySkill(id);
  if (sk) { beginSkill(sk.id, sk.lv); return; } // a skill slot: fire a self skill / arm the targeting cursor (ui/skills.ts)
  if (isHotkeyAction(id)) { hooks.sit(); return; }
  const st = inv.items.find((s) => s.itemId === id && !s.equip) ?? inv.items.find((s) => s.itemId === id);
  if (!st) return;
  if (isEquip(ITEMS.get(id)!)) (st.equip ? hooks.unequip : hooks.equip)(st.uid);
  else hooks.use(st.uid);
}
/** ▲ / ▼: rotate the bars by one (CZ_SHORTCUTKEYBAR_ROTATE); only the shift travels. */
function rotate(step: number) {
  rowShift = rotateBars(rowShift, step);
  hooks.hotkeys({ rowShift });
  renderHotbar();
  play("sfx", "click", 0.35);
}
function setRows(n: number) {
  rows = n;
  try { localStorage.setItem(ROWS_KEY, String(n)); } catch { /* private mode */ }
  renderHotbar();
}
/** The slot art of a basic action (our own glyph): a seated figure. */
function actionIcon(id: number) {
  const el = document.createElement("div");
  el.className = `icon act act-${id === HOTKEY_ACTIONS.sit ? "sit" : "x"}`;
  el.style.width = el.style.height = "24px";
  return el;
}
function hotkeyCell(i: number, key?: string) {
  const id = hotkeys[i];
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "slotcell";
  if (key) cell.dataset.key = key;
  const sk = hotkeySkill(id);
  if (sk) { // a skill slot (struct hotkey type 1): its icon + level, cooldown shade via data-skill (ui/skills.ts)
    cell.append(skillIconEl(sk.id, sk.lv, 24));
    cell.dataset.skill = String(sk.id);
    skillTip(cell, sk.id, sk.lv);
    cell.draggable = true;
    cell.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/hotkey", String(i)); });
    cell.addEventListener("contextmenu", (e) => { e.preventDefault(); setHotkey(i, null); });
  } else if (id != null && isHotkeyAction(id)) { // a basic action: sit
    cell.append(actionIcon(id));
    cell.title = t("hotbar.sit");
    cell.draggable = true;
    cell.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/hotkey", String(i)); });
    cell.addEventListener("contextmenu", (e) => { e.preventDefault(); setHotkey(i, null); });
  } else if (id != null) {
    const count = inv.items.filter((s) => s.itemId === id).reduce((n, s) => n + s.amount, 0);
    const ic = iconEl(id, count, 24);
    if (!count) ic.classList.add("none");
    if (inv.items.some((s) => s.itemId === id && s.equip)) cell.classList.add("worn"); // gear you have on
    cell.append(ic);
    tip(cell, ITEMS.get(id)!);
    cell.draggable = true;
    cell.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/item", String(id)); e.dataTransfer?.setData("text/hotkey", String(i)); });
    cell.addEventListener("contextmenu", (e) => { e.preventDefault(); setHotkey(i, null); });
  }
  cell.addEventListener("click", () => useHotkey(i));
  cell.addEventListener("dragover", (e) => e.preventDefault());
  cell.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = e.dataTransfer?.getData("text/hotkey"), item = Number(e.dataTransfer?.getData("text/item"));
    if (from) { // slot to slot: swap
      const f = Number(from), a = hotkeys[f], b = hotkeys[i];
      if (f === i) return;
      hotkeys = hotkeys.map((k, j) => (j === i ? a : j === f ? b : k));
      sendHotkeys();
      renderHotbar();
    } else if (item) setHotkey(i, item);
    else if (Number(e.dataTransfer?.getData("text/skill"))) setHotkey(i, Number(e.dataTransfer?.getData("text/skill"))); // from the skill window
    play("sfx", "click", 0.4);
  });
  return cell;
}
function renderHotbar() {
  const bar = $("hotbar"), box = $("hk-rows"), quick = $("hk-quick");
  bar.hidden = rows === 0;
  box.innerHTML = "";
  for (let r = 0; r < rows; r++) {
    const row = document.createElement("div");
    row.className = r === 0 ? "hk-row fkeys" : "hk-row";
    const num = document.createElement("span");
    num.className = "hk-num";
    num.textContent = String(barOfRow(r, rowShift) + 1);
    num.title = r === 0 ? t("hotbar.bar_f", { n: barOfRow(r, rowShift) + 1 }) : t("hotbar.bar", { n: barOfRow(r, rowShift) + 1 });
    row.append(num);
    for (let c = 0; c < HOTKEY_ROW; c++) row.append(hotkeyCell(hotkeyIndex(r, c, rowShift), r === 0 ? `F${c + 1}` : undefined));
    box.append(row);
  }
  quick.innerHTML = "";
  for (let q = 0; q < HOTKEY_QUICKSLOTS; q++) quick.append(hotkeyCell(QUICKSLOT_FIRST + q));
  if (tab === "fav") renderInventory(); // the Fav tab lists what sits on the bars
}
/** Battle mode (the chat window's chat mode off): the rows under the F1–F9 row fire on 1–9, Q–O and A–L, the original's
 *  default keys for shortcut rows 2–4 (row = window row, so they follow the bar rotation like F1–F9). */
const BATTLE_KEYS = new Map<string, [number, number]>([
  ...[..."123456789"].map((k, c) => [`Digit${k}`, [1, c]] as [string, [number, number]]),
  ...[..."QWERTYUIO"].map((k, c) => [`Key${k}`, [2, c]] as [string, [number, number]]),
  ...[..."ASDFGHJKL"].map((k, c) => [`Key${k}`, [3, c]] as [string, [number, number]]),
]);
/** Drag the window's bottom edge: 1–4 rows. */
function initRowGrip() {
  const grip = $("hk-grip");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const top = $("hotbar").getBoundingClientRect().top;
    const rowH = $("hk-rows").firstElementChild?.getBoundingClientRect().height || 33;
    const move = (ev: PointerEvent) => {
      const n = Math.max(1, Math.min(HOTKEY_BARS, Math.round((ev.clientY - top) / rowH)));
      if (n !== rows) setRows(n);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", () => grip.removeEventListener("pointermove", move), { once: true });
  });
}

// ---------- shop ----------
let shop: ShopEvent | null = null;
let shopTab: "buy" | "sell" = "buy";
const cart = new Map<number, number>(); // buy: itemId -> n; sell: uid -> n

function renderShop() {
  if (!shop) return;
  $("shop-title").textContent = shop.name;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#shop-tabs button")) b.classList.toggle("on", b.dataset.tab === shopTab);
  const list = $("shop-list");
  list.innerHTML = "";
  const rows: { key: number; itemId: number; price: number; max: number; have?: number }[] = shopTab === "buy"
    ? shop.stock.map((s) => ({ key: s.itemId, itemId: s.itemId, price: s.price, max: 999 }))
    : inv.items.filter((s) => !s.equip).map((s) => ({ key: s.uid, itemId: s.itemId, price: ITEMS.get(s.itemId)!.sell, max: s.amount, have: s.amount }));
  for (const r of rows) {
    const it = ITEMS.get(r.itemId)!;
    const row = document.createElement("div");
    row.className = "shop-row";
    const name = document.createElement("span");
    name.textContent = it.name + (r.have ? ` ×${r.have}` : "");
    if (itemGrade(it) !== "common") name.style.color = GRADE_COLOR[itemGrade(it)].light;
    const price = document.createElement("em");
    price.textContent = `${r.price.toLocaleString()} z`;
    const qty = document.createElement("input");
    qty.type = "number"; qty.min = "0"; qty.max = String(r.max); qty.value = String(cart.get(r.key) ?? 0);
    qty.addEventListener("input", () => { const n = Math.max(0, Math.min(r.max, Math.floor(Number(qty.value) || 0))); n ? cart.set(r.key, n) : cart.delete(r.key); renderShopTotal(); });
    const ic = iconEl(r.itemId);
    tip(row, it);
    row.append(ic, name, price, qty);
    row.addEventListener("dblclick", () => { qty.value = String(Math.min(r.max, (cart.get(r.key) ?? 0) + 1)); qty.dispatchEvent(new Event("input")); });
    list.append(row);
  }
  renderShopTotal();
}
function renderShopTotal() {
  if (!shop) return;
  const unit = (k: number) => shopTab === "buy"
    ? shop!.stock.find((s) => s.itemId === k)?.price ?? 0
    : ITEMS.get(inv.items.find((s) => s.uid === k)?.itemId ?? 0)?.sell ?? 0;
  let total = 0;
  for (const [k, n] of cart) total += unit(k) * n;
  $("shop-total").textContent = t(shopTab === "buy" ? "shop.cost" : "shop.earn", { total: total.toLocaleString(), have: inv.zeny.toLocaleString() });
  ($("shop-ok") as HTMLButtonElement).textContent = t(shopTab === "buy" ? "ui.buy" : "ui.sell");
  ($("shop-ok") as HTMLButtonElement).disabled = !cart.size || (shopTab === "buy" && total > inv.zeny);
}

export function openShop(s: ShopEvent) {
  shop = s;
  // callshop's option: 1 = the buy list only, 2 = the sell list only (npc_buysellsel), 0 / none = both, starting on Buy
  shopTab = s.type === 2 ? "sell" : "buy";
  for (const b of document.querySelectorAll<HTMLButtonElement>("#shop-tabs button")) b.hidden = !!s.type && b.dataset.tab !== shopTab;
  cart.clear();
  toggle($("w-shop"), true);
  renderShop();
}

export function closeShop() { shop = null; cart.clear(); toggle($("w-shop"), false); }

// ---------- public ----------
onLangChange(() => renderAll());
function renderAll() {
  if (!hooks) return;
  renderInventory();
  renderEquip();
  renderHotbar();
  if (!$("w-shop").hidden) renderShop();
}
export function setInventory(next: InvEvent) { inv = next; renderAll(); refreshCards(next); }
/** SP_WEIGHT / SP_MAXWEIGHT (Msg.status): the carry numbers changed without a new item list (STR raise, job change...).
 *  Basic Info, its overweight icons and the inventory header all read this snapshot. */
export function setWeight(weight: number, maxWeight: number) {
  if (inv.weight === weight && inv.maxWeight === maxWeight) return;
  inv = { ...inv, weight, maxWeight };
  renderAll();
}
/** The server's list at login (ZC_SHORTCUT_KEY_LIST): every slot plus the saved bar rotation. */
export function setHotkeys(keys: (number | null)[], shift?: number) { hotkeys = hotkeyList(keys); rowShift = isRowShift(shift) ? shift : 0; renderHotbar(); }
export const getInventory = () => inv;
export const refreshEquipPreview = () => hooks?.preview($<HTMLCanvasElement>("eq-preview"));

export { openCardList, cardAck };
export function initItems(h: ItemHooks) {
  hooks = h;
  initCards({ insert: (c, e) => h.insertCard?.(c, e), inventory: () => inv, icon: (id) => iconEl(id), log: (t) => h.log?.(t) });
  // the list window's x ends the shop session on the server too (clif_parse_NPCShopClosed: npc_shopid = 0)
  document.querySelector("#w-shop [data-close]")?.addEventListener("click", () => { if (shop) hooks.quit?.(shop.npc); shop = null; cart.clear(); });
  for (const b of document.querySelectorAll<HTMLButtonElement>("#inv-tabs button")) b.addEventListener("click", () => { tab = b.dataset.tab as typeof tab; renderInventory(); });
  for (const b of document.querySelectorAll<HTMLButtonElement>("#shop-tabs button")) b.addEventListener("click", () => { shopTab = b.dataset.tab as typeof shopTab; cart.clear(); renderShop(); });
  $("shop-ok").addEventListener("click", () => {
    if (!shop || !cart.size) return;
    if (shopTab === "buy") hooks.buy(shop.npc, [...cart].map(([itemId, amount]) => ({ itemId, amount })));
    else hooks.sell(shop.npc, [...cart].map(([uid, amount]) => ({ uid, amount })));
    cart.clear();
    play("sfx", "levelup", 0.4);
  });
  $("eq-strip").addEventListener("click", () => { for (const s of inv.items) if (s.equip) hooks.unequip(s.uid); }); // every worn piece, one request each
  $("btn-inv").addEventListener("click", () => toggle($("w-inv")));
  $("btn-equip").addEventListener("click", () => { toggle($("w-equip")); refreshEquipPreview(); });
  $("hk-close").addEventListener("click", () => { setRows(0); play("sfx", "ui_close", 0.6); });
  $("hk-up").addEventListener("click", () => rotate(-1));
  $("hk-down").addEventListener("click", () => rotate(1));
  $("opt-layout").addEventListener("click", () => setRows(DEFAULT_ROWS)); // "Reset windows" brings a hidden bar back too
  initRowGrip();
  addEventListener("keydown", (e) => {
    if ((e.target instanceof Element && e.target.closest("input")) || document.body.dataset.screen !== "game") return; // keydowns dispatched at window have no closest()
    if (e.altKey && e.code === "KeyE") { e.preventDefault(); toggle($("w-inv")); }
    else if (e.altKey && e.code === "KeyQ") { e.preventDefault(); toggle($("w-equip")); refreshEquipPreview(); }
    else if (/^F[1-9]$/.test(e.key)) { e.preventDefault(); useHotkey(hotkeyIndex(0, Number(e.key.slice(1)) - 1, rowShift)); }
    else if (e.key === "F12") { e.preventDefault(); setRows((rows + 1) % (HOTKEY_BARS + 1)); } // 1-4 rows, then hidden
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && BATTLE_KEYS.has(e.code) && $("chat").classList.contains("battle")) {
      e.preventDefault();
      const [r, c] = BATTLE_KEYS.get(e.code)!;
      useHotkey(hotkeyIndex(r, c, rowShift));
    }
  });
  renderAll();
}

/** The stack with this uid in the last inventory snapshot (the pet egg list names its eggs from it). */
export function invStack(uid: number) { return inv.items.find((s) => s.uid === uid); }
