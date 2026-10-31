// Painted field props in the look of classic 2.5D MMORPG fields (replaces the untextured low-poly kit models):
//  - trees: bark trunk with root flare + branches; the canopy is a cloud of camera-facing painted leaf clumps spread
//    over the upper part of an ellipsoid held about two character heights up, so the trunk shows under the crown.
//    "Foliage normals" (pointing out of the ellipsoid) + baked AO make the sun side glow yellow-green and the inside
//    and underside go dark. In the shadow pass the same cards turn to face the sun, so trees cast lobed, leafy shadows.
//  - bushes: small leaf-clump domes;  rocks: painted boulder outcrops (cards, same painting style as the foliage) with
//    stones and tufts at their feet;
//  - decor: painted grass / flower / fern / shrub / mushroom cards standing on the ground, lily pads lying on water;
//    shore decor: reeds, rushes, pebbles, mossy stones, water lilies.
// Every kind is merged into one mesh; cards draw as an opaque core plus a soft blended fringe (softEdge). Textures are
// Codex paintings processed by tools/art/build_ro.py (prop_*; see ro/assets/CREDITS.md). Props in front of the
// player are dithered away.
import * as THREE from "three";

type Shader = Parameters<THREE.Material["onBeforeCompile"]>[0];
export type Patch = (sh: Shader) => void;

/** Apply onBeforeCompile patches in order. `key` keeps three's program cache apart for different patch sets. */
export function patched<M extends THREE.Material>(mat: M, key: string, ...patches: Patch[]): M {
  mat.onBeforeCompile = (sh) => { for (const p of patches) p(sh); };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// ---------- see-through ----------
// Props drawn in front of the player (closer to the camera) inside a screen-space circle around them are dithered
// away, so trees never hide your character. Updated every frame by setSeeThrough().
// `depth` is the player's distance from the camera (view space): anything nearer than the player's chest point
// (a trunk one tile in front included) is cleared.
// Combat (F17): the units in your fight (your target, units that hit you or that you hit) get the same treatment, so a
// fight under a canopy stays visible. Each clears a screen-space capsule from its feet, where its target ring lies, up
// to its head; its radius covers the ring and the body. `units` holds up to SEE_UNITS of them, most important first.
const SEE_UNITS = 6; // fight units first, then the NPCs near you (so a canopy never hides one: main.ts / worldItems.ts npcSeeUnits)
const see = {
  center: { value: new THREE.Vector2(9, 9) }, depth: { value: 0 }, radius: { value: 0.16 }, aspect: { value: 1 },
  // per fight unit: (x, feet y, head y, radius) in NDC (radius in NDC-y units; 0 = unused slot) and its view depth
  units: { value: Array.from({ length: SEE_UNITS }, () => new THREE.Vector4()) },
  unitDepth: { value: new Array<number>(SEE_UNITS).fill(0) },
};
/** A unit to keep clear of props: its drawn feet position and standing height (world units). */
export type SeeUnit = { at: THREE.Vector3; height: number };
const tmpV = new THREE.Vector3();
export function setSeeThrough(camera: THREE.Camera, target: THREE.Vector3 | null, aspect: number, units: readonly SeeUnit[] = []) {
  const perUnit = camera.projectionMatrix.elements[5]; // NDC-y units per world unit at view depth 1 (1 / tan(fov / 2))
  see.units.value.forEach((slot, i) => {
    const u = units[i];
    slot.w = 0;
    if (!u) return;
    tmpV.copy(u.at).applyMatrix4(camera.matrixWorldInverse);
    const depth = -tmpV.z;
    if (depth < 0.1) return;
    tmpV.applyMatrix4(camera.projectionMatrix);
    const k = perUnit / depth; // sprites face the camera, so the head is straight above the feet, height * k higher
    slot.set(tmpV.x, tmpV.y, tmpV.y + u.height * k, Math.max(0.55, 0.42 * u.height) * 1.45 * k);
    see.unitDepth.value[i] = depth;
  });
  if (!target) { see.center.value.set(9, 9); return; }
  tmpV.copy(target).setY(target.y + 0.7).applyMatrix4(camera.matrixWorldInverse);
  see.depth.value = -tmpV.z;
  tmpV.applyMatrix4(camera.projectionMatrix); // -> NDC
  see.center.value.set(tmpV.x, tmpV.y);
  see.aspect.value = aspect;
}
export const seeThrough: Patch = (sh) => {
  Object.assign(sh.uniforms, { uSeeC: see.center, uSeeD: see.depth, uSeeR: see.radius, uSeeA: see.aspect, uSeeU: see.units, uSeeUD: see.unitDepth });
  sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec4 vClipPos;\nvarying float vSeeDist;")
    .replace("#include <project_vertex>", "#include <project_vertex>\nvClipPos = gl_Position;\nvSeeDist = -mvPosition.z;");
  sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
uniform vec2 uSeeC; uniform float uSeeD, uSeeR, uSeeA; varying vec4 vClipPos; varying float vSeeDist;
uniform vec4 uSeeU[${SEE_UNITS}]; uniform float uSeeUD[${SEE_UNITS}];`)
    .replace("void main() {", `void main() {
      vec2 ndc = vClipPos.xy / vClipPos.w;
      vec2 d = (ndc - uSeeC) * vec2(uSeeA, 1.0);
      float r = length(d) / uSeeR;
      // ordered dither: fully clear in the middle, fading out towards the rim
      float dither = fract(dot(floor(gl_FragCoord.xy), vec2(0.5, 0.25)));
      if (r < 1.0 && vSeeDist < uSeeD - 0.3) {
        if (dither < smoothstep(1.0, 0.55, r)) discard;
      }
      // fight units: capsule from the feet (target ring) to the head, fully clear in its inner 69%
      for (int i = 0; i < ${SEE_UNITS}; i++) {
        vec4 u = uSeeU[i];
        if (u.w <= 0.0 || vSeeDist >= uSeeUD[i] - 0.3) continue;
        float ru = length(vec2((ndc.x - u.x) * uSeeA, ndc.y - clamp(ndc.y, u.y, u.z))) / u.w;
        if (ru < 1.0 && dither < smoothstep(1.0, 0.69, ru)) discard;
      }`);
};

// ---------- camera-facing cards ----------
// `position` is the card's anchor; `aOffset` is the corner's offset in VIEW space, so the card always faces whatever
// camera renders it (the player's camera, or the sun's shadow camera in the shadow pass). Run after seeThrough.
const billboard: Patch = (sh) => {
  sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute vec2 aOffset;")
    .replace("#include <project_vertex>", `
      vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
      mvPosition.xy += aOffset;
      gl_Position = projectionMatrix * mvPosition;`);
};

// ---------- foliage colour grade ----------
// The painted leaf atlas is brighter and more lemon than classic field canopies (measured on the reference captures:
// olive hue ~72 deg, saturation ~0.85, median luma ~80, top 5% ~120). Roll the albedo's highlights off and pull red
// and blue down (linear space); measured in game afterwards: mean rgb (79, 89, 18), median luma 76, top 5% ~126.
const foliageGrade: Patch = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
    diffuseColor.rgb = 0.9 * diffuseColor.rgb / (1.0 + 0.93 * diffuseColor.rgb) * vec3(0.85, 1.0, 0.45);`);
};

// ---------- soft card edges ----------
// An alpha-tested card has a hard, stair-stepped silhouette. Cards draw twice instead: an opaque core (alpha >= CORE,
// writes depth, casts shadows) and this blended fringe pass over the same geometry (no depth write) outside the core.
// The fringe takes its alpha from a blurrier mip level, so the painted rim fades out over a few pixels instead of one
// (the atlases' transparent texels carry bled leaf/stone colours, so the halo keeps the painting's colour).
const CORE = 0.6;
const softEdge: Patch = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace("#include <alphatest_fragment>", `
    if (diffuseColor.a >= ${CORE.toFixed(2)}) discard;
    diffuseColor.a = smoothstep(0.03, 0.75, texture2D(map, vMapUv, 1.4).a) * 0.92;
    if (diffuseColor.a < 0.02) discard;`);
};

// ---------- painted rock grade ----------
// The boulder painting is lit warmer and brighter than the field around it: pull it to the ground's value range and
// cool the stone a little, keeping the moss.
const rockGrade: Patch = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
    diffuseColor.rgb = diffuseColor.rgb / (1.0 + 0.35 * diffuseColor.rgb) * vec3(0.98, 1.0, 1.04);`);
};

// ---------- deep cast shadows ----------
// three's shadows only remove the sun's direct light, so with the bright sky light a cast shadow is a faint tint
// (~25% darker after sRGB). Painted 2.5D fields have shade about half as bright as sunlit ground, so where the sun is
// blocked the ambient light is dimmed too. Only on surfaces that face the sun: a rock's or trunk's own far side is
// shaded by the normal lighting already. The shadow map is re-sampled with a wider PCF radius for a soft rim.
const shade = { value: 0.42 };
export const deepShadow: Patch = (sh) => {
  sh.uniforms.uShadeAmbient = shade;
  sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uShadeAmbient;")
    .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
      #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      if ( receiveShadow ) {
        DirectionalLightShadow sh0 = directionalLightShadows[ 0 ];
        float lit = getShadow( directionalShadowMap[ 0 ], sh0.shadowMapSize, sh0.shadowIntensity, sh0.shadowBias, sh0.shadowRadius * 3.0 + 2.0, vDirectionalShadowCoord[ 0 ] );
        float facing = saturate( dot( geometryNormal, directionalLights[ 0 ].direction ) * 4.0 );
        reflectedLight.indirectDiffuse *= mix( 1.0, mix( uShadeAmbient, 1.0, lit ), facing );
      }
      #endif`);
};

// ---------- textures ----------
const texLoader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();
export function tex(file: string, repeat = false) {
  let t = textures.get(file);
  if (!t) {
    t = texLoader.load(`/textures/${file}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    textures.set(file, t);
  }
  return t;
}

/** uv rect [u0, v0, u1, v1] of cell i in an n x n atlas (cell 0 = top left; textures load with flipY) */
function cell(i: number, n: number): [number, number, number, number] {
  const cx = i % n, cy = Math.floor(i / n), e = 0.002;
  return [cx / n + e, 1 - (cy + 1) / n + e, (cx + 1) / n - e, 1 - cy / n - e];
}

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

export type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Merged quads: camera-facing cards (offset in view space) or flat quads (offset 0, real corners). */
class Cards {
  private p: number[] = []; private o: number[] = []; private t: number[] = []; private n: number[] = []; private c: number[] = []; private i: number[] = [];
  /** card of w x h world units facing the camera; (0.5, ay) of the card sits on the anchor: ay 0.5 = centred
   *  (leaf clumps), 0 = standing on it (decor). `flip` mirrors the picture. */
  card(x: number, y: number, z: number, w: number, h: number, spin: number, uv: number[], nrm: V3, col: V3, ay = 0.5, flip = false) {
    const base = this.p.length / 3, cs = Math.cos(spin), sn = Math.sin(spin);
    const [u0, v0, u1, v1] = uv;
    for (const [qx, qy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const ox = (qx - 0.5) * w, oy = (qy - ay) * h;
      this.p.push(x, y, z);
      this.o.push(ox * cs - oy * sn, ox * sn + oy * cs);
      this.t.push(qx ^ (flip ? 1 : 0) ? u1 : u0, qy ? v1 : v0);
      this.n.push(...nrm);
      this.c.push(...col);
    }
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** quad lying flat (lily pad), counter-clockwise seen from above */
  flat(x: number, y: number, z: number, size: number, rot: number, uv: number[], col: V3) {
    const base = this.p.length / 3, cs = Math.cos(rot), sn = Math.sin(rot);
    const [u0, v0, u1, v1] = uv;
    for (const [qx, qy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const ox = (qx - 0.5) * size, oz = (0.5 - qy) * size;
      this.p.push(x + ox * cs - oz * sn, y, z + ox * sn + oz * cs);
      this.o.push(0, 0);
      this.t.push(qx ? u1 : u0, qy ? v1 : v0);
      this.n.push(0, 1, 0);
      this.c.push(...col);
    }
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  mesh(mat: THREE.Material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("aOffset", new THREE.Float32BufferAttribute(this.o, 2));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false; // anchors only: the bounds would not include the card corners
    return m;
  }
  get empty() { return !this.i.length; }
}

/** Merged ordinary triangles (trunks, rocks) with uv + vertex shade. */
export class Solid {
  protected p: number[] = []; protected n: number[] = []; protected t: number[] = []; protected c: number[] = []; protected i: number[] = [];
  vert(pos: V3, nrm: V3, u: number, v: number, col: V3) {
    this.p.push(...pos); this.n.push(...nrm); this.t.push(u, v); this.c.push(...col);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) { this.i.push(a, b, c); }
  /** tapered tube a -> b (bark: u around, v along the grain); returns the v reached at b */
  tube(a: V3, b: V3, r0: number, r1: number, seg: number, v0: number, shade0: number, shade1: number) {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d), ax = norm(d);
    const p = norm(cross(ax, Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), q = cross(ax, p);
    const base = this.p.length / 3, v1 = v0 + len / 1.6, uRep = Math.max(1, Math.round((r0 + r1) * Math.PI / 0.7));
    for (const [c, r, v, s] of [[a, r0, v0, shade0], [b, r1, v1, shade1]] as [V3, number, number, number][]) {
      for (let j = 0; j <= seg; j++) {
        const ang = (j / seg) * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
        const dir: V3 = [p[0] * cs + q[0] * sn, p[1] * cs + q[1] * sn, p[2] * cs + q[2] * sn];
        this.vert([c[0] + dir[0] * r, c[1] + dir[1] * r, c[2] + dir[2] * r], dir, (j / seg) * uRep, v, [s, s, s]);
      }
    }
    for (let j = 0; j < seg; j++) {
      const a0 = base + j, a1 = a0 + 1, b0 = base + seg + 1 + j, b1 = b0 + 1;
      this.tri(a0, a1, b1); this.tri(a0, b1, b0);
    }
    return v1;
  }
  /** a flat polygon closing a tube's end (the top of a pillar or a stump): centre `c`, facing `up` */
  cap(c: V3, r: number, seg: number, shade: number, spin = 0) {
    const centre = this.vert(c, [0, 1, 0], 0.5, 0.5, [shade, shade, shade]);
    const ring: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const ang = spin + (j / seg) * Math.PI * 2;
      ring.push(this.vert([c[0] + Math.cos(ang) * r, c[1], c[2] + Math.sin(ang) * r], [0, 1, 0], 0.5 + Math.cos(ang) * 0.5, 0.5 + Math.sin(ang) * 0.5, [shade, shade, shade]));
    }
    for (let j = 0; j < seg; j++) this.tri(centre, ring[j + 1], ring[j]);
  }
  mesh(mat: THREE.Material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return new THREE.Mesh(g, mat);
  }
  get empty() { return !this.i.length; }
}

/** decor atlas cells (tools/art/build_ro.py PROP_ATLASES prop_decor) */
export const DECOR = { grass: [0, 1, 2, 3], flower: [4, 5, 6, 7], fern: [8, 9], shrub: [10, 11], mushroom: [12, 13], lily: [14, 15] } as const;
export type DecorKind = Exclude<keyof typeof DECOR, "lily">;
/** shore atlas cells (PROP_ATLASES prop_shore) */
export const SHORE = { reed: [0, 1, 2, 3], rush: [4, 5, 6, 7], pebbles: [8, 9, 10, 11], stone: [12, 13], lotus: [14, 15] } as const;
export type ShoreKind = keyof typeof SHORE;

/** Collects props (map coordinates: tile x, ground height z, tile y) and builds the meshes. */
export class Props {
  private leaves = new Cards();
  private decor = new Cards();
  private shoreCards = new Cards();
  private boulders = new Cards();
  private trunks = new Solid();
  private stones = new Solid(); // ruins and the sealed stair (prop_rock.jpg)
  /** multiplies every canopy's colour (field themes: darker woods, olive swamp; world.ts sets it from the theme) */
  leafTint: V3 = [1, 1, 1];

  /**
   * Broadleaf tree with canopy radius `R` (world units, ~1-2.5) standing at (x, y) on ground height z.
   * Shape, lean, clump layout and tint all come from `seed`, so every tree is different but stable.
   */
  tree(x: number, y: number, z: number, R: number, seed: number) {
    const r = rng(Math.imul(seed, 2654435761) + 1);
    const Ry = R * (0.64 + r() * 0.16);
    // canopy centre: the crown's underside sits about two character heights up, so from the field camera the trunk
    // shows below the crown down to its roots (classic field trees stand ~5 characters tall)
    const cy = z + 2.0 + R * 1.0;
    const cx = x + (r() - 0.5) * 0.3 * R, cz = y + (r() - 0.5) * 0.3 * R;
    const lt = this.leafTint, tint: V3 = [(0.94 + r() * 0.1) * lt[0], (0.96 + r() * 0.06) * lt[1], (0.82 + r() * 0.16) * lt[2]];

    // trunk: flared foot with roots, two bent segments rising into the canopy, a few branches
    const tr = 0.085 + R * 0.06;
    const foot: V3 = [x, z - 0.12, y], knee: V3 = [x, z + 0.45, y];
    const mid: V3 = [x + (cx - x) * 0.45 + (r() - 0.5) * 0.15, z + (cy - z) * 0.55, y + (cz - y) * 0.45 + (r() - 0.5) * 0.15];
    const crown: V3 = [cx, cy - Ry * 0.1, cz];
    let v = this.trunks.tube(foot, knee, tr * 1.75, tr * 1.05, 8, 0, 0.42, 0.78);
    v = this.trunks.tube(knee, mid, tr * 1.05, tr * 0.82, 7, v, 0.78, 0.9);
    this.trunks.tube(mid, crown, tr * 0.82, tr * 0.42, 6, v, 0.9, 0.45);
    // root buttresses: short and thick, diving into the ground right next to the foot
    const nRoots = 3 + Math.floor(r() * 2), a0 = r() * Math.PI * 2;
    for (let k = 0; k < nRoots; k++) {
      const a = a0 + (k / nRoots) * Math.PI * 2 + (r() - 0.5) * 0.7, len = tr * (1.9 + r() * 0.9);
      const from: V3 = [x + Math.cos(a) * tr * 0.4, z + 0.3 + r() * 0.12, y + Math.sin(a) * tr * 0.4];
      const to: V3 = [x + Math.cos(a) * len, z - 0.1, y + Math.sin(a) * len];
      this.trunks.tube(from, to, tr * 0.85, tr * 0.42, 6, 0, 0.62, 0.42);
    }
    const nb = 2 + Math.floor(r() * 2);
    for (let b = 0; b < nb; b++) {
      const ang = (b / nb) * Math.PI * 2 + r() * 1.2, h = 0.35 + r() * 0.3;
      const from: V3 = [mid[0] + (crown[0] - mid[0]) * h, mid[1] + (crown[1] - mid[1]) * h, mid[2] + (crown[2] - mid[2]) * h];
      const to: V3 = [cx + Math.cos(ang) * R * 0.55, cy + (r() - 0.45) * Ry * 0.5, cz + Math.sin(ang) * R * 0.55];
      this.trunks.tube(from, to, tr * 0.42, tr * 0.18, 5, 0, 0.75, 0.4);
    }

    // canopy: clumps on a Fibonacci spiral over the upper part of the ellipsoid (smaller towards the underside, so the
    // crown is a dome with a shaded underside rather than a ball hanging to the ground), a few dark ones inside
    const n = Math.round(6 + R * 4.5), spin0 = r() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const dy = Math.max(-0.38, Math.min(1, 1 - ((i + 0.5) / n) * 1.4 + (r() - 0.5) * 0.12));
      const rad = Math.sqrt(1 - dy * dy), ang = spin0 + i * 2.39996 + (r() - 0.5) * 0.5;
      const dir: V3 = [Math.cos(ang) * rad, dy, Math.sin(ang) * rad];
      const depth = 0.74 + r() * 0.26, size = (R * (0.8 + r() * 0.26) + 0.35) * (0.8 + 0.2 * (dy * 0.5 + 0.5));
      this.clump(cx + dir[0] * R * depth, cy + dir[1] * Ry * depth, cz + dir[2] * R * depth, dir, R, Ry, depth, size, tint, r);
      if (r() < 0.3) { // a smaller clump poking out next to it breaks up the outline
        const d2 = depth + 0.12;
        this.clump(cx + dir[0] * R * d2 + (r() - 0.5) * 0.4, cy + dir[1] * Ry * d2 + (r() - 0.5) * 0.3, cz + dir[2] * R * d2 + (r() - 0.5) * 0.4,
          dir, R, Ry, 1, R * 0.4 + 0.25, tint, r);
      }
    }
    const inner = Math.round(2 + R * 1.5);
    for (let i = 0; i < inner; i++) {
      const dir = norm([r() - 0.5, (r() - 0.5) * 0.6, r() - 0.5]), depth = 0.2 + r() * 0.35;
      this.clump(cx + dir[0] * R * depth, cy + dir[1] * Ry * depth, cz + dir[2] * R * depth, dir, R, Ry, depth, R * 0.8 + 0.2, tint, r);
    }
  }

  /** one leaf card of a canopy; `depth` 0 = canopy centre .. 1 = surface drives the baked occlusion */
  private clump(x: number, y: number, z: number, dir: V3, R: number, Ry: number, depth: number, size: number, tint: V3, r: () => number) {
    const up = dir[1] * 0.5 + 0.5; // 0 underside .. 1 top
    const nrm = norm([dir[0] / R, dir[1] / Ry + 0.3, dir[2] / R]);
    // occlusion: dark towards the centre and the underside; each lobe a little lighter or darker than its neighbours
    const ao = (0.36 + 0.64 * Math.min(1, depth) ** 1.5) * (0.56 + 0.44 * up) * (0.88 + r() * 0.24);
    const warm = Math.max(0, dir[1]) * Math.min(1, depth);
    const col: V3 = [ao * tint[0] * (1 + 0.08 * warm), ao * tint[1] * (1 + 0.04 * warm), ao * tint[2] * (1 - 0.1 * warm)];
    this.leaves.card(x, y, z, size, size, (r() - 0.5) * 1.1, cell(Math.floor(r() * 4), 2), nrm, col, 0.5, r() < 0.5);
  }

  /** Conifer (highland / woods): a straight trunk under tiers of dark leaf clumps narrowing to a point. */
  pine(x: number, y: number, z: number, R: number, seed: number) {
    const r = rng(Math.imul(seed, 2654435761) + 5);
    const H = 3.6 + R * 1.3 + r() * 0.7, tr = 0.07 + R * 0.035, lt = this.leafTint;
    this.trunks.tube([x, z - 0.1, y], [x, z + H * 0.95, y], tr * 1.6, tr * 0.35, 7, 0, 0.45, 0.7);
    // a slim cone: narrow tiers of small clumps, the lowest about a character's height up so the trunk shows under it
    const tiers = 6, tint: V3 = [0.7 * lt[0], 0.88 * lt[1], 0.72 * lt[2]];
    for (let k = 0; k < tiers; k++) {
      const f = k / tiers, h = z + 1.3 + f * (H - 1.5), rad = R * 0.62 * (1 - f) + 0.16, n = 3 + Math.round(rad * 3.2);
      const shade = 0.82 + 0.18 * f; // the lower tiers sit in the upper ones' shade
      const tt: V3 = [tint[0] * shade, tint[1] * shade, tint[2] * shade];
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + k * 0.7 + r() * 0.4, dir: V3 = [Math.cos(ang), -0.2, Math.sin(ang)];
        this.clump(x + dir[0] * rad * 0.75, h + (r() - 0.5) * 0.12, y + dir[2] * rad * 0.75, dir, rad + 0.15, 0.5, 0.9, rad * 0.75 + 0.32, tt, r);
      }
    }
    this.clump(x, z + H, y, [0, 1, 0], 0.3, 0.3, 1, 0.45, tint, r);
  }

  /** Bare dead tree (swamp): a grey trunk with crooked branches, now and then a last tuft of brown leaves. */
  deadTree(x: number, y: number, z: number, R: number, seed: number) {
    const r = rng(Math.imul(seed, 2246822519) + 3);
    const H = 2.2 + R * 1.1 + r() * 0.8, tr = 0.1 + R * 0.05;
    const lean: V3 = [(r() - 0.5) * 0.6, 0, (r() - 0.5) * 0.6];
    const top: V3 = [x + lean[0], z + H, y + lean[2]], mid: V3 = [x + lean[0] * 0.4, z + H * 0.5, y + lean[2] * 0.4];
    let v = this.trunks.tube([x, z - 0.1, y], mid, tr * 1.6, tr, 7, 0, 0.32, 0.5);
    this.trunks.tube(mid, top, tr, tr * 0.25, 6, v, 0.5, 0.42);
    const nb = 3 + Math.floor(r() * 3);
    for (let b = 0; b < nb; b++) {
      const ang = r() * Math.PI * 2, h = 0.45 + r() * 0.45, len = 0.6 + R * 0.5 + r() * 0.5;
      const from: V3 = [x + lean[0] * h, z + H * h, y + lean[2] * h];
      const knee: V3 = [from[0] + Math.cos(ang) * len * 0.55, from[1] + len * 0.25, from[2] + Math.sin(ang) * len * 0.55];
      const tip: V3 = [knee[0] + Math.cos(ang + (r() - 0.5)) * len * 0.5, knee[1] + len * (0.2 + r() * 0.4), knee[2] + Math.sin(ang + (r() - 0.5)) * len * 0.5];
      v = this.trunks.tube(from, knee, tr * 0.5, tr * 0.3, 5, 0, 0.45, 0.45);
      this.trunks.tube(knee, tip, tr * 0.3, tr * 0.08, 4, v, 0.45, 0.4);
      if (r() < 0.12) this.clump(tip[0], tip[1], tip[2], [0, 1, 0], 0.5, 0.4, 0.9, 0.4 + r() * 0.2, [0.85, 0.62, 0.32], r);
    }
  }

  /** an old tree stump with roots */
  stump(x: number, y: number, z: number, seed: number) {
    const r = rng(Math.imul(seed, 3266489917) + 9);
    const rad = 0.22 + r() * 0.12, h = 0.25 + r() * 0.25;
    this.trunks.tube([x, z - 0.1, y], [x, z + h, y], rad * 1.25, rad, 8, 0, 0.42, 0.62);
    this.trunks.cap([x, z + h, y], rad, 8, 0.7);
    for (let k = 0; k < 3; k++) {
      const a = r() * Math.PI * 2;
      this.trunks.tube([x, z + h * 0.5, y], [x + Math.cos(a) * rad * 2.4, z - 0.08, y + Math.sin(a) * rad * 2.4], rad * 0.45, rad * 0.2, 5, 0, 0.5, 0.4);
    }
    if (r() < 0.6) this.plant(x + rad * 1.4, y + rad * 0.6, z, "mushroom", 0.32 + r() * 0.1, seed + 1);
  }

  /** a piece of ruined wall (a broken square block) or a broken pillar, with rubble at its foot */
  /** W03 caves: a stalagmite cluster: one tall tapering spire and a couple of short ones at its foot, pebbles around */
  stalagmite(x: number, y: number, z: number, seed: number) {
    const r = rng(Math.imul(seed, 2246822519) + 29), shade = 0.5 + r() * 0.15;
    const spire = (cx: number, cy: number, h: number, rad: number) => {
      const lean: V3 = [cx + (r() - 0.5) * 0.12, z + h, cy + (r() - 0.5) * 0.12];
      const mid: V3 = [cx + (lean[0] - cx) * 0.45, z + h * 0.45, cy + (lean[2] - cy) * 0.45];
      this.stones.tube([cx, z - 0.15, cy], mid, rad, rad * 0.55, 7, 0, shade * 0.7, shade * 0.95);
      this.stones.tube(mid, lean, rad * 0.55, 0.015, 7, 0, shade * 0.95, shade * 1.25);
    };
    spire(x, y, 1.1 + r() * 0.9, 0.3 + r() * 0.1);
    const more = 1 + Math.floor(r() * 2);
    for (let k = 0; k < more; k++) {
      const a = r() * Math.PI * 2, d = 0.3 + r() * 0.15;
      spire(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.35 + r() * 0.45, 0.12 + r() * 0.08);
    }
    for (let k = 0; k < 2; k++) {
      const a = r() * Math.PI * 2, d = 0.45 + r() * 0.25;
      this.shore(x + Math.cos(a) * d, y + Math.sin(a) * d, z, r() < 0.5 ? "stone" : "pebbles", 0.34 + r() * 0.16, seed + 11 * k);
    }
  }
  /** W03 caves: old bones on the floor (walk-through decor): a few long bones crossed, sometimes a skull */
  bones(x: number, y: number, z: number, seed: number) {
    const r = rng(Math.imul(seed, 3266489917) + 41), pale = 1.35 + r() * 0.2;
    const n = 2 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI, len = 0.22 + r() * 0.22, cx = x + (r() - 0.5) * 0.4, cy = y + (r() - 0.5) * 0.4, h = z + 0.03 + k * 0.012;
      const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
      this.stones.tube([cx - dx, h, cy - dy], [cx + dx, h, cy + dy], 0.03, 0.03, 5, 0, pale, pale);
      for (const e of [-1, 1]) this.stones.cap([cx + dx * e, h + 0.02, cy + dy * e], 0.05, 5, pale); // the knobbly ends
    }
    if (r() < 0.45) { // a skull: a squat dome with dark sockets facing the room
      const sx = x + (r() - 0.5) * 0.3, sy = y + (r() - 0.5) * 0.3;
      this.stones.tube([sx, z, sy], [sx, z + 0.16, sy], 0.12, 0.1, 7, 0, pale * 0.9, pale);
      this.stones.cap([sx, z + 0.16, sy], 0.1, 7, pale * 1.05);
      for (const e of [-1, 1]) this.stones.cap([sx + e * 0.045, z + 0.09, sy + 0.115], 0.028, 5, 0.12);
    }
  }
  /** W03 caves: a torch on an iron-bound post against the rock: (x, y) = the post's foot (the flame is torch.ts) */
  torch(x: number, y: number, z: number) {
    this.trunks.tube([x, z - 0.1, y], [x, z + 1.3, y], 0.06, 0.05, 6, 0, 0.35, 0.55);
    this.stones.tube([x, z + 1.22, y], [x, z + 1.42, y], 0.09, 0.16, 7, 0, 0.3, 0.45); // the cup
    this.stones.tube([x, z + 0.5, y], [x, z + 0.58, y], 0.075, 0.075, 6, 0, 0.3, 0.3); // a band
  }
  ruin(x: number, y: number, z: number, seed: number) {
    const r = rng(Math.imul(seed, 2654435761) + 21), shade = 0.62 + r() * 0.2;
    if (r() < 0.6) {
      const h = 0.5 + r() * 1.1, rad = 0.52 + r() * 0.08, spin = Math.PI / 4 + (r() - 0.5) * 0.3;
      this.stones.tube([x, z - 0.15, y], [x + (r() - 0.5) * 0.05, z + h, y], rad, rad * 0.94, 4, 0, shade * 0.75, shade);
      this.stones.cap([x, z + h, y], rad * 0.94, 4, shade * 1.05, spin - Math.PI / 4);
    } else {
      const h = 0.9 + r() * 1.4, rad = 0.26 + r() * 0.06;
      this.stones.tube([x, z - 0.15, y], [x, z + 0.18, y], rad * 1.5, rad * 1.5, 4, 0, shade * 0.7, shade * 0.8); // plinth
      this.stones.cap([x, z + 0.18, y], rad * 1.5, 4, shade);
      this.stones.tube([x, z + 0.18, y], [x, z + h, y], rad, rad * 0.9, 8, 0, shade * 0.8, shade);
      this.stones.cap([x, z + h, y], rad * 0.9, 8, shade * 1.05);
    }
    for (let k = 0; k < 2; k++) {
      const a = r() * Math.PI * 2, d = 0.55 + r() * 0.3;
      this.shore(x + Math.cos(a) * d, y + Math.sin(a) * d, z, r() < 0.6 ? "stone" : "pebbles", 0.4 + r() * 0.2, seed + 7 * k);
    }
  }

  /** the sealed stair down: a dark opening under a stone arch, a rune-cut slab across it */
  stair(x: number, y: number, z: number) {
    const s = this.stones, w = 1.1, H = 2.3;
    for (const side of [-1, 1]) {
      s.tube([x + side * w, z - 0.1, y - 0.2], [x + side * w, z + H, y - 0.2], 0.3, 0.27, 6, 0, 0.55, 0.8);
      s.cap([x + side * w, z + H, y - 0.2], 0.27, 6, 0.85);
    }
    s.tube([x - w - 0.35, z + H + 0.12, y - 0.2], [x + w + 0.35, z + H + 0.12, y - 0.2], 0.24, 0.24, 4, 0, 0.75, 0.75); // lintel
    // the opening: a dark pit on the ground, and the slab lying across it
    const d = 0.04, quad = (x0: number, z0: number, x1: number, z1: number, h: number, shade: number) => {
      const c: V3 = [shade, shade, shade];
      const a = s.vert([x0, h, z0], [0, 1, 0], 0, 0, c), b = s.vert([x1, h, z0], [0, 1, 0], 1, 0, c);
      const e = s.vert([x1, h, z1], [0, 1, 0], 1, 1, c), f = s.vert([x0, h, z1], [0, 1, 0], 0, 1, c);
      s.tri(a, f, e); s.tri(a, e, b);
    };
    quad(x - w + 0.2, y - 0.6, x + w - 0.2, y + 0.9, z + d, 0.08);
    s.tube([x - 0.85, z + 0.12, y + 0.15], [x + 0.85, z + 0.12, y + 0.15], 0.42, 0.42, 4, 0, 0.6, 0.6);
  }

  /** low leafy dome, radius R (~0.4-1) */
  bush(x: number, y: number, z: number, R: number, seed: number) {
    const r = rng(Math.imul(seed, 2246822519) + 7);
    const Ry = R * 0.62, cy = z + Ry * 0.62;
    const lt = this.leafTint, tint: V3 = [(0.84 + r() * 0.08) * lt[0], (0.92 + r() * 0.06) * lt[1], (0.8 + r() * 0.1) * lt[2]];
    const n = Math.round(5 + R * 5), spin0 = r() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const dy = 1 - ((i + 0.5) / n) * 1.2, rad = Math.sqrt(Math.max(0, 1 - dy * dy)), ang = spin0 + i * 2.39996;
      const dir: V3 = [Math.cos(ang) * rad, dy, Math.sin(ang) * rad], depth = 0.75 + r() * 0.25;
      this.clump(x + dir[0] * R * depth, cy + dir[1] * Ry * depth, y + dir[2] * R * depth, dir, R, Ry, depth, R * 0.85 + 0.2, tint, r);
    }
    this.clump(x, cy, y, [0, 0.2, 0], R, Ry, 0.3, R * 1.1, tint, r);
  }

  /**
   * Rock outcrop about `size` wide: a painted boulder (prop_boulders: tall crag, wide slab, round boulder, stacked
   * cluster) standing on the ground like the foliage cards, with a mossy stone or pebbles and grass tufts at its feet.
   */
  rock(x: number, y: number, z: number, size: number, seed: number) {
    const r = rng(Math.imul(seed, 3266489917) + 3);
    const t = 0.92 + r() * 0.12, tint: V3 = [t, t, t * (1 + r() * 0.05)];
    const w = size * (1.05 + r() * 0.2);
    this.boulders.card(x, z - 0.05, y, w, w, 0, cell(Math.floor(r() * 4), 2), [0, 1, 0], tint, 0, r() < 0.5);
    const feet = 1 + Math.floor(r() * 2);
    for (let k = 0; k < feet; k++) {
      const a = r() * Math.PI * 2, d = w * (0.38 + r() * 0.14);
      this.shore(x + Math.cos(a) * d, y + Math.sin(a) * d, z, r() < 0.55 ? "stone" : "pebbles", w * (0.24 + r() * 0.1), seed + 31 * k);
    }
    const tufts = 3 + Math.floor(r() * 3);
    for (let k = 0; k < tufts; k++) {
      const a = r() * Math.PI * 2, d = w * (0.3 + r() * 0.22);
      this.plant(x + Math.cos(a) * d, y + Math.sin(a) * d, z, r() < 0.3 ? "fern" : "grass", 0.42 + r() * 0.22, seed + 17 * k);
    }
    if (r() < 0.4) { // a shrub grown up against the rock
      const a = r() * Math.PI * 2, d = w * (0.45 + r() * 0.15);
      this.bush(x + Math.cos(a) * d, y + Math.sin(a) * d, z, 0.38 + r() * 0.2, seed + 5);
    }
  }

  /** painted ground decor standing at (x, y): grass tuft, flower clump, fern, shrub or mushrooms */
  plant(x: number, y: number, z: number, kind: DecorKind, size: number, seed: number) {
    const r = rng(Math.imul(seed, 2654435761) + 11), cells = DECOR[kind], s = 0.88 + r() * 0.14;
    // the painted grass/fern greens are cooler than the field's yellow-green ground: warm them up
    const col: V3 = kind === "grass" || kind === "fern" || kind === "shrub" ? [s, s * 0.98, s * 0.62] : [s, s, s];
    this.decor.card(x, z - 0.03, y, size, size, 0, cell(cells[Math.floor(r() * cells.length)], 4), [0, 1, 0], col, 0, r() < 0.5);
  }

  /** shore decor standing at (x, y): reeds, rushes, pebbles, a low mossy stone or a water-lily flower */
  shore(x: number, y: number, z: number, kind: ShoreKind, size: number, seed: number) {
    const r = rng(Math.imul(seed, 2654435761) + 17), cells = SHORE[kind], s = 0.86 + r() * 0.14;
    const col: V3 = kind === "reed" || kind === "rush" ? [s, s * 0.97, s * 0.66] : [s, s, s];
    this.shoreCards.card(x, z - 0.03, y, size, size, 0, cell(cells[Math.floor(r() * cells.length)], 4), [0, 1, 0], col, 0, r() < 0.5);
  }

  /** lily pad lying on the water surface, sometimes with a flower on it */
  lily(x: number, y: number, z: number, size: number, seed: number, flower = false) {
    const r = rng(Math.imul(seed, 2654435761) + 13);
    this.decor.flat(x, z, y, size, r() * Math.PI * 2, cell(DECOR.lily[Math.floor(r() * 2)], 4), [0.95, 0.95, 0.95]);
    if (flower) this.shore(x, y, z + 0.04, "lotus", size * 0.6, seed);
  }

  build() {
    const g = new THREE.Group();
    g.name = "props";
    addCards(g, this.leaves, "prop_leaves.png", "prop-leaves", [foliageGrade], "sun");
    addCards(g, this.boulders, "prop_boulders.png", "prop-boulders", [rockGrade, deepShadow], "shown");
    addCards(g, this.decor, "prop_decor.png", "prop-decor", [deepShadow], null);
    addCards(g, this.shoreCards, "prop_shore.png", "prop-shore", [deepShadow], null);
    if (!this.stones.empty) {
      const m = this.stones.mesh(patched(new THREE.MeshLambertMaterial({ map: tex("prop_rock.jpg", true), vertexColors: true }), "prop-stone", seeThrough, deepShadow));
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    if (!this.trunks.empty) {
      const m = this.trunks.mesh(patched(new THREE.MeshLambertMaterial({ map: tex("prop_bark.jpg", true), vertexColors: true }), "prop-solid", seeThrough, deepShadow));
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    return g;
  }
}

/** One merged card set as two meshes over the same geometry: the opaque core and its soft fringe (softEdge). */
// Shadow pass of cards standing on the ground (rocks): cast the card exactly as the player's camera shows it, so the
// shadow starts at the painted base and falls away from the sun. (A sun-facing card would swing its base line round to
// face the sun and push a straight-edged strip of shadow out in front of the rock.) The basis is the main camera's,
// copied when it last drew the mesh (the shadow pass runs first in a frame, so it is one frame old).
const shownBasis = { right: { value: new THREE.Vector3(1, 0, 0) }, up: { value: new THREE.Vector3(0, 1, 0) } };
const shownCard: Patch = (sh) => {
  Object.assign(sh.uniforms, { uShownRight: shownBasis.right, uShownUp: shownBasis.up });
  sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute vec2 aOffset;\nuniform vec3 uShownRight, uShownUp;")
    .replace("#include <project_vertex>", `
      vec3 shownPos = (modelMatrix * vec4(transformed, 1.0)).xyz + uShownRight * aOffset.x + uShownUp * aOffset.y;
      vec4 mvPosition = viewMatrix * vec4(shownPos, 1.0);
      gl_Position = projectionMatrix * mvPosition;`);
};

/** One merged card set as two meshes over the same geometry: the opaque core and its soft fringe (softEdge).
 *  shadow: "sun" = cards turn to the sun in the shadow pass (canopies: lobed shadows), "shown" = cast as seen (cards
 *  standing on the ground), null = no shadow. */
function addCards(g: THREE.Group, cards: Cards, file: string, key: string, patches: Patch[], shadow: "sun" | "shown" | null) {
  if (cards.empty) return;
  const map = tex(file);
  const core = cards.mesh(patched(new THREE.MeshLambertMaterial({
    map, vertexColors: true, alphaTest: CORE, alphaToCoverage: true, side: THREE.DoubleSide,
  }), key, seeThrough, billboard, ...patches));
  core.receiveShadow = true;
  if (shadow) {
    // One depth material per mesh: three copies this mesh's map and alphaTest into it before drawing, but only
    // re-uploads uniforms when the material changes between draws.
    core.castShadow = true;
    core.customDepthMaterial = patched(new THREE.MeshDepthMaterial(), `${key}-depth`, shadow === "sun" ? billboard : shownCard);
    if (shadow === "shown") {
      core.onBeforeRender = (_r, _s, camera) => {
        shownBasis.right.value.setFromMatrixColumn(camera.matrixWorld, 0);
        shownBasis.up.value.setFromMatrixColumn(camera.matrixWorld, 1);
      };
    }
  }
  const fringe = new THREE.Mesh(core.geometry, patched(new THREE.MeshLambertMaterial({
    map, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }), `${key}-fringe`, seeThrough, billboard, ...patches, softEdge));
  fringe.frustumCulled = false;
  fringe.receiveShadow = true;
  g.add(core, fringe);
}
