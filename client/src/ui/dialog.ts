// NPC dialog window, menu window and cutin illustration — the client half of rAthena's dialog packets (clif.cpp
// clif_scriptmes / clif_scriptnext / clif_scriptclose / clif_scriptmenu / clif_scriptclear / clif_cutin). The script runs on
// the server (server/src/script.ts); this only renders and answers Next / a menu choice / Close, with the original client's
// window rules: Next clears the page on the next line, Close and Cancel close every NPC window, and while a dialog is open
// the world takes no clicks (dialogOpen()). Lines support ^RRGGBB colours, <NAVI> links (auto-walk) and <ITEM> links.
//
// A <NAVI> link arms the auto-walk at once (doc/script_commands.txt "Navigation": clicking it begins navigation). The open
// window locks the character (pc_cant_act), so navi.ts holds the goal and walks the moment the window closes; at the Close
// button the click closes the window itself, so the character simply goes.
import "./dialog.css";
import { Vector3, type Camera } from "three";
import type { Room } from "@colyseus/sdk";
import { Msg, type CutinEvent, type NpcButtonEvent, type NpcMenuEvent, type NpcMesEvent } from "../../../shared/protocol.ts";
import { MENU_CANCEL } from "../../../shared/rules/script.ts";
import { type GameMap } from "../../../shared/map.ts";
import { mapOfState } from "../../../shared/maps.ts";
import { play } from "../audio.ts";
import { heightAt } from "../world.ts";
import { addNaviBlocker, naviActive, onNavi, startNavi } from "../navi.ts";
import { applyI18n, onLangChange, t as tr } from "../i18n.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Wrap a scrolling element with a permanent scrollbar (▲, track with a thumb, ▼) that we draw ourselves: native bars are
 *  overlays on macOS and hidden in headless capture, so a page longer than the box would give no sign that it goes on. It
 *  shows only while there is something to scroll; the wheel, the keys, the arrows (one `line`), a click on the track (one
 *  page) and a drag of the thumb all scroll. */
function withScrollbar(scroller: HTMLElement, line: number, cls = "") {
  const wrap = el("div", `npc-view ${cls}`.trim()), bar = el("div", "npc-bar"), track = el("div", "track"), thumb = el("i");
  const up = el("button"), down = el("button");
  up.type = down.type = "button"; up.tabIndex = down.tabIndex = -1;
  up.title = tr("ui.scroll_up"); down.title = tr("ui.scroll_down"); up.dataset.i18nTitle = "ui.scroll_up"; down.dataset.i18nTitle = "ui.scroll_down";
  track.append(thumb);
  bar.append(up, track, down);
  bar.hidden = true;
  wrap.append(scroller, bar);
  const range = () => scroller.scrollHeight - scroller.clientHeight;
  const sync = () => {
    const r = range();
    bar.hidden = r <= 1;
    if (bar.hidden) return;
    const h = track.clientHeight, th = Math.max(16, Math.min(h, (h * scroller.clientHeight) / scroller.scrollHeight));
    thumb.style.height = `${th}px`;
    thumb.style.transform = `translateY(${((h - th) * scroller.scrollTop) / r}px)`;
  };
  scroller.addEventListener("scroll", sync, { passive: true });
  new MutationObserver(sync).observe(scroller, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(() => requestAnimationFrame(sync)).observe(scroller); // not inside the observer: showing the bar resizes the text
  up.addEventListener("click", () => scroller.scrollBy({ top: -line }));
  down.addEventListener("click", () => scroller.scrollBy({ top: line }));
  track.addEventListener("pointerdown", (e) => {
    if (e.target === track) scroller.scrollBy({ top: (e.clientY < thumb.getBoundingClientRect().top ? -1 : 1) * scroller.clientHeight });
  });
  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation(); // the window's own pointerdown would raise it above the others
    thumb.setPointerCapture(e.pointerId);
    const y0 = e.clientY, s0 = scroller.scrollTop;
    const move = (ev: PointerEvent) => {
      const free = track.clientHeight - thumb.offsetHeight;
      if (free > 0) scroller.scrollTop = s0 + ((ev.clientY - y0) * range()) / free;
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("lostpointercapture", () => thumb.removeEventListener("pointermove", move), { once: true });
  });
  return wrap;
}

// ---------- DOM (built once, inside #hud so it hides with the HUD) ----------
const box = el("section", "win"), text = el("div", "npc-text"), btns = el("div", "npc-btns");
const hint = el("span", "hint"), nextBtn = el("button", "btn", tr("dialog.next")), closeBtn = el("button", "btn", tr("ui.close"));
nextBtn.dataset.i18n = "dialog.next"; closeBtn.dataset.i18n = "ui.close";
box.id = "w-npc"; box.hidden = true;
nextBtn.type = closeBtn.type = "button";
btns.append(hint, nextBtn, closeBtn);
const frame = el("div", "npc-frame");
frame.append(withScrollbar(text, 18), btns);
// the shared window chrome: a slim title bar with an empty caption, like the original's NPC box (drag it to move it)
const bar = () => { const h = el("header", "win-title"); h.append(el("span")); return h; };
const boxBar = bar();
box.append(boxBar, frame);
const menuWin = el("section", "win"), list = el("ul", "npc-options"), menuBtns = el("div", "npc-btns");
const okBtn = el("button", "btn", tr("dialog.ok")), cancelBtn = el("button", "btn", tr("ui.cancel"));
okBtn.dataset.i18n = "dialog.ok"; cancelBtn.dataset.i18n = "ui.cancel";
menuWin.id = "w-npcmenu"; menuWin.hidden = true;
okBtn.type = cancelBtn.type = "button";
menuBtns.append(el("span", "hint"), okBtn, cancelBtn);
const menuFrame = el("div", "npc-frame");
menuFrame.append(withScrollbar(list, 21, "opts"), menuBtns);
onLangChange(() => { applyI18n(box); applyI18n(menuWin); });
menuWin.append(bar(), menuFrame);
const cutinBox = el("div"), cutinImg = el("img"), cutinName = el("span", "cutin-name");
cutinBox.id = "npc-cutin"; cutinBox.hidden = true; cutinImg.alt = "";
cutinBox.append(cutinImg, cutinName);
(document.getElementById("hud") ?? document.body).append(cutinBox, box, menuWin);

// ---------- state ----------
let room: Room | undefined;
let camera: Camera | undefined; // the world camera: where the player and the NPC are on screen (only for the window layout)
let npc = ""; // the NPC whose dialog is open (npcid of the dialog window)
let clearOnNext = false; // "set to clear on next mes" after Next was pressed
let options: string[] = [];
let sel = 0;
let buttons: "next" | "close" | null = null;
let held = false; // an auto-walk is armed and waiting for this window to close (navi.ts)
let cutinType = 255;
let autoPlaced = true; // the box sits where place() put it, not where the player dragged it
let menuOff = { dx: 0, dy: 0 }; // where the menu sits relative to the box; it follows the box when that is dragged
let menuAt = { x: 0, y: 0 }; // where we last put the menu (a different position in its style = the player dragged it)

const npcName = (id: string) => String((room?.state as { npcs?: Map<string, { name: string }> } | undefined)?.npcs?.get(id)?.name ?? "");

// ---------- layout ----------
// The original opens its NPC box at a fixed spot (left W/3, top H/2-200), which lands on the player at the centre of the
// screen and on the NPC next to him, and far from a portrait at a screen edge. Here the box is docked beside the portrait it
// belongs to, and the spot is searched for: the cells the player and the NPC stand on (and the label under them) are never
// covered, the menu keeps room under the box, and the HUD windows are covered only when nothing else is left. The search
// is a pure scan over the viewport, so the same screen always gives the same spot.
type Rect = { x0: number; y0: number; x1: number; y1: number };
type Pt = { x: number; y: number };
const GAP = 10; // box <-> portrait
const MENU_GAP = 6; // box <-> menu
const MENU_SLOT = 150; // room kept under the box for the menu (title + three or four rows + OK / Cancel)
const EDGE = 8; // windows keep this far from the screen edge
const FREE_ZONE = 24; // portraits are mostly transparent at their edge: a box may overlap this much of one
const PLAYER_H = 1.5, NPC_H = 1.75, MONSTER_H = 1.1; // sprite heights in world units (main.ts addEntity / MOB_HEIGHT, worldItems.ts addNpc)
const MARK_PX = 34, LABEL_PX = 34; // "!" / "?" mark above an NPC's head, name plate + gauge under its feet

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m });
const rectAt = (x: number, y: number, w: number, h: number): Rect => ({ x0: x, y0: y, x1: x + w, y1: y + h });
const rectOf = (e: Element): Rect | undefined => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } : undefined;
};
const styleAt = (w: HTMLElement): Pt => ({ x: parseFloat(w.style.left) || 0, y: parseFloat(w.style.top) || 0 });

let map: GameMap | undefined, mapSeed = -1;
const v3 = new Vector3();
/** A unit on screen: its drawn body from head to feet at its depth, plus the mark above / name plate below it. */
function unitRect(x: number, y: number, height: number, abovePx: number): Rect | undefined {
  if (!camera || !map) return undefined;
  const gy = heightAt(map, x, y);
  v3.set(x, gy, y).project(camera);
  if (v3.z >= 1) return undefined;
  const fx = (v3.x * 0.5 + 0.5) * innerWidth, fy = (-v3.y * 0.5 + 0.5) * innerHeight;
  v3.set(x, gy + height, y).project(camera);
  const top = (-v3.y * 0.5 + 0.5) * innerHeight, half = (fy - top) * 0.36; // bodies are about 0.7 as wide as tall
  return { x0: fx - half, x1: fx + half, y0: top - abovePx, y1: fy + LABEL_PX };
}
/** What must stay visible: `hard` = the player and the NPC being talked to; `soft` = the other NPCs and players; `faint` = the
 *  monsters (they wander, so they only break ties: the spot must not depend on where one happens to stand). */
function worldRects() {
  const hard: Rect[] = [], soft: Rect[] = [], faint: Rect[] = [];
  const S = room?.state as any;
  if (!camera || !S?.players) return { hard, soft, faint };
  map = mapOfState(S); // C08: the room's own map (field or town)
  S.players.forEach((p: any, id: string) => {
    const r = unitRect(p.x + (p.sx ?? 0), p.y + (p.sy ?? 0), PLAYER_H, 0);
    if (r) (id === room?.sessionId ? hard : soft).push(r);
  });
  S.npcs?.forEach((n: any, id: string) => {
    const r = unitRect(n.x, n.y, NPC_H, MARK_PX);
    if (r) (id === npc ? hard : soft).push(r);
  });
  S.monsters?.forEach((m: any) => { // a monster standing near you is worth seeing while the dialog holds you still
    if (m.dead) return;
    const r = unitRect(m.x + (m.sx ?? 0), m.y + (m.sy ?? 0), MONSTER_H, 0);
    if (r) faint.push(r);
  });
  return { hard, soft, faint };
}
/** The HUD windows, chat, hotbar, minimap and tracker (covering them is allowed, but a last resort). */
function hudRects(): Rect[] {
  const out: Rect[] = [];
  for (const e of document.querySelectorAll<HTMLElement>("#hud .win, #chat, #hotbar, #w-minimap, #quest-tracker")) {
    if (e === box || e === menuWin || e.hidden) continue;
    const r = rectOf(e);
    if (r) out.push(r);
  }
  return out;
}
const portraitShape = new Map<string, number>(); // width / height of each illustration seen so far
let cutinImage = ""; // file name (without .png) of the illustration on show
/** The illustration on screen (ZC_SHOW_IMAGE positions 0-2 = bottom left / middle / right, 3-4 = centre). */
function portraitRect(): Rect | undefined {
  if (cutinBox.hidden || cutinType > 4) return undefined;
  const h = cutinImg.offsetHeight;
  if (!h) return undefined;
  const w = cutinImg.complete && cutinImg.naturalWidth ? cutinImg.offsetWidth : h * (portraitShape.get(cutinImage) ?? 0.66); // still loading: the art's usual shape
  const x0 = cutinType === 0 ? 0 : cutinType === 2 ? innerWidth - w : (innerWidth - w) / 2;
  const y0 = cutinType <= 2 ? innerHeight - h : (innerHeight - h) / 2;
  return rectAt(x0, y0, w, h);
}
/** Where the box would like to be: beside its portrait, level with its face (the original's spot without one). */
function idealSpot(w: number, p: Rect | undefined): Pt {
  if (!p) return { x: Math.max(innerWidth / 3, 20), y: Math.max(100, innerHeight / 2 - 200) };
  const y = p.y0 + (p.y1 - p.y0) * 0.1;
  if (cutinType === 2) return { x: p.x0 - GAP - w, y };
  if (cutinType === 0) return { x: p.x1 + GAP, y };
  return p.x0 >= innerWidth - p.x1 ? { x: p.x0 - GAP - w, y } : { x: p.x1 + GAP, y }; // middle / centre: the roomier side
}
/** What the windows are placed around, read once per placement: `guard` = the player and the NPC being talked to (covering
 *  them is the one thing never done while any other spot exists), `weighted` = everything else with the price of covering a
 *  pixel of it: the HUD least, the other NPCs and players more, the part of the portrait that has art in it. */
function obstacles(portrait: Rect | undefined) {
  const { hard, soft, faint } = worldRects();
  const guard = hard.map((r) => grow(r, 6));
  const weighted: [Rect, number][] = [];
  for (const r of hudRects()) weighted.push([r, 0.02]);
  for (const r of soft) weighted.push([grow(r, 4), 0.1]);
  for (const r of faint) weighted.push([r, 0.01]);
  weighted.push([rectAt(innerWidth / 2 - 175, innerHeight - 142, 350, 36), 0.05]); // where "Auto-navigating..." shows
  if (portrait) weighted.push([grow(portrait, -FREE_ZONE), 0.05]);
  return { guard, weighted };
}
/** The price of putting a window on `r`: a guarded unit costs 40 per pixel (`k` scales it for room that is only kept free). */
function cover(r: Rect, o: ReturnType<typeof obstacles>, k = 1) {
  let s = 0;
  for (const g of o.guard) s += 40 * k * overlap(r, g);
  for (const [w, price] of o.weighted) s += price * k * overlap(r, w);
  return s;
}
/** The best top-left for a w x h box with `slot` pixels of menu room under it: nothing guarded covered, then the least else
 *  covered, then the nearest to `ideal`. */
function bestSpot(w: number, h: number, slot: number, ideal: Pt, portrait: Rect | undefined): Pt {
  const o = obstacles(portrait);
  const maxX = Math.max(EDGE, innerWidth - w - EDGE), maxY = Math.max(EDGE, innerHeight - h - EDGE);
  const clampPt = (p: Pt): Pt => ({ x: Math.min(maxX, Math.max(EDGE, p.x)), y: Math.min(maxY, Math.max(EDGE, p.y)) });
  const score = (p: Pt) => {
    const d = rectAt(p.x, p.y, w, h), u = rectAt(p.x, p.y + h + MENU_GAP, w, slot);
    return Math.hypot(p.x - ideal.x, p.y - ideal.y) + cover(d, o) + cover(u, o, 0.2) // the menu slot is only room kept free
      + 0.05 * Math.max(0, u.y1 - (innerHeight - EDGE)) * w; // ... and it would run off the screen
  };
  let best = clampPt(ideal), bestScore = score(best);
  const step = Math.max(8, Math.ceil(Math.max(innerWidth, innerHeight) / 200)); // a coarser scan on a big screen: same answer to within a few pixels
  for (let y = EDGE; y <= maxY; y += step) for (let x = EDGE; x <= maxX; x += step) {
    const s = score({ x, y });
    if (s < bestScore) { bestScore = s; best = { x, y }; }
  }
  return best;
}

/** Open the box at its remembered spot, or beside its portrait where it covers neither the player nor the NPC. */
function place() {
  const saved = savedSpot();
  const w = box.offsetWidth || 304, h = box.offsetHeight || 195;
  let at: Pt;
  if (saved) at = saved; // the player moved it: keep it there (but on screen)
  else { const p = portraitRect(); at = bestSpot(w, h, MENU_SLOT, idealSpot(w, p), p); }
  autoPlaced = !saved;
  moveTo(box, at.x, at.y, w, h);
}
/** Where the player dragged the box to (windows.ts remembers a window's spot per browser). */
function savedSpot(): Pt | undefined {
  try {
    const v = JSON.parse(localStorage.getItem("ro.ui.pos.w-npc") ?? "null");
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : undefined;
  } catch { return undefined; } // private mode / bad data
}
function moveTo(win: HTMLElement, x: number, y: number, w = win.offsetWidth, h = win.offsetHeight) {
  win.style.left = `${Math.round(Math.min(Math.max(0, x), Math.max(0, innerWidth - w)))}px`;
  win.style.top = `${Math.round(Math.min(Math.max(0, y), Math.max(0, innerHeight - h)))}px`;
  win.style.right = win.style.bottom = "auto";
}
/** The menu under the box (like the original), or above / beside it when that would cover the player or leave the screen. */
function placeMenu() {
  const mw = menuWin.offsetWidth || 304, mh = menuWin.offsetHeight || 126;
  if (box.hidden) { // a menu without a dialog: it takes the spot the dialog would have had
    const p = portraitRect(), at = bestSpot(mw, mh, 0, idealSpot(mw, p), p);
    menuAt = { x: Math.round(at.x), y: Math.round(at.y) };
    moveTo(menuWin, menuAt.x, menuAt.y, mw, mh);
    return;
  }
  const at = styleAt(box), b = rectAt(at.x, at.y, box.offsetWidth, box.offsetHeight), o = obstacles(portraitRect());
  const tries: [Pt, number][] = [ // under the box first; the rest cost more than a little HUD but less than the player
    [{ x: b.x0, y: b.y1 + MENU_GAP }, 0], [{ x: b.x0, y: b.y0 - MENU_GAP - mh }, 300],
    [{ x: b.x1 + MENU_GAP, y: b.y0 }, 500], [{ x: b.x0 - MENU_GAP - mw, y: b.y0 }, 550],
  ];
  let pick = tries[0], pickScore = Infinity;
  for (const t of tries) {
    const m = rectAt(t[0].x, t[0].y, mw, mh);
    const s = t[1] + cover(m, o) + 0.05 * (mw * mh - overlap(m, rectAt(0, 0, innerWidth, innerHeight))); // + the part off the screen
    if (s < pickScore) { pickScore = s; pick = t; }
  }
  menuOff = { dx: pick[0].x - b.x0, dy: pick[0].y - b.y0 };
  followBox();
}
/** Put the menu where its offset from the box says (kept on screen). */
function followBox() {
  if (menuWin.hidden || box.hidden) return;
  const b = styleAt(box), mw = menuWin.offsetWidth, mh = menuWin.offsetHeight;
  const x = Math.min(Math.max(0, b.x + menuOff.dx), Math.max(0, innerWidth - mw)), y = Math.min(Math.max(0, b.y + menuOff.dy), Math.max(0, innerHeight - mh));
  menuAt = { x: Math.round(x), y: Math.round(y) };
  moveTo(menuWin, menuAt.x, menuAt.y, mw, mh);
}
// the menu goes wherever the box is dragged to, and a drag of the menu itself changes its place beside the box
new MutationObserver(followBox).observe(box, { attributes: true, attributeFilter: ["style"] });
new MutationObserver(() => {
  if (menuWin.hidden) return;
  const m = styleAt(menuWin), b = styleAt(box);
  if (Math.abs(m.x - menuAt.x) > 1 || Math.abs(m.y - menuAt.y) > 1) { menuAt = m; menuOff = { dx: m.x - b.x, dy: m.y - b.y }; }
}).observe(menuWin, { attributes: true, attributeFilter: ["style"] });
boxBar.addEventListener("pointerdown", () => { autoPlaced = false; }); // dragging the box takes it out of the layout's hands

function showButtons(which: "next" | "close" | null) {
  buttons = which;
  nextBtn.hidden = which !== "next";
  closeBtn.hidden = which !== "close";
  paintHint();
}
/** The line beside the buttons: the key that answers, or why a goal armed from this window hasn't started walking yet. */
function paintHint() {
  hint.textContent = held ? tr("dialog.walks_after") : buttons ? "Enter" : "";
  hint.classList.toggle("go", held);
}
// an auto-walk armed while this window is open waits for it (navi.ts holds it): say so, and mark the link that armed it
addNaviBlocker(() => dialogOpen());
onNavi((active, _label, isHeld) => {
  held = active && isHeld;
  if (!active) for (const a of text.querySelectorAll(".navi-link.armed")) a.classList.remove("armed");
  paintHint();
});

/** One mes line: [Name] lines bold, ^RRGGBB colours (^000000 = back to the default), NAVI / ITEM links. */
const TOKEN = /(<NAVI>.*?<\/NAVI>|<ITEM(?:LINK)?>.*?<\/ITEM(?:LINK)?>|\^[0-9a-fA-F]{6})/;
function renderLine(line: string) {
  const div = el("div");
  if (/^\[[^\]]+\]$/.test(line.trim())) div.className = "ln-name";
  let color: string | null = null;
  for (const part of line.split(TOKEN)) {
    if (!part) continue;
    const c = /^\^([0-9a-fA-F]{6})$/.exec(part);
    if (c) { color = c[1] === "000000" ? null : `#${c[1]}`; continue; }
    const navi = /^<NAVI>(.*?)<INFO>(.*?)<\/INFO><\/NAVI>$/.exec(part);
    if (navi) {
      const a = el("span", "navi-link", navi[1]);
      const [where, x, y] = navi[2].split(",");
      a.title = tr("quest.walk_there");
      a.addEventListener("click", () => {
        if (!Number.isFinite(+x) || !Number.isFinite(+y)) return;
        // at the Close button the script has nothing more to say: the click closes the window (so the walk starts unheld) and
        // the character goes; at a Next / menu the walk waits for the window to close (navi.ts holds it; the label, the hint
        // and the link say so)
        const closing = !closeBtn.hidden;
        if (closing) close(); else play("sfx", "click", 0.4);
        startNavi({ kind: "cell", x: +x, y: +y, within: 3, map: where || undefined }, navi[1].replace(/^\[|\]$/g, "")); // W01: the link's map (warps on the way)
        if (!closing && naviActive()) a.classList.add("armed");
      });
      div.append(a);
      continue;
    }
    const item = /^<ITEM(?:LINK)?>(.*?)<INFO>\d+<\/INFO><\/ITEM(?:LINK)?>$/.exec(part);
    if (item) { div.append(el("span", "item-link", item[1])); continue; }
    const s = el("span", "", part);
    if (color) s.style.color = color;
    div.append(s);
  }
  if (!div.childNodes.length) div.textContent = " "; // an empty mes is an empty line
  return div;
}

function closeAll(clearCutin: boolean) {
  box.hidden = true;
  menuWin.hidden = true;
  text.textContent = "";
  options = [];
  clearOnNext = false;
  showButtons(null);
  if (clearCutin) hideCutin();
  npc = "";
}
function hideCutin() { cutinBox.hidden = true; cutinImg.removeAttribute("src"); cutinName.textContent = ""; cutinType = 255; }

// ---------- server -> client ----------
function onMes(m: NpcMesEvent) {
  if (box.hidden || npc !== m.npc) {
    const opening = box.hidden;
    box.hidden = false; // visible before it is measured
    npc = m.npc;
    if (opening) { place(); play("sfx", "ui_open", 0.4); }
    if (!cutinBox.hidden) cutinName.textContent = npcName(npc);
  }
  if (clearOnNext) { text.textContent = ""; clearOnNext = false; }
  text.append(renderLine(m.text)); // a page opens at its top (the [Name] line first), like the original; long ones scroll
  showButtons(null);
}
function onNextBtn(m: NpcButtonEvent) { if (!box.hidden && m.npc === npc) showButtons("next"); }
function onCloseBtn(m: NpcButtonEvent) {
  if (box.hidden) return closeAll(false); // no window: just make sure nothing is left open (a menu on its own goes too)
  npc ||= m.npc;
  // the idle timeout (SECURE_NPCTIMEOUT) replaces Next / the menu with Close: the option list and OK / Cancel go with it
  menuWin.hidden = true;
  options = [];
  showButtons("close");
}
function onMenu(m: NpcMenuEvent) {
  npc = m.npc;
  options = m.options;
  sel = 0;
  list.textContent = "";
  options.forEach((o, i) => {
    const li = el("li");
    li.append(el("b", "", String(i + 1)), o);
    li.addEventListener("click", () => { sel = i; paintSel(); });
    li.addEventListener("dblclick", () => pick(i));
    list.append(li);
  });
  paintSel();
  if (!box.hidden) nextBtn.hidden = true; // the menu replaces Next
  menuWin.hidden = false; // visible before it is measured
  placeMenu();
}
function onClear() { text.textContent = ""; text.scrollTop = 0; clearOnNext = false; }
function onCutin(m: CutinEvent) {
  if (m.type === 255 || !m.image) return hideCutin();
  if (!/^[a-z0-9_]+$/.test(m.image)) return;
  cutinType = m.type;
  cutinImage = m.image;
  cutinBox.className = `pos-${m.type}`;
  cutinImg.src = `/art/cutin/${m.image}.png`;
  cutinName.textContent = npc ? npcName(npc) : "";
  cutinBox.hidden = false;
  relayout(); // a portrait that shows up after the box: the box moves beside it
}
/** The portrait or the screen changed under an untouched box: find its spot again (the menu goes with it). */
function relayout() {
  if (box.hidden || !autoPlaced) return;
  place();
  if (!menuWin.hidden) placeMenu();
}
cutinImg.addEventListener("load", () => { // its real width is known now
  if (cutinImg.naturalHeight) portraitShape.set(cutinImage, cutinImg.naturalWidth / cutinImg.naturalHeight);
  relayout();
});

// ---------- client -> server ----------
function next() {
  if (nextBtn.hidden || !room) return;
  room.send(Msg.npcNext, { npc });
  clearOnNext = true;
  showButtons(null);
  play("sfx", "click", 0.35);
}
function close() {
  if (closeBtn.hidden || !room) return;
  room.send(Msg.npcClose, { npc });
  closeAll(false);
  play("sfx", "ui_close", 0.5);
}
function pick(i: number) {
  if (menuWin.hidden || !room || i < 0 || i >= options.length) return;
  room.send(Msg.npcMenu, { npc, choice: i + 1 });
  menuWin.hidden = true;
  options = [];
  play("sfx", "click", 0.35);
}
function cancel() {
  if (menuWin.hidden || !room) return;
  room.send(Msg.npcMenu, { npc, choice: MENU_CANCEL });
  closeAll(true); // Cancel closes the NPC windows (and the script ends on the server)
  play("sfx", "ui_close", 0.5);
}
function paintSel() {
  [...list.children].forEach((li, i) => li.classList.toggle("on", i === sel));
  list.children[sel]?.scrollIntoView({ block: "nearest" });
}

nextBtn.addEventListener("click", next);
closeBtn.addEventListener("click", close);
okBtn.addEventListener("click", () => pick(sel));
cancelBtn.addEventListener("click", cancel);
// keys like the original: Enter / Space = Next, OK or Close; Esc = Cancel / Close; arrows + digits pick in a menu.
// Captured before the HUD's own keys (Enter = chat, Esc = options) while an NPC window is open.
addEventListener("keydown", (e) => {
  if (!dialogOpen() || e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
  const k = e.key;
  if (!menuWin.hidden) {
    if (k === "ArrowDown") { sel = (sel + 1) % options.length; paintSel(); }
    else if (k === "ArrowUp") { sel = (sel + options.length - 1) % options.length; paintSel(); }
    else if (k === "Enter" || k === " ") pick(sel);
    else if (k === "Escape") cancel();
    else if (/^[1-9]$/.test(k) && Number(k) <= options.length) pick(Number(k) - 1);
    else return;
  } else if (k === "Enter" || k === " ") { if (!nextBtn.hidden) next(); else if (!closeBtn.hidden) close(); }
  else if (k === "Escape") { if (!closeBtn.hidden) close(); }
  else if (k === "ArrowDown" || k === "ArrowUp") text.scrollBy({ top: (k === "ArrowDown" ? 1 : -1) * 18 }); // a long page: read on without the mouse
  else if (k === "PageDown" || k === "PageUp") text.scrollBy({ top: (k === "PageDown" ? 1 : -1) * text.clientHeight });
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
addEventListener("resize", () => {
  if (box.hidden && menuWin.hidden) return;
  if (!box.hidden) { if (autoPlaced) place(); else moveTo(box, styleAt(box).x, styleAt(box).y); }
  if (!menuWin.hidden) { if (autoPlaced) placeMenu(); else followBox(); }
});

// ---------- public ----------
/** Listen to a room's dialog messages (call once per room, from enterWorld). `cam` = the world camera, so a new dialog opens
 *  where it covers neither the player nor the NPC. */
export function bindDialog(r: Room, cam?: Camera) {
  room = r;
  camera = cam;
  r.onMessage(Msg.npcMes, onMes);
  r.onMessage(Msg.npcNextBtn, onNextBtn);
  r.onMessage(Msg.npcCloseBtn, onCloseBtn);
  r.onMessage(Msg.npcMenuList, onMenu);
  r.onMessage(Msg.npcClear, onClear);
  r.onMessage(Msg.npcEnd, () => closeAll(true));
  r.onMessage(Msg.cutin, onCutin);
}
/** An NPC window is open: the world ignores clicks (the original disables mouse targeting). */
export function dialogOpen() { return !box.hidden || !menuWin.hidden; }
/** Leaving the world: close everything. */
export function resetDialog() { closeAll(true); room = undefined; camera = undefined; map = undefined; mapSeed = -1; }
