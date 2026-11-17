// Per-theme weather as cheap GPU layers that wrap around the camera target (no per-frame JS per particle: the vertex shader folds
// every particle's position into a box centred on the player). 2.7.0 "blight" = ash + rain; 2.9.0 adds "desert" (sandstorm) and
// "meadow" (pollen + drifting leaves). A layer is Points (soft discs) or LineSegments (streaks along the velocity).
import * as THREE from "three";

export type WeatherKind = "blight" | "desert" | "meadow";

const BOX = new THREE.Vector3(44, 18, 44);
const common = `
uniform vec3 uCenter; uniform float uTime; uniform vec3 uBox;
attribute vec4 aSeed;
vec3 wrapped(vec3 vel, float drift) {
  vec3 base = aSeed.xyz * uBox;
  vec3 p = base + vel * uTime + vec3(sin(uTime * 0.6 + aSeed.w * 40.0) * drift, 0.0, cos(uTime * 0.5 + aSeed.w * 33.0) * drift);
  return mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5 + uCenter;
}`;

type Spec = {
  count: number;
  streak?: number; // > 0: a line segment of this length along the velocity; otherwise a point
  vel: string; // GLSL vec3 (may use aSeed.w)
  drift: number;
  size?: string; // GLSL float point size in px at distance 18 (may use aSeed.w)
  alpha: string; // GLSL float (may use aSeed.w, aEnd for streaks)
  color: [number, number, number];
  tint?: string; // GLSL vec3 expression overriding colour per particle (may use aSeed.w)
};

const SPECS: Record<string, Spec> = {
  ash: { count: 900, vel: "vec3(0.25, -0.55 - aSeed.w * 0.5, 0.15)", drift: 0.6, size: "2.2 + aSeed.w * 3.2", alpha: "0.28 + aSeed.w * 0.4", color: [0.78, 0.8, 0.6] },
  rain: { count: 700, streak: 0.55, vel: "vec3(-0.6, -16.0 - aSeed.w * 4.0, 0.3)", drift: 0, alpha: "(1.0 - aEnd * 0.8) * 0.22", color: [0.62, 0.7, 0.64] },
  // sandstorm: fast, nearly horizontal ochre streaks, plus slower dust motes
  sand: { count: 2600, streak: 3.6, vel: "vec3(-30.0 - aSeed.w * 12.0, -1.2, 7.0 + aSeed.w * 3.0)", drift: 0.15, alpha: "(1.0 - aEnd * 0.9) * (0.3 + aSeed.w * 0.3)", color: [0.96, 0.82, 0.55] },
  dust: { count: 600, vel: "vec3(-6.0 - aSeed.w * 3.0, -0.25, 1.8)", drift: 0.8, size: "5.0 + aSeed.w * 8.0", alpha: "0.12 + aSeed.w * 0.14", color: [0.8, 0.62, 0.36] },
  // meadow: floating pollen / light motes, a few drifting leaves
  pollen: { count: 450, vel: "vec3(0.35, 0.12 - aSeed.w * 0.25, 0.2)", drift: 1.6, size: "3.0 + aSeed.w * 3.5", alpha: "0.5 + aSeed.w * 0.5", color: [1.0, 0.96, 0.7] },
  leaf: { count: 45, vel: "vec3(1.1, -0.7 - aSeed.w * 0.3, 0.5)", drift: 2.4, size: "7.0 + aSeed.w * 5.0", alpha: "0.7", color: [0.5, 0.72, 0.28],
    tint: "mix(vec3(0.42, 0.68, 0.24), vec3(0.85, 0.7, 0.25), fract(aSeed.w * 7.0))" },
};

const SETS: Record<WeatherKind, string[]> = { blight: ["ash", "rain"], desert: ["sand", "dust"], meadow: ["pollen", "leaf"] };

function layer(spec: Spec) {
  const per = spec.streak ? 2 : 1, count = spec.count;
  const seeds = new Float32Array(count * 4 * per);
  for (let i = 0; i < count; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < per; k++) seeds.set(s, (i * per + k) * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * per * 3), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  if (spec.streak) g.setAttribute("aEnd", new THREE.BufferAttribute(Float32Array.from({ length: count * 2 }, (_, i) => i & 1), 1));
  const uniforms = { uCenter: { value: new THREE.Vector3() }, uTime: { value: 0 }, uBox: { value: BOX } };
  const col = `vec3(${spec.color.map((c) => c.toFixed(3)).join(",")})`;
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: spec.streak ? `${common}
      attribute float aEnd; varying float vA; varying vec3 vC;
      void main() {
        vec3 vel = ${spec.vel};
        vec3 p = wrapped(vel, ${spec.drift.toFixed(2)}) - normalize(vel) * aEnd * ${spec.streak.toFixed(2)};
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        vA = ${spec.alpha}; vC = ${spec.tint ?? col};
      }` : `${common}
      varying float vA; varying vec3 vC;
      void main() {
        vec3 p = wrapped(${spec.vel}, ${spec.drift.toFixed(2)});
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (${spec.size}) * 18.0 / max(1.0, -mv.z);
        vA = ${spec.alpha}; vC = ${spec.tint ?? col};
      }`,
    fragmentShader: spec.streak ? `varying float vA; varying vec3 vC; void main() { gl_FragColor = vec4(vC, vA); }`
      : `varying float vA; varying vec3 vC; void main() {
        float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
        gl_FragColor = vec4(vC, vA * (1.0 - d * 1.6)); }`,
  });
  const obj = spec.streak ? new THREE.LineSegments(g, mat) : new THREE.Points(g, mat);
  obj.frustumCulled = false;
  obj.renderOrder = 20;
  return { obj, uniforms };
}

const groups = new Map<WeatherKind, { group: THREE.Group; layers: ReturnType<typeof layer>[] }>();
for (const kind of Object.keys(SETS) as WeatherKind[]) {
  const layers = SETS[kind].map((k) => layer(SPECS[k]));
  const group = new THREE.Group();
  group.name = `weather_${kind}`;
  for (const l of layers) group.add(l.obj);
  group.visible = false;
  groups.set(kind, { group, layers });
}
let current: WeatherKind | null = null;

/** Show this theme's weather on the scene (null = clear sky). Safe to call on every map load. */
export function setWeather(scene: THREE.Scene, kind: string | null) {
  current = kind && groups.has(kind as WeatherKind) ? (kind as WeatherKind) : null;
  for (const [k, w] of groups) {
    if (w.group.parent !== scene) scene.add(w.group);
    w.group.visible = k === current;
  }
}
export function tickWeather(t: number, target: THREE.Vector3) {
  if (!current) return;
  for (const l of groups.get(current)!.layers) { l.uniforms.uTime.value = t; l.uniforms.uCenter.value.copy(target); }
}
