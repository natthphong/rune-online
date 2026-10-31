import * as THREE from "three";
import "./combat.css";

// Damage numbers, Miss / Lucky tags, heal and EXP pops: our own glyphs drawn on canvases (never the original sprites).
//
// Placement. A pop belongs to ONE unit and lives in that unit's billboard plane, the screen-aligned plane its sprite is
// drawn in: x from the unit's drawn feet on screen, y up from them in that unit's own pixels per world unit (the
// camera's pixels per unit at the unit's depth, exactly how a sprite of that height is drawn). So a pop starts on the
// struck unit's head at any zoom, depth or camera yaw, follows the unit while it walks, and is sized like the sprites.
//
// Size. In the classic client a fresh number is about a third of a character's height (the bar: a 23 px "64" over
// 56 px characters, sitting on the struck monster's head). Ours is D = 0.40 world units of digit height, about 24 px at
// the default camera where a player stands about 90 px, so with its outline it is about 28 px: a third of a player,
// half of a small monster. It is a world size like the sprites (it zooms with them) with a legibility floor.
//
// Motion. The classic client pops the number on the target at the blow tick, hops it up and to the right while it
// shrinks, then lets it fall and fade (studied through roBrowser Renderer/Effects/Damage.js `render`: height
// 2 + 5 sin(1.5 pi p) cells, drift 4 cells right and 4 toward the viewer, 1.5 s; Miss 3.5 + 7p cells in 0.8 s).
// Those amplitudes are map cells: copied at our closer camera they flung a number about 290 px off its target, and
// scaled to the unit's body they still lifted it to the attacker's face over a small monster. So every amplitude here
// is in D, the number's own height, the same for every unit (as the classic's cells are), and the path starts with its
// lower edge resting on the struck unit's drawn head:
//   damage 1.5 s  rises off the head (1.2D in the first third, easing out, then on up to 1.8D), while
//                 it drifts 1.8D sideways (easing out) away from the attacker: right like the classic's default motion,
//                 or left when the blow came from the right, so it never slides over the unit that dealt it; shrinks to
//                 60%, stays solid for the first half, then fades;
//   miss   0.8 s  a small tag with the same face as the digits, rising 1D straight up off the head;
//   heal   1.5 s  green digits that sit on the head, then rise 1D after 40% of their life;
//   exp    1.6 s  small text that starts above the zone the numbers use and drifts up.
// Overlap. A struck unit standing one cell in front of (or behind) another has its head over that unit's body, and a
// number resting there would read as the other unit's and sit still on its torso. So each pop also looks at the other
// drawn units (setPopObstacles): any unit whose silhouette covers the spot just over the struck head and whose own head
// is higher gives a clearance, and the number climbs that much extra in the first fifth of its life, ending above the
// higher of the two heads. It starts on the struck head (the number lifts OFF it), the overlay is above every sprite, and
// the rise never reverses, so a number always shows clear motion in successive frames.
// Pops that would overlap are stacked: the newest stays on its unit's head, and older ones step up above it.
// Crisp: each canvas is redrawn whenever its integer pixel size changes and is placed on whole device pixels. It is
// never scaled by CSS, so neither the outline nor the digits blur.
export type PopKind = "dealt" | "taken" | "crit" | "miss" | "lucky" | "exp" | "heal";
/** The unit a pop belongs to: its id, its DRAWN feet position (a live vector, read every frame) and standing height. */
export type PopUnit = { id: string; at: THREE.Vector3; height: number };
/** Every unit currently drawn (the pops look at them to clear overlapping silhouettes); set once by main.ts. */
let obstacles: () => Iterable<PopUnit> = () => [];
export function setPopObstacles(fn: () => Iterable<PopUnit>) { obstacles = fn; }

/** Lit face gradient (top, middle, bottom), the darker bevel at the lower-right edges, the outline. `cap` = glyph height
 *  in world units when fresh, `min` = the smallest it is drawn on screen (css px, far zoom). `track` = space between
 *  glyphs, in glyph heights: digits are set by their ink and spaced apart like the classic's digit sprites, words by
 *  their advance. */
type Style = { face: [string, string, string]; rim: string; line: string; cap: number; min: number; track: number; burst?: boolean };
const D = 0.4; // a fresh damage digit's height, world units (see Size above); every motion below is measured in it
const WHITE = { face: ["#ffffff", "#f3f3f3", "#c9c9c9"] as [string, string, string], rim: "#6d6d6d", line: "#141414" };
const STYLE: Record<PopKind, Style> = {
  dealt: { ...WHITE, cap: D, min: 11, track: 0.25 },
  taken: { face: ["#ffb3a6", "#ff4a37", "#cf1d12"], rim: "#6e0909", line: "#1b0303", cap: D, min: 11, track: 0.25 },
  crit: { face: ["#fffbd2", "#ffe03a", "#e0a400"], rim: "#87560a", line: "#271800", cap: D * 1.15, min: 12, track: 0.25, burst: true },
  heal: { face: ["#e4ffda", "#62ff55", "#22b022"], rim: "#0b560b", line: "#031a03", cap: D * 0.8, min: 10, track: 0.25 },
  miss: { ...WHITE, cap: D * 0.48, min: 8, track: 0.03 },
  lucky: { face: ["#fffbe2", "#ffe98c", "#efbf3a"], rim: "#86660f", line: "#261c00", cap: D * 0.48, min: 8, track: 0.03 },
  exp: { face: ["#f1f8ff", "#c2deff", "#92c0ff"], rim: "#3b5f98", line: "#0b172e", cap: D * 0.43, min: 8, track: 0.03 },
};
const LIFE: Record<PopKind, number> = { dealt: 1500, taken: 1500, crit: 1500, heal: 1500, miss: 800, lucky: 800, exp: 1600 };
const GAP = 0.05; // world units between the head and a fresh pop's lower edge (about 3 px)
const STAGGER = 160; // ms between two numbers on one unit (two hits landing together would print on top of each other)
const FAMILY = "Verdana, Tahoma, 'DejaVu Sans', sans-serif"; // words only (Miss, Lucky, the EXP line)
const DPR = Math.min(2, window.devicePixelRatio || 1);
const probe = document.createElement("canvas").getContext("2d")!;
probe.font = `bold 100px ${FAMILY}`;
const CAP_RATIO = probe.measureText("0123456789").actualBoundingBoxAscent / 100 || 0.73; // digit height / font size
const scratch = document.createElement("canvas"); // the face layer, reused by every redraw

/** Our own figures: stroke skeletons with round caps and joins, in units of the digit height (y 0 top .. 1 bottom). The
 *  strokes are SW thick and the skeletons keep SW/2 inside the box, so the ink fills 0..w across and 0..1 down. Thick
 *  round strokes give the rounded, chunky figures of the classic number sprites (no footed "1", no slab corners), and
 *  they look the same on every platform, which no system font promises. */
const SW = 0.205, T = SW / 2, BOT = 1 - SW / 2;
type Glyph = { w: number; path: (g: CanvasRenderingContext2D) => void };
const FIGURES: Record<string, Glyph> = {
  "0": { w: 0.74, path: (g) => { g.moveTo(0.37, T); g.ellipse(0.37, 0.5, 0.37 - T, 0.5 - T, 0, -Math.PI / 2, Math.PI * 1.5); } },
  "1": { w: 0.5, path: (g) => { g.moveTo(T, 0.29); g.lineTo(0.38, T); g.lineTo(0.38, BOT); } },
  "2": { w: 0.72, path: (g) => { g.arc(0.36, 0.35, 0.235, Math.PI * 1.06, Math.PI * 2.06); g.quadraticCurveTo(0.52, 0.62, T + 0.005, BOT); g.lineTo(0.72 - T, BOT); } },
  "3": { w: 0.72, path: (g) => {
    g.ellipse(0.35, 0.315, 0.215, 0.2, 0, Math.PI * 1.1, Math.PI * 2.5);
    g.moveTo(0.25, 0.515); g.lineTo(0.35, 0.515); g.ellipse(0.355, 0.69, 0.245, 0.19, 0, -Math.PI / 2, Math.PI * 0.87);
  } },
  "4": { w: 0.76, path: (g) => { g.moveTo(0.53, BOT); g.lineTo(0.53, T); g.lineTo(T, 0.665); g.lineTo(0.76 - T, 0.665); } },
  "5": { w: 0.72, path: (g) => { g.moveTo(0.61, T); g.lineTo(0.2, T); g.lineTo(0.165, 0.465); g.ellipse(0.36, 0.655, 0.245, 0.23, 0, Math.PI * 1.25, Math.PI * 2.86); } },
  "6": { w: 0.74, path: (g) => { g.moveTo(0.59, 0.165); g.quadraticCurveTo(T, 0.1, T, 0.63); g.ellipse(0.37, 0.645, 0.37 - T, 0.355 - T, 0, Math.PI, Math.PI * 3); } },
  "7": { w: 0.7, path: (g) => { g.moveTo(T, T); g.lineTo(0.7 - T, T); g.quadraticCurveTo(0.36, 0.46, 0.31, BOT); } },
  "8": { w: 0.74, path: (g) => {
    g.ellipse(0.37, 0.3, 0.2, 0.185, 0, 0, Math.PI * 2);
    g.moveTo(0.37 + 0.245, 0.68); g.ellipse(0.37, 0.68, 0.245, 0.205, 0, 0, Math.PI * 2);
  } },
  "9": { w: 0.74, path: (g) => { g.save(); g.translate(0.74, 1); g.scale(-1, -1); FIGURES["6"].path(g); g.restore(); } }, // a 6 turned over
  "+": { w: 0.68, path: (g) => { g.moveTo(T, 0.5); g.lineTo(0.68 - T, 0.5); g.moveTo(0.34, 0.28); g.lineTo(0.34, 0.72); } },
  "-": { w: 0.6, path: (g) => { g.moveTo(T, 0.5); g.lineTo(0.6 - T, 0.5); } },
};

type Pop = {
  unit: PopUnit; el: HTMLCanvasElement; text: string; kind: PopKind; side: 1 | -1; t0: number; life: number;
  size: number; // glyph height in device px the canvas is drawn at (0 = not yet)
  cw: number; ch: number; gw: number; gh: number; // canvas and glyph box, css px
  x: number; y: number; on: boolean; off: number; // this frame: natural centre, visible; eased stacking nudge
  a: number; digit: number; // this frame: opacity from its motion; a fresh digit's height in px at its unit's depth
  clear: number; // extra height (world units) needed to clear another unit's head over the struck head, eased
};
const pops: Pop[] = [];
const lastStart = new Map<string, number>();

/** Spawn a pop on `unit`; `layer` is the screen overlay (#pops). Each pop is its own element there. `side` = the way a
 *  damage number drifts off the head: +1 right (the classic's default), -1 left; main.ts passes "away from the attacker",
 *  so a number never slides over the unit that dealt the blow. */
export function spawnPop(layer: HTMLElement, unit: PopUnit, text: string, kind: PopKind, side: 1 | -1 = 1) {
  const el = document.createElement("canvas");
  el.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;opacity:0";
  el.dataset.unit = unit.id;
  el.dataset.kind = kind;
  layer.append(el);
  const now = performance.now();
  let t0 = now;
  if (kind === "dealt" || kind === "taken" || kind === "crit") {
    t0 = Math.max(now, (lastStart.get(unit.id) ?? -1e9) + STAGGER);
    lastStart.set(unit.id, t0);
    if (lastStart.size > 200) for (const [id, t] of lastStart) if (t < now - 5000) lastStart.delete(id);
  }
  pops.push({ unit, el, text, kind, side, t0, life: LIFE[kind], size: 0, cw: 0, ch: 0, gw: 0, gh: 0, x: 0, y: 0, on: false, off: 0, a: 0, digit: 0, clear: 0 });
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Offsets of the pop's lower edge from its resting place on the head (world units in the unit's billboard plane: u right,
 *  v up), its scale and its opacity at age k (0..1). Amplitudes are in D, the same for every unit (see Motion above). */
function motion(kind: PopKind, k: number, side: number) {
  switch (kind) {
    case "dealt": case "taken": case "crit": {
      // up off the head fast, then on up slowly while it fades: it never stops or comes back, so two frames always differ
      return { u: side * 1.8 * D * easeOut(k), v: D * (1.2 * easeOut(Math.min(1, k / 0.33)) + 0.6 * k), s: 1 - 0.4 * k, a: k < 0.5 ? 1 : (1 - k) / 0.5 };
    }
    case "miss": case "lucky":
      return { u: 0, v: D * easeOut(k), s: 1, a: k < 0.6 ? 1 : (1 - k) / 0.4 };
    case "heal":
      return { u: 0, v: k < 0.4 ? 0 : ((k - 0.4) / 0.6) * D, s: 1 - 0.3 * k, a: k < 0.6 ? 1 : (1 - k) / 0.4 };
    default: // exp: starts above the zone a fresh number and its hop use, so it never covers them
      return { u: 0, v: 1.7 * D + 0.6 * D * k, s: 1, a: 1 - k * k };
  }
}

/** A laid-out run of glyphs at one size, device px: its ink box, and how to draw it (as an outline of `extra` px each side
 *  or as a face) with its ink's top-left corner at (x, y). */
type Run = { width: number; height: number; draw: (g: CanvasRenderingContext2D, x: number, y: number, face: boolean, extra: number) => void };
/** Numbers in our figures (FIGURES), set by their ink, `track` glyph heights apart. */
function figureRun(text: string, cap: number, track: number): Run {
  const xs: number[] = [];
  let pen = 0;
  for (const c of text) { xs.push(pen); pen += FIGURES[c].w * cap + track * cap; }
  const width = pen - track * cap;
  return { width, height: cap, draw: (g, x, y, face, extra) => {
    g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = SW * cap + (face ? 0 : extra * 2);
    [...text].forEach((c, i) => {
      g.save(); g.translate(x + xs[i], y); g.scale(cap, cap);
      g.beginPath(); FIGURES[c].path(g);
      g.restore(); // stroke in device px, not in glyph units
      g.stroke();
    });
  } };
}
/** Words (Miss, Lucky, the EXP line) in the UI font, sized so a figure would be `cap` tall. */
function wordRun(text: string, cap: number, track: number): Run {
  const font = `bold ${Math.max(7, Math.round(cap / CAP_RATIO))}px ${FAMILY}`;
  probe.font = font;
  const chars = [...text], ms = chars.map((c) => probe.measureText(c)), m = probe.measureText(text);
  const asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
  const xs: number[] = [];
  let pen = 0;
  ms.forEach((mm) => { xs.push(Math.round(pen)); pen += mm.width + track * cap; });
  return { width: Math.ceil(pen - track * cap), height: asc + desc, draw: (g, x, y, face, extra) => {
    g.font = font; g.lineJoin = "round"; g.lineWidth = extra * 2;
    chars.forEach((c, i) => face ? g.fillText(c, x + xs[i], y + asc) : g.strokeText(c, x + xs[i], y + asc));
  } };
}

/** Draw the pop's glyphs `capCss` css px tall (redrawn only when the integer device size changes). */
function paint(p: Pop, capCss: number) {
  const cap = Math.max(6, Math.round(capCss * DPR));
  if (cap === p.size) return;
  p.size = cap;
  const st = STYLE[p.kind];
  const run = [...p.text].every((c) => c in FIGURES) ? figureRun(p.text, cap, st.track) : wordRun(p.text, cap, st.track);
  const ow = Math.max(1, Math.round(cap * 0.085)); // outline, device px: 2 px on a fresh number, solid like the labels' edge
  const pad = ow + 1 + (st.burst ? Math.round(cap * 0.58) : 0);
  const W = Math.ceil(run.width) + pad * 2, H = run.height + pad * 2;
  const cv = p.el;
  cv.width = W; cv.height = H; // also clears it
  cv.style.width = `${W / DPR}px`; cv.style.height = `${H / DPR}px`;
  const g = cv.getContext("2d")!;
  if (st.burst) { // critical: a jagged orange star behind the digits
    const cx = W / 2, cy = H / 2, r = Math.max(run.width, cap / CAP_RATIO) * 0.6, squash = Math.min(0.72, (cy - 1) / r);
    const grad = g.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    grad.addColorStop(0, "rgba(255,190,70,0.95)"); grad.addColorStop(0.6, "rgba(232,84,26,0.9)"); grad.addColorStop(1, "rgba(160,30,10,0.85)");
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, rr = i % 2 ? r * 0.58 : r * (i % 4 ? 0.9 : 1);
      g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * squash);
    }
    g.closePath(); g.fill();
  }
  // outline first (its inner half is covered by the face)
  g.strokeStyle = st.line;
  run.draw(g, pad, pad, false, ow);
  // face: the rim colour, with the lit gradient drawn up-left inside it, so a 1 px bevel stays at the lower-right edges
  scratch.width = W; scratch.height = H;
  const s = scratch.getContext("2d")!;
  s.fillStyle = s.strokeStyle = st.rim;
  run.draw(s, pad, pad, true, 0);
  s.globalCompositeOperation = "source-atop";
  const lit = s.createLinearGradient(0, pad, 0, pad + run.height);
  lit.addColorStop(0, st.face[0]); lit.addColorStop(0.5, st.face[1]); lit.addColorStop(1, st.face[2]);
  s.fillStyle = s.strokeStyle = lit;
  const o = Math.max(1, Math.round(cap * 0.04));
  run.draw(s, pad - o, pad - o, true, 0);
  g.drawImage(scratch, 0, 0);
  p.cw = W / DPR; p.ch = H / DPR; p.gw = run.width / DPR; p.gh = run.height / DPR;
}

const fwd = new THREE.Vector3(), at = new THREE.Vector3();

export function updatePops(camera: THREE.PerspectiveCamera, now: number) {
  camera.getWorldDirection(fwd);
  const pxAt1 = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)); // css px per world unit at depth 1
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i], age = now - p.t0;
    p.on = false;
    if (age < 0) continue; // staggered: not started yet
    const k = age / p.life;
    if (k >= 1) { p.el.remove(); pops.splice(i, 1); continue; }
    // the unit's drawn feet on screen and its pixels per world unit there (sprites face the camera, so its head is
    // straight above its feet, height * ppu px up)
    const depth = at.copy(p.unit.at).sub(camera.position).dot(fwd);
    at.copy(p.unit.at).project(camera);
    if (depth <= 0.1 || at.z > 1) { p.el.style.opacity = "0"; continue; }
    const ppu = pxAt1 / depth, fx = (at.x * 0.5 + 0.5) * innerWidth, fy = (-at.y * 0.5 + 0.5) * innerHeight;
    const st = STYLE[p.kind], mo = motion(p.kind, k, p.side);
    const capPx = Math.max(st.min * mo.s, st.cap * mo.s * ppu); // glyph height on screen, css px
    paint(p, capPx);
    p.x = fx + mo.u * ppu;
    // overlap: the highest head among other units whose silhouette covers the spot over the struck head
    let want = 0;
    if (p.kind !== "exp") {
      const spotTop = fy - (p.unit.height + GAP) * ppu - capPx, spotBot = fy - p.unit.height * ppu; // screen rows of the resting number
      const halfW = capPx * 0.7 + 0.35 * ppu;
      for (const q of obstacles()) {
        if (q.id === p.unit.id) continue;
        const qd = at.copy(q.at).sub(camera.position).dot(fwd);
        if (qd <= 0.1) continue;
        const qp = at.copy(q.at).project(camera), qppu = pxAt1 / qd;
        const qx = (qp.x * 0.5 + 0.5) * innerWidth, qy = (-qp.y * 0.5 + 0.5) * innerHeight, qTop = qy - q.height * qppu;
        if (Math.abs(qx - fx) > halfW || qTop >= spotBot || qy <= spotTop) continue; // beside it, or not covering the spot
        want = Math.max(want, (spotBot - qTop) / ppu + 0.1); // up to the top of that unit's head
      }
    }
    p.clear += (want - p.clear) * 0.3;
    // glyph centre: its lower edge rests GAP above the drawn head, then moves by the motion's offsets (and, in the first
    // fifth of its life, by the clearance)
    p.y = fy - (p.unit.height + GAP + mo.v + p.clear * easeOut(Math.min(1, k / 0.22))) * ppu - capPx * 0.5;
    p.on = true;
    p.a = Math.max(0, mo.a);
    p.digit = Math.max(STYLE.dealt.min, STYLE.dealt.cap * ppu);
  }
  // Stacking: the newest pop keeps its place on its unit's head. An older pop that touches a newer one (or sits flush
  // beside it, so that "12" next to a red "5" would read as "125") steps up above it. If it has to climb more than one
  // level, it fades out: in a crowded fight the newest blows stay readable on their heads, with no tower of old numbers.
  // The wide EXP line is not a combat number, so it neither pushes numbers away nor moves.
  const live = pops.filter((p) => p.on).sort((a, b) => b.t0 - a.t0); // newest first
  live.forEach((p, i) => {
    let want = 0;
    for (let pass = 0; pass < 3 && p.kind !== "exp"; pass++) {
      let moved = false;
      for (let j = 0; j < i; j++) {
        const q = live[j], qy = q.y + q.off, py = p.y + want;
        if (q.kind === "exp") continue;
        const gx = Math.min(p.gh, q.gh) * 0.3, gy = Math.min(p.gh, q.gh) * 0.1;
        if (Math.abs(p.x - q.x) * 2 >= p.gw + q.gw + gx * 2 || Math.abs(py - qy) * 2 >= p.gh + q.gh + gy * 2) continue;
        want = qy - (p.gh + q.gh) / 2 - gy - p.y; // just above the newer one
        moved = true;
      }
      if (!moved) break;
    }
    p.off += (want - p.off) * 0.35;
    const climb = Math.max(0, -p.off / p.digit - 1.2); // levels (fresh digit heights) above one step up
    p.el.style.opacity = (p.a * Math.max(0, 1 - climb)).toFixed(3);
    // whole device pixels, never a CSS scale: the glyphs stay as sharp as they were drawn
    const L = Math.round((p.x - p.cw / 2) * DPR) / DPR, T = Math.round((p.y + p.off - p.ch / 2) * DPR) / DPR;
    p.el.style.transform = `translate(${L}px, ${T}px)`;
  });
}
