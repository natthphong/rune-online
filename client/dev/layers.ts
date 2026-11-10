// Dev-only layer lab (layered bodies, tools/art/layer_build.py): http://localhost:5173/dev/layers.html
//   default        exploded view: base / outfit / hair / weapon / composited, per job and gender (5 facings)
//   ?view=swaps    every layered job x every hair style x both genders, composited by the game's own Composer
//   &dir=0..4      facing row (default 0 = front; exploded view shows all five)
import { Composer, LAYER_JOBS, PC, layerParts, layersOf } from "../src/animSprite.ts";
import { HAIR_COLORS, HAIR_STYLES, outfitOf, type Gender, type Look } from "../../shared/look.ts";

const out = document.getElementById("out")!;
const q = new URLSearchParams(location.search);
const JOBS = Object.keys(LAYER_JOBS);
const GENDERS: Gender[] = ["M", "F"];
const W = 100, H = 124, K = 0.62; // canvas px, figure scale (x the 160 px standing height)

function canvas(parent: HTMLElement, label?: string) {
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const fig = document.createElement("figure"); fig.append(cv);
  if (label) { const c = document.createElement("figcaption"); c.textContent = label; fig.append(c); }
  parent.append(fig);
  return cv.getContext("2d")!;
}
function op(parent: HTMLElement, t: string) { const s = document.createElement("span"); s.className = "op"; s.textContent = t; parent.append(s); }
const lookOf = (gender: Gender, job: string, style: number, hair: number): Look =>
  ({ gender, job, hair, style, outfit: outfitOf(job), weapon: "blade" });

async function composite(g: CanvasRenderingContext2D, look: Look, row: number) {
  const c = new Composer(PC);
  await c.loadLook(look);
  const f = c.pick(PC.idle, 0);
  if (f) c.draw(g, f, row, false, (K * 160) / f.s.meta.unit, layersOf(look), W / 2, H - 6);
}

if (q.get("view") === "swaps") {
  const row = Number(q.get("dir") ?? 0);
  for (const gender of GENDERS) {
    const h = document.createElement("h3"); h.textContent = `${gender === "M" ? "Male" : "Female"}: jobs x hair styles`; out.append(h);
    for (const [j, job] of JOBS.entries()) {
      const r = document.createElement("div"); r.className = "row"; out.append(r);
      for (let s = 0; s < HAIR_STYLES.length; s++)
        await composite(canvas(r, `${job} · ${HAIR_STYLES[s].label}`), lookOf(gender, job, s, (s + j * 2 + (gender === "F" ? 3 : 0)) % HAIR_COLORS.length), row);
    }
  }
} else {
  for (const gender of GENDERS) for (const job of JOBS) {
    const look = lookOf(gender, job, 0, gender === "M" ? 0 : 3);
    const p = await layerParts(look);
    const h = document.createElement("h3"); h.textContent = `${gender === "M" ? "Male" : "Female"} ${job}: base + outfit + hair + weapon = composited`; out.append(h);
    const r = document.createElement("div"); r.className = "row"; out.append(r);
    if (!p) { h.textContent += " (no layered art)"; continue; }
    for (const facing of [0, 1, 2]) {
      const parts: [string, typeof p.base | null][] = [["base", p.base], ["outfit", p.outfit], ["hair", p.hair], ["weapon", p.weapon]];
      for (const [i, [label, s]] of parts.entries()) {
        const g = canvas(r, facing === 0 ? label : undefined);
        if (s) {
          const m = s.meta, k = (K * 160) / m.unit;
          g.drawImage(s.img, 0, facing * m.cellH, m.cellW, m.cellH, W / 2 - (m.cellW * k) / 2, H - 6 - (m.cellH - 2) * k, m.cellW * k, m.cellH * k);
        }
        op(r, i < 3 ? "+" : "=");
      }
      await composite(canvas(r, facing === 0 ? "composited" : undefined), look, facing);
    }
  }
}
document.body.dataset.ready = "1";
