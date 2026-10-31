// Pet window (Alt+J, RO's pet info), the egg list, and the taming cursor. The server owns the pet (server/src/pets.ts, contract in
// shared/protocol.ts "Pets (2.4.0)"); this renders PetInfoEvent and sends intents. Layout after the classic client's pet info
// window (portrait, name, level, hunger and intimacy gauges, four buttons); own skin, none of its art.
import "./pet.css";
import type { Room } from "@colyseus/sdk";
import { Msg, type PetInfo, type PetInfoEvent, type PetEggsEvent, type PetCatchStartEvent, type PetCommandMsg } from "../../../shared/protocol.ts";
import { ITEMS } from "../../../shared/rules/items.ts";
import { hungerWord, intimacyWord, kindLabel, petSheet, petSpecies, notePick, isLegendaryPet } from "../pets.ts";
import { toggle } from "./windows.ts";
import { invStack, iconEl } from "./items.ts";
import { log } from "./hud.ts";
import { play } from "../audio.ts";
import { applyI18n, onLangChange, t } from "../i18n.ts";

const hud = document.getElementById("hud") ?? document.body;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
const press = (b: HTMLElement, on: () => void) => b.addEventListener("click", (e) => { e.stopPropagation(); on(); play("sfx", "click", 0.35); });

// pets.json (imported from pet_db.yml) says which species may be fed automatically; absent until the data lands
const PET_DATA = import.meta.glob("../../../shared/data/pets.json", { eager: true, import: "default" }) as Record<string, any>;
function autoFeedAllowed(mobId: number): boolean {
  const d = Object.values(PET_DATA)[0];
  const rows: any[] = Array.isArray(d) ? d : Array.isArray(d?.pets) ? d.pets : d && typeof d === "object" ? Object.values(d) : [];
  const row = rows.find((r) => r && (r.mobId ?? r.mob ?? r.id) === mobId);
  return !!(row?.allowAutoFeed ?? row?.autoFeed ?? row?.AllowAutoFeed);
}

// ---------- window ----------
const win = el("section", "win"); win.id = "w-pet"; win.hidden = true;
win.innerHTML = `<header class="win-title"><span data-i18n="pet.title">Pet</span><button data-close title="Close (Alt+J)" data-i18n-title="pet.close">×</button></header>
  <div class="win-body">
    <div class="pet-none"><p data-i18n="pet.none">You have no pet with you.</p><p class="pet-hint" data-i18n="pet.hint">Use a taming item, tame a monster, then double-click the egg to hatch it.</p></div>
    <div class="pet-in" hidden>
      <div class="pet-top">
        <canvas class="pet-portrait" width="96" height="96"></canvas>
        <div class="pet-id">
          <div class="pet-namerow"><b class="pet-name"></b><span class="pet-rarity" hidden data-i18n="pet.legendary">Legendary</span></div>
          <div class="pet-sub"><span class="pet-lv"></span><span class="pet-kind"></span></div>
          <div class="pet-ren" hidden></div>
        </div>
      </div>
      <div class="pet-stat"><label data-i18n="pet.hunger">Hunger</label><div class="pet-gauge hunger"><i></i></div><span class="pet-hw"></span></div>
      <div class="pet-stat"><label data-i18n="pet.intimacy">Intimacy</label><div class="pet-gauge love"><i></i></div><span class="pet-iw"></span></div>
      <div class="pet-btns"></div>
      <label class="pet-auto" hidden><input type="checkbox"> <span data-i18n="pet.autofeed">Auto-feed</span></label>
    </div>
  </div>`;
const q = <T extends HTMLElement>(s: string) => win.querySelector<T>(s)!;
const nameInput = el("input"); nameInput.type = "text"; nameInput.maxLength = 23; nameInput.placeholder = t("pet.name_ph"); nameInput.dataset.i18nPlaceholder = "pet.name_ph"; nameInput.autocomplete = "off"; nameInput.spellcheck = false;
const rename = () => {
  const name = nameInput.value.trim();
  if (!name) return;
  room?.send(Msg.petRename, { name });
  nameInput.value = "";
};
nameInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); rename(); } else if (e.key === "Escape") nameInput.blur(); });
const renBtn = el("button", "", t("pet.rename")); renBtn.dataset.i18n = "pet.rename"; renBtn.type = "button"; press(renBtn, rename);
q(".pet-ren").append(nameInput, renBtn);
const cmds: [string, string, PetCommandMsg["op"]][] = [["pet.feed", "pet.feed_tip", "feed"], ["pet.perform", "pet.perform_tip", "perform"], ["pet.return", "pet.return_tip", "return"]];
for (const [text, title, op] of cmds) { const b = el("button", "", t(text)); b.type = "button"; b.title = t(title); b.dataset.i18n = text; b.dataset.i18nTitle = title; press(b, () => room?.send(Msg.petCommand, { op })); q(".pet-btns").append(b); }
const autoBox = q<HTMLInputElement>(".pet-auto input");
autoBox.addEventListener("change", () => room?.send(Msg.petAutoFeed, { on: autoBox.checked }));

// the eggs list (ZC_PETEGG_LIST)
const eggs = el("section", "win"); eggs.id = "w-pet-eggs"; eggs.hidden = true;
eggs.innerHTML = `<header class="win-title"><span data-i18n="pet.select_egg">Select a pet egg</span><button data-close title="Close" data-i18n-title="ui.close">×</button></header><div class="win-body"><ul class="egg-list"></ul></div>`;
hud.append(win, eggs);
onLangChange(() => { applyI18n(win); applyI18n(eggs); render(); });

// the Pet button in the Basic Info menu
const menu = document.getElementById("bi-menu");
if (menu && !document.getElementById("btn-pet")) {
  const b = el("button"); b.type = "button"; b.id = "btn-pet"; b.title = t("ui.pet_alt_j");
  b.innerHTML = `<svg viewBox="0 0 20 20"><ellipse cx="5.2" cy="8" rx="1.9" ry="2.5"/><ellipse cx="9" cy="4.8" rx="1.9" ry="2.5"/><ellipse cx="13.2" cy="4.8" rx="1.9" ry="2.5"/><ellipse cx="16.6" cy="8.4" rx="1.8" ry="2.4"/><path d="M5 15c0-3 2.4-5.4 5.4-5.4S15.8 12 15.8 15c0 1.8-1.4 2.6-2.8 2.6-1 0-1.6-.5-2.6-.5s-1.6.5-2.6.5C6.4 17.6 5 16.8 5 15z"/></svg>Pet`;
  b.addEventListener("click", () => toggleWindow());
  menu.append(b);
}

// ---------- state ----------
let room: Room | undefined;
let pet: PetInfo | null = null;
let shownKey = "";

/** The species' first frame as the portrait: the move sheet's front-facing cell. */
function drawPortrait(mobId: number) {
  const cv = q<HTMLCanvasElement>(".pet-portrait"), g = cv.getContext("2d")!;
  g.clearRect(0, 0, cv.width, cv.height);
  const img = new Image();
  const tryKey = (key: string, fallback?: string) => {
    img.onload = async () => {
      let m: { cellW: number; cellH: number } = { cellW: img.naturalWidth / 4, cellH: img.naturalHeight / 3 };
      try { m = await (await fetch(`/sprites/anim/${key}_move.json`)).json(); } catch { /* the grid guess above */ }
      if (shownMob !== mobId) return;
      const s = Math.min((cv.width - 8) / m.cellW, (cv.height - 8) / m.cellH);
      g.clearRect(0, 0, cv.width, cv.height);
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, m.cellW, m.cellH, (cv.width - m.cellW * s) / 2, cv.height - 4 - m.cellH * s, m.cellW * s, m.cellH * s);
    };
    img.onerror = () => { if (fallback) tryKey(fallback); };
    img.src = `/sprites/anim/${key}_move.png`;
  };
  shownMob = mobId;
  tryKey(petSheet(mobId));
}
let shownMob = -1;

function render() {
  q(".pet-none").hidden = !!pet; q(".pet-in").hidden = !pet;
  if (!pet) { shownKey = ""; shownMob = -1; return; }
  q(".pet-name").textContent = pet.name;
  const legend = isLegendaryPet(pet.mobId); // 2.4.0: the gold "Legendary" badge, a gold name and frame
  q(".pet-rarity").hidden = !legend; win.classList.toggle("legendary", legend);
  q(".pet-lv").textContent = `Lv ${pet.level}`;
  const kind = q(".pet-kind"); kind.textContent = kindLabel(pet.kind); kind.className = `pet-kind ${pet.kind}`;
  const sp = petSpecies(pet.mobId);
  q(".pet-sub").title = sp ? sp.name : "";
  const ren = q(".pet-ren"); ren.hidden = pet.renamed;
  const hg = q(".pet-gauge.hunger"); (hg.firstChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, pet.hunger))}%`;
  hg.classList.toggle("low", pet.hunger <= 25);
  q(".pet-hw").textContent = `${hungerWord(pet.hunger)} (${pet.hunger})`;
  (q(".pet-gauge.love").firstChild as HTMLElement).style.width = `${Math.max(0, Math.min(100, pet.intimacy / 10))}%`;
  q(".pet-iw").textContent = `${intimacyWord(pet.intimacy)} (${pet.intimacy})`;
  const auto = q(".pet-auto"); auto.hidden = !autoFeedAllowed(pet.mobId); autoBox.checked = pet.autoFeed;
  if (shownKey !== `${pet.petId}:${pet.mobId}`) { shownKey = `${pet.petId}:${pet.mobId}`; drawPortrait(pet.mobId); }
}

export function toggleWindow(show?: boolean) {
  toggle(win, show);
  if (!win.hidden) room?.send(Msg.petCommand, { op: "info" } satisfies PetCommandMsg); // refresh on open (CZ_COMMAND_PET 0)
}
addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select") || document.body.dataset.screen !== "game") return;
  if (e.altKey && e.code === "KeyJ") { e.preventDefault(); toggleWindow(); }
});

// ---------- eggs ----------
function openEggs(m: PetEggsEvent) {
  const list = eggs.querySelector(".egg-list")!;
  list.textContent = "";
  for (const uid of m.uids) {
    const st = invStack(uid);
    const li = el("li", "egg");
    li.append(iconEl(st?.itemId ?? 0, undefined, 24), el("span", "", st ? ITEMS.get(st.itemId)?.name ?? t("pet.egg") : t("pet.egg")));
    li.addEventListener("click", () => { room?.send(Msg.petHatch, { uid }); eggs.hidden = true; play("sfx", "click", 0.35); });
    list.append(li);
  }
  if (!m.uids.length) list.append(el("li", "egg-none", t("pet.no_egg")));
  eggs.hidden = false;
  toggle(eggs, true);
}

// ---------- taming cursor (ZC_START_CAPTURE) ----------
let catching = false;
export const petCatchActive = () => catching;
function setCatching(on: boolean) { catching = on; document.body.classList.toggle("pet-cursor", on); }
export function petCatchCancel() { if (catching) { setCatching(false); log("system", t("pet.cancelled")); } }
/** The next click on a monster: CZ_TRYCAPTURE_MONSTER. */
export function petCatchPick(id: string) { if (!catching) return; setCatching(false); notePick(id); room?.send(Msg.petCatch, { id }); }
addEventListener("keydown", (e) => { if (catching && e.key === "Escape") { e.stopImmediatePropagation(); petCatchCancel(); } }, true);

export function bindPetUi(r: Room) {
  room = r; pet = null; render();
  r.onMessage(Msg.petInfo, (m: PetInfoEvent) => { pet = m.pet; render(); });
  r.onMessage(Msg.petEggs, (m: PetEggsEvent) => openEggs(m));
  r.onMessage(Msg.petCatchStart, (_m: PetCatchStartEvent) => { setCatching(true); log("system", "Click a monster to tame it (Esc or right-click to cancel)."); play("sfx", "ui_open", 0.5); });
}
export function resetPetUi() { room = undefined; pet = null; setCatching(false); eggs.hidden = true; render(); }
