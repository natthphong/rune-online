// Dev-only lab: every animation of every player look / monster, all 8 directions, playing. http://localhost:5173/dev/anims.html
// (still frames of every paper-doll part: /dev/paperdoll.html)
import { Composer, MOB, PC, facing, type Kind } from "../src/animSprite.ts";
import { START_JOBS, START_WEAPON, outfitOf, type Look } from "../../shared/look.ts";

type Cell = { comp: Composer; kind: Kind; want: () => [string, number[]]; loop: number; g: CanvasRenderingContext2D; dir: number; unit: number };
const cells: Cell[] = [];
const out = document.getElementById("out")!;

async function section(title: string, kind: Kind, what: string | Look, states: [string, Cell["want"], number][]) {
  const comp = new Composer(kind);
  if (typeof what === "string") await comp.load(what, what); else await comp.loadLook(what);
  const h = document.createElement("h3"); h.textContent = title; out.append(h);
  for (const [label, want, loop] of states) {
    const row = document.createElement("div"); row.className = "row"; out.append(row);
    for (let dir = 0; dir < 8; dir++) {
      const cv = document.createElement("canvas"); cv.width = 150; cv.height = 170;
      const fig = document.createElement("figure"); fig.append(cv);
      if (dir === 0) { const c = document.createElement("figcaption"); c.textContent = label; fig.append(c); }
      row.append(fig);
      cells.push({ comp, kind, want, loop, g: cv.getContext("2d")!, dir, unit: kind === PC ? 160 : 120 });
    }
  }
}

const pcStates: [string, Cell["want"], number][] = [
  ["walk", () => PC.walk, 0.66], ["attack", () => PC.attack(""), 0.6], ["idle", () => PC.idle, 1], ["sit", () => PC.sit, 1],
  ["hurt", () => PC.hurt, 1], ["dead", () => PC.dead, 1]];
const q = new URLSearchParams(location.search);
// ?job=Mage shows one job; default: every starting job, the boy with a hat + shield, the girl with a hood
if (!q.get("mob")) for (const job of q.get("job") ? [q.get("job")!] : START_JOBS) {
  const base = { job, outfit: outfitOf(job), weapon: START_WEAPON[job] ?? "sword" };
  await section(`Male ${job} · hat + guard`, PC, { ...base, gender: "M", hair: 2, style: 0, headgear: "hat", shield: "guard" }, pcStates);
  await section(`Female ${job} · hood`, PC, { ...base, gender: "F", hair: 4, style: 3, garment: "hood" }, pcStates);
}
// ?mob=1093,1090 shows those species instead of the default set (C14 species are checked this way)
for (const id of (q.get("mob")?.split(",") ?? ["1002", "1113", "1063", "1240", "1010", "1009", "1012", "1167"]))
  await section(`mob ${id}`, MOB, `mob_${id}`, [["move", () => MOB.walk, 0.6], ["attack", () => MOB.attack(""), 0.6], ["hurt / dead", () => (Math.floor(performance.now() / 1200) % 2 ? MOB.dead : MOB.hurt), 1]]);

function frame(now: number) {
  for (const c of cells) {
    const rel = c.dir <= 4 ? (c.dir * Math.PI) / 4 : -((8 - c.dir) * Math.PI) / 4;
    const { row, mirror } = facing(rel, c.kind.rows);
    const f = c.comp.pick(c.want(), ((now / 1000) % c.loop) / c.loop);
    c.g.clearRect(0, 0, 150, 170);
    if (f) c.comp.draw(c.g, f, row, mirror, (0.8 * c.unit) / f.s.meta.unit, 75, 160);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
