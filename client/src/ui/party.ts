// Party / Friends window (Alt+Z), party HP (minimap dots, a compact list, bars over members' heads), friend requests, whispers
// and party chat. The server owns all of it (server/src/party.ts + friends.ts, contract in shared/protocol.ts "Party (2.3.0"
// and "Friends + whisper (2.3.0"); this only renders the snapshots and sends intents. Layout: RO's Party/Friends window
// (two tabs, member rows with job/level/map and an HP gauge, a crown on the leader). Own skin, no original assets.
import "./party.css";
import type { Room } from "@colyseus/sdk";
import { Msg, type ChannelChatEvent, type FriendReqEvent, type FriendsEvent, type PartyEvent, type PartyInvitedEvent, type PartyMember,
  type PartyNoticeEvent, type PartyShare, type PartyUpdateEvent } from "../../../shared/protocol.ts";
import { JOBS } from "../../../shared/rules/data.ts";
import { MAP_INFO, type MapName } from "../../../shared/maps.ts";
import { toggle } from "./windows.ts";
import { log } from "./hud.ts";
import { play } from "../audio.ts";
import { challenge as challengeDuel, duelFoe } from "./duel.ts"; // 2.4.0: "Duel" in the player menu

type PartyData = NonNullable<PartyEvent["party"]>;
type Friend = FriendsEvent["list"][number];
import { applyI18n, onLangChange, t } from "../i18n.ts";
const hud = document.getElementById("hud") ?? document.body;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(text: string, title: string, on: () => void, cls = "") {
  const b = el("button", cls, text);
  b.type = "button"; b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); on(); play("sfx", "click", 0.35); });
  return b;
}
/** Keyed variants for static controls: the text / title / placeholder re-translate on a language switch (applyI18n(win)). */
function bk(textKey: string, titleKey: string, on: () => void, cls = "") {
  const b = btn(t(textKey), t(titleKey), on, cls);
  b.dataset.i18n = textKey; b.dataset.i18nTitle = titleKey;
  return b;
}
/** A text input that keeps its keys to itself (no hotkeys, no Enter-focuses-chat) and submits on Enter. */
function field(placeholder: string, max: number, submit: () => void) {
  const i = el("input");
  i.type = "text"; i.placeholder = placeholder; i.maxLength = max; i.autocomplete = "off"; i.spellcheck = false;
  i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); submit(); } else if (e.key === "Escape") i.blur(); });
  return i;
}

// ---------- DOM ----------
const win = el("section", "win"); win.id = "w-party"; win.hidden = true;
win.innerHTML = `<header class="win-title"><span data-i18n="party.title">Party / Friends</span><button data-close title="Close (Alt+Z)" data-i18n-title="party.close">×</button></header>
  <nav class="pt-tabs"><button type="button" data-tab="party" class="on" data-i18n="party.tab_party">Party</button><button type="button" data-tab="friends"><span data-i18n="party.tab_friends">Friends</span><i hidden></i></button></nav>
  <div class="win-body pt-pane" data-pane="party">
    <div class="pt-none"><p data-i18n="party.none">You are not in a party.</p><div class="pt-row"></div></div>
    <div class="pt-in" hidden>
      <div class="pt-head"><b class="pt-name"></b><span class="pt-count"></span></div>
      <ul class="pt-list"></ul>
      <div class="pt-opts"><label>EXP <select data-opt="exp"><option value="each" data-i18n="party.each">Each take</option><option value="even" data-i18n="party.even">Even share</option></select></label>
        <label><span data-i18n="party.items">Items</span> <select data-opt="item"><option value="each" data-i18n="party.each">Each take</option><option value="even" data-i18n="party.even">Even share</option></select></label></div>
      <div class="pt-row pt-invite"></div>
      <div class="pt-row pt-leave"></div>
    </div>
  </div>
  <div class="win-body pt-pane" data-pane="friends" hidden>
    <ul class="fr-list"></ul>
    <div class="pt-row fr-add"></div>
  </div>`;
const q = <T extends HTMLElement>(s: string) => win.querySelector<T>(s)!;
const createName = field(t("party.name_ph"), 23, () => createParty());
createName.dataset.i18nPlaceholder = "party.name_ph";
q(".pt-none .pt-row").append(createName, bk("ui.create", "party.create_tip", () => createParty()));
const inviteName = field(t("party.invite_ph"), 23, () => invite());
inviteName.dataset.i18nPlaceholder = "party.invite_ph";
q(".pt-invite").append(inviteName, bk("party.invite", "party.invite_tip", () => invite()));
q(".pt-leave").append(bk("party.leave", "party.leave_tip", () => room?.send(Msg.partyLeave)));
const friendName = field(t("party.friend_ph"), 23, () => addFriend());
friendName.dataset.i18nPlaceholder = "party.friend_ph";
q(".fr-add").append(friendName, bk("party.add", "party.add_tip", () => addFriend()));
const mini = el("div"); mini.id = "party-mini"; mini.hidden = true;
const popups = el("div"); popups.id = "pt-popups";
const ctx = el("div"); ctx.id = "pt-ctx"; ctx.hidden = true;
hud.append(win, mini, popups, ctx);
onLangChange(() => { applyI18n(win); renderParty(); renderFriends(); });

// the Party button in the Basic Info menu
const menu = document.getElementById("bi-menu");
if (menu && !document.getElementById("btn-party")) {
  const b = el("button");
  b.type = "button"; b.id = "btn-party"; b.title = t("ui.party_friends_alt_z");
  b.innerHTML = `<svg viewBox="0 0 20 20"><circle cx="7" cy="6.5" r="2.6"/><circle cx="14" cy="7.5" r="2.2"/><path d="M2 16c0-3.3 2.2-5 5-5s5 1.7 5 5zM12 12.2c.6-.2 1.2-.3 1.9-.3 2.4 0 4.1 1.4 4.1 4.1h-4.6"/></svg>${t("party.tab_party")}`;
  b.addEventListener("click", () => toggleWindow());
  menu.append(b);
}

// ---------- state ----------
let room: Room | undefined;
let party: PartyData | null = null;
let friends: Friend[] = [];
let lastFrom: string | undefined; // whisper partner for /r
let tab: "party" | "friends" = "party";

const myName = () => (import.meta.env.DEV && (window as any).__roPartyName) || String((room?.state as any)?.players?.get(room?.sessionId)?.name ?? "");
const me = () => party?.members.find((m) => m.name === myName());
const iLead = () => !!me()?.leader;
const jobName = (k: string) => (JOBS as Record<string, { name?: string }>)[k]?.name ?? k;
const mapTitle = (m: string) => MAP_INFO[m as MapName]?.title ?? m;
const pct = (m: { hp: number; maxHp: number }) => (m.maxHp > 0 ? Math.max(0, Math.min(1, m.hp / m.maxHp)) : 0);

function createParty() {
  const name = createName.value.trim();
  if (!name) { log("system", t("party.enter_name")); return; }
  room?.send(Msg.partyCreate, { name });
  createName.value = "";
}
function invite(name = inviteName.value.trim()) {
  if (!name) return;
  room?.send(Msg.partyInvite, { name });
  inviteName.value = "";
}
function addFriend(name = friendName.value.trim()) {
  if (!name) return;
  room?.send(Msg.friendAdd, { name });
  friendName.value = "";
}

// ---------- party tab ----------
const rows = new Map<number, { row: HTMLElement; fill: HTMLElement; num: HTMLElement; where: HTMLElement; mrow: HTMLElement; mfill: HTMLElement }>();
function renderParty() {
  const none = q(".pt-none"), inn = q(".pt-in");
  none.hidden = !!party; inn.hidden = !party;
  rows.clear();
  const list = q(".pt-list"), mlist = mini;
  list.textContent = ""; mlist.textContent = "";
  mini.hidden = !party;
  if (!party) return;
  q(".pt-name").textContent = party.name;
  q(".pt-count").textContent = t("party.online", { on: party.members.filter((m) => m.online).length, n: party.members.length });
  const lead = iLead();
  for (const k of ["exp", "item"] as const) { const s = q<HTMLSelectElement>(`select[data-opt=${k}]`); s.value = party[k]; s.disabled = !lead; }
  q(".pt-invite").hidden = !lead;
  const title = el("div", "pm-title", party.name);
  mlist.append(title);
  for (const m of party.members) {
    const li = el("li", "pt-m");
    li.dataset.char = String(m.charId);
    const crown = el("span", m.leader ? "pt-crown on" : "pt-crown", m.leader ? "♛" : "");
    crown.title = m.leader ? t("party.leader") : "";
    const name = el("span", "pt-n", m.name);
    const lv = el("span", "pt-lv", t("party.lv_job", { lv: m.level, job: jobName(m.job) }));
    const where = el("span", "pt-map");
    const gauge = el("span", "pt-gauge"), fill = el("i"), num = el("em");
    gauge.append(fill, num);
    li.append(crown, name, lv, where, gauge);
    if (lead && m.name !== myName()) {
      const acts = el("span", "pt-acts");
      acts.append(btn("♛", t("party.make_leader", { name: m.name }), () => room?.send(Msg.partyLeader, { charId: m.charId }), "pt-act"),
        btn("×", t("party.expel", { name: m.name }), () => room?.send(Msg.partyKick, { charId: m.charId }), "pt-act bad"));
      li.append(acts);
    }
    li.addEventListener("dblclick", () => { if (m.name !== myName()) whisperTo(m.name); });
    list.append(li);
    // compact list (under the minimap column)
    const mr = el("div", "pm-row"), mn = el("span", "pm-n", m.name), mg = el("span", "pm-g"), mf = el("i");
    mg.append(mf); mr.append(mn, mg);
    mlist.append(mr);
    rows.set(m.charId, { row: li, fill, num, where, mrow: mr, mfill: mf });
    paintMember(m);
  }
}
function paintMember(m: PartyMember) {
  const r = rows.get(m.charId);
  if (!r) return;
  const here = m.online && m.map === curMap;
  r.row.classList.toggle("off", !m.online);
  r.mrow.classList.toggle("off", !m.online);
  r.mrow.classList.toggle("far", m.online && !here);
  r.where.textContent = m.online ? mapTitle(m.map) : t("party.offline");
  r.fill.style.width = `${m.online ? pct(m) * 100 : 0}%`;
  r.fill.classList.toggle("low", pct(m) < 0.25);
  r.mfill.style.width = `${m.online ? pct(m) * 100 : 0}%`;
  r.mfill.classList.toggle("low", pct(m) < 0.25);
  r.num.textContent = m.online && m.maxHp > 0 ? `${m.hp}/${m.maxHp}` : "";
}

// ---------- friends tab ----------
function renderFriends() {
  const list = q(".fr-list");
  list.textContent = "";
  const sorted = [...friends].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (!sorted.length) list.append(el("li", "fr-empty", t("party.no_friends")));
  for (const f of sorted) {
    const li = el("li", f.online ? "fr on" : "fr");
    li.append(el("span", "fr-dot"), el("span", "fr-n", f.name), el("span", "fr-st", t(f.online ? "party.online_st" : "party.offline")));
    const acts = el("span", "pt-acts");
    acts.append(btn("✉", t("party.whisper_to", { name: f.name }), () => whisperTo(f.name), "pt-act"), btn("×", t("party.remove_friend_tip", { name: f.name }), () => room?.send(Msg.friendRemove, { charId: f.charId }), "pt-act bad"));
    li.append(acts);
    li.addEventListener("dblclick", () => whisperTo(f.name));
    li.addEventListener("contextmenu", (e) => { e.preventDefault(); openMenu(f.name, e.clientX, e.clientY, f); });
    list.append(li);
  }
  const on = friends.filter((f) => f.online).length;
  const badge = q("[data-tab=friends] i");
  badge.hidden = !on; badge.textContent = String(on);
}

// ---------- tabs + window ----------
function setTab(t: "party" | "friends") {
  tab = t;
  for (const b of win.querySelectorAll<HTMLButtonElement>(".pt-tabs button")) b.classList.toggle("on", b.dataset.tab === t);
  for (const p of win.querySelectorAll<HTMLElement>(".pt-pane")) p.hidden = p.dataset.pane !== t;
}
for (const b of win.querySelectorAll<HTMLButtonElement>(".pt-tabs button")) b.addEventListener("click", () => { setTab(b.dataset.tab as "party" | "friends"); play("sfx", "click", 0.3); });
for (const s of win.querySelectorAll<HTMLSelectElement>("select[data-opt]")) s.addEventListener("change", () => {
  room?.send(Msg.partyOption, { [s.dataset.opt!]: s.value as PartyShare });
  if (party) s.value = party[s.dataset.opt as "exp" | "item"]; // the server answers with the new Msg.party
});
export function toggleWindow(show?: boolean) { toggle(win, show); }
addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select") || document.body.dataset.screen !== "game") return;
  if (e.altKey && e.code === "KeyZ") { e.preventDefault(); toggleWindow(); }
});

// ---------- popups (party invite, friend request) ----------
function popup(key: string, title: string, text: string, answer: (accept: boolean) => void) {
  popups.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
  const p = el("section", "win pt-pop");
  p.dataset.key = key;
  p.innerHTML = `<header class="win-title"><span></span></header><div class="win-body"><p></p><div class="pt-row"></div></div>`;
  p.querySelector("span")!.textContent = title;
  p.querySelector("p")!.textContent = text;
  const done = (a: boolean) => { p.remove(); answer(a); };
  p.querySelector(".pt-row")!.append(btn(t("party.accept"), t("party.accept"), () => done(true), "ok"), btn(t("party.decline"), t("party.decline"), () => done(false)));
  popups.append(p);
  play("sfx", "ui_open", 0.5);
}

// ---------- whisper / chat input ----------
function chatInput() { return document.getElementById("chat-input") as HTMLInputElement | null; }
export function whisperTo(name: string) {
  const i = chatInput();
  if (!i) return;
  i.value = `/w ${/\s/.test(name) ? `"${name}"` : name} `;
  i.focus();
}
/** Chat line typed in the chat box: `/w name text`, `/r text` (reply), `%text` or `/p text` (party chat). True = handled here. */
export function handleChatInput(text: string): boolean {
  if (!room) return false;
  let m = /^\/(?:w|whisper|t|tell)\s+(?:"([^"]+)"|(\S+))\s+(.+)$/i.exec(text);
  if (m) { room.send(Msg.whisper, { to: m[1] ?? m[2], text: m[3].trim() }); return true; }
  if (/^\/(?:w|whisper|t|tell)\b/i.test(text)) { log("system", t("party.usage_w")); return true; }
  m = /^\/r\s+(.+)$/i.exec(text);
  if (m) {
    if (lastFrom) room.send(Msg.whisper, { to: lastFrom, text: m[1].trim() });
    else log("system", t("party.no_whisper"));
    return true;
  }
  m = /^(?:%|\/p(?:arty)?\s+)\s*(.+)$/i.exec(text);
  if (m) {
    if (party) room.send(Msg.partyChat, { text: m[1].trim() });
    else log("system", t("party.none"));
    return true;
  }
  return false;
}

// ---------- right-click menu on a player ----------
function closeMenu() { ctx.hidden = true; }
addEventListener("pointerdown", (e) => { if (!ctx.hidden && !ctx.contains(e.target as Node)) closeMenu(); }, true);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
/** The small menu on another player (or a friends-list row): Whisper / Invite to party / Add friend / Remove friend. */
export function openMenu(name: string, x: number, y: number, friend?: Friend) {
  ctx.textContent = "";
  ctx.append(el("div", "pc-name", name));
  const add = (label: string, on: () => void) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", () => { closeMenu(); on(); play("sfx", "click", 0.35); }); ctx.append(b); };
  add(t("party.whisper"), () => whisperTo(name));
  if (party && iLead() && !party.members.some((m) => m.name === name)) add(t("party.invite_to"), () => invite(name));
  else if (!party) add(t("party.create_to_invite"), () => { toggleWindow(true); setTab("party"); createName.focus(); });
  if (!friend && !duelFoe()) add(t("party.duel"), () => challengeDuel(name));
  const isFriend = friend ?? friends.find((f) => f.name === name);
  if (isFriend) add(t("party.remove_friend"), () => room?.send(Msg.friendRemove, { charId: isFriend.charId }));
  else add(t("party.add_friend"), () => addFriend(name));
  ctx.hidden = false;
  ctx.style.left = `${Math.min(x, innerWidth - 150)}px`; ctx.style.top = `${Math.min(y, innerHeight - ctx.offsetHeight - 4)}px`;
}

// ---------- hooks for main.ts ----------
let curMap = "";
export function setPartyMap(map: string) { curMap = map; for (const m of party?.members ?? []) paintMember(m); }
/** Party member of that character name (HP bars over heads, minimap), or undefined. */
export function partyMemberByName(name: string) { return party?.members.find((m) => m.name === name); }
/** Other online members on the map I'm on, for the minimap (pink dots). */
export function partyDots(): { x: number; y: number }[] {
  return (party?.members ?? []).filter((m) => m.online && m.map === curMap && m.name !== myName()).map((m) => ({ x: m.x, y: m.y }));
}

/** Wire the window to a room (each map has its own room; the party/friends survive a map change, the server resends them). */
export function bindParty(r: Room) {
  room = r;
  r.onMessage(Msg.party, (m: PartyEvent) => { party = m.party; renderParty(); });
  r.onMessage(Msg.partyUpdate, (u: PartyUpdateEvent) => {
    const m = party?.members.find((x) => x.charId === u.charId);
    if (!m) return;
    const { charId: _c, ...rest } = u;
    Object.assign(m, rest);
    paintMember(m);
  });
  r.onMessage(Msg.partyNotice, (n: PartyNoticeEvent) => log("party", n.text));
  r.onMessage(Msg.partyInvited, (e: PartyInvitedEvent) =>
    popup(`party${e.partyId}`, t("party.invitation"), t("party.invited", { from: e.from, party: e.partyName }), (accept) => room?.send(Msg.partyReply, { partyId: e.partyId, accept })));
  r.onMessage(Msg.friends, (e: FriendsEvent) => { friends = e.list; renderFriends(); });
  r.onMessage(Msg.friendReq, (e: FriendReqEvent) =>
    popup(`friend${e.charId}`, t("party.friend_request"), t("party.wants_friend", { name: e.name }), (accept) => room?.send(Msg.friendReply, { charId: e.charId, accept })));
  r.onMessage(Msg.channelChat, (c: ChannelChatEvent) => {
    if (c.channel === "party") { log("party", c.text, `[${t("party.tab_party")}] ${c.from}`); return; }
    const mine = c.from === myName();
    if (!mine) { lastFrom = c.from; play("sfx", "ui_open", 0.4); }
    log("whisper", c.text, mine ? t("party.to", { name: c.to ?? "?" }) : t("party.from", { name: c.from }));
  });
  renderParty(); renderFriends();
}
/** Leave to character select / logout (not a map change): forget the party. */
export function resetParty() {
  room = undefined; party = null; friends = []; lastFrom = undefined;
  popups.textContent = ""; closeMenu();
  renderParty(); renderFriends();
}
/** Map change: only drop the room; the next room's join resends the party and friends. */
export function unbindParty() { room = undefined; }

// dev only: feed fake server events, e.g. __roParty("party", {...})
if (import.meta.env.DEV) {
  (window as any).__roParty = (type: string, data: unknown) => {
    const fake = { onMessage() {}, send: (t: string, d: unknown) => console.log("[party send]", t, d), sessionId: room?.sessionId } as unknown as Room;
    if (!room) room = fake;
    const handlers: Record<string, (d: any) => void> = {};
    const stub = { ...fake, onMessage: (t: string, h: (d: any) => void) => { handlers[t] = h; } } as unknown as Room;
    const keep = room; bindParty(stub); room = keep;
    handlers[type]?.(data);
  };
}
