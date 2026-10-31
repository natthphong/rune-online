// Auto-play UI (C12): the "Auto" toggle beside the quest tracker (Alt+T) and the AUTO indicator with the current task. The
// work itself is client/src/autoplay.ts (ordinary intents only); this binds it to the HUD: dialog pages are answered by
// clicking the NPC window's own Next / Close buttons so the window's state stays the one the player sees.
import "./auto.css";
import type { Room } from "@colyseus/sdk";
import { bindAuto, onAuto, toggleAuto } from "../autoplay.ts";
import { dialogOpen } from "./dialog.ts";
import { log } from "./hud.ts";
import { learnedByKey } from "./skills.ts";
import { play } from "../audio.ts";

const hud = document.getElementById("hud") ?? document.body;
const btn = document.createElement("button");
btn.type = "button"; btn.id = "auto-btn"; btn.hidden = true;
btn.title = "Auto quest / auto battle (Alt+T). Click anywhere in the world to take over.";
btn.innerHTML = `<svg viewBox="0 0 20 20"><path d="M6 4.5l9 5.5-9 5.5z"/></svg>Auto`;
const badge = document.createElement("div");
badge.id = "auto-badge"; badge.hidden = true;
const tag = document.createElement("b"), what = document.createElement("span");
tag.textContent = "AUTO";
badge.append(tag, what);
hud.append(btn, badge);
btn.addEventListener("click", () => { toggleAuto(); play("sfx", "click", 0.4); });
addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea") || document.body.dataset.screen !== "game") return;
  if (e.altKey && e.code === "KeyT") { e.preventDefault(); toggleAuto(); }
});
onAuto((on, task) => {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  badge.hidden = !on;
  what.textContent = task;
});

/** Click the NPC window's visible Next / Close button (dialog.ts sends the request and keeps its own state). */
function press(kind: "next" | "close") {
  const want = kind === "next" ? "Next" : "Close";
  const b = [...document.querySelectorAll<HTMLButtonElement>("#w-npc .npc-btns button")].find((x) => !x.hidden && x.textContent === want);
  b?.click();
}

/** Double-click option `choice` (1-based) of the open menu window, as the player would (dialog.ts sends the request). */
function choose(choice: number) {
  document.querySelectorAll<HTMLElement>("#w-npcmenu .npc-options li")[choice - 1]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

/** Give auto-play its room (from enterWorld; undefined when leaving the world). */
export function bindAutoUi(r: Room | undefined) {
  btn.hidden = !r;
  bindAuto(r, { locked: dialogOpen, press, choose, skillLv: learnedByKey, pageMs: 1600, log: (t) => log("system", t) });
}
export { stopAuto } from "../autoplay.ts";
