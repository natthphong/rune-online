// RO-style animated billboards: each actor composites its current frame on a small canvas and shows that canvas as one
// camera-facing sprite, so layers can never z-fight or drift apart.
//
// Players are PAPER DOLLS (paperdoll.ts): a headless body per outfit + a head per hair style + weapon / headgear / garment /
//   shield sprites, pinned to per-frame anchors. Sheets: walk (8 frames) · act [stand, sit, hurt, dead, swing x4], 5 facings
//   (front, 3/4 front, side, 3/4 back, back; facing right, mirrored for the left).
// Monsters (3 rows: front, side, back): animation sheets cut by tools/art/slice_grid.py into public/sprites/anim:
//   move 4 frames · act [attack wind-up, strike, hurt, dead]
import * as THREE from "three";
import type { Look } from "../../shared/look.ts";
import { drawPd, getJson, loadImg, loadPd, type PdLook } from "./paperdoll.ts";

/** stride = sheet px a planted foot travels per step in the side-view walk row (slice_grid.py --stride-row) */
type Meta = { rows: number; cols: number; cellW: number; cellH: number; unit: number; views?: number; stride?: number };
type Sheet = { img: CanvasImageSource; meta: Meta; feet: number; horizontal: boolean };
export type ActorState = { moving: boolean; dead: boolean; sitting: boolean; speed: number };
export type ActionKind = "attack" | "hit" | "pickup" | "cheer";

const animIndex: Promise<Set<string>> = fetch("/sprites/anim/index.json").then((r) => r.json()).then((a: string[]) => new Set(a)).catch(() => new Set());
const spriteIndex: Promise<Set<string>> = fetch("/sprites/index.json").then((r) => r.json()).then((a: string[]) => new Set(a)).catch(() => new Set());
const cache = new Map<string, Promise<Sheet | null>>();

/** A monster animation sheet (`mob_1002_move`). */
function animSheet(key: string): Promise<Sheet | null> {
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      if (!(await animIndex).has(key)) return null;
      const [img, meta] = await Promise.all([loadImg(`/sprites/anim/${key}.png`), getJson(`/sprites/anim/${key}.json`) as Promise<Meta>]);
      return { img, meta, feet: 2, horizontal: false };
    })().catch(() => null));
  }
  return cache.get(key)!;
}
/** A static 3-view strip from slice.py (`mob_1002`): views side by side, feet 4 px above the bottom. */
function viewSheet(key: string): Promise<Sheet | null> {
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      if (!(await spriteIndex).has(key)) return null;
      const [img, m] = await Promise.all([loadImg(`/sprites/${key}.png`), getJson(`/sprites/${key}.json`)]);
      return { img, meta: { rows: m.views, cols: 1, cellW: m.cellW, cellH: m.cellH, unit: m.cellH - 8 }, feet: 4, horizontal: true };
    })().catch(() => null));
  }
  return cache.get(key)!;
}

// ---------- actor kinds ----------
/** cols = sheet columns played in order; [] = every column the sheet has (its json `cols`), so a walk plays however
 *  many frames its art was drawn with. */
type Frames = [sheet: string, cols: number[]];
/** impact = index (into the attack frames) of the frame on which the blow connects. */
export type Kind = { rows: 3 | 5; walk: Frames; idle: Frames; sit: Frames; hurt: Frames; dead: Frames; attack: (weapon: string) => Frames; impact: number };
/** Paper-doll players (paperdoll.ts): sheets `walk` (8 frames) and `act` = stand, sit, hurt, dead, swing x4. */
export const PC: Kind = { // swing: wind-up, mid-swing, full extension (impact), recovery
  rows: 5, walk: ["walk", []], idle: ["act", [0]], sit: ["act", [1]], hurt: ["act", [2]], dead: ["act", [3]],
  attack: () => ["act", [4, 5, 6, 7]], impact: 2,
};
export const MOB: Kind = { // attack: wind-up, strike (impact)
  rows: 3, walk: ["move", []], idle: ["move", [0]], sit: ["move", [0]], hurt: ["act", [2]], dead: ["act", [3]],
  attack: () => ["act", [0, 1]], impact: 1,
};

/** Opacity of a sprite that hides a unit you are fighting (see AnimSprite.setSeeThrough). */
const SEE_THROUGH_ALPHA = 0.5;
/** How far (world units) a struck actor jolts away from the blow while its hurt frame shows (see action "hit"). */
const FLINCH_PUSH = 0.16;

const CW = 320, CH = 300, FEET = 14; // composite canvas; feet at (CW/2, CH-FEET)
// Walk cycle length in world units. Frames advance with distance walked, so the cadence follows the server walk speed
// the way RO scales its walk delay by speed (roBrowser EntityRender getAnimationDelay: act.delay / 150 * walk.speed).
// A sheet with a measured stride covers 2 steps per cycle times WALK_SLIDE: 1 would plant the feet exactly, but chibi
// legs at RO's walk speed (150 ms per cell) would then cycle ~6 times a second; RO's own sprites slide ~3x.
const WALK_SLIDE = 1.3; // F02 r2: 1 plants the boot exactly but cycles ~7/s (frantic); 1.75 skated at ~3x the leg stride; 1.3 = compromise
const WALK_CYCLE = 2; // sheets without a stride (monsters): one cycle every 2 units

/** Row (facing) + mirror for a facing angle relative to the camera (positive = facing screen-right). */
export function facing(rel: number, rows: number) {
  const a = Math.abs(rel);
  if (rows === 3) {
    const row = a <= Math.PI / 3 ? 0 : a >= (Math.PI * 2) / 3 ? 2 : 1;
    return { row, mirror: row === 1 && rel < 0 };
  }
  const row = Math.min(4, Math.round(a / (Math.PI / 4)));
  return { row, mirror: row > 0 && row < 4 && rel < 0 };
}

/** A camera-facing sprite leans back with the camera pitch, so its upper half would sink into anything standing
 *  just behind the actor. Give every pixel the depth of the feet (pulled a little toward the camera), the way 2.5D
 *  sprite games sort: things in front of the feet still cover the actor, things behind never cut into it. */
function flatDepth(mat: THREE.SpriteMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <logdepthbuf_vertex>", `
      vec4 feetClip = projectionMatrix * vec4(modelViewMatrix[3].xyz + vec3(0.0, 0.0, 0.45), 1.0);
      gl_Position.z = feetClip.z / feetClip.w * gl_Position.w;
      #include <logdepthbuf_vertex>`);
  };
  return mat;
}

/** Draws one actor frame into a 2D context; shared by the world sprite and UI previews. */
export class Composer {
  sheets = new Map<string, Sheet | null>(); // loaded sheets by short name ("walk", "act", "move")
  private loadId = 0;
  kind: Kind;
  /** The paper doll of the loaded look (paperdoll.ts): draw() composes its parts on the frame's anchors. */
  pd?: PdLook;

  constructor(kind: Kind) { this.kind = kind; }

  /** Monsters: (re)load the sheets for a body key ("mob_1002"); resolves once all exist or failed. */
  async load(body: string, fallback?: string, onProvisional?: () => void, standin?: string) {
    const id = ++this.loadId;
    const names = ["move", "act"];
    // never leave a monster invisible while its (big) animation sheets load: show its small static 3-view sprite meanwhile
    if (fallback && !this.sheets.size) {
      void viewSheet(fallback).then((st) => {
        if (!st || id !== this.loadId || this.sheets.size) return;
        for (const n of names) this.sheets.set(n, st);
        onProvisional?.();
      });
    }
    const got = await Promise.all(names.map((n) => animSheet(`${body}_${n}`)));
    if (id !== this.loadId) return false;
    this.sheets.clear();
    names.forEach((n, i) => this.sheets.set(n, got[i]));
    if (!got.some(Boolean)) this.sheets.clear();
    if (!got.some(Boolean) && fallback) { // monsters without animation art yet: their static 3-view sprite
      const st = await viewSheet(fallback);
      if (id !== this.loadId) return false;
      if (st) for (const n of names) this.sheets.set(n, st);
    }
    if (!this.sheets.size && standin) { // W03: no art of its own at all yet: a look-alike species' sheets (shared/mobart.ts)
      const alt = await Promise.all(names.map((n) => animSheet(`${standin}_${n}`)));
      if (id !== this.loadId) return false;
      if (alt.some(Boolean)) names.forEach((n, i) => this.sheets.set(n, alt[i]));
      else {
        const st = await viewSheet(standin);
        if (id !== this.loadId) return false;
        if (st) for (const n of names) this.sheets.set(n, st);
      }
    }
    return true;
  }

  /** A player's look (world, Select Character, Make Character): every part is loaded before anything is swapped in, so a look is
   *  never drawn half dressed. */
  async loadLook(look: Look) {
    const id = ++this.loadId, pd = await loadPd(look);
    if (id !== this.loadId || !pd) return false;
    this.pd = pd;
    this.sheets.clear();
    for (const n of ["walk", "act"] as const) this.sheets.set(n, { img: pd[n].img, meta: pd[n].meta, feet: 0, horizontal: false });
    return true;
  }

  /** Resolve wanted frames to a loaded sheet, falling back to standing/walking art when a sheet is missing. */
  pick(want: Frames, t: number): { s: Sheet; col: number } | null {
    for (const [name, cols] of [want, this.kind.idle, this.kind.walk]) {
      const s = this.sheets.get(name);
      if (!s) continue;
      const n = cols.length || s.meta.cols, i = Math.min(n - 1, Math.floor(t * n));
      const col = s.horizontal ? 0 : cols.length ? cols[i] : i;
      return { s, col: Math.min(col, s.meta.cols - 1) };
    }
    return null;
  }

  draw(g: CanvasRenderingContext2D, f: { s: Sheet; col: number }, row: number, mirror: boolean, scale: number, cx: number, feetY: number) {
    const { s, col } = f, m = s.meta;
    if (this.pd) return drawPd(g, this.pd, s.meta === this.pd.walk.meta ? "walk" : "act", col, Math.min(row, 4), mirror, scale, cx, feetY);
    const r = Math.min(row, m.rows - 1);
    const sx = s.horizontal ? r * m.cellW : col * m.cellW, sy = s.horizontal ? 0 : r * m.cellH;
    g.save();
    g.translate(cx, feetY);
    if (mirror) g.scale(-1, 1);
    g.scale(scale, scale);
    g.drawImage(s.img, sx, sy, m.cellW, m.cellH, -m.cellW / 2, -(m.cellH - s.feet), m.cellW, m.cellH);
    g.restore();
  }
}

/** One actor in the world: a sprite whose texture is the composited current frame. */
export class AnimSprite {
  readonly object: THREE.Sprite;
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private comp: Composer;
  private kind: Kind;
  private look?: Look;
  private lookKey = "";
  private yaw = 0;
  /** one-shot action; for attacks `impact` = seconds to the blow and `follow` = seconds the frames after it take */
  private act?: { want: Frames; t: number; dur: number; kind: ActionKind; impact?: number; follow?: number };
  private flinch?: { t: number; dur: number; away?: { x: number; y: number } }; // hurt frame shown over whatever plays
  private walkDist = 0;
  private deadFor = 0;
  private drawn = "";
  private box?: { sig: string; x0: number; x1: number; y0: number; y1: number; alpha: Uint8ClampedArray };
  private fade = 1; // see-through factor, eased toward fadeTo
  private fadeTo = 1;
  private worldPerPx: number;
  private unitPx: number; // canvas px of a standing actor (players 160, monsters 120)
  /** world height of the standing actor (numbers and bars are placed from it) */
  readonly height: number;

  /** body = "mob_1002" for monsters; players pass their look instead. height = world height of a standing actor. */
  constructor(opts: { look?: Look; body?: string; height: number; fallback?: string; standin?: string; tint?: number }) {
    this.height = opts.height;
    this.kind = opts.look ? PC : MOB;
    this.comp = new Composer(this.kind);
    this.canvas.width = CW; this.canvas.height = CH;
    this.g = this.canvas.getContext("2d", { willReadFrequently: true })!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.object = new THREE.Sprite(flatDepth(new THREE.SpriteMaterial({ map: this.tex, alphaTest: 0.3, transparent: true })));
    this.object.center.set(0.5, FEET / CH);
    if (opts.tint !== undefined && opts.tint !== 0xffffff) (this.object.material as THREE.SpriteMaterial).color.setHex(opts.tint); // 2.7.0 tower species: base sheets x colour
    this.unitPx = opts.look ? 160 : 120;
    this.worldPerPx = opts.height / this.unitPx;
    this.object.scale.set(CW * this.worldPerPx, CH * this.worldPerPx, 1);
    // the canvas is much larger than the actor: only count clicks/hover on (or right next to) drawn pixels
    const raycast = this.object.raycast.bind(this.object);
    this.object.raycast = (rc, hits) => {
      const n = hits.length;
      raycast(rc, hits);
      for (let i = hits.length - 1; i >= n; i--) if (!hits[i].uv || !this.opaqueAt(hits[i].uv!.x, hits[i].uv!.y)) hits.splice(i, 1);
    };
    if (opts.look) this.setLook(opts.look);
    else void this.comp.load(opts.body!, opts.fallback, () => { this.drawn = ""; }, opts.standin).then(() => { this.drawn = ""; });
  }

  setLook(look: Look) {
    const key = JSON.stringify(look);
    if (key === this.lookKey) return;
    this.lookKey = key;
    this.look = look;
    void this.comp.loadLook(look).then(() => { this.drawn = ""; });
  }

  face(yaw: number) { this.yaw = yaw; }
  faceDir(dir: number) { this.yaw = (dir * Math.PI) / 4; } // server dir 0..7, 0 = +y (= +z in world)

  /**
   * One-shot animation.
   * - attack: `sec` = time from the swing's start to the blow (the attacker's amotion). The classic client scales the
   *   attack ACT so its hit frame lands at attackMT and shows the number then (roBrowser Engine/MapEngine/Entity.js,
   *   ZC_NOTIFY_ACT: animSpeed = attackMT / attackMotion, Damage.add(..., tick + attackMT)), so the wind-up frames are
   *   spread over `sec`, the impact frame starts exactly when main.ts pops the number, and the follow-through takes as
   *   long as the wind-up (capped, so slow monsters don't freeze mid-strike).
   * - hit: `sec` = the target's damage motion (dmotion). The hurt frame plays over anything (RO's ACTION_HURT
   *   interrupts a swing too); a swing keeps its clock underneath and resumes when the flinch ends. `away` = unit screen
   *   direction (x right, y up) the blow pushes toward: the sprite jolts that way for an instant and settles back, so
   *   the flinch also reads on a unit seen from behind or small on screen.
   */
  action(kind: ActionKind, sec?: number, away?: { x: number; y: number }) {
    const k = this.kind;
    if (kind === "attack") {
      const want = k.attack(this.look?.weapon ?? "fist");
      const impact = Math.max(0.06, sec ?? 0.3), n = want[1].length;
      const follow = Math.min(0.42, (impact / k.impact) * (n - k.impact));
      this.act = { kind, want, t: 0, dur: impact + follow, impact, follow };
    } else if (kind === "hit") this.flinch = { t: 0, dur: THREE.MathUtils.clamp((sec ?? 0.5) * 0.6, 0.25, 0.4), away };
    else if (kind === "pickup") this.act = { kind, want: k.sit, t: 0, dur: 0.4 };
    else this.act = { kind, want: k.idle, t: 0, dur: 0.7 };
  }

  /** Fade this actor (and stop it hiding things in the depth buffer) while it stands in front of a unit you fight. */
  setSeeThrough(on: boolean) { this.fadeTo = on ? SEE_THROUGH_ALPHA : 1; }
  get seeThrough() { return this.fadeTo < 1; }

  private stand?: { key: string; top: number };
  /**
   * Top of the standing pose as drawn, in world units above the feet: where a damage number on this unit's head goes.
   * A squat slime fills less of its size class than a mushroom, and an attack or hurt frame may be taller or shorter,
   * so this measures the idle frame once per loaded sheet. Falls back to the nominal height before the art loads.
   */
  standTop(): number {
    const f = this.comp.pick(this.kind.idle, 0);
    if (!f) return this.height;
    const key = `${f.s.meta.cellW}|${f.s.meta.cellH}|${f.col}`;
    if (this.stand?.key !== key) {
      const cv = document.createElement("canvas");
      cv.width = CW; cv.height = CH;
      const g = cv.getContext("2d", { willReadFrequently: true })!;
      this.comp.draw(g, f, 0, false, this.unitPx / f.s.meta.unit, CW / 2, CH - FEET);
      const d = g.getImageData(0, 0, CW, CH).data;
      let y = 0;
      search: for (; y < CH; y++) for (let x = 0; x < CW; x += 2) if (d[(y * CW + x) * 4 + 3] >= 80) break search;
      this.stand = { key, top: y < CH ? (CH - FEET - y) * this.worldPerPx : this.height };
    }
    return this.stand.top;
  }

  /** The drawn frame's pixels (alpha) and their bounding box, scanned once per drawn frame, on demand. */
  private scan() {
    if (this.box?.sig !== this.drawn) {
      const d = this.g.getImageData(0, 0, CW, CH).data;
      let x0 = CW, x1 = -1, y0 = CH, y1 = -1;
      for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) {
        if (d[(y * CW + x) * 4 + 3] < 80) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      this.box = { sig: this.drawn, x0, x1: x1 + 2, y0, y1: y1 + 2, alpha: d };
    }
    return this.box.x1 > this.box.x0 ? this.box : null; // null: nothing drawn (yet)
  }

  /**
   * Box around the drawn pixels of the current frame, in world units from the feet anchor (x right, y up on screen),
   * or null before anything is drawn. Sprites face the camera, so main.ts turns this into a screen rectangle by
   * scaling with the camera's pixels per unit at the actor's depth.
   */
  bounds(): { l: number; r: number; b: number; t: number } | null {
    const box = this.scan();
    if (!box) return null;
    const sx = this.object.scale.x / CW, sy = this.object.scale.y / CH;
    const ax = this.object.center.x * CW, ay = (1 - this.object.center.y) * CH; // feet anchor in canvas px
    return { l: (box.x0 - ax) * sx, r: (box.x1 - ax) * sx, t: (ay - box.y0) * sy, b: (ay - box.y1) * sy };
  }

  /** Is there a solid pixel at (x right, y up) world units from the feet anchor in the current frame? */
  solidAt(x: number, y: number) {
    const box = this.scan();
    if (!box) return false;
    const cx = Math.round(this.object.center.x * CW + (x * CW) / this.object.scale.x);
    const cy = Math.round((1 - this.object.center.y) * CH - (y * CH) / this.object.scale.y);
    return cx >= 0 && cy >= 0 && cx < CW && cy < CH && box.alpha[(cy * CW + cx) * 4 + 3] >= 80;
  }

  update(dt: number, camYaw: number, s: ActorState) {
    const k = this.kind;
    this.walkDist += s.moving ? s.speed * dt : 0;
    this.deadFor = s.dead ? this.deadFor + dt : 0;
    if (this.act) { this.act.t += dt; if (this.act.t >= this.act.dur || s.dead) this.act = undefined; }
    if (this.flinch) { this.flinch.t += dt; if (this.flinch.t >= this.flinch.dur || s.dead) this.flinch = undefined; }
    let want: Frames, t = 0;
    if (s.dead) want = k.dead;
    else if (this.flinch) want = k.hurt;
    else if (this.act) {
      const a = this.act, n = a.want[1].length;
      want = a.want;
      // attacks: wind-up frames before the impact time, the impact frame and the rest after it (see action())
      t = a.impact === undefined ? a.t / a.dur
        : (a.t < a.impact ? (a.t / a.impact) * k.impact : k.impact + Math.min(0.999, (a.t - a.impact) / a.follow!) * (n - k.impact)) / n;
    }
    else if (s.moving) { want = k.walk; t = (this.walkDist / this.walkCycle()) % 1; }
    else if (s.sitting) want = k.sit;
    else want = k.idle;
    const rel = Math.atan2(Math.sin(this.yaw - camYaw), Math.cos(this.yaw - camYaw));
    const { row, mirror } = facing(rel, k.rows);
    const f = this.comp.pick(want, t);
    const sig = f ? `${f.s.meta.cellW}|${want[0]}|${f.col}|${row}|${mirror}` : "";
    if (sig !== this.drawn) {
      this.drawn = sig;
      this.g.clearRect(0, 0, CW, CH);
      if (f) this.comp.draw(this.g, f, row, mirror, this.unitPx / f.s.meta.unit, CW / 2, CH - FEET);
      this.tex.needsUpdate = true;
    }
    // procedural touches: breathing while idle, a hop for level-up, monsters fade out after the death pose
    const mat = this.object.material as THREE.SpriteMaterial;
    this.fade += (this.fadeTo - this.fade) * Math.min(1, dt * 12);
    mat.opacity = (k === MOB && s.dead ? THREE.MathUtils.clamp(1 - (this.deadFor - 0.8) / 0.7, 0, 1) : 1) * this.fade;
    // keep the cut-out edge where it is while fading (alpha test runs on texel alpha x opacity)
    mat.alphaTest = Math.max(0.01, 0.3 * mat.opacity);
    // a see-through actor must not hide what stands behind it in the depth buffer (the target ring is drawn later)
    mat.depthWrite = this.fade > 0.97;
    this.object.visible = mat.opacity > 0.01;
    const breathe = !s.moving && !s.dead && !this.act ? 1 + Math.sin(performance.now() / 600) * 0.012 : 1;
    // flinch jolt: out in 50 ms, eased back over the rest of the hurt frame, with a slight squash
    const fl = this.flinch, jolt = fl ? (fl.t < 0.05 ? fl.t / 0.05 : Math.max(0, 1 - (fl.t - 0.05) / (fl.dur - 0.05))) : 0;
    this.object.scale.set(CW * this.worldPerPx / breathe * (1 + 0.06 * jolt), CH * this.worldPerPx * breathe * (1 - 0.05 * jolt), 1);
    const hop = this.act?.kind === "cheer" ? Math.sin(Math.PI * Math.min(1, this.act.t / this.act.dur * 2)) * 0.35 : 0;
    this.object.center.x = 0.5 - (jolt * FLINCH_PUSH * (fl?.away?.x ?? 0)) / (CW * this.worldPerPx);
    this.object.center.y = FEET / CH - (hop + jolt * FLINCH_PUSH * (fl?.away?.y ?? 0)) / (CH * this.worldPerPx);
  }

  /** world units per walk cycle: two measured steps (sheet px -> world via the standing height) times WALK_SLIDE */
  private walkCycle() {
    const m = this.comp.sheets.get(this.kind.walk[0])?.meta;
    return m?.stride ? 2 * m.stride * (this.height / m.unit) * WALK_SLIDE : WALK_CYCLE;
  }

  private opaqueAt(u: number, v: number) {
    const x = Math.round(u * CW) - 6, y = Math.round((1 - v) * CH) - 6;
    const d = this.g.getImageData(Math.max(0, x), Math.max(0, y), 13, 13).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 60) return true;
    return false;
  }

  dispose() { this.tex.dispose(); (this.object.material as THREE.SpriteMaterial).dispose(); }
}

// ---------- UI previews (character select / make character / equipment window) ----------
async function composerFor(look: Look) {
  const c = new Composer(PC);
  await c.loadLook(look);
  return c;
}
function fit(cv: HTMLCanvasElement) {
  const g = cv.getContext("2d")!;
  g.clearRect(0, 0, cv.width, cv.height);
  g.imageSmoothingQuality = "high";
  return { g, scale: Math.min(cv.width / 140, (cv.height - 10) / 200), cx: cv.width / 2, feet: cv.height - 6 };
}

/** Standing, facing the viewer (character select slots, equipment window). */
export async function drawStill(cv: HTMLCanvasElement, look: Look, row = 0) {
  const c = await composerFor(look);
  const f = c.pick(c.kind.idle, 0);
  const { g, scale, cx, feet } = fit(cv);
  if (f) c.draw(g, f, row, false, scale * 160 / f.s.meta.unit, cx, feet);
}

/** Make Character: walks in place while slowly turning through all 8 directions; click = attack. */
export class LivePreview {
  private comp?: Composer;
  private look?: Look;
  private shown?: Look; // the look `comp` was loaded for
  private t0 = performance.now();
  private attackAt = -1e9;
  private raf = 0;
  private cv: HTMLCanvasElement;
  /** Facing 0..7 (0 front, turning right; 5..7 mirrored) held by the Make Character arrows; null = slow auto-turn. */
  dir: number | null = null;
  /** false = stand (idle frame) instead of the walk cycle. */
  walking = true;

  constructor(cv: HTMLCanvasElement) {
    this.cv = cv;
    cv.addEventListener("click", () => { this.attackAt = performance.now(); });
  }

  async show(look: Look) {
    this.look = look;
    const c = await composerFor(look);
    if (this.look !== look) return;
    this.comp = c; this.shown = look;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    // draw the look the loaded parts belong to (a look is swapped in whole, never part by part)
    const look = this.shown;
    if (!this.comp || !look || !this.cv.isConnected || this.cv.offsetParent === null) return;
    const el = (now - this.t0) / 1000;
    const dir = this.dir ?? Math.floor(el / 2.4) % 8; // 0 front, then turning right ... (5..7 = mirrored)
    const rel = dir <= 4 ? (dir * Math.PI) / 4 : -((8 - dir) * Math.PI) / 4;
    const { row, mirror } = facing(rel, 5);
    const at = (now - this.attackAt) / 1000;
    const k = this.comp.kind;
    const f = at < 0.6 ? this.comp.pick(k.attack(look.weapon ?? "fist"), at / 0.6)
      : this.walking ? this.comp.pick(k.walk, (el * 1.5) % 1) : this.comp.pick(k.idle, 0); // 1.5 walk cycles a second
    const { g, scale, cx, feet } = fit(this.cv);
    g.fillStyle = "rgba(0,0,0,.18)";
    g.beginPath(); g.ellipse(cx, feet - 2, 34 * scale, 10 * scale, 0, 0, Math.PI * 2); g.fill();
    if (f) this.comp.draw(g, f, row, mirror, scale * 160 / f.s.meta.unit, cx, feet);
  };
}

/** Warm the caches for monster species that are about to appear (a room join, or the next map at idle time): their anim
 *  sheets are fetched and decoded, so the first sprite of each species draws at once instead of popping in late. */
export function preloadMobs(ids: Iterable<number>) {
  for (const id of ids) {
    const body = `mob_${id}`;
    void viewSheet(body);
    for (const n of ["move", "act"]) void animSheet(`${body}_${n}`);
  }
}
/** Warm every part of a look (character select knows the look before the room joins). */
export function preloadLook(look: Look) {
  void loadPd(look);
}
