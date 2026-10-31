import { walkable, type GameMap } from "../../../shared/map.ts";
import { JOBS, STAT_KEYS, type JobKey, type StatKey } from "../../../shared/rules/data.ts";
import { nextBaseExp, nextJobExp, canRaise, needStatusPoint } from "../../../shared/rules/exp.ts";
import { MAJOR_OVERWEIGHT, NATURAL_HEAL_WEIGHT, weightPct } from "../../../shared/rules/items.ts";
import { jobBonus, statusDetail, statusDisplay, type Status, type StatusDetail } from "../../../shared/rules/status.ts";
import { getMusicVolume, getVolume, isMusicMuted, play, setMusicMuted, setMusicVolume, setVolume } from "../audio.ts";
import { getInventory } from "./items.ts";
import { applyI18n, onLangChange, t } from "../i18n.ts";
import { npcSpots } from "../worldItems.ts";
import { initWindows, resetWindowPositions, setMinimized, toggle } from "./windows.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- settings (per browser) ----------
export const settings = { showNames: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem("ro.settings") ?? "{}")); } catch { /* ignore */ }
function saveSettings() { try { localStorage.setItem("ro.settings", JSON.stringify(settings)); } catch { /* ignore */ } }

export type MeView = {
  name: string; job: string; level: number; exp: number; jobLevel: number; jobExp: number; statPoints: number;
  hp: number; maxHp: number; sp: number; maxSp: number; x: number; y: number; dead: boolean;
} & Record<StatKey, number>;
export type Dot = { x: number; y: number; self: boolean; mob?: boolean; party?: boolean };

export function initHud(hooks: { onRespawn: () => void; onLogout: () => void; onCharSelect: () => void; onResetCamera: () => void; onStatUp: (k: StatKey) => void }) {
  const hud = $("hud");
  initWindows(hud);
  // HUD buttons let go of focus after a mouse click, so the game keys pressed next (F1–F9, F12, battle-mode keys) don't paint
  // a focus ring on them; keyboard activation (detail 0) keeps it
  hud.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("#hotbar button, #w-minimap button, #chat-tabs button, #w-basic button, #status-icons button, #menu-icons button");
    if (b && e.detail > 0) b.blur();
  });

  // chat tabs filter by message type (Battle Message / EXP / Chat / General Message = everything)
  const chat = $("chat"), chatLog = $("chat-log");
  for (const tab of hud.querySelectorAll<HTMLButtonElement>("#chat-tabs button[data-tab]")) {
    tab.addEventListener("click", () => {
      hud.querySelectorAll("#chat-tabs button[data-tab]").forEach((b) => b.classList.toggle("on", b === tab));
      chatLog.dataset.tab = tab.dataset.tab!;
      chatLog.scrollTop = chatLog.scrollHeight;
    });
  }
  // header buttons, left to right like the original's: chat mode (off = battle mode: the input line rests and 1–9 / Q–O /
  // A–L fire the shortcut rows under the F1–F9 row, items.ts), battle messages in General Message, follow the newest line,
  // the body's tint (steps through CHAT_TINTS), fold the log away, and the window size the original cycles with F10 (all
  // remembered per browser)
  const chatPrefs = { size: 0, tint: 0, battleMode: false, battleLog: true, follow: true, mini: false };
  try { Object.assign(chatPrefs, JSON.parse(localStorage.getItem(CHAT_KEY) ?? "{}")); } catch { /* ignore */ }
  delete (chatPrefs as Record<string, unknown>).clear; // the old on/off see-through flag, replaced by the tint steps
  chatPrefs.size = Math.abs(Math.trunc(Number(chatPrefs.size))) % CHAT_SIZES || 0;
  chatPrefs.tint = Math.abs(Math.trunc(Number(chatPrefs.tint))) % CHAT_TINTS.length || 0;
  for (const k of ["battleMode", "mini"] as const) chatPrefs[k] = chatPrefs[k] === true;
  for (const k of ["battleLog", "follow"] as const) chatPrefs[k] = chatPrefs[k] !== false;
  const input = $<HTMLInputElement>("chat-input");
  const applyChat = () => {
    chat.dataset.size = String(chatPrefs.size);
    const tint = CHAT_TINTS[chatPrefs.tint];
    chat.style.setProperty("--chat-a", String(tint));
    $("chat-alpha").title = `Window tint: ${Math.round(tint * 100)} % (click for the next)`;
    chat.classList.toggle("battle", chatPrefs.battleMode);
    chat.classList.toggle("mini", chatPrefs.mini);
    chatLog.classList.toggle("no-battle", !chatPrefs.battleLog);
    chatFollow = chatPrefs.follow;
    $("chat-mode").classList.toggle("on", !chatPrefs.battleMode);
    $("chat-battle").classList.toggle("on", chatPrefs.battleLog);
    $("chat-follow").classList.toggle("on", chatPrefs.follow);
    $("chat-mini").classList.toggle("on", chatPrefs.mini);
    input.placeholder = t(chatPrefs.battleMode ? "chat.battle_mode_hint" : "ui.press_enter_to_chat");
    chatLog.scrollTop = chatLog.scrollHeight;
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatPrefs)); } catch { /* private mode */ }
  };
  const cycleChatSize = () => { chatPrefs.size = (chatPrefs.size + 1) % CHAT_SIZES; applyChat(); };
  const cycleChatTint = () => { chatPrefs.tint = (chatPrefs.tint + 1) % CHAT_TINTS.length; applyChat(); play("sfx", "click", 0.3); };
  const flip = (k: "battleMode" | "battleLog" | "follow" | "mini") => () => { chatPrefs[k] = !chatPrefs[k]; applyChat(); play("sfx", "click", 0.3); };
  initChatScroll(chatLog);
  applyChat();
  $("chat-size").addEventListener("click", cycleChatSize);
  $("chat-alpha").addEventListener("click", cycleChatTint);
  $("chat-mode").addEventListener("click", flip("battleMode"));
  $("chat-battle").addEventListener("click", flip("battleLog"));
  $("chat-follow").addEventListener("click", flip("follow"));
  $("chat-mini").addEventListener("click", flip("mini"));
  // battle mode rests the chat line; Enter (main.ts then focuses it) or a click on it brings chat mode back
  const chatOn = () => { if (chatPrefs.battleMode) { chatPrefs.battleMode = false; applyChat(); } };
  input.addEventListener("pointerdown", chatOn);
  addEventListener("keydown", (e) => { if (e.key === "Enter" && document.body.dataset.screen === "game") chatOn(); });

  // options window
  const vol = $<HTMLInputElement>("opt-volume");
  vol.value = String(Math.round(getVolume() * 100));
  vol.addEventListener("input", () => setVolume(Number(vol.value) / 100));
  vol.addEventListener("change", () => play("sfx", "hit"));
  const mus = $<HTMLInputElement>("opt-music"), mute = $<HTMLInputElement>("opt-music-mute");
  mus.value = String(Math.round(getMusicVolume() * 100));
  mus.addEventListener("input", () => setMusicVolume(Number(mus.value) / 100));
  mute.checked = isMusicMuted();
  mute.addEventListener("change", () => setMusicMuted(mute.checked));
  const names = $<HTMLInputElement>("opt-names");
  names.checked = settings.showNames;
  names.addEventListener("change", () => { settings.showNames = names.checked; saveSettings(); });
  $("opt-camera").addEventListener("click", hooks.onResetCamera);
  $("opt-layout").addEventListener("click", () => resetWindowPositions(hud));
  $("opt-logout").addEventListener("click", hooks.onLogout);
  $("opt-charselect").addEventListener("click", hooks.onCharSelect);
  $("btn-options").addEventListener("click", () => toggle($("w-options")));
  $("btn-map").addEventListener("click", () => toggle($("w-minimap")));
  initMinimapBar();
  $("btn-status").addEventListener("click", () => toggle($("w-status")));
  $("st-badge").addEventListener("click", () => toggle($("w-status"), true));
  // Basic Info: the expand arrow folds the menu buttons away, closed by default like the original (remembered per browser)
  let menuOpen = false;
  try { menuOpen = localStorage.getItem(MENU_KEY) === "1"; } catch { /* private mode */ }
  setMenu(menuOpen);
  $("bi-more").addEventListener("click", () => { setMenu($("bi-menu").hidden, true); play("sfx", "click", 0.35); });
  buildStatusWindow(hooks.onStatUp);
  initMenuIcons(hud);
  $("death-respawn").addEventListener("click", hooks.onRespawn);

  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input")) return;
    if (e.key === "Escape") toggle($("w-options"));
    else if (e.altKey && e.code === "KeyV") setMinimized($("w-basic"));
    else if (e.key === "F10" && document.body.dataset.screen === "game") { e.preventDefault(); cycleChatSize(); }
    else if (e.altKey && e.code === "KeyA") { e.preventDefault(); toggle($("w-status")); }
    else if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); cycleMinimap(true); } // 100 % -> 50 % -> hidden
  });
}

// ---------- basic info ----------
/** The original client paints "Weight : a / b" red from half capacity. That threshold lives in the client: the server only
 *  sends SP_WEIGHT / SP_MAXWEIGHT (clif_updatestatus, clif.cpp:3637), and its own overweight state — the status icon and
 *  the regen stop at natural_heal_weight_rate (pc_updateweightstatus, pc.cpp:3026) — is a separate thing. */
export const WEIGHT_RED_RATE = 50;
/** HP / SP gauges switch to the red capsule below this percentage (the client's red gauge art). */
const LOW_GAUGE_RATE = 25;
const MENU_KEY = "ro.ui.basicMenu";

function setMenu(open: boolean, remember = false) {
  $("w-basic").classList.toggle("menu-open", open);
  $("bi-menu").hidden = !open;
  $("bi-more").title = open ? "Hide menu" : "Menu";
  if (remember) try { localStorage.setItem(MENU_KEY, open ? "1" : "0"); } catch { /* private mode */ }
}

// updateBasicInfo runs every frame: only touch the DOM when a value actually changed
const shown = new Map<string, string>();
onLangChange(() => { shown.clear(); shownWeightState = -1; }); // texts built with t() are rewritten on the next frame
function put(id: string, what: "text" | "title" | "fill", v: string) {
  const key = `${id}.${what}`;
  if (shown.get(key) === v) return;
  shown.set(key, v);
  const el = $(id);
  if (what === "text") el.textContent = v;
  else if (what === "title") el.title = v;
  else (el.firstElementChild as HTMLElement).style.width = v;
}
function show(el: HTMLElement, on: boolean) { if (el.hidden === on) el.hidden = !on; }
/** HP/SP capsule: fill width, "v / max" centred on it, floor(v*100/max)% beside it (the client's readout). */
function gauge(id: string, v: number, max: number) {
  const pct = max > 0 ? Math.floor((v * 100) / max) : 0;
  put(id, "fill", `${max > 0 ? Math.max(0, Math.min(100, (v * 100) / max)) : 0}%`);
  $(id).classList.toggle("low", pct < LOW_GAUGE_RATE);
  put(`${id}-txt`, "text", `${v} / ${max}`);
  put(`${id}-pct`, "text", `${pct}%`);
}
/** EXP gauge; at max level the original shows no gauge at all (the server then sends MAX_LEVEL_*_EXP as "next",
 *  pc_nextbaseexp / pc_nextjobexp, mirrored by shared/rules/exp.ts). The exact percentage is the gauge's tooltip. */
function expGauge(id: string, exp: number, next: number, maxed: boolean) {
  const el = $(id);
  show(el, !maxed);
  if (maxed) return "MAX";
  const p = next > 0 ? Math.min(100, (exp * 100) / next) : 0;
  put(id, "fill", `${p}%`);
  put(id, "title", `${p.toFixed(1)}%`);
  return `${p.toFixed(1)}%`;
}
let lastLevel = 0, lastJobLevel = 0;
function flash(id: string) { const el = $(id); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }

export function updateBasicInfo(me: MeView) {
  const job = me.job as JobKey, def = JOBS[job], jobName = def?.name ?? me.job;
  put("bi-name", "text", me.name);
  put("bi-job", "text", jobName);
  gauge("bi-hp", me.hp, me.maxHp);
  gauge("bi-sp", me.sp, me.maxSp);
  put("bi-lv", "text", String(me.level));
  put("bi-jlv", "text", String(me.jobLevel));
  const exp = expGauge("bi-exp", me.exp, nextBaseExp(job, me.level), me.level >= def.maxBaseLevel);
  expGauge("bi-jexp", me.jobExp, nextJobExp(job, me.jobLevel), me.jobLevel >= def.maxJobLevel);
  // footer from the last inventory snapshot (weight is kept in tenths, shown whole like the client)
  const inv = getInventory();
  put("bi-weight", "text", t("hud.weight", { cur: Math.floor(inv.weight / 10), max: Math.floor(inv.maxWeight / 10) }));
  put("bi-weight", "title", `${inv.maxWeight > 0 ? ((inv.weight * 100) / inv.maxWeight).toFixed(1) : "0.0"}%`);
  $("bi-weight").classList.toggle("heavy", inv.weight * 100 >= inv.maxWeight * WEIGHT_RED_RATE);
  put("bi-zeny", "text", t("hud.zeny", { n: inv.zeny.toLocaleString("en-US") }));
  updateStatusIcons(inv.weight, inv.maxWeight);
  // mini view (title button / Alt+V): name in the title bar, two summary lines
  put("bi-mname", "text", me.name);
  put("bi-mline1", "text", t("hud.mline1", { lv: me.level, job: jobName, jlv: me.jobLevel, exp }));
  put("bi-mline2", "text", `HP. ${me.hp} / ${me.maxHp} | SP. ${me.sp} / ${me.maxSp}`);
  const spend = STAT_KEYS.some((k) => canRaise(job, k, me[k], me.statPoints)); // same rule as the Status window's buttons
  show($("st-badge"), spend);
  updatePointsIcon(spend ? me.statPoints : 0);
  if (me.level !== lastLevel) { if (lastLevel) flash("bi-lv"); lastLevel = me.level; }
  if (me.jobLevel !== lastJobLevel) { if (lastJobLevel) flash("bi-jlv"); lastJobLevel = me.jobLevel; }
}

// ---------- window shortcuts (the icon column under the minimap) ----------
/** The square coloured icons (index.html #menu-icons): each forwards its click to the Basic Info menu button it stands for
 *  (data-for: the same open / refresh logic, the Quest button quests.ts adds later included) and lights up while its window
 *  (data-win) is open. */
function initMenuIcons(hud: HTMLElement) {
  const icons = [...hud.querySelectorAll<HTMLButtonElement>("#menu-icons .mico")];
  for (const b of icons) b.addEventListener("click", () => { document.getElementById(b.dataset.for!)?.click(); play("sfx", "click", 0.3); });
  const sync = () => { for (const b of icons) b.classList.toggle("on", document.getElementById(b.dataset.win!)?.hidden === false); };
  new MutationObserver(sync).observe(hud, { attributes: true, attributeFilter: ["hidden"], subtree: true });
  sync();
}

// ---------- status icons (the column under the window shortcuts) ----------
// The original stacks one square icon per active status down the right edge under the minimap. Only real states go there:
//  - the status points you can still spend (the same condition as the red square on Basic Info; click opens the Status window);
//  - the overweight pair: pc_updateweightstatus (pc.cpp:3026) starts SC_WEIGHT50 from natural_heal_weight_rate
//    (Renewal 70 %: no natural HP/SP recovery) and SC_WEIGHT90 from major_overweight_rate (90 %: no recovery and no attacking),
//    iconed EFST_WEIGHTOVER50 / EFST_WEIGHTOVER90 in db/re/status.yml. The server applies the same two thresholds from
//    shared/rules/items.ts (regen and attack in MapRoom); this shows them from the inventory snapshot.
// There is no buff system yet, so nothing else shows up here.
let shownPoints = -1, pointsIcon: HTMLButtonElement | undefined;
/** The "spend your points" icon: `points` is 0 when nothing can be raised (the icon is then gone). Only touches the DOM on a change. */
function updatePointsIcon(points: number) {
  if (points === shownPoints) return;
  shownPoints = points;
  if (!points) { pointsIcon?.remove(); pointsIcon = undefined; return; }
  if (!pointsIcon) {
    pointsIcon = document.createElement("button");
    pointsIcon.type = "button";
    pointsIcon.className = "sicon points";
    pointsIcon.append(document.createElement("b"));
    pointsIcon.addEventListener("click", () => { toggle($("w-status"), true); play("sfx", "click", 0.3); });
    $("status-icons").append(pointsIcon);
  }
  pointsIcon.title = t("hud.points_tip", { count: points });
  pointsIcon.firstElementChild!.textContent = points > 99 ? "99+" : String(points);
}
const WEIGHT_ICONS = [
  null,
  { cls: "weight50", rate: NATURAL_HEAL_WEIGHT, tip: "hud.overweight50" },
  { cls: "weight90", rate: MAJOR_OVERWEIGHT, tip: "hud.overweight90" },
] as const;
let shownWeightState = -1;
/** pc_updateweightstatus's new_overweight: 0, 1 (SC_WEIGHT50) or 2 (SC_WEIGHT90); pc_getpercentweight floors like weightPct. */
function weightState(weight: number, maxWeight: number): 0 | 1 | 2 {
  if (maxWeight <= 0) return 0; // no inventory snapshot yet
  const pct = weightPct(weight, maxWeight);
  return pct >= MAJOR_OVERWEIGHT ? 2 : pct >= NATURAL_HEAL_WEIGHT ? 1 : 0;
}
function updateStatusIcons(weight: number, maxWeight: number) {
  const state = weightState(weight, maxWeight);
  if (state === shownWeightState) return;
  shownWeightState = state;
  const col = $("status-icons");
  col.querySelector(".sicon.weight")?.remove();
  const def = WEIGHT_ICONS[state];
  if (!def) return;
  const icon = document.createElement("span"), pct = document.createElement("b");
  icon.className = `sicon weight ${def.cls}`;
  icon.title = t("hud.overweight", { rate: def.rate, tip: t(def.tip) });
  pct.textContent = `${def.rate}%`;
  icon.append(pct);
  col.append(icon);
}

// ---------- status window (Alt+A) ----------
// The original's ledger (markup in index.html): Str..Luk | Atk Matk Hit Critical | Def Mdef Flee Aspd, then Status Point and
// Guild across both right columns. Every number comes from the shared rules; this only prints them.
const STAT_LABEL: Record<StatKey, string> = { str: "Str", agi: "Agi", vit: "Vit", int: "Int", dex: "Dex", luk: "Luk" }; // stat names stay English in every language;
/** Ledger cells right of the stats: [container id, [value id, label][]], top to bottom. */
const STATUS_LEDGER: [string, [string, string][]][] = [
  ["st-col1", [["atk", "status.atk"], ["matk", "status.matk"], ["hit", "status.hit"], ["cri", "status.cri"]]],
  ["st-col2", [["def", "status.def"], ["mdef", "status.mdef"], ["flee", "status.flee"], ["aspd", "status.aspd"]]],
  ["st-wide", [["points", "status.points"], ["guild", "status.guild"]]], // Guild stays blank until guilds exist (a guildless character)
];
/** The footer expander's second ledger ("Details", index.html), row-major over the same three columns: [value id, label, tooltip,
 *  text from the shared rule statusDetail]. The numbers (units, tenths, rAthena sources) are the rule's; this only prints them.
 *  Add a row here, and a field to statusDetail, and it shows up. */
const STATUS_DETAIL: [string, string, string, (d: StatusDetail) => string][] = [
  ["element", "status.element", "status.element_tip", (d) => `${d.element} ${d.elementLevel}`],
  ["range", "status.range", "status.range_tip", (d) => String(d.range)],
  ["pdodge", "status.pdodge", "status.pdodge_tip", (d) => `${d.perfectDodge.toFixed(1)} %`],
  ["walk", "status.walk", "status.walk_tip", (d) => `${d.walkSpeed.toFixed(1)}/s`],
  ["delay", "status.delay", "status.delay_tip", (d) => `${d.attackDelay.toFixed(2)} s`],
  ["crit", "status.crit", "status.crit_tip", (d) => `${d.crit.toFixed(1)} %`],
];

function buildStatusWindow(onStatUp: (k: StatKey) => void) {
  for (const k of STAT_KEYS) {
    const row = document.createElement("div");
    row.className = "st-stat";
    row.innerHTML = `<span class="k"></span><span class="st-strip"><span class="st-field" id="st-${k}-f"><span class="v" id="st-${k}"></span><span class="b" id="st-${k}-b"></span></span>`
      + `<button type="button" class="st-up" id="st-${k}-up"></button><span class="st-cost" id="st-${k}-c"></span></span>`;
    row.querySelector(".k")!.textContent = STAT_LABEL[k];
    const up = row.querySelector("button")!;
    up.dataset.i18nTitle = "status.raise_" + k;
    up.addEventListener("click", () => onStatUp(k));
    $("st-stats").append(row);
  }
  for (const [col, cells] of STATUS_LEDGER) for (const [id, label] of cells) {
    const cell = document.createElement("div");
    cell.className = "st-cell";
    cell.innerHTML = `<span class="k" data-i18n="${label}"></span><span class="v" id="sd-${id}"></span>`;
    $(col).append(cell);
  }
  for (const [id, label, tip] of STATUS_DETAIL) {
    const cell = document.createElement("div");
    cell.className = "st-cell";
    cell.dataset.i18nTitle = tip;
    cell.innerHTML = `<span class="k" data-i18n="${label}"></span><span class="v" id="sx-${id}"></span>`;
    $("st-detail").append(cell);
  }
  applyI18n($("w-status"));
}

/** Signed values print the way the original prints them: a stat bonus "+n" / "- n" (the "+0" slot stays, painted pale, so the
 *  bonus column lines up in all six rows), a pair "a + b" / "a - b". rAthena sends both signed: ZC_COUPLESTATUS
 *  `battle_status.str - status.str` (clif.cpp:3782-3797) and the pc_rightside_* halves (pc.hpp:1239-1244), which go negative with
 *  e.g. bStr,-2 / bDef,-5 / bBaseAtk,-20 gear. */
const bonusText = (v: number) => (v < 0 ? `- ${-v}` : `+${v}`);
const pairText = ([l, r]: readonly [number, number]) => `${l} ${r < 0 ? "-" : "+"} ${Math.abs(r)}`;
/** Tooltip of a stat field: where its +bonus comes from, "Str 10 + 2 Job + 20 Gear = 32" (the job part is job_stats.yml's
 *  BonusStats accumulated to the job level, status.ts jobBonus; the gear part is what's left of battle_status - status). */
const statTip = (label: string, base: number, job: number, gear: number) => {
  const part = (v: number, what: string) => (v ? ` ${v < 0 ? "-" : "+"} ${Math.abs(v)} ${what}` : "");
  return job || gear ? `${label} ${base}${part(job, t("status.job"))}${part(gear, t("status.gear"))} = ${base + job + gear}` : t("status.no_bonus", { label, base });
};

export function updateStatusWindow(me: MeView, s: Status) {
  if ($("w-status").hidden) return;
  const job = me.job as JobKey, jb = jobBonus(job, me.jobLevel);
  for (const k of STAT_KEYS) {
    const bonus = s.bonus[k];
    put(`st-${k}`, "text", String(me[k]));
    put(`st-${k}-b`, "text", bonusText(bonus));
    $(`st-${k}-b`).classList.toggle("none", bonus === 0);
    put(`st-${k}-f`, "title", statTip(STAT_LABEL[k], me[k], jb[k], bonus - jb[k]));
    put(`st-${k}-c`, "text", String(needStatusPoint(job, k, me[k]))); // pc_need_status_point: 0 at the job's cap
    // the arrow is drawn only while pc_statusup would accept +1 (the same rule as the Basic Info notice square)
    const up = $<HTMLButtonElement>(`st-${k}-up`), can = canRaise(job, k, me[k], me.statPoints);
    if (up.disabled === can) up.disabled = !can;
  }
  const d = statusDisplay(s); // pure rule: same halves/order as clif_updatestatus
  put("sd-atk", "text", pairText(d.atk));
  put("sd-matk", "text", pairText(d.matk));
  put("sd-hit", "text", String(d.hit));
  put("sd-cri", "text", String(d.cri));
  put("sd-def", "text", pairText(d.def));
  put("sd-mdef", "text", pairText(d.mdef));
  put("sd-flee", "text", pairText(d.flee));
  put("sd-aspd", "text", String(d.aspd));
  put("sd-points", "text", String(me.statPoints));
  const x = statusDetail(s); // pure rule: the Details ledger's values in player units
  for (const [id, , , text] of STATUS_DETAIL) put(`sx-${id}`, "text", text(x)); // cheap: change-only writes; hidden while folded
}

// ---------- minimap (north-up, like the original) ----------
// A small picture of the map itself, painted once per map (and zoom) from the generated tiles: grass, dirt roads, the cobbled
// plaza, stone, water with a darker shore, hill shading from the heights and the trees and rocks seen from above. It is
// slightly translucent and sits in a thin frame (style.css #mm-canvas); on top come the markers, redrawn at 10 fps: amber dots
// for NPCs while the town-info toggle (the glass) is on, a pulsing yellow "!" diamond on an NPC with work for you (quests.ts
// feeds it through setMinimapQuestSource), small white dots for other players, red ones for monsters and your own white arrow
// last. The map's name is not written on it (see banner()).
// Footer like the original's: town info, "x y", zoom in / out, fold the map away, opacity (Ctrl+Tab cycles 100 %, 50 % and
// hidden like the original). Toggles are remembered per browser.
const MM_ZOOMS = [1, 2]; // zoom 1 fits the whole map in the canvas, zoom 2 doubles it around you
const MM_KEY = "ro.ui.minimap";
const MM_ALPHA = 0.9; // the painted map's opacity (markers stay opaque); the opacity button then halves the whole canvas
/** Our own palette, [r, g, b] per TILE kind (shared/map.ts): grass, dirt, water, stone, cobble. */
const MM_TILE_RGB: readonly (readonly [number, number, number])[] = [[72, 112, 44], [140, 102, 62], [48, 86, 132], [106, 103, 96], [164, 142, 98]]; // slightly darkened, like the original's
const MM_CAVE_ROCK = [34, 30, 28] as const;
const MM_TREE = ["#1e4a1c", "#3f7a2e"], MM_ROCK = ["#5d5b58", "#9b988f"]; // [shade, light] of a tree crown / a rock
const MM_PROP: Partial<Record<string, string[]>> = { pine: ["#173b26", "#2f6243"], deadtree: ["#3b342a", "#6b5d48"], stump: ["#4a3a26", "#7a6040"], ruin: ["#57544c", "#a59f90"], stair: ["#2a2622", "#6d655a"],
  stalagmite: ["#3a3632", "#6e675e"], torch: ["#7a3a10", "#ffb347"] }; // W03 caves
const MM_ARROW_CLEAR = 7; // px: NPC and player dots this close to your arrow's centre are left out (they'd sit on it)
let mmImages: HTMLCanvasElement[] = [], mmScales: number[] = [], mmZoom = 0;
const mmPrefs = { npcs: true, mini: false, half: false };
let mmQuestSource: (npcId: string) => string | undefined = () => undefined;
/** quests.ts registers how to ask "does this NPC have work for me" (a colour, or undefined); hud.ts can't import it (cycle). */
export function setMinimapQuestSource(f: (npcId: string) => string | undefined) { mmQuestSource = f; }

/** One pixel per tile: tile colour, a hill shade from the height field (light from the upper left), a little grain, a darker
 *  tree line on the map's border cells (they are blocked, not shown as props) and a darker rim of water along the shore. */
function terrainTiles(m: GameMap) {
  const cv = document.createElement("canvas");
  cv.width = m.w; cv.height = m.h;
  const g = cv.getContext("2d")!, img = g.createImageData(m.w, m.h), px = img.data;
  const hAt = (x: number, y: number) => m.height[Math.max(0, Math.min(m.h - 1, y)) * m.w + Math.max(0, Math.min(m.w - 1, x))];
  const kindAt = (x: number, y: number) => (x < 0 || y < 0 || x >= m.w || y >= m.h ? 0 : m.kind[y * m.w + x]);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const i = y * m.w + x, k = m.kind[i];
    // W03 caves: the rock between the passages is near black, the floor reads as a lit path
    const c = m.theme === "cave" && m.blocked[i] && k !== 2 ? MM_CAVE_ROCK : MM_TILE_RGB[k] ?? MM_TILE_RGB[0];
    const grain = 1 + (((x * 73856093) ^ (y * 19349663)) % 11 - 5) * 0.012; // +-6 %, the same every time
    let shade = 1 + (hAt(x - 1, y - 1) - hAt(x + 1, y + 1)) * 0.5;
    if (k === 2) { // water: deeper where no land touches it
      const shore = kindAt(x - 1, y) !== 2 || kindAt(x + 1, y) !== 2 || kindAt(x, y - 1) !== 2 || kindAt(x, y + 1) !== 2;
      shade = shore ? 1.12 : 0.9;
    } else if (m.blocked[i] && (x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1)) shade = 0.55; // the border: forest wall
    shade = Math.max(0.5, Math.min(1.3, shade)) * grain;
    px[i * 4] = Math.min(255, c[0] * shade); px[i * 4 + 1] = Math.min(255, c[1] * shade); px[i * 4 + 2] = Math.min(255, c[2] * shade); px[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/** The map painted at `s` canvas pixels per tile: the tile pixels scaled up smooth (soft edges between ground types, like a
 *  painted map), then the props on top. */
function terrainImage(m: GameMap, tiles: HTMLCanvasElement, s: number, warps: readonly { x: number; y: number }[]) {
  const cv = document.createElement("canvas");
  cv.width = Math.round(m.w * s); cv.height = Math.round(m.h * s);
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.globalAlpha = MM_ALPHA;
  g.drawImage(tiles, 0, 0, cv.width, cv.height);
  for (const p of m.props) {
    const big = p.type === "tree" || p.type === "pine" || p.type === "deadtree";
    const cx = (p.x + 0.5) * s, cy = (p.y + 0.5) * s, [shade, light] = MM_PROP[p.type] ?? (p.type === "tree" ? MM_TREE : MM_ROCK);
    const r = big ? Math.max(1.4, s * 0.62) : Math.max(1, s * 0.4);
    g.fillStyle = shade; g.beginPath(); g.arc(cx + s * 0.08, cy + s * 0.1, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = light; g.beginPath(); g.arc(cx - r * 0.2, cy - r * 0.25, r * 0.6, 0, Math.PI * 2); g.fill();
  }
  // warp portals (W01): a bright ring where a gate leads to another map
  g.globalAlpha = 1;
  for (const w of warps) {
    const cx = (w.x + 0.5) * s, cy = (w.y + 0.5) * s, r = Math.max(2.6, s * 1.1);
    g.fillStyle = "rgba(124, 200, 255, 0.35)"; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#dff3ff"; g.lineWidth = Math.max(1, s * 0.3); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  }
  return cv;
}

export function setMinimapMap(m: GameMap, title: string, warps: readonly { x: number; y: number }[] = []) {
  const size = $<HTMLCanvasElement>("mm-canvas").width, fit = size / Math.max(m.w, m.h), tiles = terrainTiles(m);
  mmScales = MM_ZOOMS.map((z) => fit * z);
  mmImages = mmScales.map((s) => terrainImage(m, tiles, s, warps));
  $("w-minimap").setAttribute("aria-label", `${title} minimap`);
}

function zoomMinimap(step: number) {
  mmZoom = Math.max(0, Math.min(MM_ZOOMS.length - 1, mmZoom + step));
  ($("mm-in") as HTMLButtonElement).disabled = mmZoom === MM_ZOOMS.length - 1;
  ($("mm-out") as HTMLButtonElement).disabled = mmZoom === 0;
}
function applyMinimap() {
  const w = $("w-minimap");
  w.classList.toggle("half", mmPrefs.half);
  w.classList.toggle("mini", mmPrefs.mini);
  $("mm-npc").classList.toggle("on", mmPrefs.npcs);
  $("mm-mini").classList.toggle("on", mmPrefs.mini);
  $("mm-alpha").classList.toggle("on", mmPrefs.half);
  try { localStorage.setItem(MM_KEY, JSON.stringify(mmPrefs)); } catch { /* private mode */ }
}
/** The opacity button cycles 100 % / 50 %; Ctrl+Tab also hides it (the Map menu button shows it again). */
function cycleMinimap(withHidden: boolean) {
  const w = $("w-minimap");
  if (w.hidden) { toggle(w, true); mmPrefs.half = false; }
  else if (!mmPrefs.half) mmPrefs.half = true;
  else if (withHidden) toggle(w, false);
  else mmPrefs.half = false;
  applyMinimap();
}
function initMinimapBar() {
  try { Object.assign(mmPrefs, JSON.parse(localStorage.getItem(MM_KEY) ?? "{}")); } catch { /* ignore */ }
  for (const k of ["mini", "half"] as const) mmPrefs[k] = mmPrefs[k] === true;
  mmPrefs.npcs = mmPrefs.npcs !== false;
  const flip = (k: "npcs" | "mini") => () => { mmPrefs[k] = !mmPrefs[k]; applyMinimap(); play("sfx", "click", 0.3); };
  $("mm-npc").addEventListener("click", flip("npcs"));
  $("mm-mini").addEventListener("click", flip("mini"));
  $("mm-alpha").addEventListener("click", () => { cycleMinimap(false); play("sfx", "click", 0.3); });
  $("mm-in").addEventListener("click", () => zoomMinimap(1));
  $("mm-out").addEventListener("click", () => zoomMinimap(-1));
  zoomMinimap(0);
  applyMinimap();
}

export function drawMinimap(dots: Dot[], me: { x: number; y: number }, camYaw: number) {
  const cv = $<HTMLCanvasElement>("mm-canvas"), img = mmImages[mmZoom], s = mmScales[mmZoom];
  put("mm-pos", "text", `${Math.round(me.x)} ${Math.round(me.y)}`);
  if (!img || mmPrefs.mini) return;
  const g = cv.getContext("2d")!;
  // zoomed in: keep the player centred, clamped to the map
  const ox = Math.round(Math.max(0, Math.min((me.x + 0.5) * s - cv.width / 2, img.width - cv.width)));
  const oy = Math.round(Math.max(0, Math.min((me.y + 0.5) * s - cv.height / 2, img.height - cv.height)));
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(img, ox, oy, cv.width, cv.height, 0, 0, cv.width, cv.height);
  const ax = (me.x + 0.5) * s - ox, ay = (me.y + 0.5) * s - oy;
  const dot = (tx: number, ty: number, fill: string, size = 3, ring = true) => { // a size x size px dot (in a dark 1-px ring), unless it would sit on your arrow
    const x = Math.round((tx + 0.5) * s - ox) - (size >> 1), y = Math.round((ty + 0.5) * s - oy) - (size >> 1);
    if (Math.hypot(x - ax, y - ay) <= MM_ARROW_CLEAR) return;
    if (ring) { g.fillStyle = "rgba(14, 12, 8, 0.85)"; g.fillRect(x - 1, y - 1, size + 2, size + 2); }
    g.fillStyle = fill; g.fillRect(x, y, size, size);
  };
  for (const d of dots) if (!d.self) { if (d.party) dot(d.x, d.y, "#ff7ac8", 4); else if (d.mob) dot(d.x, d.y, "#ff4b3c", 2, false); else dot(d.x, d.y, "#ffffff"); }
  if (mmPrefs.npcs) for (const n of npcSpots()) { // town info: an amber dot per NPC, a pulsing yellow diamond when it has work for you
    const q = mmQuestSource(n.id);
    if (!q) { dot(n.x, n.y, "#ffc54a"); continue; }
    const x = Math.round((n.x + 0.5) * s - ox), y = Math.round((n.y + 0.5) * s - oy), r = 4 + Math.sin(performance.now() / 260);
    g.fillStyle = "rgba(14, 12, 8, 0.9)"; g.beginPath(); g.moveTo(x, y - r - 1.2); g.lineTo(x + r + 1.2, y); g.lineTo(x, y + r + 1.2); g.lineTo(x - r - 1.2, y); g.closePath(); g.fill();
    g.fillStyle = q; g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fill();
  }
  // you: a white arrow pointing where the camera looks (away from the viewer), drawn last so nothing covers it
  g.save();
  g.translate(ax, ay);
  g.rotate(-camYaw);
  g.fillStyle = "#ffffff"; g.strokeStyle = "rgba(0, 0, 0, 0.7)"; g.lineWidth = 1.2; g.lineJoin = "round";
  g.beginPath(); g.moveTo(0, -5.5); g.lineTo(4.5, 4.5); g.lineTo(0, 2.2); g.lineTo(-4.5, 4.5); g.closePath(); g.stroke(); g.fill();
  g.restore();
}

// ---------- chat / battle log ----------
const CHAT_KEY = "ro.ui.chat";
const CHAT_SIZES = 3; // #chat[data-size] heights in style.css
/** The chat panel's tints (black alpha, --chat-a in style.css: body, tabs and input line together) the transparency button
 *  steps through. The first is the original's: a dark translucent panel — on the reference captures the log keeps only ~0.4 of
 *  the ground's brightness (the tabs less), so its coloured lines read at 8:1 or better over bright grass — then nearly
 *  opaque, the lighter tint this used to default to, and almost clear. The text carries its own outline, so it reads on all. */
const CHAT_TINTS = [0.65, 0.85, 0.4, 0.2];
const CHAT_LINE = 14; // px, one line of the log (▲ / ▼ step)
let chatFollow = true; // header button: new lines scroll the log when you are at its end

/** The original's chat scrollbar (▲, track with a thumb, ▼), drawn by us so it is always there — native scrollbars
 *  are overlays on macOS and hidden in headless capture. Synced on scroll, new lines, tab filters and resizes. */
function initChatScroll(logEl: HTMLElement) {
  const bar = $("chat-scroll"), track = bar.querySelector<HTMLElement>(".track")!, thumb = track.firstElementChild as HTMLElement;
  const range = () => logEl.scrollHeight - logEl.clientHeight;
  const sync = () => {
    const h = track.clientHeight, r = range();
    thumb.hidden = r <= 0; // nothing to scroll: bare track, like a classic scrollbar
    if (r <= 0) return;
    const th = Math.max(10, (h * logEl.clientHeight) / logEl.scrollHeight);
    thumb.style.height = `${th}px`;
    thumb.style.transform = `translateY(${((h - th) * logEl.scrollTop) / r}px)`;
  };
  logEl.addEventListener("scroll", sync, { passive: true });
  new MutationObserver(sync).observe(logEl, { childList: true, attributes: true, attributeFilter: ["data-tab"] });
  new ResizeObserver(sync).observe(logEl);
  for (const b of bar.querySelectorAll<HTMLButtonElement>("button")) b.addEventListener("click", () => logEl.scrollBy({ top: Number(b.dataset.step) * CHAT_LINE }));
  track.addEventListener("pointerdown", (e) => { // click on the track pages, like the original
    if (e.target === track) logEl.scrollBy({ top: (e.clientY < thumb.getBoundingClientRect().top ? -1 : 1) * logEl.clientHeight });
  });
  thumb.addEventListener("pointerdown", (e) => { // drag the thumb
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    const y0 = e.clientY, s0 = logEl.scrollTop;
    const move = (ev: PointerEvent) => {
      const free = track.clientHeight - thumb.offsetHeight;
      if (free > 0) logEl.scrollTop = s0 + ((ev.clientY - y0) * range()) / free;
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("lostpointercapture", () => thumb.removeEventListener("pointermove", move), { once: true });
  });
}

export type LogKind = "chat" | "self" | "system" | "battle" | "battle-bad" | "exp" | "announce" | "mvp" | "party" | "whisper";
export function log(kind: LogKind, text: string, who?: string) {
  const line = document.createElement("div");
  line.className = `ln ${kind}`;
  if (who) {
    const b = document.createElement("b");
    b.textContent = `${who} : `;
    line.append(b);
  }
  line.append(text);
  const el = $("chat-log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.append(line);
  while (el.childElementCount > 200) el.firstElementChild!.remove();
  if (atBottom && chatFollow) el.scrollTop = el.scrollHeight;
}

/** ZC_NOTIFY_EXP with the `lost` flag (pc_lostexp): the death penalty, one chat line per part, in the EXP colour. */
export function logExpLoss(base: number, job: number) {
  if (base > 0) log("battle-bad", t("hud.lost_base", { n: base.toLocaleString() }));
  if (job > 0) log("battle-bad", t("hud.lost_job", { n: job.toLocaleString() }));
}

// ---------- banner, death, tooltip ----------
/** The map sign: a title over a small subtitle, held ~5 s then faded like the original's map-name sign, but set as a small
 *  regular-weight label just left of the minimap (style.css #banner), so the top centre of the play area stays clear and the
 *  minimap itself carries no text. Map entry and level-ups use it. */
export function banner(text: string, sub = "") {
  const b = $("banner");
  b.innerHTML = "";
  const h = document.createElement("div");
  h.textContent = text;
  const s = document.createElement("small");
  s.textContent = sub;
  b.append(h, s);
  b.classList.remove("show"); void b.offsetWidth; b.classList.add("show");
}

export function showDeath(show: boolean) {
  $("death").hidden = !show;
  document.body.classList.toggle("dead", show);
}

export function tooltip(text: string | null, x = 0, y = 0, cls = "") {
  const t = $("tooltip");
  t.hidden = !text;
  if (!text) return;
  t.textContent = text;
  t.className = cls;
  t.style.left = `${x + 16}px`;
  t.style.top = `${y + 14}px`;
}
