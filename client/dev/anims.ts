// Dev-only lab: every animation of every body/monster, all 8 directions, plus gear layers. http://localhost:5173/dev/anims.html
import { Composer, MOB, PC, facing, type Kind } from "../src/animSprite.ts";
import { HAIR_COLORS, JOB_OUTFITS } from "../../shared/look.ts";

type Cell = { comp: Composer; kind: Kind; want: () => [string, number[]]; loop: number; g: CanvasRenderingContext2D; dir: number; unit: number;
  layers: { slot: "headgear" | "garment" | "shield"; key: string }[] };
const cells: Cell[] = [];
const out = document.getElementById("out")!;

async function section(title: string, kind: Kind, body: string, hair: string | undefined, gear: Cell["layers"], states: [string, Cell["want"], number][]) {
  const comp = new Composer(kind);
  await comp.load(body, hair, gear.map((l) => l.key), kind === MOB ? body : undefined);
  const h = document.createElement("h3"); h.textContent = title; out.append(h);
  for (const [label, want, loop] of states) {
    const row = document.createElement("div"); row.className = "row"; out.append(row);
    for (let dir = 0; dir < 8; dir++) {
      const cv = document.createElement("canvas"); cv.width = 130; cv.height = 150;
      const fig = document.createElement("figure"); fig.append(cv);
      if (dir === 0) { const c = document.createElement("figcaption"); c.textContent = label; fig.append(c); }
      row.append(fig);
      cells.push({ comp, kind, want, loop, g: cv.getContext("2d")!, dir, unit: kind === PC ? 160 : 120, layers: gear });
    }
  }
}

const pcStates = (w: string): [string, Cell["want"], number][] => [
  ["walk", () => PC.walk, 0.66], [`attack (${w})`, () => PC.attack(w), 0.6], ["idle", () => PC.idle, 1], ["sit", () => PC.sit, 1],
  ["hurt", () => PC.hurt, 1], ["dead", () => PC.dead, 1]];
await section("Male novice · blade · hat + guard", PC, "pc_M_novice", HAIR_COLORS[2], [{ slot: "shield", key: "guard" }, { slot: "headgear", key: "hat" }], pcStates("blade"));
await section("Female novice · fist · hood", PC, "pc_F_novice", HAIR_COLORS[4], [{ slot: "garment", key: "hood" }], pcStates("fist"));
// job outfits (shared/look.ts JOB_OUTFITS): both genders, novice-free
for (const outfit of new Set(Object.values(JOB_OUTFITS)))
  for (const [g, hair] of [["M", HAIR_COLORS[0]], ["F", HAIR_COLORS[3]]] as const)
    await section(`${g === "M" ? "Male" : "Female"} ${outfit}`, PC, `pc_${g}_${outfit}`, hair, [], pcStates(g === "M" ? "blade" : "fist"));
// ?mob=1093,1090 shows those species instead of the default set (C14 species are checked this way)
for (const id of (new URLSearchParams(location.search).get("mob")?.split(",") ?? ["1002", "1113", "1063", "1240", "1010", "1009", "1012", "1167"]))
  await section(`mob ${id}`, MOB, `mob_${id}`, undefined, [], [["move", () => MOB.walk, 0.6], ["attack", () => MOB.attack(""), 0.6], ["hurt / dead", () => (Math.floor(performance.now() / 1200) % 2 ? MOB.dead : MOB.hurt), 1]]);

function frame(now: number) {
  for (const c of cells) {
    const rel = c.dir <= 4 ? (c.dir * Math.PI) / 4 : -((8 - c.dir) * Math.PI) / 4;
    const { row, mirror } = facing(rel, c.kind.rows);
    const f = c.comp.pick(c.want(), ((now / 1000) % c.loop) / c.loop);
    c.g.clearRect(0, 0, 130, 150);
    if (f) c.comp.draw(c.g, f, row, mirror, (0.8 * c.unit) / f.s.meta.unit, c.layers, 65, 144);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
