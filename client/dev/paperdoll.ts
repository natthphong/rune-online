// Dev-only paper-doll lab (client/src/paperdoll.ts): http://localhost:5173/dev/paperdoll.html
//   default          every frame of every complete body: 5 facings x (walk 8 + stand, sit, hurt, dead, swing 4), with head + weapon
//   ?view=matrix     starting jobs x genders x hair styles (front + 3/4), drawn by the game's own Composer
//   ?view=exploded   one look taken apart: body / head / weapon / gear, then composited (5 facings)   &job= &g= &style= &hair=
//   ?view=gear       every weapon on its job, hat / hood / shield on every body
import { Composer, PC } from "../src/animSprite.ts";
import { drawPd, loadPd, pdIndex, bodyKey, type PdParts } from "../src/paperdoll.ts";
import { HAIR_COLORS, HAIR_STYLES, START_JOBS, START_WEAPON, outfitOf, type Gender, type Look } from "../../shared/look.ts";

const out = document.getElementById("out")!;
const q = new URLSearchParams(location.search);
const GENDERS: Gender[] = ["M", "F"];
const FACING = ["front", "3/4 front", "side", "3/4 back", "back"];
const ACT = ["stand", "sit", "hurt", "dead", "swing 1", "swing 2", "swing 3", "swing 4"];
const ix = (await pdIndex)!;

function canvas(parent: HTMLElement, w: number, h: number, label?: string) {
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const fig = document.createElement("figure"); fig.append(cv);
  if (label) { const c = document.createElement("figcaption"); c.textContent = label; fig.append(c); }
  parent.append(fig);
  return cv.getContext("2d")!;
}
const h3 = (t: string) => { const h = document.createElement("h3"); h.textContent = t; out.append(h); };
const row = () => { const r = document.createElement("div"); r.className = "row"; out.append(r); return r; };
const op = (parent: HTMLElement, t: string) => { const s = document.createElement("span"); s.className = "op"; s.textContent = t; parent.append(s); };
const lookOf = (gender: Gender, job: string, style = 0, hair = 0, extra: Partial<Look> = {}): Look =>
  ({ gender, job, hair, style, outfit: outfitOf(job), weapon: START_WEAPON[job] ?? "sword", ...extra });

const view = q.get("view");
if (view === "matrix") {
  for (const gender of GENDERS) {
    h3(`${gender === "M" ? "Male" : "Female"}: starting jobs x hair styles (front, 3/4)`);
    for (const [j, job] of START_JOBS.entries()) {
      const r = row();
      for (let s = 0; s < HAIR_STYLES.length; s++) for (const facing of [0, 1]) {
        const look = lookOf(gender, job, s, (s + j * 2 + (gender === "F" ? 3 : 0)) % HAIR_COLORS.length);
        const g = canvas(r, 92, 132, facing ? undefined : `${job} · ${HAIR_STYLES[s].label}`);
        const c = new Composer(PC);
        await c.loadLook(look);
        const f = c.pick(c.kind.idle, 0);
        if (f) c.draw(g, f, facing, false, (0.66 * 160) / f.s.meta.unit, 46, 126);
      }
    }
  }
} else if (view === "exploded") {
  const look = lookOf((q.get("g") as Gender) ?? "F", q.get("job") ?? "Swordman", Number(q.get("style") ?? 0), Number(q.get("hair") ?? 3), { headgear: "hat", garment: "hood", shield: "guard" });
  const pd = await loadPd(look);
  h3(`${look.gender} ${look.job}: headless body + head (face + hair) + weapon + gear = one character. Every part sits on the body's anchors.`);
  if (pd) for (const [sheet, col, name] of [["act", 0, "stand"], ["act", 6, "swing"], ["walk", 1, "walk"], ["act", 3, "dead"]] as const) for (const facing of [0, 1, 2, 3, 4]) {
    const r = row();
    const parts: [string, PdParts][] = [["body (headless)", { head: false, weapon: false, gear: false }], ["head", { body: false, weapon: false, gear: false }],
      ["weapon", { body: false, head: false, gear: false }], ["gear", { body: false, head: false, weapon: false }]];
    for (const [i, [label, p]] of parts.entries()) {
      const g = canvas(r, 150, 150, `${label} · ${name} · ${FACING[facing]}`);
      drawPd(g, pd, sheet, col, facing, false, 0.7, 75, 138, p);
      op(r, i < 3 ? "+" : "=");
    }
    drawPd(canvas(r, 150, 150, "composited"), pd, sheet, col, facing, false, 0.7, 75, 138);
  }
} else if (view === "gear") {
  h3("Weapons: one sprite each (profile + toward-viewer view), held on the measured hand anchor of ANY body");
  for (const gender of GENDERS) for (const job of START_JOBS) {
    const pd = await loadPd(lookOf(gender, job, 0, 2));
    if (!pd) continue;
    const r = row();
    for (const [sheet, col] of [["act", 0], ["act", 4], ["act", 5], ["act", 6], ["act", 7], ["walk", 0], ["walk", 4]] as const) for (const facing of [0, 2, 4])
      drawPd(canvas(r, 110, 130, col === 0 && sheet === "act" && facing === 0 ? `${gender} ${job}` : undefined), pd, sheet, col, facing, false, 0.6, 55, 122);
  }
  h3("Headgear, garment, shield: one image each, drawn on every body");
  for (const gender of GENDERS) for (const job of START_JOBS) {
    const pd = await loadPd(lookOf(gender, job, 1, 5, { headgear: "hat", garment: "hood", shield: "guard" }));
    if (!pd) continue;
    const r = row();
    for (const facing of [0, 1, 2, 3, 4]) drawPd(canvas(r, 110, 130, facing ? undefined : `${gender} ${job}`), pd, "act", 0, facing, false, 0.6, 55, 122);
  }
} else {
  for (const gender of GENDERS) for (const job of START_JOBS) {
    const look = lookOf(gender, job, 0, gender === "M" ? 0 : 3);
    if (!bodyKey(ix, look)) continue;
    const pd = await loadPd(look);
    if (!pd) continue;
    h3(`${gender === "M" ? "Male" : "Female"} ${job}: walk 1-8 | ${ACT.join(", ")}`);
    for (let facing = 0; facing < 5; facing++) {
      const r = row();
      for (const sheet of ["walk", "act"] as const) for (let col = 0; col < 8; col++)
        drawPd(canvas(r, 104, 124, col === 0 && sheet === "walk" ? FACING[facing] : undefined), pd, sheet, col, facing, false, 0.56, 52, 116);
    }
  }
}
document.body.dataset.ready = "1";
