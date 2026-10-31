// Hearthmoor's buildings and street furniture (W01 r2), drawn from the shared layout (shared/town.ts -> GameMap.town): every
// blocked cell of the town shows what blocks it. Our own procedural meshes in the painted props' manner (props.ts): stacked
// stone (prop_rock.jpg) for foundations, the town wall, towers, the fountain and the chapel; cream plaster with timber framing,
// shuttered windows, plank doors and tiled gable roofs for the houses; striped cloth for awnings and market stalls; painted
// signboards with the shop names and, at the four gates, the field behind each gate and its level band. Plaster, roof tiles,
// planks and cloth are painted at load into small canvas textures (no image files). One merged mesh per material; every
// solid uses the props' see-through (the player and nearby NPCs are never hidden behind a house) and deep shadows.
import * as THREE from "three";
import type { Building, GameMap, TownDecor } from "../../shared/map.ts";
import { Solid, deepShadow, patched, rng, seeThrough, tex, type Props, type V3 } from "./props.ts";

const time = { value: 0 };

// ---------- painted canvas textures ----------
function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, n: number, r: () => number) => void, seed: number) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size, rng(seed));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
/** soft blotches (the painted look): n dabs of a colour at low alpha */
function dabs(g: CanvasRenderingContext2D, n: number, size: number, r: () => number, rgb: string, a: number, rad: number) {
  for (let i = 0; i < n; i++) {
    const x = r() * size, y = r() * size, rr = rad * (0.4 + r());
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) { g.save(); g.translate(ox, oy); g.fillRect(x - rr, y - rr, rr * 2, rr * 2); g.restore(); }
  }
}
let T: { plaster: THREE.Texture; roof: THREE.Texture; plank: THREE.Texture; cloth: THREE.Texture } | undefined;
function textures() {
  if (T) return T;
  const plaster = canvasTex(256, (g, n, r) => {
    g.fillStyle = "#efe6d2"; g.fillRect(0, 0, n, n);
    dabs(g, 160, n, r, "190,170,140", 0.08, 40);
    dabs(g, 120, n, r, "255,252,240", 0.1, 30);
    dabs(g, 40, n, r, "150,135,110", 0.06, 14);
  }, 11);
  const roof = canvasTex(256, (g, n, r) => {
    g.fillStyle = "#5a524c"; g.fillRect(0, 0, n, n);
    const rows = 8, cols = 6, rh = n / rows, cw = n / cols;
    for (let j = 0; j < rows; j++) for (let i = -1; i <= cols; i++) {
      const x = i * cw + (j % 2) * cw * 0.5, y = j * rh, l = 0.82 + r() * 0.18;
      const gr = g.createLinearGradient(0, y, 0, y + rh * 1.15);
      gr.addColorStop(0, `rgb(${150 * l},${142 * l},${134 * l})`); gr.addColorStop(0.7, `rgb(${222 * l},${214 * l},${204 * l})`); gr.addColorStop(1, `rgb(${120 * l},${112 * l},${104 * l})`);
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(x + 2, y); g.lineTo(x + cw - 2, y); g.lineTo(x + cw - 2, y + rh * 0.75);
      g.quadraticCurveTo(x + cw * 0.5, y + rh * 1.18, x + 2, y + rh * 0.75); g.closePath(); g.fill();
    }
    dabs(g, 60, n, r, "90,80,60", 0.08, 30);
  }, 23);
  const plank = canvasTex(256, (g, n, r) => {
    const k = 4, pw = n / k;
    for (let i = 0; i < k; i++) {
      const l = 0.85 + r() * 0.2;
      g.fillStyle = `rgb(${200 * l},${172 * l},${136 * l})`; g.fillRect(i * pw, 0, pw, n);
      g.strokeStyle = "rgba(90,60,35,0.35)"; g.lineWidth = 1.5;
      for (let s = 0; s < 7; s++) { const x = i * pw + 6 + r() * (pw - 12); g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + 4, n * 0.3, x - 4, n * 0.6, x + 2, n); g.stroke(); }
      g.fillStyle = "rgba(50,30,15,0.8)"; g.fillRect(i * pw, 0, 3, n);
    }
    dabs(g, 40, n, r, "80,50,30", 0.08, 24);
  }, 37);
  const cloth = canvasTex(128, (g, n, r) => {
    const k = 8, sw = n / k;
    for (let i = 0; i < k; i++) { g.fillStyle = i % 2 ? "#f4efe2" : "#ffffff"; g.fillRect(i * sw, 0, sw, n); }
    for (let i = 0; i < k; i += 2) { g.fillStyle = "rgba(0,0,0,0.0)"; }
    dabs(g, 30, n, r, "120,110,90", 0.08, 16);
  }, 41);
  T = { plaster, roof, plank, cloth };
  return T;
}
/** A signboard's painted face: parchment board, dark border, the lines centred (the first one big), an arrow if `dir`. */
function signTex(lines: string[], dir?: "N" | "E" | "S" | "W") {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 192;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e9d8b0"; g.fillRect(0, 0, 512, 192);
  const gr = g.createRadialGradient(256, 96, 40, 256, 96, 300);
  gr.addColorStop(0, "rgba(255,250,230,0.5)"); gr.addColorStop(1, "rgba(120,80,40,0.35)");
  g.fillStyle = gr; g.fillRect(0, 0, 512, 192);
  g.strokeStyle = "#5b3a1e"; g.lineWidth = 10; g.strokeRect(5, 5, 502, 182);
  g.fillStyle = "#3b2412"; g.textAlign = "center"; g.textBaseline = "middle";
  const arrow = dir ? { W: "◀", E: "▶", N: "▲", S: "▼" }[dir] : "";
  const big = lines.length > 1 ? 54 : 60;
  g.font = `bold ${big}px Georgia, 'Times New Roman', serif`;
  const first = arrow ? (dir === "E" ? `${lines[0]} ${arrow}` : `${arrow} ${lines[0]}`) : lines[0];
  let w = g.measureText(first).width;
  if (w > 470) g.font = `bold ${Math.floor(big * 470 / w)}px Georgia, 'Times New Roman', serif`;
  g.fillText(first, 256, lines.length > 1 ? 72 : 98);
  if (lines[1]) { g.font = "bold 40px Georgia, 'Times New Roman', serif"; w = g.measureText(lines[1]).width; g.fillText(lines[1], 256, 140); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------- geometry ----------
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crs = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** A Solid with boxes, quads, triangles and cylinders in world units (uv = world units / `uvs`). */
class Geo extends Solid {
  readonly uvs: number;
  constructor(uvs = 1) { super(); this.uvs = uvs; }
  /** a flat polygon (3 or 4 points), wound to face `n`; uv from the given per-point pairs */
  poly(p: V3[], n: V3, uv: [number, number][], col: V3) {
    const ids = p.map((q, i) => this.vert(q, n, uv[i][0], uv[i][1], col));
    const front = dot(crs(sub(p[1], p[0]), sub(p[2], p[0])), n) >= 0;
    for (let i = 1; i + 1 < ids.length; i++) front ? this.tri(ids[0], ids[i], ids[i + 1]) : this.tri(ids[0], ids[i + 1], ids[i]);
  }
  /** an axis-aligned box x0..x1 (world x), y0..y1 (up), z0..z1 (world z = map y), no bottom */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: V3, top = true) {
    const u = this.uvs;
    const P = (x: number, y: number, z: number): V3 => [x, y, z];
    this.poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], [0, 0, 1], [[x0 / u, y0 / u], [x1 / u, y0 / u], [x1 / u, y1 / u], [x0 / u, y1 / u]], col);
    this.poly([P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0)], [0, 0, -1], [[-x1 / u, y0 / u], [-x0 / u, y0 / u], [-x0 / u, y1 / u], [-x1 / u, y1 / u]], col);
    this.poly([P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1)], [1, 0, 0], [[-z1 / u, y0 / u], [-z0 / u, y0 / u], [-z0 / u, y1 / u], [-z1 / u, y1 / u]], col);
    this.poly([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], [-1, 0, 0], [[z0 / u, y0 / u], [z1 / u, y0 / u], [z1 / u, y1 / u], [z0 / u, y1 / u]], col);
    if (top) this.poly([P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)], [0, 1, 0], [[x0 / u, z1 / u], [x1 / u, z1 / u], [x1 / u, z0 / u], [x0 / u, z0 / u]], col);
  }
  /** a box centred on (x, z) with half sizes */
  boxC(x: number, z: number, hx: number, hz: number, y0: number, y1: number, col: V3, top = true) { this.box(x - hx, x + hx, y0, y1, z - hz, z + hz, col, top); }
  /** a (tapered) cylinder side from y0 (radius r0) to y1 (r1), optionally capped on top; `inward` flips it (a basin's inner wall) */
  cyl(x: number, z: number, y0: number, y1: number, r0: number, r1: number, seg: number, col: V3, cap = true, inward = false) {
    const u = this.uvs, base = this.p.length / 3, s = inward ? -1 : 1;
    for (const [y, r] of [[y0, r0], [y1, r1]]) for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      this.vert([x + c * r, y, z + sn * r], [c * s, 0, sn * s], (j / seg) * Math.max(1, Math.round((r0 + r1) * Math.PI / u)), y / u, col);
    }
    for (let j = 0; j < seg; j++) {
      const a0 = base + j, a1 = a0 + 1, b0 = a0 + seg + 1, b1 = b0 + 1;
      if (inward) { this.tri(a0, b1, a1); this.tri(a0, b0, b1); } else { this.tri(a0, a1, b1); this.tri(a0, b1, b0); }
    }
    if (cap) this.disc(x, z, y1, r1, seg, col);
  }
  /** a flat disc (or annulus from r0) facing up */
  disc(x: number, z: number, y: number, r: number, seg: number, col: V3, r0 = 0) {
    const u = this.uvs;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2, b = ((j + 1) / seg) * Math.PI * 2;
      const o = (ang: number, rr: number): V3 => [x + Math.cos(ang) * rr, y, z + Math.sin(ang) * rr];
      const pts = r0 > 0 ? [o(a, r0), o(a, r), o(b, r), o(b, r0)] : [[x, y, z] as V3, o(a, r), o(b, r)];
      this.poly(pts, [0, 1, 0], pts.map((q) => [q[0] / u, q[2] / u] as [number, number]), col);
    }
  }
  /** a pyramid / cone roof: apex height h over a regular polygon of `seg` sides, radius r, at y */
  cone(x: number, z: number, y: number, r: number, h: number, seg: number, col: V3, spin = 0) {
    const apex: V3 = [x, y + h, z], u = this.uvs;
    for (let j = 0; j < seg; j++) {
      const a = spin + (j / seg) * Math.PI * 2, b = spin + ((j + 1) / seg) * Math.PI * 2;
      const p0: V3 = [x + Math.cos(a) * r, y, z + Math.sin(a) * r], p1: V3 = [x + Math.cos(b) * r, y, z + Math.sin(b) * r];
      const mid = (a + b) / 2, n = nrm([Math.cos(mid) * h, r, Math.sin(mid) * h]);
      const w = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), sl = Math.hypot(r, h);
      this.poly([p0, p1, apex], n, [[0, 0], [w / u, 0], [w / u / 2, sl / u]], col);
    }
  }
}

// ---------- materials ----------
type Mats = Record<"stone" | "plaster" | "roof" | "plank" | "bark" | "cloth" | "plain", THREE.Material> & { glow: THREE.Material; water: THREE.MeshLambertMaterial; curtain: THREE.ShaderMaterial };
let M: Mats | undefined;
function mats(): Mats {
  if (M) return M;
  const t = textures();
  const lam = (key: string, map?: THREE.Texture, side: THREE.Side = THREE.FrontSide) =>
    patched(new THREE.MeshLambertMaterial({ map, vertexColors: true, side }), `town-${key}`, seeThrough, deepShadow);
  const waterMap = new THREE.TextureLoader().load("/textures/ground_water.jpg");
  waterMap.colorSpace = THREE.SRGBColorSpace; waterMap.wrapS = waterMap.wrapT = THREE.RepeatWrapping; waterMap.repeat.set(0.5, 0.5);
  M = {
    stone: lam("stone", tex("prop_rock.jpg", true)), plaster: lam("plaster", t.plaster), roof: lam("roof", t.roof), plank: lam("plank", t.plank),
    bark: lam("bark", tex("prop_bark.jpg", true)), cloth: lam("cloth", t.cloth, THREE.DoubleSide), plain: lam("plain"),
    glow: patched(new THREE.MeshBasicMaterial({ vertexColors: true }), "town-glow", seeThrough),
    water: new THREE.MeshLambertMaterial({ map: waterMap, color: "#9fd6e8", transparent: true, opacity: 0.88 }),
    curtain: new THREE.ShaderMaterial({
      uniforms: { uTime: time },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUv;
        void main() {
          float streak = 0.55 + 0.45 * sin(vUv.x * 6.2832 * 14.0 + sin(vUv.x * 40.0) * 2.0);
          float flow = 0.6 + 0.4 * sin(vUv.y * 22.0 + uTime * 7.0 + vUv.x * 30.0);
          float a = streak * flow * (0.25 + 0.35 * vUv.y);
          gl_FragColor = vec4(vec3(0.82, 0.94, 1.0), a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }),
  };
  return M;
}

// palettes
const ROOFS: V3[] = [[0.78, 0.38, 0.27], [0.36, 0.47, 0.66], [0.42, 0.56, 0.36], [0.55, 0.38, 0.27]]; // terracotta, slate, moss, brown
const SHUTTERS: V3[] = [[0.35, 0.55, 0.42], [0.62, 0.32, 0.26], [0.3, 0.42, 0.6], [0.55, 0.45, 0.25]];
const CLOTH: V3[] = [[0.86, 0.3, 0.26], [0.3, 0.48, 0.82], [0.36, 0.66, 0.36], [0.92, 0.74, 0.28]];
const WOOD: V3 = [0.62, 0.46, 0.32], DARKWOOD: V3 = [0.42, 0.3, 0.2], IRON: V3 = [0.16, 0.16, 0.18], GLASS: V3 = [0.16, 0.19, 0.25];
const WHITE: V3 = [1, 1, 1];
const shade = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];

type Ctx = {
  g: Record<keyof Omit<Mats, "water" | "curtain">, Geo>; group: THREE.Group; cups: { x: number; y: number; z: number }[];
  props: Props; ground: number; covered: Set<number>; w: number;
};

// ---------- buildings ----------
const FOUND = 0.35, FLOOR = 1.85;
/** A point on one side of a box: `along` = world coordinate along the side, `out` = distance out of the wall plane. */
function sideFrame(side: Building["face"], X0: number, X1: number, Z0: number, Z1: number) {
  const n: V3 = side === "S" ? [0, 0, 1] : side === "N" ? [0, 0, -1] : side === "E" ? [1, 0, 0] : [-1, 0, 0];
  const along = side === "S" || side === "N" ? [X0, X1] : [Z0, Z1];
  const at = (a: number, y: number, out: number): V3 =>
    side === "S" ? [a, y, Z1 + out] : side === "N" ? [a, y, Z0 - out] : side === "E" ? [X1 + out, y, a] : [X0 - out, y, a];
  // a flat rectangle on the side: along a0..a1, up y0..y1, `out` from the wall
  const rect = (geo: Geo, a0: number, a1: number, y0: number, y1: number, out: number, col: V3) => {
    const u = geo.uvs;
    geo.poly([at(a0, y0, out), at(a1, y0, out), at(a1, y1, out), at(a0, y1, out)], n, [[a0 / u, y0 / u], [a1 / u, y0 / u], [a1 / u, y1 / u], [a0 / u, y1 / u]], col);
  };
  // a small box standing out of the side: along a0..a1, up y0..y1, from out0 to out1
  const block = (geo: Geo, a0: number, a1: number, y0: number, y1: number, out0: number, out1: number, col: V3) => {
    const p = at(a0, y0, out0), q = at(a1, y1, out1);
    geo.box(Math.min(p[0], q[0]), Math.max(p[0], q[0]), y0, y1, Math.min(p[2], q[2]), Math.max(p[2], q[2]), col);
  };
  return { n, along, at, rect, block };
}

function building(c: Ctx, b: Building, seed: number) {
  const r = rng(seed), g = c.g;
  const X0 = b.x0 - 0.45, X1 = b.x1 + 0.45, Z0 = b.y0 - 0.45, Z1 = b.y1 + 0.45, base = c.ground;
  const stoneAll = b.kind === "chapel", stoneLow = stoneAll || b.kind === "guild" || b.kind === "smithy";
  const plaster: V3 = [[1, 0.97, 0.9], [1, 0.93, 0.83], [0.97, 0.97, 0.93]][Math.floor(r() * 3)] as V3;
  const roofCol = ROOFS[b.roof % ROOFS.length], shutter = SHUTTERS[(b.roof + 1 + Math.floor(r() * 2)) % SHUTTERS.length];
  // foundation
  g.stone.box(X0 - 0.08, X1 + 0.08, base - 0.1, base + FOUND, Z0 - 0.08, Z1 + 0.08, [0.82, 0.8, 0.76]);
  let top = base + FOUND;
  for (let f = 0; f < b.floors; f++) {
    const y0 = top, y1 = top + FLOOR, j = f > 0 ? 0.1 : 0; // the upper storey juts out a little
    const x0 = X0 - j, x1 = X1 + j, z0 = Z0 - j, z1 = Z1 + j;
    const stone = stoneAll || (stoneLow && f === 0);
    (stone ? g.stone : g.plaster).box(x0, x1, y0, y1, z0, z1, stone ? [0.95, 0.92, 0.86] : plaster, false);
    if (!stone) { // timber frame: corner posts, a beam round the top, studs
      for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) g.bark.boxC(px, pz, 0.1, 0.1, y0, y1, DARKWOOD);
      for (const s of ["N", "S", "E", "W"] as const) {
        const F = sideFrame(s, x0, x1, z0, z1);
        F.block(g.bark, F.along[0], F.along[1], y1 - 0.14, y1, -0.02, 0.05, DARKWOOD);
        F.block(g.bark, F.along[0], F.along[1], y0, y0 + 0.12, -0.02, 0.05, DARKWOOD);
      }
    }
    // windows (and the door on the front's ground floor)
    for (const s of ["N", "S", "E", "W"] as const) {
      const F = sideFrame(s, x0, x1, z0, z1), [a0, a1] = F.along, L = a1 - a0, n = Math.max(1, Math.floor(L / 1.8));
      for (let k = 0; k < n; k++) {
        const a = a0 + (L * (k + 0.5)) / n;
        if (s === b.face && f === 0 && Math.abs(a - b.door) < 1.1) continue;
        if (s !== b.face && s !== "S" && r() < 0.35) continue; // fewer windows on the sides and the back
        const wy = y0 + 0.7, wh = 0.72, ww = 0.3;
        F.rect(g.plain, a - ww, a + ww, wy, wy + wh, 0.02, GLASS);
        F.block(g.bark, a - ww - 0.06, a + ww + 0.06, wy + wh, wy + wh + 0.07, 0, 0.07, DARKWOOD);
        F.block(g.bark, a - ww - 0.08, a + ww + 0.08, wy - 0.08, wy, 0, 0.12, DARKWOOD);
        F.block(g.bark, a - 0.03, a + 0.03, wy, wy + wh, 0, 0.04, DARKWOOD);
        F.block(g.plank, a - ww - 0.3, a - ww - 0.02, wy - 0.02, wy + wh + 0.02, 0.01, 0.05, shutter);
        F.block(g.plank, a + ww + 0.02, a + ww + 0.3, wy - 0.02, wy + wh + 0.02, 0.01, 0.05, shutter);
        if (!stone && k + 1 < n && r() < 0.6) { // a diagonal-free stud between two windows
          const sa = a0 + (L * (k + 1)) / n;
          F.block(g.bark, sa - 0.06, sa + 0.06, y0, y1, -0.01, 0.04, DARKWOOD);
        }
        if (f === 0 && b.kind !== "smithy" && r() < 0.45) c.props.plant(F.at(a, 0, 0.4)[0], F.at(a, 0, 0.4)[2], base, "flower", 0.42, seed + k * 7);
      }
    }
    top = y1;
  }
  // the door: planks in a frame, a step, and over it the shop's awning or sign
  const F = sideFrame(b.face, X0, X1, Z0, Z1), dy0 = base + FOUND, dh = b.kind === "guild" || b.kind === "chapel" ? 1.75 : 1.5, dw = b.kind === "guild" ? 0.65 : 0.46;
  F.rect(g.plank, b.door - dw, b.door + dw, dy0, dy0 + dh, 0.03, b.kind === "chapel" ? [0.7, 0.5, 0.35] : WOOD);
  F.block(g.stone, b.door - dw - 0.16, b.door - dw, dy0, dy0 + dh + 0.1, 0, 0.1, [0.9, 0.88, 0.82]);
  F.block(g.stone, b.door + dw, b.door + dw + 0.16, dy0, dy0 + dh + 0.1, 0, 0.1, [0.9, 0.88, 0.82]);
  F.block(g.stone, b.door - dw - 0.16, b.door + dw + 0.16, dy0 + dh, dy0 + dh + 0.18, 0, 0.12, [0.9, 0.88, 0.82]);
  F.block(g.stone, b.door - dw - 0.25, b.door + dw + 0.25, base - 0.05, dy0, 0, 0.45, [0.85, 0.83, 0.78]);
  if (b.kind === "shop" || b.kind === "smithy" || b.kind === "inn") { // striped awning over the door and its windows
    const ay = dy0 + dh + 0.35, cl = CLOTH[(b.roof + 2) % CLOTH.length], half = 1.4;
    const p0 = F.at(b.door - half, ay + 0.35, 0), p1 = F.at(b.door + half, ay + 0.35, 0), p2 = F.at(b.door + half, ay - 0.15, 1.0), p3 = F.at(b.door - half, ay - 0.15, 1.0);
    g.cloth.poly([p0, p1, p2, p3], nrm([F.n[0], 2, F.n[2]]), [[0, 1], [2.8, 1], [2.8, 0], [0, 0]], cl);
    for (const e of [-half, half]) F.block(g.bark, b.door + e - 0.03, b.door + e + 0.03, ay - 0.15, ay + 0.35, 0.95, 1.0, IRON);
  }
  if (b.sign) signBoard(c, F, b.door, dy0 + dh + (b.kind === "shop" || b.kind === "smithy" || b.kind === "inn" ? 0.95 : 0.35), [b.sign]);
  if (b.kind === "inn") for (const e of [-0.8, 0.8]) lantern(c, F.at(b.door + e, dy0 + 1.55, 0.18), r);
  if (b.kind === "guild") { // the six guilds' banners on the front
    const bc: V3[] = [[0.75, 0.2, 0.2], [0.35, 0.3, 0.8], [0.3, 0.62, 0.3], [0.92, 0.88, 0.75], [0.85, 0.65, 0.2], [0.3, 0.3, 0.32]];
    const L = X1 - X0;
    bc.forEach((col, k) => {
      const a = X0 + (L * (k + 0.5)) / 6;
      if (Math.abs(a - b.door) < 1.0) return;
      const yt = base + FOUND + FLOOR * 2 - 0.25;
      F.rect(g.cloth, a - 0.28, a + 0.28, yt - 1.5, yt, 0.07, col);
      F.block(g.bark, a - 0.36, a + 0.36, yt, yt + 0.06, 0.04, 0.1, DARKWOOD);
    });
  }
  roof(c, b, X0, X1, Z0, Z1, top, roofCol, plaster, stoneAll, r);
  if (b.kind === "chapel") bellTower(c, b, X0, X1, Z0, Z1, top, roofCol);
}

/** A gable roof along the building's long side, with fascia boards, a ridge cap, plastered gable ends and a chimney. */
function roof(c: Ctx, b: Building, X0: number, X1: number, Z0: number, Z1: number, eave: number, col: V3, wall: V3, stone: boolean, r: () => number) {
  const g = c.g, alongX = X1 - X0 >= Z1 - Z0, o = 0.4, og = 0.3;
  const j = b.floors > 1 ? 0.1 : 0;
  const [a0, a1] = alongX ? [X0 - j - og, X1 + j + og] : [Z0 - j - og, Z1 + j + og];
  const [s0, s1] = alongX ? [Z0 - j, Z1 + j] : [X0 - j, X1 + j];
  const half = (s1 - s0) / 2, mid = (s0 + s1) / 2, rise = Math.min(2.3, Math.max(1.1, half * 0.78)), ridge = eave + rise, ey = eave - 0.12;
  const P = (a: number, y: number, s: number): V3 => (alongX ? [a, y, s] : [s, y, a]);
  const slope = Math.hypot(half + o, rise + 0.12), u = g.roof.uvs;
  for (const side of [-1, 1]) {
    const se = side > 0 ? s1 + o : s0 - o;
    const n = nrm(alongX ? [0, half + o, side * (rise + 0.12)] : [side * (rise + 0.12), half + o, 0]);
    g.roof.poly([P(a0, ey, se), P(a1, ey, se), P(a1, ridge, mid), P(a0, ridge, mid)], n, [[a0 / u, 0], [a1 / u, 0], [a1 / u, slope / u], [a0 / u, slope / u]], col);
    // the underside (seen at the eaves), dark
    g.plain.poly([P(a0, ey - 0.02, se), P(a1, ey - 0.02, se), P(a1, ridge - 0.02, mid), P(a0, ridge - 0.02, mid)], [-n[0], -n[1], -n[2]], [[0, 0], [1, 0], [1, 1], [0, 1]], [0.25, 0.2, 0.17]);
    // fascia along the eave
    const fa = P(a0, ey - 0.16, se), fb = P(a1, ey + 0.02, se);
    g.bark.box(Math.min(fa[0], fb[0]) - (alongX ? 0 : 0.05), Math.max(fa[0], fb[0]) + (alongX ? 0 : 0.05), ey - 0.16, ey + 0.02, Math.min(fa[2], fb[2]) - (alongX ? 0.05 : 0), Math.max(fa[2], fb[2]) + (alongX ? 0.05 : 0), DARKWOOD);
  }
  const rc = shade(col, 0.7), ra = P(a0, ridge - 0.05, mid - 0.13), rb = P(a1, ridge + 0.12, mid + 0.13);
  g.roof.box(Math.min(ra[0], rb[0]), Math.max(ra[0], rb[0]), ridge - 0.05, ridge + 0.12, Math.min(ra[2], rb[2]), Math.max(ra[2], rb[2]), rc);
  // gable ends: in the wall planes
  for (const e of [a0 + og, a1 - og]) {
    const n: V3 = alongX ? [e > (a0 + a1) / 2 ? 1 : -1, 0, 0] : [0, 0, e > (a0 + a1) / 2 ? 1 : -1];
    const geo = stone ? g.stone : g.plaster;
    const tri: V3[] = [P(e, eave, s0), P(e, eave, s1), P(e, ridge, mid)], uu = geo.uvs;
    geo.poly(tri, n, tri.map((p) => [(alongX ? p[2] : p[0]) / uu, p[1] / uu] as [number, number]), stone ? [0.95, 0.92, 0.86] : wall);
    if (!stone) { // a king post and a collar beam on the gable
      const kp = P(e + n[0] * 0.03 + n[2] * 0.03, 0, mid);
      g.bark.boxC(alongX ? e + n[0] * 0.03 : kp[0], alongX ? mid : e + n[2] * 0.03, alongX ? 0.04 : 0.07, alongX ? 0.07 : 0.04, eave, ridge - 0.1, DARKWOOD);
    }
  }
  if (b.kind === "house" || b.kind === "inn" || b.kind === "smithy") { // chimney
    const ca = a0 + (a1 - a0) * (0.22 + r() * 0.15), cs = mid + (s1 - mid) * 0.45, cp = P(ca, 0, cs);
    const w = b.kind === "smithy" ? 0.42 : 0.3;
    g.stone.boxC(cp[0], cp[2], w, w, eave + rise * 0.3, ridge + 0.9, [0.78, 0.74, 0.7]);
    g.stone.boxC(cp[0], cp[2], w + 0.06, w + 0.06, ridge + 0.9, ridge + 1.02, [0.6, 0.58, 0.55]);
  }
}

/** The hearth chapel's bell tower at the front: stone, an open belfry, a slate spire with a gilt finial. */
function bellTower(c: Ctx, b: Building, X0: number, X1: number, Z0: number, Z1: number, eave: number, col: V3) {
  const g = c.g, hw = 0.95, F = sideFrame(b.face, X0, X1, Z0, Z1);
  const centre = F.at(b.door, 0, -hw + 0.15), top = eave + 2.6;
  g.stone.boxC(centre[0], centre[2], hw, hw, eave - 0.5, top, [0.95, 0.92, 0.86]);
  for (const s of ["N", "S", "E", "W"] as const) { // belfry openings
    const T = sideFrame(s, centre[0] - hw, centre[0] + hw, centre[2] - hw, centre[2] + hw), m = (T.along[0] + T.along[1]) / 2;
    T.rect(g.plain, m - 0.32, m + 0.32, top - 1.3, top - 0.35, 0.01, [0.12, 0.1, 0.1]);
    T.block(g.stone, T.along[0] - 0.05, T.along[1] + 0.05, top - 0.12, top, 0, 0.08, [0.85, 0.82, 0.78]);
  }
  g.roof.cone(centre[0], centre[2], top, hw * 1.45, 2.4, 4, col, Math.PI / 4);
  g.plain.cyl(centre[0], centre[2], top + 2.3, top + 2.75, 0.05, 0.05, 6, [0.95, 0.75, 0.3]);
  g.plain.boxC(centre[0], centre[2], 0.2, 0.04, top + 2.55, top + 2.62, [0.95, 0.75, 0.3]);
}

/** A signboard flat on a wall (plaques over doors): parchment face with the name. */
function signBoard(c: Ctx, F: ReturnType<typeof sideFrame>, along: number, y: number, lines: string[]) {
  const w = 1.25, h = 0.47;
  F.block(c.g.bark, along - w - 0.06, along + w + 0.06, y - h - 0.06, y + h + 0.06, 0, 0.08, DARKWOOD);
  const mat = new THREE.MeshLambertMaterial({ map: signTex(lines) });
  const geo = new THREE.PlaneGeometry(w * 2, h * 2), mesh = new THREE.Mesh(geo, mat), p = F.at(along, y, 0.09);
  mesh.position.set(p[0], p[1], p[2]);
  mesh.rotation.y = Math.atan2(F.n[0], F.n[2]);
  c.group.add(mesh);
}

/** A hanging iron lantern with warm panes. */
function lantern(c: Ctx, p: V3, _r: () => number) {
  c.g.plain.boxC(p[0], p[2], 0.13, 0.13, p[1] - 0.2, p[1] + 0.2, IRON);
  c.g.glow.boxC(p[0], p[2], 0.135, 0.135, p[1] - 0.14, p[1] + 0.14, [1, 0.82, 0.45], false);
  c.g.plain.cone(p[0], p[2], p[1] + 0.2, 0.2, 0.18, 4, IRON, Math.PI / 4);
}

// ---------- the town wall ----------
function townWall(c: Ctx, cx: number, cy: number, R: number, street: number) {
  const g = c.g, H = 2.7, T = 0.55, wallCol: V3 = [0.92, 0.89, 0.83];
  const lo = -R - 0.5, hi = R + 0.5, gap = street + 0.5;
  const tower = (x: number, z: number, big: boolean) => {
    const rad = big ? 1.3 : 1.1, h = big ? 4.6 : 4.1;
    g.stone.cyl(x, z, c.ground - 0.1, c.ground + h, rad, rad * 0.94, 16, wallCol, true);
    for (let k = 0; k < 8; k++) { // crenels round the top
      const a = (k / 8) * Math.PI * 2;
      g.stone.boxC(x + Math.cos(a) * rad * 0.85, z + Math.sin(a) * rad * 0.85, 0.2, 0.2, c.ground + h, c.ground + h + 0.35, wallCol);
    }
    g.roof.cone(x, z, c.ground + h + 0.3, rad * 1.15, big ? 2.4 : 2.0, 12, ROOFS[1]);
    g.plain.cyl(x, z, c.ground + h + (big ? 2.6 : 2.2), c.ground + h + (big ? 3.1 : 2.6), 0.03, 0.03, 5, IRON, false);
  };
  for (const side of ["N", "S", "W", "E"] as const) {
    const fixed = side === "N" ? cy - R : side === "S" ? cy + R : side === "W" ? cx - R : cx + R, c0 = side === "N" || side === "S" ? cx : cy;
    const seg = (a0: number, a1: number) => {
      const horiz = side === "N" || side === "S";
      const x0 = horiz ? c0 + a0 : fixed - T, x1 = horiz ? c0 + a1 : fixed + T, z0 = horiz ? fixed - T : c0 + a0, z1 = horiz ? fixed + T : c0 + a1;
      g.stone.box(x0, x1, c.ground - 0.1, c.ground + H, z0, z1, wallCol);
      for (let a = a0 + 0.3; a + 0.45 < a1; a += 0.9) { // merlons
        const mx0 = horiz ? c0 + a : fixed - T - 0.02, mx1 = horiz ? c0 + a + 0.45 : fixed + T + 0.02;
        const mz0 = horiz ? fixed - T - 0.02 : c0 + a, mz1 = horiz ? fixed + T + 0.02 : c0 + a + 0.45;
        g.stone.box(mx0, mx1, c.ground + H, c.ground + H + 0.4, mz0, mz1, wallCol);
      }
    };
    seg(lo, -gap - 0.3); seg(gap + 0.3, hi);
    // the gate: towers either side, a lintel with the town's banners over the road
    const P = (a: number): [number, number] => (side === "N" || side === "S" ? [c0 + a, fixed] : [fixed, c0 + a]);
    for (const s of [-1, 1]) { const [x, z] = P(s * (gap + 0.75)); tower(x, z, true); }
    const [lx0, lz0] = P(-gap - 0.5), [lx1, lz1] = P(gap + 0.5);
    g.stone.box(Math.min(lx0, lx1) - (side === "W" || side === "E" ? T : 0), Math.max(lx0, lx1) + (side === "W" || side === "E" ? T : 0), c.ground + 3.2, c.ground + 4.0,
      Math.min(lz0, lz1) - (side === "N" || side === "S" ? T : 0), Math.max(lz0, lz1) + (side === "N" || side === "S" ? T : 0), wallCol);
  }
  for (const [x, z] of [[cx - R, cy - R], [cx + R, cy - R], [cx - R, cy + R], [cx + R, cy + R]]) tower(x, z, false);
}

// ---------- street furniture ----------
function fountain(c: Ctx, x: number, z: number) {
  const g = c.g, y = c.ground, stone: V3 = [0.95, 0.93, 0.88];
  g.stone.cyl(x, z, y - 0.1, y + 0.6, 2.4, 2.4, 32, stone, false);
  g.stone.cyl(x, z, y + 0.2, y + 0.6, 2.0, 2.0, 32, stone, false, true);
  g.stone.disc(x, z, y + 0.6, 2.4, 32, [1, 0.98, 0.94], 2.0);
  g.stone.cyl(x, z, y + 0.3, y + 1.35, 0.45, 0.32, 12, stone, false);
  g.stone.cyl(x, z, y + 1.3, y + 1.6, 0.32, 1.05, 16, stone, false);
  g.stone.disc(x, z, y + 1.6, 1.05, 16, stone, 0.85);
  g.stone.cyl(x, z, y + 1.6, y + 2.3, 0.18, 0.14, 10, stone, false);
  g.stone.cyl(x, z, y + 2.25, y + 2.4, 0.14, 0.45, 12, stone, false);
  g.stone.cyl(x, z, y + 2.4, y + 2.7, 0.12, 0.05, 8, stone, true);
  const water = new THREE.Mesh(new THREE.CircleGeometry(2.02, 40).rotateX(-Math.PI / 2), mats().water);
  water.position.set(x, y + 0.45, z);
  const bowl = new THREE.Mesh(new THREE.CircleGeometry(0.88, 24).rotateX(-Math.PI / 2), mats().water);
  bowl.position.set(x, y + 1.56, z);
  const curtain = (r0: number, r1: number, y0: number, y1: number) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, y1 - y0, 32, 1, true), mats().curtain);
    m.position.set(x, (y0 + y1) / 2, z);
    m.renderOrder = 4;
    return m;
  };
  c.group.add(water, bowl, curtain(1.08, 1.4, y + 0.45, y + 1.6), curtain(0.46, 0.92, y + 1.6, y + 2.4));
}

function lampPost(c: Ctx, x: number, z: number) {
  const g = c.g, y = c.ground;
  g.plain.cyl(x, z, y - 0.05, y + 0.3, 0.17, 0.12, 8, IRON, true);
  g.plain.cyl(x, z, y + 0.3, y + 2.35, 0.06, 0.05, 8, IRON, false);
  g.plain.boxC(x, z, 0.16, 0.16, y + 2.35, y + 2.42, IRON);
  lantern(c, [x, y + 2.65, z], () => 0.5);
}

function stall(c: Ctx, x: number, z: number, tint: number) {
  const g = c.g, y = c.ground, cl = CLOTH[tint % CLOTH.length];
  for (const [px, pz] of [[-0.75, -0.42], [0.75, -0.42], [-0.75, 0.42], [0.75, 0.42]]) g.bark.boxC(x + px, z + pz, 0.05, 0.05, y, y + (pz < 0 ? 2.15 : 1.85), WOOD);
  g.plank.boxC(x, z + 0.1, 0.72, 0.28, y, y + 0.85, WOOD);
  g.cloth.poly([[x - 0.95, y + 2.2, z - 0.6], [x + 0.95, y + 2.2, z - 0.6], [x + 0.95, y + 1.75, z + 0.75], [x - 0.95, y + 1.75, z + 0.75]], nrm([0, 1.35, 0.45]), [[0, 1], [1.9, 1], [1.9, 0], [0, 0]], cl);
  const goods: V3[] = [[0.9, 0.3, 0.2], [0.95, 0.7, 0.2], [0.4, 0.7, 0.3], [0.7, 0.5, 0.8], [0.9, 0.85, 0.7]];
  for (let k = 0; k < 6; k++) {
    const gx = x - 0.55 + k * 0.22, gz = z + 0.1 + ((k * 37) % 5 - 2) * 0.04, col = goods[(k + tint) % goods.length];
    if (k % 2) g.plain.cyl(gx, gz, y + 0.85, y + 0.98, 0.09, 0.07, 8, col, true);
    else g.plain.boxC(gx, gz, 0.08, 0.08, y + 0.85, y + 1.0, col);
  }
}

function signpost(c: Ctx, x: number, z: number, lines: string[], dir: TownDecor["dir"]) {
  const g = c.g, y = c.ground;
  g.bark.boxC(x, z, 0.09, 0.09, y - 0.05, y + 2.75, DARKWOOD);
  g.bark.boxC(x, z, 1.25, 0.04, y + 1.62, y + 2.6, DARKWOOD);
  const tex = signTex(lines, dir), mat = new THREE.MeshLambertMaterial({ map: tex });
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), mat);
    m.position.set(x, y + 2.11, z + s * 0.05);
    if (s < 0) m.rotation.y = Math.PI;
    c.group.add(m);
  }
}

function decor(c: Ctx, d: TownDecor, all: Map<number, TownDecor>) {
  const g = c.g, y = c.ground, x = d.x, z = d.y, h = ((x * 73856093) ^ (z * 19349663)) >>> 0, r = rng(h + 1);
  switch (d.type) {
    case "fountain": return fountain(c, x, z);
    case "lamp": return lampPost(c, x, z);
    case "stall": return stall(c, x, z, d.tint ?? 0);
    case "signpost": return signpost(c, x, z, d.label ?? [], d.dir);
    case "bed": { // a stone planter full of flowers round a little shrub
      g.stone.boxC(x, z, 0.47, 0.47, y - 0.05, y + 0.38, [0.92, 0.9, 0.85], false);
      g.plain.disc(x, z, y + 0.33, 0.44, 4, [0.3, 0.22, 0.15]);
      c.props.bush(x, z, y + 0.35, 0.38, h);
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; c.props.plant(x + Math.cos(a) * 0.32, z + Math.sin(a) * 0.32, y + 0.33, "flower", 0.36, h + k); }
      return;
    }
    case "brazier": {
      g.stone.cyl(x, z, y - 0.05, y + 0.6, 0.22, 0.16, 10, [0.9, 0.87, 0.8], false);
      g.stone.cyl(x, z, y + 0.6, y + 0.95, 0.18, 0.42, 12, [0.9, 0.87, 0.8], false);
      g.plain.disc(x, z, y + 0.9, 0.38, 12, [0.25, 0.12, 0.06]);
      c.cups.push({ x, y: z, z: y + 1.05 });
      return;
    }
    case "well": {
      g.stone.cyl(x, z, y - 0.05, y + 0.75, 0.6, 0.6, 16, [0.9, 0.88, 0.82], false);
      g.stone.cyl(x, z, y + 0.2, y + 0.75, 0.44, 0.44, 16, [0.7, 0.68, 0.64], false, true);
      g.stone.disc(x, z, y + 0.75, 0.6, 16, [0.95, 0.93, 0.88], 0.44);
      g.plain.disc(x, z, y + 0.35, 0.44, 16, [0.1, 0.16, 0.2]);
      for (const s of [-1, 1]) g.bark.boxC(x + s * 0.55, z, 0.06, 0.06, y + 0.7, y + 1.9, DARKWOOD);
      g.bark.cyl(x - 0.55, z, y + 1.45, y + 1.45, 0.05, 0.05, 6, WOOD, false);
      g.plank.boxC(x, z, 0.62, 0.04, y + 1.4, y + 1.48, WOOD);
      g.roof.poly([[x - 0.75, y + 1.75, z - 0.6], [x + 0.75, y + 1.75, z - 0.6], [x + 0.75, y + 2.2, z], [x - 0.75, y + 2.2, z]], [0, 1, -0.8], [[0, 0], [1, 0], [1, 0.5], [0, 0.5]], ROOFS[0]);
      g.roof.poly([[x - 0.75, y + 1.75, z + 0.6], [x + 0.75, y + 1.75, z + 0.6], [x + 0.75, y + 2.2, z], [x - 0.75, y + 2.2, z]], [0, 1, 0.8], [[0, 0], [1, 0], [1, 0.5], [0, 0.5]], ROOFS[0]);
      return;
    }
    case "anvil": {
      g.bark.cyl(x, z, y - 0.05, y + 0.45, 0.3, 0.28, 10, WOOD, true);
      g.plain.boxC(x, z, 0.12, 0.09, y + 0.45, y + 0.62, IRON);
      g.plain.boxC(x, z, 0.32, 0.12, y + 0.62, y + 0.78, IRON);
      g.plain.boxC(x + 0.38, z, 0.08, 0.05, y + 0.68, y + 0.76, IRON);
      return;
    }
    case "dummy": {
      g.bark.boxC(x, z, 0.06, 0.06, y - 0.05, y + 1.75, WOOD);
      g.bark.boxC(x, z, 0.5, 0.05, y + 1.25, y + 1.35, WOOD);
      g.plain.cyl(x, z, y + 0.7, y + 1.45, 0.24, 0.2, 10, [0.85, 0.72, 0.42], true);
      g.plain.cyl(x, z, y + 1.5, y + 1.8, 0.15, 0.12, 10, [0.88, 0.8, 0.6], true);
      g.plain.boxC(x, z - 0.0, 0.25, 0.22, y + 0.95, y + 1.0, [0.6, 0.3, 0.2]);
      return;
    }
    case "barrels": case "crates": {
      const n = 2 + Math.floor(r() * 2);
      for (let k = 0; k < n; k++) {
        const bx = x + (k === 0 ? -0.22 : k === 1 ? 0.22 : 0), bz = z + (k === 2 ? 0.0 : (r() - 0.5) * 0.3), up = k === 2 && d.type === "crates" ? 0.5 : 0;
        if (d.type === "barrels") {
          g.plank.cyl(bx, bz + (k === 2 ? 0.3 : 0), y - 0.02, y + 0.62, 0.22, 0.22, 10, [0.85, 0.7, 0.55], true);
          for (const hb of [0.12, 0.48]) g.plain.cyl(bx, bz + (k === 2 ? 0.3 : 0), y + hb, y + hb + 0.05, 0.226, 0.226, 10, IRON, false);
        } else g.plank.boxC(bx, bz, 0.23, 0.23, y + up - 0.02, y + up + 0.46, [0.9, 0.78, 0.6]);
      }
      return;
    }
    case "woodpile": {
      for (let row = 0; row < 3; row++) for (let k = 0; k < 4 - row; k++) {
        const lz = z - 0.36 + k * 0.24 + row * 0.12, ly = y + 0.12 + row * 0.21;
        const seg = 7, base = g.bark;
        // a log lying along x: a short cylinder turned on its side, light end grain
        for (let j = 0; j < seg; j++) {
          const a = (j / seg) * Math.PI * 2, b = ((j + 1) / seg) * Math.PI * 2;
          const p = (t: number, xx: number): V3 => [xx, ly + Math.sin(t) * 0.11, lz + Math.cos(t) * 0.11];
          base.poly([p(a, x - 0.48), p(b, x - 0.48), p(b, x + 0.48), p(a, x + 0.48)], [0, Math.sin((a + b) / 2), Math.cos((a + b) / 2)], [[0, a], [0, b], [1, b], [1, a]], [0.8, 0.7, 0.6]);
          for (const e of [-1, 1]) g.plain.poly([[x + e * 0.48, ly, lz], p(a, x + e * 0.48), p(b, x + e * 0.48)], [e, 0, 0], [[0, 0], [1, 0], [1, 1]], [0.85, 0.7, 0.5]);
        }
      }
      return;
    }
    case "bench": {
      g.plank.boxC(x, z, 0.6, 0.18, y + 0.42, y + 0.5, WOOD);
      for (const s of [-1, 1]) g.bark.boxC(x + s * 0.48, z, 0.05, 0.15, y - 0.02, y + 0.42, DARKWOOD);
      g.plank.boxC(x, z - 0.17, 0.6, 0.03, y + 0.5, y + 0.85, WOOD);
      return;
    }
    case "fence": {
      g.bark.boxC(x, z, 0.06, 0.06, y - 0.05, y + 0.95, DARKWOOD);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = all.get((z + dz) * c.w + (x + dx));
        if (nb?.type !== "fence") continue;
        for (const ry of [0.35, 0.75]) {
          if (dx) g.bark.box(Math.min(x, x + dx * 0.5), Math.max(x, x + dx * 0.5), y + ry, y + ry + 0.08, z - 0.03, z + 0.03, WOOD);
          else g.bark.box(x - 0.03, x + 0.03, y + ry, y + ry + 0.08, Math.min(z, z + dz * 0.5), Math.max(z, z + dz * 0.5), WOOD);
        }
      }
      return;
    }
    case "tree": case "tower": return; // trees are the props' (world.ts)
  }
}

/** Hearthmoor's buildings, wall and street furniture for `m` (its `town` layout); flames for the braziers go to `cups`. */
export function buildTown(m: GameMap, props: Props, cups: { x: number; y: number; z: number }[]) {
  const t = m.town!, group = new THREE.Group();
  group.name = "town";
  const geo = (u: number) => new Geo(u);
  const c: Ctx = {
    g: { stone: geo(2.2), plaster: geo(2.4), roof: geo(1.6), plank: geo(1.2), bark: geo(1.4), cloth: geo(1), plain: geo(1), glow: geo(1) },
    group, cups, props, ground: 0.05, covered: new Set(), w: m.w,
  };
  t.buildings.forEach((b, i) => building(c, b, 7919 * (i + 1)));
  townWall(c, t.cx, t.cy, t.ring, t.street);
  const all = new Map(t.decor.map((d) => [d.y * m.w + d.x, d]));
  for (const d of t.decor) decor(c, d, all);
  const M = mats();
  for (const [k, g] of Object.entries(c.g) as [keyof typeof c.g, Geo][]) {
    if (g.empty) continue;
    const mesh = g.mesh(M[k]);
    mesh.castShadow = k !== "glow";
    mesh.receiveShadow = k !== "glow";
    group.add(mesh);
  }
  return group;
}

/** Cells the town's own meshes cover (buildings, wall ring, furniture): anything else blocked gets a hedge from world.ts. */
export function townCovered(m: GameMap) {
  const t = m.town!, out = new Set<number>();
  for (const b of t.buildings) for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) out.add(y * m.w + x);
  for (const d of t.decor) {
    if (d.type === "fountain") { for (let y = d.y - 3; y <= d.y + 3; y++) for (let x = d.x - 3; x <= d.x + 3; x++) if (Math.hypot(x - d.x, y - d.y) <= 2.3) out.add(y * m.w + x); }
    else out.add(d.y * m.w + d.x);
  }
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (Math.max(Math.abs(x - t.cx), Math.abs(y - t.cy)) === t.ring) out.add(y * m.w + x);
  return out;
}

/** Every frame: the fountain's water flows. */
export function tickTown(t: number) {
  time.value = t;
  if (M) { M.water.map!.offset.set((t * 0.02) % 1, (t * 0.035) % 1); }
}
