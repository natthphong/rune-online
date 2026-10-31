// Quests on the client: the quest window (Alt+U, RO's quest list + details), the always-visible tracker on the right with
// live objective counts (click = auto-walk to the targets or the NPC to report to, client/src/navi.ts), "!" / "?" marks
// over NPC heads (the server's questinfo / showevent icons), and the reward feed for quest EXP / zeny / items.
// The server owns the quest log (snapshots in Msg.quests, never in the shared room state); this only renders it.
import "./quests.css";
import * as THREE from "three";
import { Callbacks, type Room } from "@colyseus/sdk";
import { Msg, type ExpEvent, type ItemGetEvent, type QuestLogEvent, type QuestMarkEvent, type StatusEvent, type ZenyEvent } from "../../../shared/protocol.ts";
import { QUEST_DB, QUEST_INFO } from "../../../shared/content/quest_db.ts";
import { taskProgress, type QuestTask, type TaskView } from "../../../shared/content/tasks.ts";
import { MOBS, MOB_BY_ID } from "../../../shared/rules/data.ts";
import { ITEMS } from "../../../shared/rules/items.ts";
import { itemNamed, objectiveMatches, questKillOf, questTimeLeft, type QuestObjective } from "../../../shared/rules/quest.ts";
import { QTYPE } from "../../../shared/rules/script.ts";
import { type GameMap } from "../../../shared/map.ts";
import { NPC_HOMES, mapOfState } from "../../../shared/maps.ts";
import { heightAt } from "../world.ts";
import { play } from "../audio.ts";
import { onNavi, setNaviLog, setNaviRoom, startNavi, stopNavi, tickNavi } from "../navi.ts";
import { dialogOpen } from "./dialog.ts";
import { getInventory, iconEl } from "./items.ts";
import { banner, log, setMinimapQuestSource } from "./hud.ts";
import { toggle } from "./windows.ts";
import { learnedByKey, onSkillsChanged, openSkills } from "./skills.ts";
import { applyI18n, onLangChange, t as tr } from "../i18n.ts"; // aliased: `t` is a local name all over this file

type Entry = QuestLogEvent["quests"][number];
/** One line of a quest: a kill target, an item to bring or a task (shared/content/tasks.ts); `label` replaces "have/need". */
type Obj = { text: string; have: number; need: number; done: boolean; nav: () => void; label?: string };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const hud = document.getElementById("hud") ?? document.body;

// ---------- DOM ----------
const tracker = el("section"); tracker.id = "quest-tracker"; tracker.hidden = true;
const head = el("div", "qt-head"), fold = el("button", "", "–");
fold.type = "button";
head.append(el("span", "", tr("quest.quests")), fold);
const trackList = el("div");
tracker.append(head, trackList);
const win = el("section", "win"); win.id = "w-quest"; win.hidden = true;
win.innerHTML = `<header class="win-title"><span data-i18n="quest.title">Quest</span><button data-close title="Close (Alt+U)" data-i18n-title="quest.close">×</button></header>
  <div class="win-body"><ul class="q-list"></ul><div class="q-detail"></div></div>`;
const qList = win.querySelector<HTMLUListElement>(".q-list")!, qDetail = win.querySelector<HTMLDivElement>(".q-detail")!;
const feed = el("div"); feed.id = "reward-feed";
const naviLabel = el("div"); naviLabel.id = "navi-label"; naviLabel.hidden = true;
hud.append(tracker, win, feed, naviLabel);
const marksLayer = document.getElementById("labels") ?? document.body;

// the Quest button in the Basic Info menu (next to Status / Items / Equip ...)
const menu = document.getElementById("bi-menu");
if (menu && !document.getElementById("btn-quest")) {
  const b = el("button");
  b.type = "button"; b.id = "btn-quest"; b.title = tr("ui.quest_alt_u");
  b.innerHTML = `<svg viewBox="0 0 20 20"><path d="M5 3.5h9.5a2 2 0 0 1 0 4H14v8.5a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 16V5.5a2 2 0 0 1 2-2z"/><path d="M6 7.5h5M6 10.5h5M6 13.5h3.5"/></svg>${tr("quest.title")}`;
  b.addEventListener("click", () => toggleWindow());
  menu.append(b);
}

// ---------- state ----------
let room: Room | undefined;
let quests: Entry[] = [];
let own: StatusEvent | undefined; // my own numbers (Msg.status): what the quest tasks read
let first = true; // the login snapshot is not news
let selected: number | undefined;
let map: GameMap | undefined, seed = -1;
const marks = new Map<string, { el: HTMLDivElement; icon: number }>();
let folded = false;
try { folded = localStorage.getItem("ro.ui.questFold") === "1"; } catch { /* private mode */ }
tracker.classList.toggle("folded", folded);

const S = () => room?.state as any;
const npcName = (id?: string) => (id ? String(S()?.npcs?.get(id)?.name ?? NPC_HOMES[id]?.name ?? id) : "");
const nowSec = () => Math.floor(Date.now() / 1000);
const invCount = (itemId: number) => getInventory().items.filter((s) => s.itemId === itemId).reduce((n, s) => n + s.amount, 0);

/** Monsters an objective counts (a Mob target, or every monster passing the Id target's filters). */
function targetMobs(o: QuestObjective): number[] {
  if (o.mobId) return [o.mobId];
  return MOBS.filter((m) => objectiveMatches(o, questKillOf(m), "")).map((m) => m.id); // map filter: any
}
function filterName(o: QuestObjective) {
  const parts = [o.race !== "All" && o.race, o.size !== "All" && o.size, o.element !== "All" && o.element].filter(Boolean);
  const lv = o.maxLevel ? ` Lv ${o.minLevel}-${o.maxLevel}` : o.minLevel ? ` Lv ${o.minLevel}+` : "";
  return tr("quest.monsters", { what: parts.join(" ") || tr("quest.any"), lv });
}

/** The objectives of a held quest: its kill targets (quest_db Targets + live counters) and the items to bring (Info.Items,
 *  counted in the inventory snapshot), each with where to go. */
function objectives(e: Entry): Obj[] {
  const def = QUEST_DB.get(e.id), info = QUEST_INFO.get(e.id);
  const out: Obj[] = [];
  def?.objectives.forEach((o, j) => {
    const name = o.mobId ? MOB_BY_ID.get(o.mobId)?.name ?? "?" : filterName(o);
    const have = Math.min(e.count[j] ?? 0, o.count);
    out.push({ text: tr("quest.defeat", { name }), have, need: o.count, done: have >= o.count,
      nav: () => startNavi({ kind: "mob", mobIds: targetMobs(o), fallback: info?.Navi }, name) });
  });
  for (const it of info?.Items ?? []) {
    const item = itemNamed(it.Item);
    if (!item) continue;
    const have = Math.min(invCount(item.id), it.Count);
    // monsters that drop it (mob_db) plus the quest's own Drops
    const from = new Set([...MOBS.filter((m) => m.drops?.some((d) => d.item === item.id)).map((m) => m.id),
      ...(def?.drops ?? []).filter((d) => d.itemId === item.id && d.mobId).map((d) => d.mobId)]);
    out.push({ text: tr("quest.collect", { name: item.name }), have, need: it.Count, done: have >= it.Count,
      nav: () => startNavi({ kind: "mob", mobIds: [...from], fallback: info?.Navi }, item.name) });
  }
  for (const t of info?.Tasks ?? []) {
    const p = taskProgress(t, taskView());
    out.push({ text: t.Text, ...p, nav: () => taskNav(t, info?.Navi), label: "HpFull" in t && !p.done ? `${Math.floor((100 * p.have) / Math.max(1, p.need))}%` : undefined });
  }
  return out;
}

/** The character as quest tasks read it: my own numbers (Msg.status) and the bag (worn rows = equipped). */
function taskView(): TaskView {
  const inv = getInventory();
  const idOf = (ref: string | number) => itemNamed(ref)?.id;
  return {
    statusPoint: own?.statPoints ?? 0, baseLevel: own?.level ?? 0, hp: own?.hp ?? 0, maxHp: own?.maxHp ?? 0,
    jobLevel: own?.jobLevel ?? 0, skillLv: learnedByKey, // C04: JobLevel / Skill tasks (the last Msg.skills list)
    countitem: (ref) => { const id = idOf(ref); return inv.items.filter((s) => s.itemId === id).reduce((n, s) => n + s.amount, 0); },
    isequipped: (ref) => { const id = idOf(ref); return inv.items.some((s) => s.itemId === id && !!s.equip); },
  };
}
/** Clicking a task: walk to a place, or open the window the task is done in. */
function taskNav(t: QuestTask, navi?: { x: number; y: number; map?: string }) {
  if ("Visit" in t) return startNavi({ kind: "cell", x: t.Visit.X, y: t.Visit.Y, within: 1, map: t.Visit.Map }, t.Text);
  if ("StatusPoint" in t) return openWin("w-status");
  if ("Skill" in t) return openSkills(); // the Skill Tree window (Alt+S)
  if ("Equip" in t || "Use" in t) return openWin("w-inv");
  if ("HpFull" in t) return log("system", tr("quest.sit_hint"));
  if (navi) startNavi({ kind: "cell", x: navi.x, y: navi.y, within: 3, map: navi.map }, t.Text);
}
function openWin(id: string) { const w = document.getElementById(id); if (w) toggle(w, true); }
const isReady = (e: Entry) => objectives(e).every((o) => o.done);
const titleOf = (id: number) => QUEST_DB.get(id)?.title ?? tr("quest.n", { id });

/** Click on a tracked quest: walk to the next thing to do. */
function navigate(e: Entry) {
  const info = QUEST_INFO.get(e.id);
  const open = objectives(e).find((o) => !o.done);
  if (open) open.nav();
  else if (info?.Report) startNavi({ kind: "npc", id: info.Report }, npcName(info.Report));
  play("sfx", "click", 0.4);
}

// ---------- tracker ----------
/** "!" icons (new work, questinfo / showevent): QTYPE QUEST / JOB / EVENT / DAILY / JOBQUEST. */
const OFFER = new Set<number>([QTYPE.QUEST, QTYPE.JOB, QTYPE.EVENT, QTYPE.EVENT3, QTYPE.DAILYQUEST, QTYPE.JOBQUEST]);
function renderTracker() {
  const shown = quests.filter((q) => q.state === 1);
  const offers = [...marks].filter(([id, m]) => OFFER.has(m.icon) && S()?.npcs?.get(id));
  tracker.hidden = !room || (!shown.length && !offers.length);
  trackList.textContent = "";
  // NPCs with new work for you come first: the next step is always on screen, even with an empty quest log
  for (const [id] of offers.slice(0, 2)) {
    const box = el("div", "qt-quest offer");
    const t = el("div", "qt-title");
    t.append(npcName(id));
    box.append(t, el("div", "qt-obj report", tr("quest.talk_work", { name: npcName(id) })));
    box.title = tr("quest.click_talk");
    box.addEventListener("click", () => { startNavi({ kind: "npc", id }, npcName(id)); play("sfx", "click", 0.4); });
    trackList.append(box);
  }
  // the story chain first (RO3's [Main Quest] line), then the rest in log order
  const main = (q: Entry) => (QUEST_INFO.get(q.id)?.Type === "Main" ? 0 : 1);
  for (const e of [...shown].sort((a, b) => main(a) - main(b)).slice(0, 4)) {
    const box = el("div", "qt-quest");
    box.dataset.id = String(e.id);
    const t = el("div", "qt-title");
    const objs = objectives(e), info = QUEST_INFO.get(e.id);
    if (info?.Type === "Main") t.append(el("span", "qt-tag", tr("quest.main")), " ");
    t.append(titleOf(e.id));
    box.append(t);
    if (objs.length && objs.every((o) => o.done) && info?.Report) box.append(el("div", "qt-obj report", tr("quest.report_to", { name: npcName(info.Report) })));
    else if (!objs.length) box.append(el("div", "qt-obj report", info?.Summary ?? (info?.Report ? tr("quest.talk_to", { name: npcName(info.Report) }) : "")));
    for (const o of objs) {
      if (objs.every((x) => x.done) && info?.Report) break;
      const line = el("div", o.done ? "qt-obj done" : "qt-obj", o.text);
      line.append(el("b", "", o.label ?? `${o.have}/${o.need}`));
      box.append(line);
    }
    box.title = tr("quest.click_go");
    box.addEventListener("click", () => navigate(e));
    trackList.append(box);
  }
}
fold.addEventListener("click", () => {
  folded = !folded;
  tracker.classList.toggle("folded", folded);
  paintFold();
onLangChange(() => { applyI18n(win); head.firstElementChild!.textContent = tr("quest.quests"); paintFold(); renderTracker(); renderWindow(); });
  try { localStorage.setItem("ro.ui.questFold", folded ? "1" : "0"); } catch { /* private mode */ }
});
function paintFold() { fold.textContent = folded ? tr("quest.quests") + " ▾" : "▴"; fold.title = tr(folded ? "quest.show_tracker" : "quest.hide_tracker"); }
paintFold();
onLangChange(() => { applyI18n(win); head.firstElementChild!.textContent = tr("quest.quests"); paintFold(); renderTracker(); renderWindow(); });
function flash(id: number) {
  const box = trackList.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (!box) return;
  box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
}

// ---------- quest window ----------
function toggleWindow(show?: boolean) {
  toggle(win, show ?? win.hidden);
  if (!win.hidden) renderWindow();
}
function renderWindow() {
  if (win.hidden) return;
  qList.textContent = "";
  if (selected !== undefined && !quests.some((q) => q.id === selected)) selected = undefined;
  selected ??= quests[0]?.id;
  if (!quests.length) { qList.append(el("li", "q-empty", tr("quest.empty"))); qDetail.textContent = ""; return; }
  for (const e of quests) {
    const li = el("li");
    li.classList.toggle("on", e.id === selected);
    li.classList.toggle("off", e.state !== 1);
    const chk = el("input");
    chk.type = "checkbox"; chk.checked = e.state === 1; chk.title = tr("quest.show_in_tracker");
    chk.addEventListener("click", (ev) => { ev.stopPropagation(); room?.send(Msg.questActive, { id: e.id, active: chk.checked }); });
    const objs = objectives(e), ready = objs.length > 0 && objs.every((o) => o.done);
    const prog = el("span", ready ? "q-prog ready" : "q-prog", ready ? tr("quest.ready") : objs.length ? objs.map((o) => `${o.have}/${o.need}`).join(" ") : "");
    const name = el("span", "q-name");
    if (QUEST_INFO.get(e.id)?.Type === "Main") name.append(el("span", "qt-tag", tr("quest.main")), " ");
    name.append(titleOf(e.id));
    li.append(chk, name, prog);
    li.addEventListener("click", () => { selected = e.id; renderWindow(); });
    li.addEventListener("dblclick", () => navigate(e));
    qList.append(li);
  }
  const e = quests.find((q) => q.id === selected)!;
  const info = QUEST_INFO.get(e.id);
  qDetail.textContent = "";
  qDetail.append(el("div", "q-title", titleOf(e.id)));
  for (const p of info?.Description ?? [info?.Summary ?? ""]) qDetail.append(el("p", "q-desc", p));
  const objs = objectives(e);
  if (objs.length) {
    const sec = el("div", "q-sec");
    sec.append(el("h4", "", tr("quest.objectives")));
    for (const o of objs) {
      const row = el("div", o.done ? "q-row done" : "q-row");
      const go = el("a", "", o.text);
      go.title = tr("quest.walk_there");
      go.addEventListener("click", () => { o.nav(); play("sfx", "click", 0.4); });
      row.append(go, el("span", "", o.label ?? `${o.have} / ${o.need}`));
      sec.append(row);
    }
    qDetail.append(sec);
  }
  if (info?.Report) {
    const sec = el("div", "q-sec"), row = el("div", "q-row"), go = el("a", "", npcName(info.Report));
    go.addEventListener("click", () => { startNavi({ kind: "npc", id: info.Report! }, npcName(info.Report)); play("sfx", "click", 0.4); });
    row.append(go);
    sec.append(el("h4", "", tr("quest.report_h")), row);
    qDetail.append(sec);
  }
  const rw = el("div", "q-rewards");
  if (info?.RewardEXP) rw.append(el("span", "", `Base EXP ${info.RewardEXP.toLocaleString()}`));
  if (info?.RewardJEXP) rw.append(el("span", "", `Job EXP ${info.RewardJEXP.toLocaleString()}`));
  if (info?.RewardZeny) rw.append(el("span", "", `${info.RewardZeny.toLocaleString()} z`));
  for (const it of info?.RewardItems ?? []) {
    const item = itemNamed(it.Item);
    if (!item) continue;
    const s = el("span");
    s.append(iconEl(item.id), `${item.name} ×${it.Count}`);
    rw.append(s);
  }
  if (rw.childElementCount) { const sec = el("div", "q-sec"); sec.append(el("h4", "", tr("quest.rewards")), rw); qDetail.append(sec); }
  if (e.time > 0) {
    const left = questTimeLeft(e, nowSec());
    qDetail.append(el("div", "q-time", left ? tr("quest.time_left", { h: Math.floor(left / 3600), m: Math.floor((left % 3600) / 60), s: left % 60 }) : tr("quest.time_up")));
  }
}
addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea") || document.body.dataset.screen !== "game") return;
  if (e.altKey && e.code === "KeyU") { e.preventDefault(); toggleWindow(); }
});

// ---------- marks over NPC heads (questinfo / showevent) ----------
const GLYPH: Record<number, [string, string]> = { // icon -> glyph, colour
  [QTYPE.QUEST]: ["!", "#ffcf3a"], [QTYPE.QUEST2]: ["?", "#ffcf3a"], [QTYPE.JOB]: ["!", "#7ee05a"], [QTYPE.JOB2]: ["?", "#7ee05a"],
  [QTYPE.EVENT]: ["!", "#ff9a4a"], [QTYPE.EVENT2]: ["?", "#ff9a4a"], [QTYPE.EVENT3]: ["!", "#ff9a4a"], [QTYPE.DAILYQUEST]: ["!", "#7fc8ff"],
  [QTYPE.JOBQUEST]: ["!", "#7ee05a"], [QTYPE.CLICKME]: ["…", "#ffffff"], [QTYPE.JUMPING_BLOB]: ["!", "#ff9ec4"],
};
function markSvg(icon: number) {
  const [g, c] = GLYPH[icon] ?? ["!", "#ffcf3a"];
  return `<svg viewBox="0 0 26 32"><path d="M13 1.5c6.4 0 11.5 4.6 11.5 10.6 0 5.4-4.3 9.8-9.9 10.5L13 30.5l-1.6-7.9C5.8 21.9 1.5 17.5 1.5 12.1 1.5 6.1 6.6 1.5 13 1.5z"
    fill="${c}" stroke="#3a2600" stroke-width="1.6"/><path d="M6 8.5c1.4-2.6 4-4.1 7-4.1" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-linecap="round"/>
    <text x="13" y="17.6" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="15" fill="#3a2600"
    stroke="#fff" stroke-width="2.4" paint-order="stroke">${g}</text></svg>`;
}
// the minimap marks an NPC with new work for you (any quest mark, in its colour) with a pulsing diamond
setMinimapQuestSource((id) => { const m = marks.get(id); return m ? GLYPH[m.icon]?.[1] ?? "#ffcf3a" : undefined; });
function onMark(m: QuestMarkEvent) {
  const cur = marks.get(m.npc);
  if (m.icon === QTYPE.NONE) { cur?.el.remove(); marks.delete(m.npc); renderTracker(); return; }
  if (cur && cur.icon === m.icon) return;
  const div = cur?.el ?? el("div", "quest-mark");
  div.innerHTML = markSvg(m.icon);
  marksLayer.append(div);
  marks.set(m.npc, { el: div, icon: m.icon });
  renderTracker();
}
const tmp = new THREE.Vector3();
function placeMarks(camera: THREE.Camera) {
  const npcs = S()?.npcs;
  if (!npcs || !marks.size) return;
  map = mapOfState(S()); // C08: the room's own map (field or town)
  for (const [id, mk] of marks) {
    const n = npcs.get(id);
    if (!n || !map) { mk.el.style.display = "none"; continue; }
    tmp.set(n.x, heightAt(map, n.x, n.y) + 2.15, n.y).project(camera);
    mk.el.style.display = tmp.z < 1 ? "" : "none";
    mk.el.style.left = `${(tmp.x * 0.5 + 0.5) * innerWidth}px`;
    mk.el.style.top = `${(-tmp.y * 0.5 + 0.5) * innerHeight}px`;
  }
}

// ---------- reward feed ----------
const STAR = `<svg viewBox="0 0 20 20"><path d="M10 1.8l2.4 5.3 5.8.6-4.3 3.9 1.2 5.7L10 14.4l-5.1 2.9 1.2-5.7L1.8 7.7l5.8-.6z" fill="#ffd65a" stroke="#5a3d00"/></svg>`;
const JSTAR = `<svg viewBox="0 0 20 20"><path d="M10 1.8l2.4 5.3 5.8.6-4.3 3.9 1.2 5.7L10 14.4l-5.1 2.9 1.2-5.7L1.8 7.7l5.8-.6z" fill="#8fd0ff" stroke="#1b3d63"/></svg>`;
const COIN = `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.6" fill="#f2c94c" stroke="#7a5200" stroke-width="1.4"/><circle cx="10" cy="10" r="4.6" fill="none" stroke="#a87400" stroke-width="1.2"/></svg>`;
const SCROLL = `<svg viewBox="0 0 20 20"><path d="M5 3.5h9.5a2 2 0 0 1 0 4H14v8.5a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 16V5.5a2 2 0 0 1 2-2z" fill="#f4e3b5" stroke="#6b4a12" stroke-width="1.3"/></svg>`;
function feedRow(icon: string | HTMLElement, label: string, amount?: number, cls = "") {
  const row = el("div", `rf-row ${cls}`.trim()), ic = el("span", "rf-ic");
  if (typeof icon === "string") ic.innerHTML = icon; else ic.append(icon);
  row.append(ic, label);
  if (amount !== undefined) row.append(" ", el("em", "", `× ${amount.toLocaleString()}`));
  feed.append(row);
  while (feed.childElementCount > 7) feed.firstElementChild!.remove();
  setTimeout(() => row.remove(), 5200);
}

// ---------- server -> client ----------
function onQuests(m: QuestLogEvent) {
  const before = new Map(quests.map((q) => [q.id, q]));
  quests = m.quests;
  doneIds = new Set(m.done ?? []);
  for (const f of logListeners) queueMicrotask(f);
  if (!first) {
    for (const q of quests) {
      const old = before.get(q.id);
      if (!old) {
        feedRow(SCROLL, tr("quest.new", { title: titleOf(q.id) }), undefined, "quest");
        log("system", tr("quest.log_new", { title: titleOf(q.id) }));
        play("sfx", "ui_open", 0.6);
        setTimeout(() => flash(q.id), 50);
      } else if (q.count.some((c, j) => c !== old.count[j]) && isReady(q) && !isReady(old)) {
        const info = QUEST_INFO.get(q.id);
        log("system", tr("quest.log_done", { title: titleOf(q.id), report: info?.Report ? tr("quest.report_to", { name: npcName(info.Report) }) + "." : "" }));
        play("sfx", "levelup", 0.45);
        setTimeout(() => flash(q.id), 50);
      }
    }
    for (const [id] of before) if (!quests.some((q) => q.id === id)) {
      banner(tr("quest.complete"), titleOf(id));
      feedRow(SCROLL, tr("quest.complete_feed", { title: titleOf(id) }), undefined, "quest");
      log("system", tr("quest.log_complete", { title: titleOf(id) }));
    }
  }
  first = false;
  renderTracker();
  renderWindow();
}
let invTimer = 0;
function onInv() { // collect objectives follow the bag
  clearTimeout(invTimer);
  invTimer = window.setTimeout(() => {
    const ready = quests.filter(isReady).map((q) => q.id);
    renderTracker();
    renderWindow();
    for (const id of ready) if (!readyBefore.has(id)) { flash(id); const info = QUEST_INFO.get(id); if (info?.Items?.length || info?.Tasks?.length) log("system", tr("quest.log_done", { title: titleOf(id), report: info.Report ? tr("quest.report_to", { name: npcName(info.Report) }) + "." : "" })); }
    readyBefore = new Set(ready);
  }, 60);
}
let readyBefore = new Set<number>();
/** My own numbers changed: quest tasks that read them (status points, HP, base level) follow, like the bag-based ones. */
function onStatus(m: StatusEvent) {
  const before = own;
  own = m;
  if (before && before.statPoints === m.statPoints && before.hp === m.hp && before.maxHp === m.maxHp && before.level === m.level && before.jobLevel === m.jobLevel) return;
  if (quests.some((q) => QUEST_INFO.get(q.id)?.Tasks?.length)) onInv();
}

setNaviLog(log);
onSkillsChanged(() => { if (quests.some((q) => QUEST_INFO.get(q.id)?.Tasks?.length)) onInv(); }); // Skill tasks read the list
onNavi((active, what) => {
  naviLabel.hidden = !active;
  naviLabel.textContent = tr("quest.navigating");
  if (active && what) naviLabel.append(el("small", "", what));
});

// ---------- public ----------
const logListeners: (() => void)[] = [];
let doneIds = new Set<number>();
/** A quest's state in my log (rAthena Q_INACTIVE 0 / Q_ACTIVE 1 / Q_COMPLETE 2; completed ones come in the snapshot's `done`). */
export const questStateOf = (id: number) => (doneIds.has(id) ? 2 : quests.find((q) => q.id === id)?.state ?? 0);
/** Called after every quest log snapshot (e.g. the sealed stair's glow follows quest 1018). */
export function onQuestLog(f: () => void) { logListeners.push(f); }
/** Listen to a room's quest messages and give navigation its room (call once per room, from enterWorld). */
export function bindQuests(r: Room) {
  room = r; quests = []; first = true; readyBefore = new Set(); own = undefined;
  setNaviRoom(r);
  r.onMessage(Msg.quests, onQuests);
  r.onMessage(Msg.questMark, onMark);
  r.onMessage(Msg.inv, onInv);
  r.onMessage(Msg.status, onStatus);
  r.onMessage(Msg.exp, (m: ExpEvent) => {
    if (!m.quest) return;
    if (m.base) feedRow(STAR, "Base EXP", m.base);
    if (m.job) feedRow(JSTAR, "Job EXP", m.job);
  });
  r.onMessage(Msg.zenyGet, (m: ZenyEvent) => { feedRow(COIN, "Zeny", m.amount); log("exp", `Received ${m.amount.toLocaleString()} zeny.`); });
  r.onMessage(Msg.itemGet, (m: ItemGetEvent) => { if (m.quest) feedRow(iconEl(m.itemId), ITEMS.get(m.itemId)?.name ?? "Item", m.amount); });
  Callbacks.get(r).onAdd("npcs", () => renderTracker()); // NPC names for "Report to ..."
}
/** Leaving the world: clear marks, windows, tracker and navigation. */
export function resetQuests() {
  for (const mk of marks.values()) mk.el.remove();
  marks.clear();
  quests = []; doneIds = new Set(); room = undefined; first = true;
  setNaviRoom(undefined);
  tracker.hidden = true; win.hidden = true; feed.textContent = ""; naviLabel.hidden = true;
}
/** Every frame: marks follow their NPC, navigation sends its next step. */
export function updateQuestUi(camera: THREE.Camera, now: number) {
  if (!room) return;
  placeMarks(camera);
  tickNavi(now, dialogOpen());
}
export { stopNavi };
