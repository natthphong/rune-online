// Terrain: the ground of a map, rendered from the shared tile grid without changing it (shared/map.ts generation stays
// as it is: saved positions depend on it). Tile kinds become smooth material *fields* sampled by one ground shader, so
// every transition (path to grass, shore to water, plaza rim) is an irregular painted edge instead of a tile polygon:
//  - water: signed distance to a rounded, noise-wobbled shoreline. Ponds are painted on the ground mesh itself (which
//    is flattened to WATER_Y there): a muddy bank and wet dark soil on land, foam on the waterline, the bed showing
//    through the shallows, two scrolling painted ripple layers. Being part of the ground, water takes cast shadows.
//  - plaza: signed distance to the paved area's rim: a curb ring, grass creeping into the joints near it, broken
//    stones scattered outside it, a contact shade line.
//  - dirt / stone: blurred weights, cut into ragged borders by noise and by the textures' own light/dark detail.
//  - shade: occlusion pooled under tree canopies and at rock feet, plus large-scale light variation (warm lit
//    stretches, cooler darker ones), so the ground reads as terrain rather than a flat sheet.
// The fields extend MARGIN tiles beyond the map (roads and ponds run on a little, then plain grass) where the forest
// ring stands; an apron with the same material carries the ground to the horizon.
import * as THREE from "three";
import { lookOf } from "./themes.ts";
import { TILE, type GameMap } from "../../shared/map.ts";
import { deepShadow, patched, type Patch } from "./props.ts";

/** height of the pond surfaces (the ground mesh is flat at this height wherever there is water) */
export const WATER_Y = -0.16;
/** field texels per tile */
const RES = 8;
/** tiles of terrain beyond the map edge (the forest ring stands in it) */
export const MARGIN = 12;
/** ground mesh vertex spacing, tiles */
const STEP = 1 / 3;
/** width of the bank sloping from the land down to the water, tiles */
const BANK = 0.5;
/** signed distances are stored as 128 + d * SDF_SCALE in 8 bits (+-4 tiles) */
const SDF_SCALE = 32;

/** an occluder pooling shade on the ground: centre, radius (tiles), strength */
export type Occluder = { x: number; y: number; r: number; k: number };

// ---------- small deterministic noise ----------
function hash2(x: number, y: number, s: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** smooth value noise in [0, 1]; `period` > 0 makes it tile every `period` cells */
export function vnoise(x: number, y: number, s: number, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (i: number) => (period ? ((i % period) + period) % period : i);
  const a = hash2(w(xi), w(yi), s), b = hash2(w(xi + 1), w(yi), s), c = hash2(w(xi), w(yi + 1), s), d = hash2(w(xi + 1), w(yi + 1), s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// ---------- field maths ----------
/** box blur of radius r along rows (running sum, edges clamped) */
function boxRows(src: Float32Array, dst: Float32Array, nx: number, ny: number, r: number) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < ny; y++) {
    const o = y * nx;
    let acc = src[o] * (r + 1);
    for (let i = 1; i <= r; i++) acc += src[o + Math.min(nx - 1, i)];
    for (let x = 0; x < nx; x++) {
      dst[o + x] = acc * inv;
      acc += src[o + Math.min(nx - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
}
/** box blur of radius r along columns, row by row (one running sum per column keeps memory access sequential) */
function boxCols(src: Float32Array, dst: Float32Array, nx: number, ny: number, r: number) {
  const inv = 1 / (2 * r + 1), acc = new Float64Array(nx);
  for (let x = 0; x < nx; x++) {
    let a = src[x] * (r + 1);
    for (let i = 1; i <= r; i++) a += src[Math.min(ny - 1, i) * nx + x];
    acc[x] = a;
  }
  for (let y = 0; y < ny; y++) {
    const o = y * nx, add = Math.min(ny - 1, y + r + 1) * nx, sub = Math.max(0, y - r) * nx;
    for (let x = 0; x < nx; x++) {
      dst[o + x] = acc[x] * inv;
      acc[x] += src[add + x] - src[sub + x];
    }
  }
}
/** Gaussian blur (sigma in texels) of an nx * ny grid, approximated by three box passes per axis (edges clamped) */
function blur(src: Float32Array, nx: number, ny: number, sigma: number) {
  // box widths whose three-fold convolution has the Gaussian's variance (W. Jarosz, "Fast image convolutions")
  const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    const r = ((pass < m ? wl : wl + 2) - 1) / 2;
    boxRows(a, b, nx, ny, r);
    boxCols(b, a, nx, ny, r);
  }
  return a;
}

/** squared Euclidean distance transform along one line (Felzenszwalb & Huttenlocher) */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
/** distance (texels) from every texel to the nearest texel where `on` is set */
function edt(on: Uint8Array, nx: number, ny: number) {
  const n = Math.max(nx, ny), INF = 1e20;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(nx * ny);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = on[y * nx + x] ? 0 : INF;
    edt1(f, ny, d, v, z);
    for (let y = 0; y < ny; y++) g[y * nx + x] = d[y];
  }
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) f[x] = g[y * nx + x];
    edt1(f, nx, d, v, z);
    for (let x = 0; x < nx; x++) out[y * nx + x] = Math.sqrt(d[x]);
  }
  return out;
}
/** signed distance (tiles, + outside) to the 0.5 contour of a smooth mask */
function sdf(mask: Float32Array, nx: number, ny: number) {
  const inside = new Uint8Array(mask.length), outside = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) { inside[i] = mask[i] > 0.5 ? 1 : 0; outside[i] = 1 - inside[i]; }
  const toIn = edt(inside, nx, ny), toOut = edt(outside, nx, ny), out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = (inside[i] ? -(toOut[i] - 0.5) : toIn[i] - 0.5) / RES;
  return out;
}

/** The map's material fields on a grid of RES texels per tile, covering the map plus MARGIN tiles around it. */
export class TerrainFields {
  /** world position of the grid's corner, texels per side */
  readonly x0: number; readonly y0: number; readonly nx: number; readonly ny: number;
  readonly water: Float32Array; // signed distance to the shoreline, tiles (+ on land)
  readonly plaza: Float32Array; // signed distance to the paved area's rim, tiles (+ outside)
  readonly dirt: Float32Array; // 0..1
  readonly stone: Float32Array; // 0..1
  readonly shade: Float32Array; // 1 = open sky; lower under canopies

  constructor(m: GameMap) {
    this.x0 = -0.5 - MARGIN; this.y0 = -0.5 - MARGIN;
    const nx = this.nx = (m.w + 2 * MARGIN) * RES, ny = this.ny = (m.h + 2 * MARGIN) * RES;
    // tile kinds; outside the map the edge row runs on for 2 tiles (roads and ponds don't stop at the border), then grass
    const kindAt = (tx: number, ty: number) => {
      const cx = Math.min(m.w - 1, Math.max(0, tx)), cy = Math.min(m.h - 1, Math.max(0, ty));
      if (Math.max(Math.abs(tx - cx), Math.abs(ty - cy)) > 2) return TILE.grass;
      return m.kind[cy * m.w + cx];
    };
    const masks = [TILE.water, TILE.cobble, TILE.dirt, TILE.stone].map(() => new Float32Array(nx * ny));
    for (let j = 0; j < ny; j++) {
      const ty = Math.round(this.y0 + (j + 0.5) / RES);
      for (let i = 0; i < nx; i++) {
        const k = kindAt(Math.round(this.x0 + (i + 0.5) / RES), ty);
        const at = j * nx + i;
        if (k === TILE.water) masks[0][at] = 1;
        else if (k === TILE.cobble) masks[1][at] = 1;
        else if (k === TILE.dirt) masks[2][at] = 1;
        else if (k === TILE.stone) masks[3][at] = 1;
      }
    }
    // shoreline: tile squares rounded off (a lone water tile keeps a pond ~0.8 tiles wide), then wobbled by three
    // octaves of noise, asymmetrically: land may jut ~0.5 tiles into the water (water tiles are blocked anyway), water
    // reaches at most 0.3 tiles into land, so a land tile's centre, where units stand, stays dry
    this.water = sdf(blur(masks[0], nx, ny, 0.38 * RES), nx, ny);
    this.plaza = sdf(blur(masks[1], nx, ny, 0.65 * RES), nx, ny);
    for (let j = 0; j < ny; j++) {
      const wy = this.y0 + (j + 0.5) / RES;
      for (let i = 0; i < nx; i++) {
        const wx = this.x0 + (i + 0.5) / RES, at = j * nx + i;
        const n = vnoise(wx * 0.24, wy * 0.24, 10) * 0.45 + vnoise(wx * 0.55, wy * 0.55, 11) * 0.35 + vnoise(wx * 1.3, wy * 1.3, 12) * 0.2;
        const c = Math.min(1, Math.max(0, (n - 0.25) * 2)), wob = c * c * (3 - 2 * c); // contrast: coves and points are common
        this.water[at] += (wob - 0.36) * 0.82; // -0.3 (water reaches into land) .. +0.52 (land juts into the water)
        this.plaza[at] += (vnoise(wx * 0.9, wy * 0.9, 13) - 0.5) * 0.18;
      }
    }
    this.dirt = blur(masks[2], nx, ny, 0.5 * RES);
    this.stone = blur(masks[3], nx, ny, 0.7 * RES);
    this.shade = new Float32Array(nx * ny).fill(1); // open sky until occlude()
  }

  /** world (x, y) -> fractional texel coordinates */
  private texel(x: number, y: number) { return [(x - this.x0) * RES - 0.5, (y - this.y0) * RES - 0.5]; }

  /** bilinear sample of one field at world (x, y) */
  sample(f: Float32Array, x: number, y: number) {
    const [fx, fy] = this.texel(x, y);
    const i = Math.min(this.nx - 2, Math.max(0, Math.floor(fx))), j = Math.min(this.ny - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), at = j * this.nx + i;
    const a = f[at] + (f[at + 1] - f[at]) * tx, b = f[at + this.nx] + (f[at + this.nx + 1] - f[at + this.nx]) * tx;
    return a + (b - a) * ty;
  }

  /** pool shade under canopies and at rock feet; overlapping pools saturate instead of going black */
  occlude(list: Occluder[]) {
    const occ = new Float32Array(this.nx * this.ny);
    for (const o of list) {
      const [cx, cy] = this.texel(o.x, o.y), rr = o.r * RES, reach = Math.ceil(rr * 2.6);
      for (let j = Math.max(0, Math.floor(cy) - reach); j <= Math.min(this.ny - 1, Math.ceil(cy) + reach); j++) {
        for (let i = Math.max(0, Math.floor(cx) - reach); i <= Math.min(this.nx - 1, Math.ceil(cx) + reach); i++) {
          const d2 = ((i - cx) ** 2 + (j - cy) ** 2) / (rr * rr);
          if (d2 < 6.8) occ[j * this.nx + i] += o.k * Math.exp(-d2);
        }
      }
    }
    for (let i = 0; i < occ.length; i++) this.shade[i] = 1 - 0.5 * (1 - Math.exp(-occ[i] * 1.7));
  }

  /** W03 caves: the ground goes dark (`dark`, 0..1) except in a pool of light around every torch (radius ~`reach` tiles); call
   *  after occlude */
  light(list: { x: number; y: number }[], dark: number, reach = 6) {
    const lit = new Float32Array(this.nx * this.ny), rr = reach * RES;
    for (const o of list) {
      const [cx, cy] = this.texel(o.x, o.y);
      for (let j = Math.max(0, Math.floor(cy - rr)); j <= Math.min(this.ny - 1, Math.ceil(cy + rr)); j++) {
        for (let i = Math.max(0, Math.floor(cx - rr)); i <= Math.min(this.nx - 1, Math.ceil(cx + rr)); i++) {
          const d2 = ((i - cx) ** 2 + (j - cy) ** 2) / (rr * rr);
          if (d2 < 1) lit[j * this.nx + i] += (1 - d2) * (1 - d2);
        }
      }
    }
    for (let i = 0; i < lit.length; i++) this.shade[i] *= dark + (1 - dark) * Math.min(1, lit[i] * 1.3);
  }

  /** RGBA8 field texture (water sdf, plaza sdf, dirt, stone) + R8 shade texture for the ground shader */
  textures() {
    const n = this.nx * this.ny, rgba = new Uint8Array(n * 4), r8 = new Uint8Array(n);
    const enc = (d: number) => Math.max(0, Math.min(255, Math.round(128 + d * SDF_SCALE)));
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = enc(this.water[i]);
      rgba[i * 4 + 1] = enc(this.plaza[i]);
      rgba[i * 4 + 2] = Math.round(Math.min(1, this.dirt[i]) * 255);
      rgba[i * 4 + 3] = Math.round(Math.min(1, this.stone[i]) * 255);
      r8[i] = Math.round(this.shade[i] * 255);
    }
    const mk = (data: Uint8Array, format: THREE.PixelFormat) => {
      const t = new THREE.DataTexture(data, this.nx, this.ny, format, THREE.UnsignedByteType);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    };
    return { field: mk(rgba, THREE.RGBAFormat), shade: mk(r8, THREE.RedFormat) };
  }
}

/** tileable RGBA value noise (R: 8, G: 16, B: 32, A: 4 cells per repeat) for the ground shader */
function noiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4), periods = [8, 16, 32, 4];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        const p = periods[c], s = p / size;
        data[(y * size + x) * 4 + c] = Math.round(vnoise(x * s, y * s, 101 + c, p) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ---------- painted ground textures ----------
const texLoader = new THREE.TextureLoader();
const FALLBACK: Record<string, string> = { grass: "#6fae4a", dirt: "#b08d57", stone: "#8d8f86", cobble: "#c9b48e", water: "#2f6f80", rock: "#8a8780" };
function groundTexture(name: string, file = `ground_${name}.jpg`) {
  // solid colour until the painted texture arrives (or if it is missing)
  const c = new THREE.Color(FALLBACK[name]);
  const t = new THREE.DataTexture(new Uint8Array([c.r * 255, c.g * 255, c.b * 255, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  const holder = { value: t as THREE.Texture };
  texLoader.load(`/textures/${file}`, (img) => {
    img.wrapS = img.wrapT = THREE.RepeatWrapping;
    img.colorSpace = THREE.SRGBColorSpace;
    img.anisotropy = 8;
    holder.value = img;
  }, undefined, () => { /* keep fallback colour */ });
  return holder;
}

const time = { value: 0 };
export function tickTerrain(t: number) { time.value = t; }

/** direction towards the sun (main.ts: sun.position = target + (-20, 40, 10)) */
const SUN = new THREE.Vector3(-20, 40, 10).normalize();

const GROUND_PARS = /* glsl */ `
const vec3 SUN_DIR = vec3(${SUN.x.toFixed(4)}, ${SUN.y.toFixed(4)}, ${SUN.z.toFixed(4)});
uniform sampler2D tGrass, tDirt, tStone, tCobble, tWater, tRock, tField, tShade, tNoise;
uniform vec3 uGrassT, uDirtT, uWaterT; // the map theme's ground tints (themes.ts)
uniform float uCave; // W03: 1 in a cave (no grass anywhere; the rock between the passages fades to black above the floor)
uniform vec2 uOrigin, uSize;
uniform float uTime;
varying vec2 vXZ;
varying vec3 vWN;
varying float vY;
vec3 layer(sampler2D t, vec2 uv) { return mix(texture2D(t, uv).rgb, texture2D(t, uv * 0.31 + 0.17).rgb, 0.35); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

const GROUND_MAIN = /* glsl */ `
  vec2 fuv = (vXZ - uOrigin) / uSize;
  vec4 F = texture2D(tField, fuv);
  float ao = texture2D(tShade, fuv).r;
  vec4 nA = texture2D(tNoise, vXZ * 0.123);        // ~1 tile features
  vec4 nB = texture2D(tNoise, vXZ * 0.41 + 0.29);   // finer
  vec2 uvw = vXZ * 0.25;                            // one texture repeat every 4 tiles
  vec3 grass = layer(tGrass, uvw) * uGrassT, dirt = layer(tDirt, uvw) * 0.92 * uDirtT, stone = layer(tStone, uvw);
  grass = mix(grass, dirt * uGrassT * 1.6, uCave); // caves: packed earth wherever a field would grow grass
  vec4 nL = texture2D(tNoise, vXZ * 0.047 + 0.71);  // ~2.7 tile waves

  // ragged borders: a wavy contour (low-frequency noise) with a soft few-pixel blend, broken up by the paintings' own
  // detail (grass blades poke into the path, bright pebbles out of it)
  float eD = F.b + (nL.r - 0.5) * 0.55 + (nA.g - 0.5) * 0.28;
  float wD = smoothstep(0.36, 0.64, eD + ((luma(dirt) - luma(grass)) * 0.7 + (nB.b - 0.5) * 0.25) * smoothstep(0.1, 0.5, eD) * (1.0 - smoothstep(0.5, 0.9, eD)));
  // the path itself: patches of darker packed earth and lighter dust, so it is not one flat tan sheet
  dirt *= mix(vec3(0.84, 0.82, 0.8), vec3(1.05, 1.03, 1.0), smoothstep(0.25, 0.75, nL.a * 0.6 + nA.b * 0.4));
  vec3 ground = mix(grass, dirt, wD);
  // rocky ground: the painting's stones (brighter than their surroundings) stay, grass fills the gaps between them
  float relS = luma(stone) / max(0.05, luma(texture2D(tStone, uvw, 5.0).rgb));
  float wS = smoothstep(0.42, 0.62, F.a + (nL.g - 0.5) * 0.45 + (relS - 1.0) * 0.9 * smoothstep(0.15, 0.6, F.a));
  ground = mix(ground, mix(stone, ground, 0.18), wS);

  // steep banks: where the field steps up sharply the ground shows painted rock strata (run along the slope)
  vec3 wn = normalize(vWN);
  vec2 hd = normalize(wn.xz + vec2(1e-4, 0.0));
  vec3 rock = texture2D(tRock, vec2(dot(vXZ, vec2(-hd.y, hd.x)), vY * 1.5) * 0.42).rgb;
  float steep = (1.0 - smoothstep(0.8, 0.9, wn.y)) * smoothstep(0.35, 0.7, nB.g + 0.35);

  // paved plaza: curb ring inside the rim, grass in the joints near it, broken stones scattered outside it
  float dp = (F.g * 255.0 - 128.0) / ${SDF_SCALE.toFixed(1)} + (nB.r - 0.5) * 0.1;
  vec3 cob = texture2D(tCobble, vXZ * 0.4).rgb;
  float rel = luma(cob) / max(0.05, luma(texture2D(tCobble, vXZ * 0.4, 5.0).rgb)); // > 1 on a stone, < 1 in a joint
  float onStone = smoothstep(0.93, 1.05, rel);
  vec3 curbC = texture2D(tCobble, vXZ * 0.19 + 0.37).rgb;
  float relC = luma(curbC) / max(0.05, luma(texture2D(tCobble, vXZ * 0.19 + 0.37, 5.0).rgb));
  float curb = smoothstep(-0.52, -0.44, dp) * (1.0 - smoothstep(-0.05, 0.0, dp));
  vec3 paved = cob * vec3(0.84, 0.82, 0.8);
  paved = mix(paved, curbC * mix(0.55, 0.92, smoothstep(0.85, 1.02, relC)) * vec3(0.95, 0.93, 0.9), curb);
  float creep = (1.0 - onStone) * smoothstep(-1.6, -0.5, dp) * smoothstep(0.3, 0.65, nA.b) * (1.0 - curb);
  paved = mix(paved, grass * 0.85, creep * 0.8);
  float scatter = onStone * (1.0 - smoothstep(0.0, 0.85, dp + (nA.a - 0.5) * 0.6)) * step(0.0, dp);
  float paveW = max(1.0 - smoothstep(-0.02, 0.02, dp), scatter);
  float curbShade = smoothstep(-0.02, 0.01, dp) * (1.0 - smoothstep(0.0, 0.2, dp)) * (1.0 - scatter);
  ground = mix(ground, rock * vec3(0.86, 0.86, 0.84), steep * (1.0 - paveW));
  ground = mix(ground, paved, paveW) * (1.0 - 0.32 * curbShade);

  // shore: muddy bank, wet dark soil, then water (bed in the shallows, painted ripples, foam on the waterline)
  float dw = (F.r * 255.0 - 128.0) / ${SDF_SCALE.toFixed(1)} + (nA.g - 0.5) * 0.12 + (nB.r - 0.5) * 0.08;
  vec3 mud = dirt * vec3(0.58, 0.5, 0.4);
  float wet = 1.0 - smoothstep(0.0, 0.75, dw);
  ground = mix(ground, mud, (1.0 - smoothstep(0.04, 0.34, dw)) * 0.85);
  ground *= 1.0 - 0.34 * wet * wet;
  float depth = smoothstep(0.0, 2.0, -dw);
  // two painted ripple layers drifting across each other; part of each comes from a blurrier mip, which keeps the
  // surface calm and painterly (softer strokes, fewer glints)
  vec2 wuv = vXZ * 0.19, w1 = wuv + uTime * vec2(0.012, 0.007), w2 = vec2(-wuv.y, wuv.x) * 1.31 + uTime * vec2(-0.009, 0.011);
  vec3 ripple = mix(mix(texture2D(tWater, w1).rgb, texture2D(tWater, w2).rgb, 0.5),
                    mix(texture2D(tWater, w1, 2.5).rgb, texture2D(tWater, w2, 2.5).rgb, 0.5), 0.45);
  vec3 water = mix(mud * 0.72, ripple * vec3(0.8, 0.95, 0.92), 0.5 + 0.35 * depth);
  water = mix(water, ripple * vec3(0.4, 0.56, 0.64), smoothstep(0.2, 1.0, depth) * 0.8);
  // shallows: the bed lightens the water just inside the waterline; foam flecks gather on some stretches of shore only
  water = mix(water, mix(water, dirt * vec3(0.78, 0.8, 0.7), 0.45), smoothstep(-0.32, -0.02, dw) * 0.8);
  float foam = (1.0 - smoothstep(-0.05, 0.0, dw)) * smoothstep(-0.2, -0.07, dw);
  foam *= smoothstep(0.5, 0.68, nL.b) * smoothstep(0.5, 0.8, texture2D(tNoise, vXZ * 1.3 + vec2(uTime * 0.02, uTime * -0.011)).b);
  water = mix(water, vec3(0.8, 0.86, 0.8), foam * 0.45);
  water *= uWaterT;
  ground = mix(ground, water, 1.0 - smoothstep(-0.07, 0.02, dw));

  // relief: the field's gentle slopes are lit up or shaded several times more than plain Lambert would, the way
  // painted field lightmaps model the ground's rises and hollows (SUN_DIR: main.ts puts the sun at (-20, 40, 10))
  float relief = dot(normalize(vWN), SUN_DIR) - SUN_DIR.y;
  ground *= clamp(1.0 + relief * 2.6, 0.72, 1.18);
  // large-scale light: warm sunlit stretches and cooler, darker ones; occlusion pooled under canopies
  float lv = texture2D(tNoise, vXZ * 0.02 + 0.61).a * 0.7 + texture2D(tNoise, vXZ * 0.035 + 0.13).r * 0.3;
  ground *= mix(vec3(0.8, 0.84, 0.9), vec3(1.07, 1.04, 0.92), smoothstep(0.28, 0.72, lv));
  ground *= ao;
  // caves: the walls are high rock; their faces keep the rock strata, their tops sink into the dark like a cave's ceiling void
  ground = mix(ground, mix(ground, rock * vec3(0.5, 0.47, 0.45), 0.6) * (1.0 - 0.88 * smoothstep(0.55, 1.25, vY)), uCave * smoothstep(0.18, 0.5, vY));
  diffuseColor.rgb *= ground;
`;

/** Ground mesh + apron for a map; `heightAt` samples the rendered surface (units stand on what is drawn). */
export class Terrain {
  readonly group = new THREE.Group();
  readonly ground: THREE.Mesh;
  private readonly hx0: number; private readonly hy0: number; private readonly hn: number; private readonly hm: number;
  private readonly hgt: Float32Array;

  /** builds from `fields` without keeping them (only the height grid stays, for heightAt) */
  constructor(m: GameMap, fields: TerrainFields) {
    // land height: bilinear between tile centres (a tile's centre is exactly its height); water tiles count as 0,
    // outside the map the edge heights fade out
    const tileH = (tx: number, ty: number) => {
      const cx = Math.min(m.w - 1, Math.max(0, tx)), cy = Math.min(m.h - 1, Math.max(0, ty)), i = cy * m.w + cx;
      const out = Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
      return m.kind[i] === TILE.water ? 0 : Math.max(0, m.height[i]) * Math.max(0, 1 - out / 3);
    };
    const landH = (x: number, y: number) => {
      const fx = Math.floor(x), fy = Math.floor(y), tx = x - fx, ty = y - fy;
      const a = tileH(fx, fy) + (tileH(fx + 1, fy) - tileH(fx, fy)) * tx;
      const b = tileH(fx, fy + 1) + (tileH(fx + 1, fy + 1) - tileH(fx, fy + 1)) * tx;
      return a + (b - a) * ty;
    };
    const smooth = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const x0 = this.hx0 = fields.x0, y0 = this.hy0 = fields.y0;
    const n = this.hn = Math.round((m.w + 2 * MARGIN) / STEP) + 1, mm = this.hm = Math.round((m.h + 2 * MARGIN) / STEP) + 1;
    const pos = new Float32Array(n * mm * 3), hgt = this.hgt = new Float32Array(n * mm);
    // bilinear tile heights crease along the tile-centre lines (and the relief shading would show every crease):
    // smooth them over ~half a tile first, then cut the banks down to the water
    let land = new Float32Array(n * mm);
    for (let j = 0; j < mm; j++) for (let i = 0; i < n; i++) land[j * n + i] = landH(x0 + i * STEP, y0 + j * STEP);
    land = blur(land, n, mm, 0.5 / STEP);
    for (let j = 0; j < mm; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * STEP, y = y0 + j * STEP, ds = fields.sample(fields.water, x, y);
        const h = ds <= 0 ? WATER_Y : WATER_Y + (land[j * n + i] - WATER_Y) * smooth(0, BANK, ds);
        hgt[j * n + i] = h;
        pos.set([x, h, y], (j * n + i) * 3);
      }
    }
    const index: number[] = [];
    for (let j = 0; j < mm - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const { field, shade } = fields.textures();
    const T = {
      grass: groundTexture("grass"), dirt: groundTexture("dirt"), stone: groundTexture("stone"), cobble: groundTexture("cobble"),
      water: groundTexture("water"), rock: groundTexture("rock", "prop_rock.jpg"),
    };
    const sizeX = (m.w + 2 * MARGIN), sizeY = (m.h + 2 * MARGIN), look = lookOf(m.theme);
    const groundPatch: Patch = (sh) => {
      Object.assign(sh.uniforms, {
        tGrass: T.grass, tDirt: T.dirt, tStone: T.stone, tCobble: T.cobble, tWater: T.water, tRock: T.rock,
        tField: { value: field }, tShade: { value: shade }, tNoise: { value: noiseTexture() },
        uOrigin: { value: new THREE.Vector2(x0, y0) }, uSize: { value: new THREE.Vector2(sizeX, sizeY) }, uTime: time,
        uCave: { value: look.cave ? 1 : 0 },
        uGrassT: { value: new THREE.Vector3(...look.grass) }, uDirtT: { value: new THREE.Vector3(...look.dirt) }, uWaterT: { value: new THREE.Vector3(...look.water) },
      });
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vXZ;\nvarying vec3 vWN;\nvarying float vY;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvXZ = position.xz;\nvWN = normal;\nvY = position.y;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>\n${GROUND_PARS}`)
        .replace("#include <map_fragment>", GROUND_MAIN);
    };
    const mat = patched(new THREE.MeshLambertMaterial({ color: 0xffffff }), "terrain", groundPatch, deepShadow);
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.name = "ground";
    this.ground.receiveShadow = true;
    // clicks: the ground is a heightfield, so march the ray over it instead of testing ~140k triangles
    let maxH = -Infinity;
    for (const h of hgt) maxH = Math.max(maxH, h);
    const x1 = x0 + sizeX, y1 = y0 + sizeY;
    this.ground.raycast = (raycaster, intersects) => {
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      if (d.y >= 0 && o.y > maxH) return;
      const above = (t: number) => o.y + d.y * t - this.heightAt(o.x + d.x * t, o.z + d.z * t);
      const step = 0.08, far = Math.min(raycaster.far, 500);
      let t = Math.max(raycaster.near, d.y < 0 && o.y > maxH ? (o.y - maxH - 0.01) / -d.y : 0), prev = above(t);
      for (; t < far; t += step) {
        const f = above(t + step);
        if (prev > 0 && f <= 0) {
          let a = t, b = t + step;
          for (let k = 0; k < 18; k++) { const mid = (a + b) / 2; if (above(mid) > 0) a = mid; else b = mid; }
          const point = d.clone().multiplyScalar(b).add(o);
          if (point.x >= x0 && point.x <= x1 && point.z >= y0 && point.z <= y1) intersects.push({ distance: b, point, object: this.ground });
          return;
        }
        prev = f;
      }
    };
    this.group.add(this.ground);

    // apron: the same material carried out to the horizon around the terrain (its edge is plain grass at height 0)
    const ax0 = x0, az0 = y0, ax1 = x0 + sizeX, az1 = y0 + sizeY, pad = 60, top = 0;
    const quads = [
      [ax0 - pad, az0 - pad, ax1 + pad, az0], [ax0 - pad, az1, ax1 + pad, az1 + pad],
      [ax0 - pad, az0, ax0, az1], [ax1, az0, ax1 + pad, az1],
    ];
    const apronPos: number[] = [];
    for (const [qx0, qz0, qx1, qz1] of quads) apronPos.push(qx0, top, qz0, qx0, top, qz1, qx1, top, qz0, qx1, top, qz0, qx0, top, qz1, qx1, top, qz1);
    const apronGeo = new THREE.BufferGeometry();
    apronGeo.setAttribute("position", new THREE.Float32BufferAttribute(apronPos, 3));
    apronGeo.computeVertexNormals();
    const apron = new THREE.Mesh(apronGeo, mat);
    apron.receiveShadow = true;
    this.group.add(apron);
  }

  /** height of the drawn ground at world (x, y) (bilinear over the mesh grid) */
  heightAt(x: number, y: number) {
    const fx = (x - this.hx0) / STEP, fy = (y - this.hy0) / STEP;
    const i = Math.min(this.hn - 2, Math.max(0, Math.floor(fx))), j = Math.min(this.hm - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), h = this.hgt, at = j * this.hn + i;
    // the mesh splits each cell along the b-c diagonal: sample the triangle the point is in
    if (tx + ty <= 1) return h[at] + (h[at + 1] - h[at]) * tx + (h[at + this.hn] - h[at]) * ty;
    const d = h[at + this.hn + 1];
    return d + (h[at + this.hn] - d) * (1 - tx) + (h[at + 1] - d) * (1 - ty);
  }
}
