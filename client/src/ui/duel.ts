// Duel UI (2.4.0): challenge popup (Accept / Reject, 30 s), a strip with the opponent and a Leave button, slash commands
// (/duel name, /accept, /reject, /leave = rAthena's @duel, @accept, @reject, @leave) and the opponent id for main.ts (red name,
// click to attack). The server owns the rules (server/src/duel.ts); this only sends intents and renders Msg.duel / duelInvited.
import "./duel.css";
import type { Room } from "@colyseus/sdk";
import { Msg, type DuelEvent, type DuelInvitedEvent } from "../../../shared/protocol.ts";
import { log } from "./hud.ts";
import { play } from "../audio.ts";

let room: Room | undefined;
let foe: { name: string; id: string } | undefined;
const INVITE_MS = 30_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(text: string, on: () => void, cls = "") {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", (e) => { e.stopPropagation(); on(); play("sfx", "click", 0.35); });
  return b;
}

const pops = el("div"); pops.id = "duel-pops";
const strip = el("div"); strip.id = "duel-strip"; strip.hidden = true;
const stripText = el("span");
strip.append(stripText, btn("Leave duel", () => leaveDuel()));
(document.getElementById("hud") ?? document.body).append(pops, strip);

/** The duel opponent's session id (the only unit a duelist may attack), or undefined. */
export const duelFoe = () => foe?.id;

export function challenge(name: string) {
  if (!room) return;
  if (foe) { log("system", "Duel: you are already in a duel."); return; }
  room.send(Msg.duelInvite, { name });
}
export function leaveDuel() { room?.send(Msg.duelLeave); }

/** Slash commands typed in the chat box. True = handled. */
export function handleDuelInput(text: string): boolean {
  if (!room) return false;
  let m = /^\/duel\s+(?:"([^"]+)"|(.+?))\s*$/i.exec(text);
  if (m) { challenge(m[1] ?? m[2]); return true; }
  if (/^\/duel\s*$/i.test(text)) { log("system", "Usage: /duel Name   (right-click a player and choose Duel)"); return true; }
  if (/^\/accept\s*$/i.test(text)) { room.send(Msg.duelReply, { accept: true }); closePops(); return true; }
  if (/^\/reject\s*$/i.test(text)) { room.send(Msg.duelReply, { accept: false }); closePops(); return true; }
  if (/^\/leave\s*$/i.test(text)) { leaveDuel(); return true; }
  return false;
}

function closePops() { pops.textContent = ""; }
function popup(e: DuelInvitedEvent) {
  closePops();
  const p = el("section", "win");
  p.innerHTML = `<header class="win-title"><span>Duel challenge</span></header><div class="win-body"><p></p><div class="dl-row"></div><div class="dl-time"><i></i></div></div>`;
  p.querySelector("p")!.textContent = `${e.from} challenges you to a duel.`;
  const answer = (accept: boolean) => { clearTimeout(timer); p.remove(); room?.send(Msg.duelReply, { accept }); };
  p.querySelector(".dl-row")!.append(btn("Accept", () => answer(true), "ok"), btn("Reject", () => answer(false)));
  const timer = setTimeout(() => p.remove(), INVITE_MS); // the server drops the invitation at the same time
  pops.append(p);
  requestAnimationFrame(() => requestAnimationFrame(() => { (p.querySelector(".dl-time i") as HTMLElement).style.width = "0"; }));
  play("sfx", "ui_open", 0.5);
}

function show() {
  strip.hidden = !foe;
  stripText.textContent = "";
  if (foe) { stripText.append("Dueling with "); stripText.append(el("b", "", foe.name)); closePops(); }
}

export function bindDuel(r: Room) {
  room = r;
  r.onMessage(Msg.duel, (e: DuelEvent) => { foe = e.duel ? { name: e.duel.with, id: e.duel.withId } : undefined; show(); });
  r.onMessage(Msg.duelInvited, (e: DuelInvitedEvent) => popup(e));
}
/** Map change / logout: the duel ends on the server with the room. */
export function resetDuel() { room = undefined; foe = undefined; closePops(); show(); }
