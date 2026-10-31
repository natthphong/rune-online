// Torch flames (W03 caves): our own procedural effect, two point clouds per map (one draw call each): a flickering teardrop flame
// over every torch cup and a soft warm halo around it, both additive. The light the torches throw on the ground is baked into
// the terrain's shade field (world.ts -> TerrainFields.light); no real lights (one per torch would recompile every lit material).
import * as THREE from "three";

const time = { value: 0 };
/** pixels per world unit at distance 1 (set from the camera's vertical fov and the canvas height) */
const scale = { value: 600 };

const vertexShader = /* glsl */ `
  attribute float aSeed;
  uniform float uTime, uScale, uSize;
  varying float vSeed, vFlick;
  void main() {
    vSeed = aSeed;
    vFlick = 0.82 + 0.18 * sin(uTime * 13.0 + aSeed * 7.1) * sin(uTime * 7.3 + aSeed * 3.3);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * vFlick * uScale / -mv.z;
  }`;

const flameMat = new THREE.ShaderMaterial({
  uniforms: { uTime: time, uScale: scale, uSize: { value: 0.75 } },
  vertexShader,
  fragmentShader: /* glsl */ `
    uniform float uTime; varying float vSeed, vFlick;
    void main() {
      vec2 p = gl_PointCoord - vec2(0.5, 0.62);            // y grows downward: the flame's base sits low in the sprite
      p.x += sin(uTime * 9.0 + vSeed * 5.0 + p.y * 6.0) * 0.04 * (0.62 - gl_PointCoord.y);
      float w = 0.16 + 0.22 * clamp(gl_PointCoord.y, 0.0, 1.0); // narrow tip, round belly
      float d = length(vec2(p.x / w, p.y / (p.y < 0.0 ? 0.52 : 0.26)));
      float a = smoothstep(1.0, 0.35, d);
      if (a <= 0.01) discard;
      vec3 c = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.78, 0.32), smoothstep(0.95, 0.3, d));
      c = mix(c, vec3(1.0, 0.97, 0.85), smoothstep(0.45, 0.0, d));
      gl_FragColor = vec4(c * vFlick, a);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const haloMat = new THREE.ShaderMaterial({
  uniforms: { uTime: time, uScale: scale, uSize: { value: 4.2 } },
  vertexShader,
  fragmentShader: /* glsl */ `
    varying float vSeed, vFlick;
    void main() {
      float d = length(gl_PointCoord - 0.5) * 2.0;
      float a = (1.0 - smoothstep(0.0, 1.0, d)) * 0.3 * vFlick;
      gl_FragColor = vec4(vec3(1.0, 0.55, 0.2) * a, a);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

/** Flames + halos for the torch cups at these world points (x, height, y). */
export function makeFlames(cups: { x: number; y: number; z: number }[]) {
  const g = new THREE.Group();
  g.name = "torches";
  if (!cups.length) return g;
  const pos = new Float32Array(cups.length * 3), seed = new Float32Array(cups.length);
  cups.forEach((c, i) => { pos.set([c.x, c.z, c.y], i * 3); seed[i] = (i * 0.618) % 1 * 10; });
  const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)).setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const flames = new THREE.Points(geo, flameMat), halos = new THREE.Points(geo, haloMat);
  flames.frustumCulled = halos.frustumCulled = false;
  flames.renderOrder = 6; halos.renderOrder = 5;
  g.add(halos, flames);
  return g;
}

/** Every frame: time (seconds) and the camera's projection scale, so a flame keeps its world size. */
export function tickTorches(t: number, camera?: THREE.PerspectiveCamera, height = innerHeight) {
  time.value = t;
  if (camera) scale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
