// Skill Tree window (Alt+S), skill icons, skill tooltips, the skill-targeting cursor and the cooldown shade on shortcut slots.
// The server owns the list (Msg.skills = clif_skillinfoblock: learned level, tree max, upgradable, points left); this window
// renders it, sends CZ_UPGRADE_SKILLLEVEL (+) and starts a use: self skills go at once, the others arm the targeting cursor
// and the next click on a unit / cell sends CZ_USE_SKILL / CZ_USE_SKILL_TOGROUND (main.ts). Numbers in the tooltip come from
// the same shared rules the server uses (shared/rules/skill.ts: cost, range, Renewal cast time with the owner's DEX / INT).
import { SKILLS, SKILL_ID, SKILL_USE, treeChain, castTime, skillCooldown, skillCost, skillLv, skillRange, skillTree, treeRows, type Learned, type Skill } from "../../../shared/rules/skill.ts";
import { JOBS, type JobKey } from "../../../shared/rules/data.ts";
import { SKILL_TEXT } from "../../../shared/content/skill_text.ts";
import type { SkillDelayEvent, SkillsEvent, StatusEvent } from "../../../shared/protocol.ts";
import { skillHotkey } from "../../../shared/rules/hotkey.ts";
import { play } from "../audio.ts";
import { toggle } from "./windows.ts";
import "./skills.css";
import { t } from "../i18n.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type SkillHooks = {
  skillUp: (id: number) => void;
  /** A self skill fires at once (target undefined); main.ts sends the targeted ones after the click. */
  use: (id: number, lv: number, target?: { unit?: string; x?: number; y?: number }) => void;
  log: (text: string) => void;
};
let hooks: SkillHooks;
let list: SkillsEvent["list"] = [];
let points = 0;
let own: StatusEvent | undefined;
let job: JobKey = "Novice";
let tab: string | undefined; // the job whose tree the window shows
/** canact (EFST_POSTDELAY): no skill before this performance.now(); cooldowns per skill id: [start, end]. */
let canactUntil = 0, canactFrom = 0;
const cooldowns = new Map<number, [number, number]>();

// ---------- icons: our own glyphs, drawn once per skill on a canvas ----------
const ELE_COLOR: Record<string, [string, string]> = {
  Fire: ["#ffb35a", "#c8401c"], Water: ["#a8e2ff", "#2f79c4"], Wind: ["#fff27a", "#c09a12"], Earth: ["#d9b57a", "#7b5a2a"],
  Ghost: ["#e0ccff", "#7655c4"], Holy: ["#fffbe0", "#d6b24a"], Poison: ["#c8f28a", "#4f8c22"], Dark: ["#b79bd0", "#41305e"],
  Neutral: ["#e8edf6", "#7d8aa6"], Weapon: ["#e8edf6", "#6c7896"], Undead: ["#c9d0b0", "#5a6040"],
};
const iconCache = new Map<number, string>();
/** What the glyph shows: by skill key where it is specific, else by job prefix / kind. */
function glyphOf(s: Skill): string {
  const k = s.key;
  if (k === "NV_BASIC") return "book";
  if (k === "AL_HEAL" || k === "TF_DETOXIFY" || k === "AL_CURE") return "cross";
  if (k === "MC_MAMMONITE" || k === "MC_DISCOUNT" || k === "MC_OVERCHARGE") return "coin";
  if (k === "TF_POISON") return "drop";
  if (k.startsWith("AC_") && s.target !== "Passive") return k === "AC_SHOWER" ? "rain" : "arrow";
  if (k === "MG_COLDBOLT" || k === "MG_FROSTDIVER") return "shard";
  if (k === "MG_LIGHTNINGBOLT" || k === "MG_THUNDERSTORM") return "bolt";
  if (k === "SM_MAGNUM" || k.startsWith("MG_FIRE")) return "flame";
  if (k === "MG_NAPALMBEAT" || k === "MG_SOULSTRIKE") return "orb";
  if (s.type === "Weapon" && s.target !== "Passive") return "sword";
  if (s.target === "Passive") return "star";
  if (s.type === "Magic") return "orb";
  return "star";
}
// painted icons: a 64 px atlas cut from Codex sheets by tools/art/build_ro.py skillicons(); skills missing from it keep the glyph
let skillAtlas: { size: number; cols: number; keys: Record<string, number>; img: HTMLImageElement } | undefined;
fetch("/icons/skills.json").then((r) => r.json()).then((a) => {
  const img = new Image();
  img.onload = () => { skillAtlas = { ...a, img }; iconCache.clear(); if (list.length) render(); };
  img.src = "/icons/skills.png";
}).catch(() => {});
function iconUrl(s: Skill) {
  const hit = iconCache.get(s.id);
  if (hit) return hit;
  const S = 48, cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  const cell = skillAtlas?.keys[s.key];
  if (skillAtlas && cell !== undefined) {
    const { size, cols, img } = skillAtlas;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, (cell % cols) * size, Math.floor(cell / cols) * size, size, size, 0, 0, S, S);
    const url = cv.toDataURL();
    iconCache.set(s.id, url);
    return url;
  }
  const ele = s.element[0] ?? "Neutral", [c1, c2] = ELE_COLOR[s.target === "Passive" ? "Neutral" : ele] ?? ELE_COLOR.Neutral;
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, c1); bg.addColorStop(1, c2);
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(2, 2, S - 4, S - 4, 9); g.fill();
  g.lineWidth = 2; g.strokeStyle = "rgba(30,34,52,0.65)"; g.stroke();
  g.fillStyle = "#fff"; g.strokeStyle = "rgba(20,22,40,0.75)"; g.lineWidth = 2.2; g.lineJoin = "round"; g.lineCap = "round";
  const path = (pts: number[][], close = true) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); g.stroke(); g.fill(); };
  switch (glyphOf(s)) {
    case "sword": path([[34, 9], [39, 9], [39, 14], [20, 33], [15, 28]]); path([[12, 27], [21, 36], [18, 39], [9, 30]]); path([[13, 35], [9, 39], [11, 41], [15, 37]]); break;
    case "flame": path([[24, 8], [33, 21], [35, 30], [30, 39], [24, 41], [17, 38], [13, 30], [16, 21], [20, 26]]); break;
    case "shard": path([[24, 7], [31, 22], [24, 41], [17, 22]]); path([[11, 18], [17, 24], [12, 33], [8, 25]]); path([[37, 18], [40, 25], [36, 33], [31, 24]]); break;
    case "bolt": path([[28, 7], [15, 26], [23, 26], [19, 41], [34, 20], [26, 20], [31, 7]]); break;
    case "orb": g.beginPath(); g.arc(24, 24, 11, 0, Math.PI * 2); g.stroke(); g.fill(); g.fillStyle = c2; g.beginPath(); g.arc(21, 21, 4, 0, Math.PI * 2); g.fill(); break;
    case "cross": path([[20, 9], [28, 9], [28, 20], [39, 20], [39, 28], [28, 28], [28, 39], [20, 39], [20, 28], [9, 28], [9, 20], [20, 20]]); break;
    case "coin": g.beginPath(); g.arc(24, 24, 13, 0, Math.PI * 2); g.stroke(); g.fill(); g.fillStyle = c2; g.font = "bold 16px Arial"; g.textAlign = "center"; g.fillText("Z", 24, 30); break;
    case "drop": path([[24, 8], [33, 25], [33, 31], [28, 39], [20, 39], [15, 31], [15, 25]]); break;
    case "arrow": path([[9, 39], [33, 15], [30, 12], [40, 8], [36, 18], [33, 15]], false); path([[12, 33], [15, 36], [10, 41], [7, 38]]); break;
    case "rain": for (const x of [14, 24, 34]) path([[x, 10], [x + 2, 10], [x + 2, 32], [x + 5, 32], [x + 1, 39], [x - 3, 32], [x, 32]]); break;
    case "book": path([[10, 13], [23, 16], [23, 38], [10, 35]]); path([[25, 16], [38, 13], [38, 35], [25, 38]]); break;
    default: path(Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 7 : 15; return [24 + Math.cos(a) * r, 25 + Math.sin(a) * r]; }));
  }
  const url = cv.toDataURL();
  iconCache.set(s.id, url);
  return url;
}
/** A skill icon element at `px` (24 on the shortcut bar), with a level badge when `lv` is given. */
export function skillIconEl(id: number, lv?: number, px = 32) {
  const s = SKILLS.get(id);
  const el = document.createElement("div");
  el.className = "icon skicon";
  el.style.width = el.style.height = `${px}px`;
  if (s) { el.style.backgroundImage = `url(${iconUrl(s)})`; el.style.backgroundSize = "100% 100%"; }
  if (lv) { const b = document.createElement("b"); b.textContent = String(lv); el.append(b); }
  return el;
}

// ---------- tooltip ----------
const learnedLv = (id: number) => list.find((r) => r.id === id)?.lv ?? 0;
const learnedMap = (): Learned => Object.fromEntries(list.filter((r) => r.lv > 0).map((r) => [r.id, r.lv]));
const secs = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;
function describe(id: number, useLv?: number): string {
  const s = SKILLS.get(id);
  if (!s) return "";
  const lv = useLv ?? learnedLv(id), shown = Math.max(1, lv), max = list.find((r) => r.id === id)?.maxLevel ?? s.maxLevel;
  const lines = [`<b>${s.name}</b> <span class="muted">Lv ${lv} / ${max}</span>`, SKILL_TEXT[s.key] ?? ""];
  const kind = s.target === "Passive" ? t("skill.passive") : !SKILL_USE[s.key] ? t("ui.not_available_yet") : s.target === "Self" ? t("skill.self") : s.target === "Support" ? t("skill.ally") : s.target === "Ground" ? t("skill.ground") : t("skill.enemy");
  if (s.target === "Passive" || !SKILL_USE[s.key]) lines.push(`<span class="muted">${kind}</span>`);
  else {
    const c = skillCost(s, shown), cast = own ? castTime(s, shown, { dex: own.dex, int: own.int }) : skillLv(s.castTime, shown);
    const range = skillRange(s, shown, learnedMap()), cd = skillCooldown(s, shown);
    const bits = [t("skill.target", { kind }), c.sp ? `SP ${c.sp}` : "", c.zeny ? `${c.zeny} z` : "", c.hp ? `HP ${c.hp}` : "",
      range ? t("item.range", { n: range }) : "", cast ? t("skill.cast", { s: secs(cast) }) : t("skill.instant"), cd ? t("skill.cooldown", { s: secs(cd) }) : ""].filter(Boolean);
    lines.push(`<span class="muted">${lv ? `Lv ${shown}: ` : "Lv 1: "}${bits.join(" · ")}</span>`);
    if (s.weapons) lines.push(`<span class="muted">${t("skill.needs")} ${s.weapons.length > 6 ? t("skill.most_weapons") : s.weapons.join(", ")}${s.ammo ? ` + ${s.ammo.join("/")}` : ""}</span>`);
  }
  const row = treeRows(job).find((r) => r.id === id);
  if (row?.requires.length) lines.push(`<span class="muted">${t("skill.requires")} ${row.requires.map((q) => `${SKILLS.get(q.id)?.name ?? q.id} Lv ${q.level}`).join(", ")}</span>`);
  return lines.filter(Boolean).join("<br>");
}
/** Hover tooltip of a skill (window tile or shortcut slot): shares the item tooltip box (#item-tip). */
export function skillTip(el: HTMLElement, id: number, lv?: number) {
  el.addEventListener("pointerenter", (e) => {
    const t = $("item-tip");
    t.innerHTML = describe(id, lv);
    t.hidden = false;
    t.style.left = `${Math.min(innerWidth - 240, e.clientX + 14)}px`;
    t.style.top = `${Math.min(innerHeight - 140, e.clientY + 12)}px`;
  });
  el.addEventListener("pointerleave", () => ($("item-tip").hidden = true));
}

// ---------- the window ----------
function render() {
  const win = $("w-skill");
  if (!win || win.hidden) return;
  const trees = treeChain(job); // 2.5.0: Novice, the first job, the 2nd job (and the trans job) each get a tab
  if (!tab || !trees.includes(tab)) tab = trees[trees.length - 1];
  const tabs = $("sk-tabs");
  tabs.innerHTML = "";
  for (const t of trees) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = JOBS[t as JobKey]?.name ?? t;
    b.classList.toggle("on", t === tab);
    b.addEventListener("click", () => { tab = t; render(); play("sfx", "click", 0.3); });
    tabs.append(b);
  }
  const learned = learnedMap();
  const avail = own ? skillTree(job, learned, own.level, own.jobLevel).known : new Set<number>();
  const before = new Set(trees.slice(0, trees.indexOf(tab)).flatMap((t) => treeRows(t).map((r) => r.id))); // rows of the earlier tabs
  const own_ = new Set(treeRows(tab).map((r) => r.id).filter((id) => !before.has(id)));
  const grid = $("sk-grid");
  grid.innerHTML = "";
  for (const r of list.filter((x) => own_.has(x.id))) {
    const s = SKILLS.get(r.id);
    if (!s) continue;
    const tile = document.createElement("div");
    tile.className = "sk-tile";
    tile.classList.toggle("locked", r.lv === 0 && !avail.has(r.id));
    tile.classList.toggle("passive", s.target === "Passive");
    tile.classList.toggle("later", !!r.later); // not working yet: greyed, no + button, the server refuses points too
    if (r.later) tile.dataset.later = r.upgradable || r.lv > 0 ? "Effect later" : "Coming later"; // 2.5.0: a prerequisite stand-in takes points
    const ic = skillIconEl(r.id, undefined, 34);
    const lvl = document.createElement("span");
    lvl.className = "sk-lv";
    lvl.textContent = `${r.lv}/${r.maxLevel}`;
    const name = document.createElement("span");
    name.className = "sk-name";
    name.textContent = s.name;
    tile.append(ic, lvl, name);
    if (r.upgradable) {
      const up = document.createElement("button");
      up.type = "button";
      up.className = "sk-up";
      up.title = t("skill.raise");
      up.textContent = "+";
      up.addEventListener("click", (e) => { e.stopPropagation(); hooks.skillUp(r.id); play("sfx", "click", 0.45); });
      tile.append(up);
    }
    skillTip(tile, r.id);
    if (r.lv > 0 && s.target !== "Passive") {
      tile.draggable = true;
      tile.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/skill", String(skillHotkey(r.id, r.lv))); $("item-tip").hidden = true; });
      tile.addEventListener("dblclick", () => beginSkill(r.id, r.lv));
    }
    grid.append(tile);
  }
  $("sk-points").textContent = t("skill.points", { n: points });
}

const listeners: (() => void)[] = [];
/** Called after every Msg.skills (quest tasks that read a skill level re-check, ui/quests.ts). */
export const onSkillsChanged = (fn: () => void) => { listeners.push(fn); };
/** Learned level of a skill by its key (SM_BASH ...) from the last list. */
export const learnedByKey = (key: string) => { const id = SKILL_ID[key]; return id === undefined ? 0 : learnedLv(id); };
/** Open the Skill Tree window (a quest task's click). */
export function openSkills() { toggle($("w-skill"), true); render(); }
export function setSkills(m: SkillsEvent) {
  const gained = m.points > points && list.length > 0;
  list = m.list; points = m.points;
  render();
  // the window shortcut under the minimap carries the points left, like the original's "skill points available" notice
  const ico = document.querySelector<HTMLElement>('#menu-icons .mico[data-win="w-skill"]');
  if (ico) { if (points > 0 && m.list.some((r) => r.upgradable)) ico.dataset.badge = String(points); else delete ico.dataset.badge; }
  for (const fn of listeners) fn();
  if (gained) hooks.log(t("skill.points_log", { count: points }));
}
/** Msg.status + my synced job: the tooltip's cast time reads DEX / INT, the window's tabs the job. */
export function setSkillOwner(st: StatusEvent | undefined, myJob: string | undefined) {
  const j = (myJob && myJob in JOBS ? myJob : "Novice") as JobKey;
  const changed = j !== job || st?.level !== own?.level || st?.jobLevel !== own?.jobLevel;
  own = st;
  if (j !== job) tab = undefined;
  job = j;
  if (changed) render();
}
export const skillPoints = () => points;
/** The last Msg.skills (dev hook / shots). */
export const skillState = () => ({ list, points });

// ---------- using a skill ----------
let pending: { id: number; lv: number; at: number } | undefined;
/** The armed skill waiting for its target click (main.ts reads it on pointerdown). */
export const pendingSkill = () => pending;
export function clearPending() {
  pending = undefined;
  document.body.classList.remove("skill-cursor");
}
/** Start a use from a shortcut slot or the window: self skills fire now; the others arm the targeting cursor. Using the same
 *  support skill again while armed casts it on yourself (the original's double tap). */
export function beginSkill(id: number, lv: number) {
  const s = SKILLS.get(id);
  if (!s) return;
  const have = learnedLv(id);
  if (have <= 0) { hooks.log(t("skill.not_learned", { name: s.name })); play("sfx", "error", 0.5); return; }
  lv = Math.min(lv || have, have);
  if (s.target === "Passive") { hooks.log(t("skill.is_passive", { name: s.name })); return; }
  if (!SKILL_USE[s.key]) { hooks.log(t("skill.unavailable", { name: s.name })); play("sfx", "error", 0.5); return; }
  const cd = cooldowns.get(id);
  if (cd && performance.now() < cd[1]) { hooks.log(t("skill.not_ready", { name: s.name })); play("sfx", "error", 0.4); return; }
  if (s.target === "Self") { clearPending(); hooks.use(id, lv); return; }
  if (pending?.id === id && s.target === "Support") { clearPending(); hooks.use(id, lv, {}); return; } // twice = on yourself
  pending = { id, lv, at: performance.now() };
  document.body.classList.add("skill-cursor");
  play("sfx", "click", 0.35);
}

// ---------- delays and cooldowns (shown on shortcut slots holding the skill) ----------
export function skillDelay(m: SkillDelayEvent) {
  const now = performance.now();
  if (m.delayMs > 0) { canactFrom = now; canactUntil = now + m.delayMs; }
  if (m.cooldownMs > 0) cooldowns.set(m.id, [now, now + m.cooldownMs]);
}
/** Every frame: a dark sweep over shortcut slots whose skill can't be used yet (data-skill set by ui/items.ts). */
export function updateSkillShades(now: number) {
  for (const cell of document.querySelectorAll<HTMLElement>(".slotcell[data-skill]")) {
    const id = Number(cell.dataset.skill), cd = cooldowns.get(id);
    let from = 0, to = 0;
    if (cd && now < cd[1]) [from, to] = cd;
    if (now < canactUntil && canactUntil > to) [from, to] = [canactFrom, canactUntil];
    const left = to > now ? (to - now) / Math.max(1, to - from) : 0;
    const v = left > 0 ? `${Math.round(left * 360)}deg` : "";
    if (cell.style.getPropertyValue("--cd") !== v) cell.style.setProperty("--cd", v);
    cell.classList.toggle("cooling", left > 0);
  }
}

export function resetSkills() { list = []; points = 0; own = undefined; job = "Novice"; tab = undefined; cooldowns.clear(); canactUntil = 0; clearPending(); }

export function initSkills(h: SkillHooks) {
  hooks = h;
  $("btn-skill").addEventListener("click", () => { toggle($("w-skill")); render(); });
  addEventListener("keydown", (e) => {
    if ((e.target instanceof Element && e.target.closest("input")) || document.body.dataset.screen !== "game") return;
    if (e.altKey && e.code === "KeyS") { e.preventDefault(); toggle($("w-skill")); render(); }
    else if (e.key === "Escape" && pending) { e.stopImmediatePropagation(); clearPending(); }
  }, { capture: true });
}
