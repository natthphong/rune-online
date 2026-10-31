// Out-of-game screens, laid out like the original client: Login -> Select Character (3 slots x 3 pages) -> Make Character.
import { GENDERS, GENDER_LABEL, HAIR_COLORS, HAIR_LABEL, HAIR_STYLES, MAX_SLOTS, NAME_RE, USERNAME_RE, outfitOf, type CharacterSummary, type Gender, type Look } from "../../../shared/look.ts";
import { JOBS, type JobKey } from "../../../shared/rules/data.ts";
import { MAP_INFO, type MapName } from "../../../shared/maps.ts";
import { ApiError, api, session } from "../api.ts";
import { play, unlock } from "../audio.ts";
import { onLangChange, t } from "../i18n.ts";
import { Composer, LivePreview, PC, layersOf } from "../animSprite.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SCREENS = ["login-screen", "select-screen", "create-screen"] as const;
type ScreenId = (typeof SCREENS)[number] | null;

export function show(id: ScreenId) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  document.body.dataset.screen = id ?? "game";
}

const lookOf = (c: CharacterSummary): Look => c.look ?? { gender: c.gender, hair: c.hair, outfit: outfitOf(c.job) };

type Hooks = { onStart: (c: CharacterSummary) => Promise<void> };
let hooks: Hooks;
let chars: CharacterSummary[] = [];
let page = 0, selected = 0; // selected = slot index 0..8

// ---------------- login ----------------
let registering = false;
function setMode(reg: boolean) {
  registering = reg;
  $("login-title").textContent = t(reg ? "login.title_register" : "ui.login");
  $("password2-row").hidden = !reg;
  $("btn-mode").textContent = t(reg ? "login.back" : "ui.create_account");
  $("btn-login").textContent = t(reg ? "ui.create" : "ui.login");
  $<HTMLInputElement>("password").autocomplete = reg ? "new-password" : "current-password";
  $("login-error").textContent = "";
}

async function submitLogin(ev: Event) {
  ev.preventDefault();
  unlock();
  const username = $<HTMLInputElement>("username").value.trim().toLowerCase();
  const password = $<HTMLInputElement>("password").value;
  const err = (m: string) => { $("login-error").textContent = m; play("sfx", "error"); };
  if (!USERNAME_RE.test(username)) return err(t("login.err_username"));
  if (registering && password !== $<HTMLInputElement>("password2").value) return err(t("login.err_mismatch"));
  const btn = $<HTMLButtonElement>("btn-login");
  btn.disabled = true;
  try {
    session.save(registering ? await api.register(username, password) : await api.login(username, password));
    $<HTMLInputElement>("password").value = $<HTMLInputElement>("password2").value = "";
    play("sfx", "ui_open");
    await openSelect();
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
  } finally {
    btn.disabled = false;
  }
}

export function openLogin(message = "") {
  show("login-screen");
  setMode(false);
  $<HTMLInputElement>("username").value = session.username;
  $("login-error").textContent = message;
  ($(session.username ? "password" : "username") as HTMLInputElement).focus();
}

// ---------------- select: slot previews ----------------
// Like the original, each slot shows the character at its sprite's own pixel size standing on its ground shadow, and the
// chosen one is the only one that moves (the original loops READYFIGHT on the cursor slot and IDLE on the rest —
// roBrowser UI/Components/CharSelect/CharSelectCommon.js moveCursorToPaginated). Our sheets store a standing body
// meta.unit px tall, so drawing at PREVIEW_UNIT / unit (= 1 for every sheet so far) is a whole-pixel copy of the art: no
// resampling, nothing to blur. The canvases are 1x; CSS `pixelated` doubles them on HiDPI screens instead of smoothing.
const PREVIEW_UNIT = 160; // px of a standing body in the slot (the size the sheets are drawn at)
const SLOT_W = 150, SLOT_H = 214; // canvas = the frame's inner box (style.css .slot)
// ground line near the frame's foot like the original's box; leaves room above the head for headgear (a hat reaches
// ~188 px above the feet) below the "Select" tab
const FEET_Y = SLOT_H - 11;
const WAIST = 72; // px above the feet where the breathing split runs
const BREATH_MS = 700; // the chosen character's 2-frame breath: upper body 1 px down, then back
/** The info ledger, row by row: Name..SP beside STR..LUK, then Map across the row (the original's 16 px rows). */
const LEDGER: readonly (readonly string[])[] = [["Name", "STR"], ["Job", "AGI"], ["Lv.", "VIT"], ["EXP", "INT"], ["HP", "DEX"], ["SP", "LUK"], ["Map"]];
const LABEL_KEY: Record<string, string> = { Name: "ui.name", Job: "select.job", Map: "select.map" };
const LEDGER_TIP: Record<string, string> = { "Lv.": "select.tip_level", EXP: "select.tip_exp" };

type Layer = ReturnType<typeof layersOf>[number];
/** One loaded Composer per look (body + dyed hair + gear layers), kept across re-renders so a click repaints at once. */
const bodies = new Map<string, { comp: Composer; ready: boolean; loaded: Promise<unknown> }>();
function bodyOf(look: Look) {
  const key = JSON.stringify(look);
  let b = bodies.get(key);
  if (!b) {
    const comp = new Composer(PC), entry = { comp, ready: false, loaded: Promise.resolve() as Promise<unknown> };
    entry.loaded = comp.load(`pc_${look.gender}_${look.outfit}`, HAIR_COLORS[look.hair] ?? HAIR_COLORS[0],
      layersOf(look).map((l) => l.key), undefined, layersOf(look).some((l) => l.slot === "hair")).then(() => { entry.ready = true; });
    bodies.set(key, (b = entry));
  }
  return b;
}

/** look = null for an empty slot: the frame stays blank and style.css draws the small "+" mark (like the original, which
 *  leaves empty frames empty; never a faded stand-in character). */
type SlotView = { cv: HTMLCanvasElement; look: Look | null; on: boolean };
let views: SlotView[] = [];

function groundShadow(g: CanvasRenderingContext2D, cx: number) {
  g.save();
  g.translate(cx, FEET_Y - 1);
  g.scale(1, 0.27);
  const r = 34, grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, "rgba(32, 32, 50, 0.44)");
  grad.addColorStop(0.55, "rgba(32, 32, 50, 0.3)");
  grad.addColorStop(1, "rgba(32, 32, 50, 0)");
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** Paint one slot: shadow + the standing front view at 1:1; `sink` = 1 drops the upper body a pixel (breath). */
function paintSlot(v: SlotView, sink = 0) {
  if (!v.look) return;
  const b = bodyOf(v.look);
  if (!b.ready) { void b.loaded.then(() => { if (v.cv.isConnected) paintSlot(v); }); return; }
  const g = v.cv.getContext("2d")!;
  g.clearRect(0, 0, SLOT_W, SLOT_H);
  const f = b.comp.pick(PC.idle, 0);
  if (!f) return;
  const m = f.s.meta, scale = PREVIEW_UNIT / m.unit;
  // whole-pixel placement: at 1:1 the cell's left edge (cx - cellW / 2) has to land on a pixel boundary
  const cx = Math.floor(SLOT_W / 2) + (scale === 1 ? (m.cellW % 2) / 2 : 0);
  const draw = (gg: CanvasRenderingContext2D, layers: Layer[]) => b.comp.draw(gg, f, 0, false, scale, layers, cx, FEET_Y);
  groundShadow(g, cx);
  const layers = layersOf(v.look);
  if (!sink) { draw(g, layers); return; }
  // legs stay planted; everything above the waist is drawn again 1 px lower over them (a gap-free 2-frame breath)
  const cut = FEET_Y - WAIST;
  g.save(); g.beginPath(); g.rect(0, cut, SLOT_W, SLOT_H - cut); g.clip(); draw(g, layers); g.restore();
  g.save(); g.beginPath(); g.rect(0, 0, SLOT_W, cut + sink); g.clip(); g.translate(0, sink); draw(g, layers); g.restore();
}

let breathRaf = 0, breath = 0;
const still = matchMedia("(prefers-reduced-motion: reduce)");
function breathe(now: number) {
  breathRaf = 0;
  if (document.body.dataset.screen !== "select-screen") return;
  breathRaf = requestAnimationFrame(breathe);
  const b = still.matches ? 0 : Math.floor(now / BREATH_MS) % 2;
  if (b === breath) return;
  breath = b;
  for (const v of views) if (v.on && v.look && v.cv.isConnected) paintSlot(v, b);
}

// ---------------- select ----------------
export async function openSelect() {
  try {
    chars = await api.characters();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { session.clear(); return openLogin(e.message); }
    throw e;
  }
  show("select-screen");
  if (!chars.some((c) => c.slot === selected)) selected = chars[0]?.slot ?? 0;
  renderSelect();
}

/** Cursor to a slot (wraps through all pages, like the original's slot arrows). */
function select(slot: number) {
  selected = (slot + MAX_SLOTS) % MAX_SLOTS;
  play("sfx", "click", 0.4);
  renderSelect();
}

function renderSelect() {
  page = Math.floor(selected / 3);
  $("sel-page").innerHTML = `<b>${page + 1}</b> / ${MAX_SLOTS / 3}`;
  $("sel-used").textContent = `${chars.length} / ${MAX_SLOTS}`;
  views = [];
  const cards = [0, 1, 2].map((i) => {
    const slot = page * 3 + i, c = chars.find((x) => x.slot === slot);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `slot${slot === selected ? " on" : ""}${c ? "" : " empty"}`;
    card.title = c ? t("select.slot_tip", { name: c.name }) : t("select.empty_tip");
    const cv = document.createElement("canvas");
    cv.width = SLOT_W; cv.height = SLOT_H;
    card.append(cv);
    const v: SlotView = { cv, look: c ? lookOf(c) : null, on: slot === selected };
    views.push(v);
    paintSlot(v, v.on ? breath : 0);
    card.addEventListener("click", () => (selected === slot && !c ? openCreate(slot) : select(slot)));
    card.addEventListener("dblclick", () => (c ? start() : openCreate(slot)));
    return card;
  });
  $("slots").replaceChildren(...cards);
  if (!breathRaf) breathRaf = requestAnimationFrame(breathe);

  // the ledger; an empty slot keeps the rows with blank values like the original
  const c = chars.find((x) => x.slot === selected);
  const values: string[][] = c ? [
    [c.name, String(c.str)], [JOBS[c.job as JobKey]?.name ?? c.job, String(c.agi)], [`${c.level} / ${c.jobLevel}`, String(c.vit)],
    [c.exp.toLocaleString("en-US"), String(c.int)], [`${c.hp} / ${c.maxHp}`, String(c.dex)], [`${c.sp} / ${c.maxSp}`, String(c.luk)], [MAP_INFO[c.map as MapName]?.title ?? c.map ?? ""],
  ] : [];
  const cell = (tag: "b" | "span", text: string, cls = "", title = "") => Object.assign(document.createElement(tag), { textContent: text, className: cls, title });
  $("sel-info").replaceChildren(...LEDGER.flatMap((labels, r) => labels.flatMap((k, i) =>
    [cell("b", LABEL_KEY[k] ? t(LABEL_KEY[k]) : k, "", LEDGER_TIP[k] ? t(LEDGER_TIP[k]) : ""), cell("span", values[r]?.[i] ?? "", labels.length === 1 ? "wide" : "")])));

  // the original swaps OK for Make on an empty slot and only offers Delete on a character
  const go = $<HTMLButtonElement>("sel-start");
  go.textContent = t(c ? "ui.start" : "select.make");
  go.title = t(c ? "select.start_tip" : "select.make_tip");
  $<HTMLButtonElement>("sel-delete").disabled = !c;
}

/** Start on a character, Make on an empty slot. */
function primary() {
  if (chars.some((x) => x.slot === selected)) void start();
  else openCreate(selected);
}

async function start() {
  const c = chars.find((x) => x.slot === selected);
  if (!c) return;
  const btn = $<HTMLButtonElement>("sel-start");
  btn.disabled = true;
  $("sel-error").textContent = "";
  try {
    await hooks.onStart(c);
  } catch (e) {
    $("sel-error").textContent = e instanceof Error ? e.message : String(e);
    play("sfx", "error");
    if (/session expired/i.test(String(e))) { session.clear(); openLogin(t("login.expired")); }
  } finally {
    btn.disabled = false;
  }
}

// delete: type the exact name (the original asks for e-mail / birthdate)
function openDelete() {
  const c = chars.find((x) => x.slot === selected);
  if (!c) return;
  $("del-name").textContent = c.name;
  $<HTMLInputElement>("del-confirm").value = "";
  $("del-error").textContent = "";
  $("w-delete").hidden = false;
  $<HTMLInputElement>("del-confirm").focus();
}
async function confirmDelete(ev: Event) {
  ev.preventDefault();
  const c = chars.find((x) => x.slot === selected);
  if (!c) return;
  try {
    await api.remove(c.id, $<HTMLInputElement>("del-confirm").value);
    $("w-delete").hidden = true;
    play("sfx", "ui_close");
    await openSelect();
  } catch (e) {
    $("del-error").textContent = e instanceof Error ? e.message : String(e);
    play("sfx", "error");
  }
}

// ---------------- create ----------------
let draft: { slot: number; gender: Gender; hair: number; style: number } = { slot: 0, gender: "M", hair: 0, style: 0 };
let live: LivePreview | undefined;
const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

function openCreate(slot: number) {
  draft = { slot, gender: pick(GENDERS), hair: Math.floor(Math.random() * HAIR_COLORS.length), style: Math.floor(Math.random() * HAIR_STYLES.length) };
  show("create-screen");
  play("sfx", "ui_open", 0.6);
  $<HTMLInputElement>("cr-name").value = "";
  $("cr-error").textContent = "";
  live ??= new LivePreview($<HTMLCanvasElement>("cr-preview"));
  (window as any).__crLive = live; // loop screenshots drive the facing
  live.dir = 0; live.walking = false;
  $("cr-spin").classList.remove("on"); $("cr-walk").classList.remove("on");
  renderCreate();
  $<HTMLInputElement>("cr-name").focus();
}

const styleLook = (style: number): Look => ({ gender: draft.gender, hair: draft.hair, style, outfit: outfitOf("Novice"), weapon: "blade" });
function renderCreate() {
  $("cr-hair").textContent = HAIR_LABEL[draft.hair];
  $("cr-style-n").textContent = `${draft.style + 1} / ${HAIR_STYLES.length} · ${HAIR_STYLES[draft.style].label}`;
  void live?.show(styleLook(draft.style));
  for (const b of $("cr-gender").querySelectorAll("button")) b.classList.toggle("on", b.dataset.g === draft.gender);
  $("cr-colors").querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === draft.hair));
  // style tiles: head and shoulders of each style in the chosen gender and colour (3/4 view so ties and tails show),
  // cropped from the same Composer the select screen uses
  $("cr-styles").querySelectorAll<HTMLCanvasElement>("canvas").forEach((cv, i) => {
    cv.parentElement!.classList.toggle("on", i === draft.style);
    const body = bodyOf(styleLook(i));
    void body.loaded.then(() => {
      if (!cv.isConnected) return;
      const f = body.comp.pick(PC.idle, 0), g = cv.getContext("2d")!;
      g.clearRect(0, 0, cv.width, cv.height);
      if (f) body.comp.draw(g, f, TILE_ROW, false, TILE_SCALE, layersOf(styleLook(i)), cv.width / 2, TILE_FEET);
    });
  });
}
const TILE_ROW = 1, TILE_SCALE = 0.8, TILE_FEET = 134;
function setStyle(i: number) { draft.style = ((i % HAIR_STYLES.length) + HAIR_STYLES.length) % HAIR_STYLES.length; play("sfx", "click", 0.5); renderCreate(); }
function buildCreate() {
  $("cr-gender").replaceChildren(...GENDERS.map((g) => Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: (g === "M" ? "\u2642 " : "\u2640 ") + GENDER_LABEL[g], onclick: () => { draft.gender = g; renderCreate(); } }), ), );
  $("cr-gender").querySelectorAll("button").forEach((b, i) => (b.dataset.g = GENDERS[i]));
  $("cr-colors").replaceChildren(...HAIR_COLORS.map((c, i) => Object.assign(document.createElement("button"), { type: "button", title: HAIR_LABEL[i], onclick: () => { draft.hair = i; renderCreate(); } }) ).map((b, i) => { b.style.setProperty("--c", HAIR_COLORS[i]); return b; }));
  $("cr-styles").replaceChildren(...HAIR_STYLES.map((st, i) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "cr-style", title: st.label, onclick: () => setStyle(i) });
    const cv = document.createElement("canvas"); cv.width = 84; cv.height = 84; b.append(cv);
    return b;
  }));
}
function turn(d: number) {
  if (!live) return;
  live.dir = (((live.dir ?? 0) + d) % 8 + 8) % 8;
  $("cr-spin").classList.remove("on");
}

async function submitCreate(ev: Event) {
  ev.preventDefault();
  const name = $<HTMLInputElement>("cr-name").value.trim();
  if (!NAME_RE.test(name)) { $("cr-error").textContent = t("create.err_name"); play("sfx", "error"); return; }
  try {
    const c = await api.create({ slot: draft.slot, name, gender: draft.gender, hair: draft.hair, style: draft.style });
    live?.stop();
    play("sfx", "levelup", 0.6);
    selected = c.slot;
    await openSelect();
  } catch (e) {
    $("cr-error").textContent = e instanceof Error ? e.message : String(e);
    play("sfx", "error");
  }
}

// ---------------- wiring ----------------
export function initScreens(h: Hooks) {
  hooks = h;
  onLangChange(() => { setMode(registering); if (!$("select-screen").hidden) renderSelect(); });
  $<HTMLFormElement>("login").addEventListener("submit", submitLogin);
  $("btn-mode").addEventListener("click", () => setMode(!registering));

  $("cr-style-l").addEventListener("click", () => setStyle(draft.style - 1));
  $("cr-style-r").addEventListener("click", () => setStyle(draft.style + 1));
  $("sel-prev").addEventListener("click", () => select(selected - 1));
  $("sel-next").addEventListener("click", () => select(selected + 1));
  $("sel-start").addEventListener("click", primary);
  $("sel-delete").addEventListener("click", openDelete);
  $("sel-logout").addEventListener("click", async () => { await api.logout(); session.clear(); openLogin(); });
  $<HTMLFormElement>("w-delete").addEventListener("submit", confirmDelete);
  $("del-cancel").addEventListener("click", () => ($("w-delete").hidden = true));

  buildCreate();
  $("cr-turn-l").addEventListener("click", () => turn(-1));
  $("cr-turn-r").addEventListener("click", () => turn(1));
  $("cr-spin").addEventListener("click", () => { if (live) { live.dir = live.dir === null ? 0 : null; $("cr-spin").classList.toggle("on", live.dir === null); } });
  $("cr-walk").addEventListener("click", () => { if (live) { live.walking = !live.walking; $("cr-walk").classList.toggle("on", live.walking); } });
  $<HTMLFormElement>("w-create").addEventListener("submit", submitCreate);
  $("cr-cancel").addEventListener("click", () => { live?.stop(); show("select-screen"); renderSelect(); });

  addEventListener("keydown", (e) => {
    if (document.body.dataset.screen !== "select-screen" || !$("w-delete").hidden) return;
    // Enter = OK / Make whatever has focus (preventDefault: a focused slot button must not also click itself)
    if (e.key === "Enter") { e.preventDefault(); primary(); }
    else if (e.key === "ArrowRight") select(selected + 1);
    else if (e.key === "ArrowLeft") select(selected - 1);
  });
}
