// The status icons (clif_status_change): one 24 px square per status the character carries, in the column down the right edge under the
// minimap (the same #status-icons column as the weight and status-point icons, hud.ts). Hover = name, level and the time left, counting
// down live; an icon flashes when less than 5 s remain. Debuffs are red-framed, buffs blue-framed. The list comes from the server
// (Msg.scList, the owner alone); the glyphs are our own.
import "./status.css";
import type { ScListEvent } from "../../../shared/protocol.ts";
import { SKILLS, SKILL_ID } from "../../../shared/rules/skill.ts";

type Look = { name: string; skill?: string; c1: string; c2: string; debuff?: true; glyph: string };
const S = (d: string, fill = "#fff") => `<svg viewBox="0 0 24 24"><path d="${d}" fill="${fill}" stroke="rgba(0,0,0,.55)" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
const T = (t: string, size = 15) => `<svg viewBox="0 0 24 24"><text x="12" y="${12 + size * 0.36}" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="${size}" fill="#fff" stroke="rgba(0,0,0,.6)" stroke-width="1.6" paint-order="stroke">${t}</text></svg>`;
const DROP = S("M12 3c4 5.4 6.4 8.4 6.4 11.4a6.4 6.4 0 0 1-12.8 0C5.6 11.4 8 8.4 12 3z");
const STAR = S("M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.4 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z", "#ffe14a");
const ARROW_UP = S("M12 3l7 8h-4.2V21H9.2V11H5z"), ARROW_DOWN = S("M12 21l-7-8h4.2V3h5.6v10H19z");
const CROSS = S("M9.4 3h5.2v6.4H21v5.2h-6.4V21H9.4v-6.4H3V9.4h6.4z");
const SHIELD = S("M12 2.8l7.4 2.7v5.6c0 4.6-3.1 7.8-7.4 9.7-4.3-1.9-7.4-5.1-7.4-9.7V5.5z");
const FLAKE = S("M11 2h2v7l4.6-2.7 1 1.7L14 11l4.6 2.7-1 1.7L13 12.7V20h-2v-7.3l-4.6 2.7-1-1.7L10 11 5.4 8.3l1-1.7L11 9z");
const ROCK = S("M4.5 15.5l2-7.5 5-4.5 6.5 3 2.5 6-3 5.5h-8.5z", "#e8e4dc");
const EYE = S("M2.5 12C5 7.6 8.4 5.6 12 5.6s7 2 9.5 6.4c-2.5 4.4-5.9 6.4-9.5 6.4S5 16.4 2.5 12zM12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z");
const BANG = T("!", 19);
/** Per status: our label (buffs: the skill that gives it, so the name matches the skill window), two gradient colours, a glyph. */
const LOOK: Record<string, Look> = {
  Poison: { name: "Poison", c1: "#b9f0a0", c2: "#3f9a2a", debuff: true, glyph: DROP },
  Stun: { name: "Stun", c1: "#fff0a8", c2: "#c9a020", debuff: true, glyph: STAR },
  Freeze: { name: "Frozen", c1: "#e4f6ff", c2: "#5aa6d8", debuff: true, glyph: FLAKE },
  Stone: { name: "Petrified", c1: "#e0dcd4", c2: "#7a756c", debuff: true, glyph: ROCK },
  StoneWait: { name: "Turning to stone", skill: "MG_STONECURSE", c1: "#ece8e0", c2: "#9a958c", debuff: true, glyph: ROCK },
  Sleep: { name: "Sleep", c1: "#dfe6ff", c2: "#6a7cc8", debuff: true, glyph: T("Zz", 13) },
  Curse: { name: "Curse", c1: "#d9b8ee", c2: "#6a3a96", debuff: true, glyph: T("X", 16) },
  Silence: { name: "Silence", c1: "#f0f0f0", c2: "#8a8a98", debuff: true, glyph: T("...", 13) },
  Blind: { name: "Blind", c1: "#c8c8d8", c2: "#444458", debuff: true, glyph: EYE },
  Bleeding: { name: "Bleeding", c1: "#ffb0b0", c2: "#b01820", debuff: true, glyph: DROP },
  Provoke: { name: "Provoke", skill: "SM_PROVOKE", c1: "#ffc0a0", c2: "#d0481c", debuff: true, glyph: BANG },
  Endure: { name: "Endure", skill: "SM_ENDURE", c1: "#f6ecc8", c2: "#a8802c", glyph: SHIELD },
  Concentrate: { name: "Improve Concentration", skill: "AC_CONCENTRATION", c1: "#d8f0d0", c2: "#4a9a48", glyph: EYE },
  Angelus: { name: "Angelus", skill: "AL_ANGELUS", c1: "#fff6c8", c2: "#d8a820", glyph: CROSS },
  Blessing: { name: "Blessing", skill: "AL_BLESSING", c1: "#e8f4ff", c2: "#5a8ed8", glyph: CROSS },
  IncreaseAgi: { name: "Increase AGI", skill: "AL_INCAGI", c1: "#d0f4ff", c2: "#3a9ad0", glyph: ARROW_UP },
  DecreaseAgi: { name: "Decrease AGI", skill: "AL_DECAGI", c1: "#ffd4d0", c2: "#c4543c", debuff: true, glyph: ARROW_DOWN },
};
const nameOf = (sc: string) => {
  const l = LOOK[sc];
  const s = l?.skill ? SKILLS.get(SKILL_ID[l.skill]) : undefined;
  return s?.name ?? l?.name ?? sc;
};

type Shown = { sc: string; lv: number; ms: number; at: number; el: HTMLButtonElement };
let shown: Shown[] = [];
let tip: HTMLDivElement | undefined, tipFor: string | undefined, timer = 0;
const column = () => document.getElementById("status-icons");

const clock = (ms: number) => {
  if (ms < 0) return "";
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};
const left = (s: Shown, now: number) => (s.ms < 0 ? -1 : Math.max(0, s.ms - (now - s.at)));

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "sc-tip";
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}
function refresh() {
  const now = performance.now();
  for (const s of shown) {
    const rest = left(s, now);
    s.el.classList.toggle("low", rest >= 0 && rest < 5000);
    if (tipFor === s.sc && tip && !tip.hidden) {
      const lv = LOOK[s.sc]?.skill && s.lv > 0 && s.lv <= 10 ? ` Lv ${s.lv}` : "";
      tip.textContent = `${nameOf(s.sc)}${lv}${rest >= 0 ? ` — ${clock(rest)}` : ""}`;
    }
  }
}

/** Msg.scList: replace the icons with the character's current statuses. */
export function setStatusList(m: ScListEvent) {
  const col = column();
  if (!col) return;
  const now = performance.now();
  for (const s of shown) s.el.remove();
  shown = m.list.map((e) => {
    const look = LOOK[e.sc] ?? { name: e.sc, c1: "#eee", c2: "#888", glyph: T("?") };
    const el = document.createElement("button");
    el.type = "button";
    el.className = `sicon sc${look.debuff ? " bad" : ""}`;
    el.style.setProperty("--c1", look.c1); el.style.setProperty("--c2", look.c2);
    el.innerHTML = look.glyph;
    el.dataset.sc = e.sc;
    el.addEventListener("mouseenter", () => {
      tipFor = e.sc;
      const t = ensureTip(), r = el.getBoundingClientRect();
      t.hidden = false;
      t.style.top = `${r.top + r.height / 2}px`;
      t.style.left = `${r.left - 6}px`;
      refresh();
    });
    el.addEventListener("mouseleave", () => { if (tipFor === e.sc) { tipFor = undefined; if (tip) tip.hidden = true; } });
    col.append(el);
    return { sc: e.sc, lv: e.lv, ms: e.ms, at: now, el };
  });
  if (tip && tipFor && !shown.some((s) => s.sc === tipFor)) { tipFor = undefined; tip.hidden = true; }
  if (shown.length && !timer) timer = window.setInterval(refresh, 250);
  if (!shown.length && timer) { clearInterval(timer); timer = 0; }
  refresh();
}
/** Leaving the world: no icons. */
export function clearStatusList() { setStatusList({ list: [] }); }
/** The statuses currently shown (the status bot reads them). */
export const shownStatuses = () => shown.map((s) => s.sc);
