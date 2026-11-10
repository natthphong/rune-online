// The Tower HUD (2.7.0): on a floor-guardian map the server sends Msg.tower every 2 s (shared/tower.ts); this draws the small panel
// under the minimap: which guardian, an arrow to where it roams, the hint in words, its respawn clock and the floor's clear tag.
// A map that sends nothing shows nothing (the panel hides itself 6 s after the last message and whenever a room is bound).
import "./tower.css";
import type { Room } from "@colyseus/sdk";
import { Msg, type TowerEvent } from "../../../shared/protocol.ts";
import { t } from "../i18n.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "") => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const panel = el("section"); panel.id = "tower-hud"; panel.hidden = true;
const title = el("div", "tw-title"), row = el("div", "tw-row"), arrow = el("div", "tw-arrow"), hint = el("div", "tw-hint"), tag = el("div", "tw-tag");
arrow.textContent = "➤";
row.append(arrow, hint);
panel.append(title, row, tag);
(document.getElementById("hud") ?? document.body).append(panel);

let last: TowerEvent | undefined, lastAt = 0;
const show = (on: boolean) => { panel.hidden = !on; document.body.classList.toggle("has-tower", on); };
const hintWords = (e: TowerEvent) => e.dist <= 6 ? t("tower.here") : t(e.dist > 45 ? "tower.far" : e.dist > 20 ? "tower.to" : "tower.close", { dir: t(`tower.dir.${e.dir}`) });
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function paint() {
  if (!last) return;
  const e = last;
  title.textContent = t("tower.title", { floor: e.floor, boss: e.boss });
  panel.classList.toggle("dead", !e.alive);
  if (e.alive) {
    row.hidden = false;
    arrow.style.transform = `rotate(${90 - 45 * e.dir}deg)`; // the glyph points east at 0deg; dir 0 = south, 2 = east, 4 = north (screen up, as the minimap)
    hint.textContent = hintWords(e);
  } else {
    row.hidden = true;
  }
  tag.className = "tw-tag";
  if (!e.alive) { tag.textContent = t("tower.defeated", { time: mmss((e.respawnAt ?? 0) - Date.now()) }); tag.classList.add("dead"); }
  else if (e.cleared) { tag.textContent = t("tower.cleared"); tag.classList.add("ok"); }
  else tag.textContent = "";
  tag.hidden = !tag.textContent;
  // a cleared floor shows the green tag beside the live hint, a defeated guardian its clock
  if (e.cleared && !e.alive) tag.textContent += " · " + t("tower.cleared");
}

export function bindTower(r: Room) {
  last = undefined; show(false);
  r.onMessage(Msg.tower, (m: TowerEvent) => { last = m; lastAt = Date.now(); show(true); paint(); });
  r.onLeave(() => { last = undefined; show(false); });
}
setInterval(() => {
  if (!last) return;
  if (Date.now() - lastAt > 6000) { last = undefined; show(false); return; }
  if (!last.alive) paint(); // the respawn clock
}, 500);
