// NPC scripts in the world, on the client: emotion bubbles over a unit (ZC_EMOTION from the script command `emotion`: "!",
// "?", a note, a sweat drop ...) and an NPC's spoken line (ZC_NPC_CHAT from `npctalk`: a speech bubble over the NPC's head
// plus a line in the chat log). Our own glyphs, drawn as SVG; the original's emotion sprites are not used.
import "./emotion.css";
import * as THREE from "three";
import type { Room } from "@colyseus/sdk";
import { Msg, type EmotionEvent, type NpcTalkEvent } from "../../../shared/protocol.ts";
import { ET } from "../../../shared/rules/script.ts";
import { type GameMap } from "../../../shared/map.ts";
import { mapOfState } from "../../../shared/maps.ts";
import { heightAt } from "../world.ts";
import { log } from "./hud.ts";

/** dy = height over the unit's feet (world units), px / py = a pixel offset on top (bubbles stay clear of the quest mark). */
type Shown = { el: HTMLDivElement; id: string; until: number; dy: number; px: number; py: number };
const layer = () => document.getElementById("labels") ?? document.body;
const live: Shown[] = [];
let room: Room | undefined;
let map: GameMap | undefined, seed = -1;

/** The glyph of an emotion (ET_*): a short text in a round bubble, or a little drawing for the ones that are pictures. */
const DROP = `<path d="M16 7c3 4.6 5.4 7.6 5.4 10.6a5.4 5.4 0 0 1-10.8 0C10.6 14.6 13 11.6 16 7z" fill="#7cc8ff" stroke="#24507a" stroke-width="1.2"/>`;
const HEART = `<path d="M16 23.5s-7-4.3-7-9.2a3.9 3.9 0 0 1 7-2.4 3.9 3.9 0 0 1 7 2.4c0 4.9-7 9.2-7 9.2z" fill="#ff6f8e" stroke="#7a1d33" stroke-width="1.2"/>`;
const STAR = `<path d="M16 7.5l2.4 5.2 5.6.6-4.2 3.8 1.2 5.6L16 19.9l-5 2.8 1.2-5.6L8 13.3l5.6-.6z" fill="#ffd34d" stroke="#7a5200" stroke-width="1.2"/>`;
const NOTE = `<path d="M13.5 20.5V10l8-2v10" fill="none" stroke="#3a2600" stroke-width="1.8"/><circle cx="11.6" cy="20.6" r="2.4" fill="#3a2600"/><circle cx="19.6" cy="18.4" r="2.4" fill="#3a2600"/>`;
const ANGER = `<path d="M11 11.5c2 1 2.5 2.5 2 4.5M21 11.5c-2 1-2.5 2.5-2 4.5M11 21c2-1 2.5-2.5 2-4.5M21 21c-2-1-2.5-2.5-2-4.5" fill="none" stroke="#d62020" stroke-width="2.2" stroke-linecap="round"/>`;
const FRET = `<path d="M9.5 16c1.6-3 3.2 3 4.8 0s3.2 3 4.8 0 3.2 3 3.4 0" fill="none" stroke="#3a2600" stroke-width="1.8" stroke-linecap="round"/>`;
const text = (t: string, size = 15) => `<text x="16" y="${16 + size * 0.36}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="${size}" fill="#3a2600">${t}</text>`;
const BOWL = `<path d="M8 15h16c0 5-3.4 8.5-8 8.5S8 20 8 15z" fill="#f0c36a" stroke="#6a4308" stroke-width="1.3"/><path d="M12 12c-1-2 1-3 0-5M17 12c-1-2 1-3 0-5" fill="none" stroke="#8a7a60" stroke-width="1.3" stroke-linecap="round"/>`;
const GLYPH: Record<number, string> = {
  [ET.HUNGRY]: BOWL, [ET.SHY]: HEART, [ET.GOODBOY]: STAR, [ET.SLEEPY]: text("zZ", 12),
  [ET.SURPRISE]: text("!", 17), [ET.QUESTION]: text("?", 17), [ET.DELIGHT]: NOTE, [ET.THROB]: HEART, [ET.SWEAT]: DROP, [ET.AHA]: text("!!", 13),
  [ET.FRET]: FRET, [ET.ANGER]: ANGER, [ET.MONEY]: text("z", 16), [ET.THINK]: text("...", 13), [ET.THANKS]: HEART, [ET.SMILE]: text("^^", 13),
  [ET.PROFUSELY_SWEAT]: DROP, [ET.BEST]: STAR, [ET.HUK]: text("!?", 13), [ET.OK]: text("OK", 11), [ET.SORRY]: DROP, [ET.SPARK]: STAR,
  [ET.OHNO]: text("!!", 13), [ET.LUV]: HEART, [ET.CONGRATULATION]: STAR, [ET.STARE]: text("-_-", 10),
};
function bubbleSvg(type: number) {
  return `<svg viewBox="0 0 32 34"><path d="M16 2.5c7.6 0 13.5 5.2 13.5 12s-5.9 12-13.5 12c-1 0-2-.1-2.9-.3L9 31l.6-5.6C5.3 23.5 2.5 19.3 2.5 14.5 2.5 7.7 8.4 2.5 16 2.5z"
    fill="#fffdf4" stroke="#3a2600" stroke-width="1.5"/>${GLYPH[type] ?? text("...", 13)}</svg>`;
}

function place(s: Shown, camera: THREE.Camera, v: THREE.Vector3) {
  const S = room?.state as any;
  const unit = S?.players?.get(s.id) ?? S?.npcs?.get(s.id) ?? S?.pets?.get(s.id); // 2.4.0: a pet's emotion (clif_pet_emotion)
  if (!unit || !map) { s.el.style.display = "none"; return; }
  const x = unit.x + (unit.sx ?? 0), y = unit.y + (unit.sy ?? 0);
  v.set(x, heightAt(map, x, y) + s.dy, y).project(camera);
  s.el.style.display = v.z < 1 ? "" : "none";
  s.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth + s.px}px`;
  s.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight + s.py}px`;
}
function show(id: string, el: HTMLDivElement, ms: number, dy: number, px = 0, py = 0) {
  for (const s of live.filter((x) => x.id === id && x.el.className === el.className)) { s.el.remove(); live.splice(live.indexOf(s), 1); }
  layer().append(el);
  live.push({ el, id, until: performance.now() + ms, dy, px, py });
}

/** An emotion bubble over any unit (a pet's, from pets.ts). */
export function showEmotion(id: string, type: number) { onEmotion({ id, type } as EmotionEvent); }
function onEmotion(m: EmotionEvent) {
  const el = document.createElement("div");
  el.className = "emotion";
  el.innerHTML = bubbleSvg(m.type);
  show(m.id, el, 2600, 1.95, 26, 0); // beside the head, so a quest mark over it stays visible
}
function onNpcTalk(m: NpcTalkEvent) {
  const el = document.createElement("div");
  el.className = "bubble npc-talk";
  el.textContent = m.text;
  if (m.color !== 0xffffff) el.style.color = `#${m.color.toString(16).padStart(6, "0")}`;
  show(m.npc, el, 5000, 2.15, 0, -38); // above the head and its quest mark, like a player's chat
  log("chat", m.text); // like ZC_NPC_CHAT, the line also goes to the chat window
}

/** Listen to a room's emotion / npctalk messages (call once per room, from enterWorld). */
export function bindEmotions(r: Room) {
  room = r;
  r.onMessage(Msg.emotion, onEmotion);
  r.onMessage(Msg.npcTalk, onNpcTalk);
}
/** Leaving the world: drop every bubble. */
export function resetEmotions() {
  for (const s of live) s.el.remove();
  live.length = 0;
  room = undefined;
}
const tmp = new THREE.Vector3();
/** Every frame: bubbles follow their unit and go after their time. */
export function updateEmotions(camera: THREE.Camera, now: number) {
  if (!live.length) return;
  const S = room?.state as any;
  if (S) map = mapOfState(S); // C08: the room's own map (field or town)
  for (let i = live.length - 1; i >= 0; i--) {
    const s = live[i];
    if (now > s.until) { s.el.remove(); live.splice(i, 1); continue; }
    place(s, camera, tmp);
  }
}
