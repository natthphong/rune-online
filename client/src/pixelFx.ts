import * as THREE from "three";

// PixelFX sprite sheets (MIT, github.com/patch-gg/pixelfx; exported by tools/fx/export.mjs into public/fx/) played as quads in
// the world, plus the boss-fight kit around them: telegraph decals on the terrain, camera shake and hit-stop.
//   spawn(name, pos, opts)          an animated quad that plays once and frees itself (billboard, or flat on the ground)
//   telegraph(shape, ms, ...)       a warning area that fills up over `ms`, then flashes at impact (handle.impact())
//   shake(strength, ms) / hitStop(ms)  read by main.ts' frame loop (applyShake after placeCamera, frozen() for sprite animation)
// Never runs PixelFX's own renderer in the game: the sheets are baked.

type Sheet = { src: string; w: number; h: number; cols: number; n: number; fps: number; add: boolean; pivot: [number, number] };
export type SpawnOpts = {
  /** multiplier on the natural size (a 38 px PixelFX dummy = our 1.5-unit character) */ scale?: number;
  /** world width of a frame instead of scale */ size?: number;
  tint?: THREE.ColorRepresentation; /** lay it flat on the ground, centred on pos */ ground?: boolean; yOffset?: number; delayMs?: number;
  /** radians: billboard roll / ground yaw */ rotation?: number; fps?: number; flip?: boolean;
  /** anchor the frame's centre on pos instead of the effect's origin (feet) */ center?: boolean;
  /** draw over everything (small hit sparks, like Fx.impact) */ onTop?: boolean; opacity?: number;
  /** a live point the quad rides on (pos is then an offset from it) */ follow?: THREE.Vector3;
};

const PX = 1.5 / 38; // world units per sheet pixel
const MAX_QUADS = 80;
const URL_BASE = "/fx/";

let scene: THREE.Scene | undefined;
let groundY: (x: number, z: number) => number = () => 0;
let index: Promise<Record<string, Sheet>> | undefined;
const textures = new Map<string, Promise<THREE.Texture | undefined>>();
const loaded = new Map<string, THREE.Texture>();

function sheets() {
  return (index ??= fetch(`${URL_BASE}index.json`).then((r) => r.json()).catch(() => ({})));
}
function texture(name: string) {
  let p = textures.get(name);
  if (!p) {
    p = new Promise<THREE.Texture | undefined>((res) => {
      new THREE.TextureLoader().load(`${URL_BASE}${name}.png`, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        loaded.set(name, t);
        res(t);
      }, undefined, () => res(undefined));
    });
    textures.set(name, p);
  }
  return p;
}

/** main.ts: once, with the scene and the terrain height (cell coordinates = world x / z). */
export function initPixelFx(s: THREE.Scene, height: (x: number, z: number) => number) {
  scene = s;
  groundY = height;
  // lazy: the sheets (~1.7 MB) download at idle a few seconds after boot, or on first use
  setTimeout(() => { void sheets().then((ix) => { for (const n of Object.keys(ix)) void texture(n); }); }, 4000);
}
export const groundAt = (x: number, z: number) => groundY(x, z);

/** A camera-facing quad gets the depth of its base pulled toward the camera (animSprite.ts flatDepth): terrain and props behind
 *  never cut into it, things in front of it still cover it. */
function flatDepth<M extends THREE.Material>(mat: M) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <logdepthbuf_vertex>", `
      vec4 baseClip = projectionMatrix * vec4(modelViewMatrix[3].xyz + vec3(0.0, 0.0, 1.0), 1.0);
      gl_Position.z = baseClip.z / baseClip.w * gl_Position.w;
      #include <logdepthbuf_vertex>`);
  };
  mat.customProgramCacheKey = () => "pfx-flat";
  return mat;
}

// Every quad is its own 4-vertex plane whose UVs pick the frame, all quads of a sheet share ONE texture (a texture clone per quad
// would re-upload the whole sheet: three's Texture.copy flags the shared source for upload). Billboards turn to the camera.
type Quad = { obj: THREE.Mesh; geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial; sheet: Sheet; t: number; fps: number; opacity: number;
  rows: number; frame: number; billboard: boolean; roll: number; follow?: THREE.Vector3; offset: THREE.Vector3 };
const live: Quad[] = [];

function freeQuad(q: Quad) {
  scene?.remove(q.obj);
  q.mat.dispose();
  q.geo.dispose();
}

/** Play sheet `name` once at `pos` (feet / ground point). Lazy: the sheet loads on first use (the quad starts when it is ready). */
export function spawn(name: string, pos: THREE.Vector3, opts: SpawnOpts = {}) {
  if (!scene) return;
  const at = pos.clone(), born = performance.now();
  void Promise.all([sheets(), texture(name)]).then(([ix, tex]) => {
    const sheet = ix[name];
    if (!sheet || !tex || !scene) return;
    const late = performance.now() - born;
    if (late > 600) return; // too late to mean anything
    if (live.length >= MAX_QUADS) freeQuad(live.shift()!);
    const rows = Math.ceil(sheet.n / sheet.cols);
    const blending = sheet.add ? THREE.AdditiveBlending : THREE.NormalBlending;
    const k = opts.size ? opts.size / (sheet.w * PX) : opts.scale ?? 1, W = sheet.w * PX * k, H = sheet.h * PX * k;
    const geo = new THREE.PlaneGeometry(1, 1);
    const center = opts.center || opts.ground, u = center ? 0.5 : sheet.pivot[0] / sheet.w, v = center ? 0.5 : sheet.pivot[1] / sheet.h;
    geo.translate(0.5 - u, v - 0.5, 0);
    geo.scale(W * (opts.flip ? -1 : 1), H, 1);
    let mat: THREE.MeshBasicMaterial;
    if (opts.ground) {
      geo.rotateX(-Math.PI / 2);
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      at.y = groundY(at.x, at.z) + 0.07 + (opts.yOffset ?? 0);
    } else {
      mat = flatDepth(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !opts.onTop, blending, side: THREE.DoubleSide }));
      at.y += opts.yOffset ?? 0;
    }
    const obj = new THREE.Mesh(geo, mat);
    obj.renderOrder = opts.onTop ? 11 : opts.ground ? 4 : 8;
    if (opts.ground) obj.rotation.y = opts.rotation ?? 0;
    if (opts.tint !== undefined) mat.color.set(opts.tint);
    obj.position.copy(at);
    if (opts.follow) obj.position.add(opts.follow);
    obj.visible = false;
    obj.frustumCulled = false;
    scene.add(obj);
    live.push({ obj, geo, mat, sheet, t: -Math.max(0, (opts.delayMs ?? 0) - late) / 1000, fps: opts.fps ?? sheet.fps, opacity: opts.opacity ?? 1, rows,
      frame: -1, billboard: !opts.ground, roll: opts.ground ? 0 : opts.rotation ?? 0, follow: opts.follow, offset: at });
  });
}
/** Point a quad's UVs at frame f of its sheet (PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right). */
function setFrame(q: Quad, f: number) {
  const c = f % q.sheet.cols, r = Math.floor(f / q.sheet.cols);
  const u0 = c / q.sheet.cols, u1 = (c + 1) / q.sheet.cols, v1 = 1 - r / q.rows, v0 = 1 - (r + 1) / q.rows;
  const uv = q.geo.attributes.uv as THREE.BufferAttribute;
  uv.setXY(0, u0, v1); uv.setXY(1, u1, v1); uv.setXY(2, u0, v0); uv.setXY(3, u1, v0);
  uv.needsUpdate = true;
  q.frame = f;
}

/** Warm the cache (a boss on screen: its move sheets). */
export function preload(...names: string[]) { for (const n of names) void texture(n); }

// ---------- camera shake + hit-stop ----------
type Shake = { t0: number; ms: number; s: number; seed: number };
const shakes: Shake[] = [];
let frozenUntil = 0;
/** A decaying shake of `strength` world units over `ms` (stacks with others; the strongest dominates). */
export function shake(strength: number, ms: number) {
  if (strength <= 0.003) return;
  if (shakes.length > 6) shakes.shift();
  shakes.push({ t0: performance.now(), ms, s: strength, seed: Math.random() * 100 });
}
/** Freeze sprite animation and world FX for `ms` (heavy impacts). UI keeps running. 0 releases a hold at once. */
export function hitStop(ms: number) { frozenUntil = ms <= 0 ? 0 : Math.max(frozenUntil, performance.now() + ms); }
export const frozen = (now: number) => now < frozenUntil;
const right = new THREE.Vector3(), up = new THREE.Vector3();
/** After main.ts placeCamera(): offset the camera in its own screen plane (the controller re-places it every frame). */
export function applyShake(camera: THREE.Camera, now: number) {
  let x = 0, y = 0;
  for (let i = shakes.length - 1; i >= 0; i--) {
    const sh = shakes[i], k = (now - sh.t0) / sh.ms;
    if (k >= 1) { shakes.splice(i, 1); continue; }
    const a = sh.s * (1 - k) * (1 - k), t = (now - sh.t0) / 1000 + sh.seed;
    x += a * (Math.sin(t * 71) * 0.6 + Math.sin(t * 113 + 1.3) * 0.4);
    y += a * (Math.sin(t * 89 + 2.1) * 0.6 + Math.sin(t * 131 + 0.7) * 0.4);
  }
  if (!x && !y) return;
  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(right, x).addScaledVector(up, y);
}

// ---------- telegraph decals ----------
export type TeleShape = { shape: "circle" | "line" | "sweep"; x: number; z: number; r: number; ex?: number; ez?: number; safe?: { x: number; z: number; r: number }[] };
export type Telegraph = { impact(): void; remove(): void; readonly done: boolean };
type Decal = { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; t0: number; ms: number; hit?: number; done: boolean; linger: number };
const decals: Decal[] = [];
const MAX_SAFE = 8;

const DECAL_VERT = `
varying vec2 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const DECAL_FRAG = `
uniform int uShape;
uniform vec2 uA, uB;
uniform float uR, uProg, uFlash, uTime, uAlpha, uWave;
uniform vec3 uSafe[${MAX_SAFE}];
uniform int uSafeN;
uniform vec3 uCol, uRim, uSafeCol;
varying vec2 vW;
void main() {
  vec2 p = (floor(vW * 8.0) + 0.5) / 8.0; // 1/8-cell pixels, like the sheets
  float inside, edge, fillK;
  if (uShape == 1) {
    vec2 ab = uB - uA; float L = max(length(ab), 0.001); vec2 dir = ab / L; vec2 ap = p - uA;
    float t = dot(ap, dir), s = abs(dir.x * ap.y - dir.y * ap.x);
    inside = step(0.0, t) * step(t, L) * step(s, uR);
    edge = min(min(t, L - t), uR - s); fillK = t / L;
  } else {
    float d = length(p - uA);
    inside = step(d, uR); edge = uR - d; fillK = d / uR;
  }
  float safeEdge = 1e3;
  for (int i = 0; i < ${MAX_SAFE}; i++) { if (i >= uSafeN) break; safeEdge = min(safeEdge, length(p - uSafe[i].xy) - uSafe[i].z); }
  float safe = step(safeEdge, 0.0);
  float danger = inside * (1.0 - safe);
  vec4 c = vec4(0.0);
  if (danger > 0.0) {
    float rim = 1.0 - smoothstep(0.0, 0.2, min(edge, safeEdge));
    float filled = step(fillK, uProg);
    float lead = (1.0 - smoothstep(0.0, 0.05, abs(fillK - uProg))) * step(uProg, 0.995);
    float stripes = step(0.55, fract((p.x + p.y) * 0.8 - uTime * 0.9));
    float late = smoothstep(0.8, 1.0, uProg) * (0.5 + 0.5 * sin(uTime * 34.0));
    float a = 0.14 + 0.07 * stripes + filled * 0.26 + rim * 0.6 + lead * 0.45 + late * 0.18;
    c = vec4(mix(uCol, uRim, max(rim, lead)), min(0.92, a));
    c.rgb = mix(c.rgb, vec3(1.0, 0.93, 0.75), uFlash * 0.75);
    c.a = mix(c.a, 0.95, uFlash);
    // the shockwave: a white-hot band racing out from the centre (circle / sweep) or down the line after the impact
    float wave = (1.0 - smoothstep(0.0, 0.07, abs(fillK - uWave * 1.05))) * step(0.001, uWave) * (1.0 - uWave);
    c.rgb = mix(c.rgb, vec3(1.0, 0.98, 0.9), wave);
    c.a = max(c.a, wave * 0.95);
  } else if (safe > 0.0 && (uShape == 2 || inside > 0.0)) {
    float rimS = 1.0 - smoothstep(0.0, 0.18, -safeEdge);
    float pulse = 0.5 + 0.5 * sin(uTime * 7.0);
    c = vec4(mix(uSafeCol, vec3(0.85, 1.0, 0.85), rimS), 0.2 + 0.12 * pulse + rimS * 0.65);
    c.a *= 1.0 - uFlash * 0.5;
  }
  c.a *= uAlpha;
  if (c.a < 0.01) discard;
  gl_FragColor = c;
}`;

/** A warning area on the terrain (cells = world units): fills from the centre (circle / sweep) or the start (line) over `ms`, blinks
 *  at the end, holds until impact() (or `ms` + 700 ms), flashes and fades. `tone` "danger" = red/orange; safe circles are green. */
export function telegraph(sh: TeleShape, ms: number, tone: "danger" | "acid" | "dark" = "danger"): Telegraph {
  const pad = 0.6;
  let x0: number, x1: number, z0: number, z1: number;
  if (sh.shape === "line") {
    const ex = sh.ex ?? sh.x, ez = sh.ez ?? sh.z;
    x0 = Math.min(sh.x, ex) - sh.r - pad; x1 = Math.max(sh.x, ex) + sh.r + pad; z0 = Math.min(sh.z, ez) - sh.r - pad; z1 = Math.max(sh.z, ez) + sh.r + pad;
  } else { x0 = sh.x - sh.r - pad; x1 = sh.x + sh.r + pad; z0 = sh.z - sh.r - pad; z1 = sh.z + sh.r + pad; }
  const nx = Math.min(128, Math.max(4, Math.ceil((x1 - x0) * 2))), nz = Math.min(128, Math.max(4, Math.ceil((z1 - z0) * 2)));
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz).rotateX(-Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + (x0 + x1) / 2, z = p.getZ(i) + (z0 + z1) / 2;
    p.setXYZ(i, x, groundY(x, z) + 0.08, z);
  }
  geo.computeBoundingSphere();
  const safe = (sh.safe ?? []).slice(0, MAX_SAFE);
  const col = { danger: ["#ff3b1a", "#ffc23a"], acid: ["#ff5a1a", "#e8ff4a"], dark: ["#e0283c", "#ff9a5a"] }[tone];
  const mat = new THREE.ShaderMaterial({
    vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    uniforms: {
      uShape: { value: sh.shape === "line" ? 1 : sh.shape === "sweep" ? 2 : 0 },
      uA: { value: new THREE.Vector2(sh.x, sh.z) }, uB: { value: new THREE.Vector2(sh.ex ?? sh.x, sh.ez ?? sh.z) }, uR: { value: sh.r },
      uProg: { value: 0 }, uFlash: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 0 }, uWave: { value: 0 },
      uSafe: { value: Array.from({ length: MAX_SAFE }, (_, i) => new THREE.Vector3(safe[i]?.x ?? 0, safe[i]?.z ?? 0, safe[i]?.r ?? 0)) }, uSafeN: { value: safe.length },
      uCol: { value: new THREE.Color(col[0]) }, uRim: { value: new THREE.Color(col[1]) }, uSafeCol: { value: new THREE.Color("#2dff6a") },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  scene?.add(mesh);
  const d: Decal = { mesh, mat, t0: performance.now(), ms: Math.max(1, ms), done: false, linger: 700 };
  decals.push(d);
  return {
    impact() { if (d.hit === undefined) d.hit = performance.now(); },
    remove() { d.done = true; },
    get done() { return d.done; },
  };
}

function dropDecal(d: Decal) {
  scene?.remove(d.mesh);
  d.mesh.geometry.dispose();
  d.mat.dispose();
}

/** Every frame from main.ts: `dt` is 0 during a hit-stop (sheets hold their frame). */
export function updatePixelFx(dt: number, now: number, camera: THREE.Camera) {
  for (let i = live.length - 1; i >= 0; i--) {
    const q = live[i];
    q.t += dt;
    if (q.t < 0) continue;
    const f = Math.floor(q.t * q.fps), n = q.sheet.n;
    if (f >= n) { freeQuad(q); live.splice(i, 1); continue; }
    if (f !== q.frame) setFrame(q, f);
    const tail = f / n; // the export trims the long fades: ease the last quarter out
    q.mat.opacity = q.opacity * (tail > 0.75 ? 1 - (tail - 0.75) / 0.25 : 1);
    if (q.follow) q.obj.position.copy(q.offset).add(q.follow);
    if (q.billboard) { q.obj.quaternion.copy(camera.quaternion); if (q.roll) q.obj.rotateZ(q.roll); }
    q.obj.visible = true;
  }
  const real = lastNow ? now - lastNow : 0;
  lastNow = now;
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i], t = now - d.t0, u = d.mat.uniforms;
    if (!d.done && d.hit === undefined && t > d.ms + d.linger) d.hit = now; // no impact came: flash and go anyway
    if (d.hit !== undefined && dt === 0) d.hit += real; // a hit-stop holds the impact flash too
    const h = d.hit === undefined ? -1 : now - d.hit;
    if (d.done || h > 520) { dropDecal(d); decals.splice(i, 1); continue; }
    u.uProg.value = Math.min(1, t / d.ms);
    u.uTime.value = t / 1000;
    u.uAlpha.value = Math.min(1, t / 120) * (h < 0 ? 1 : Math.max(0, 1 - Math.max(0, h - 160) / 360));
    u.uFlash.value = h < 0 ? 0 : Math.max(0, 1 - h / 260);
    u.uWave.value = h < 0 ? 0 : Math.min(0.999, 0.05 + h / 460);
  }
}
let lastNow = 0;

/** A map change: drop every quad and decal. */
export function clearPixelFx() {
  for (const q of live) freeQuad(q);
  live.length = 0;
  for (const d of decals) dropDecal(d);
  decals.length = 0;
  shakes.length = 0;
}

if (import.meta.env.DEV) Object.assign(window as any, { __pfx: { live, decals, loaded } });
