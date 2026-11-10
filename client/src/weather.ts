// 2.7.0 floor 3 ("blight" theme): ash flakes drifting down and thin rain, as two cheap GPU layers that wrap around the camera target
// (no per-frame JS per particle: the vertex shader folds every particle's position into a box centred on the player).
import * as THREE from "three";

const BOX = new THREE.Vector3(44, 18, 44);
const common = `
uniform vec3 uCenter; uniform float uTime; uniform vec3 uBox;
attribute vec4 aSeed;
vec3 wrapped(vec3 vel, float drift) {
  vec3 base = aSeed.xyz * uBox;
  vec3 p = base + vel * uTime + vec3(sin(uTime * 0.6 + aSeed.w * 40.0) * drift, 0.0, cos(uTime * 0.5 + aSeed.w * 33.0) * drift);
  return mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5 + uCenter;
}`;

function layer(count: number, kind: "ash" | "rain") {
  const seeds = new Float32Array(count * 4 * (kind === "rain" ? 2 : 1));
  const per = kind === "rain" ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < per; k++) seeds.set(s, (i * per + k) * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * per * 3), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  if (kind === "rain") g.setAttribute("aEnd", new THREE.BufferAttribute(Float32Array.from({ length: count * 2 }, (_, i) => i & 1), 1));
  const uniforms = { uCenter: { value: new THREE.Vector3() }, uTime: { value: 0 }, uBox: { value: BOX } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: kind === "ash" ? `${common}
      varying float vA;
      void main() {
        vec3 p = wrapped(vec3(0.25, -0.55 - aSeed.w * 0.5, 0.15), 0.6);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (2.2 + aSeed.w * 3.2) * 18.0 / max(1.0, -mv.z);
        vA = 0.28 + aSeed.w * 0.4;
      }` : `${common}
      attribute float aEnd; varying float vA;
      void main() {
        vec3 vel = vec3(-0.6, -16.0 - aSeed.w * 4.0, 0.3);
        vec3 p = wrapped(vel, 0.0) - normalize(vel) * aEnd * 0.55;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        vA = (1.0 - aEnd * 0.8) * 0.22;
      }`,
    fragmentShader: kind === "ash" ? `varying float vA; void main() {
        float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
        gl_FragColor = vec4(0.78, 0.8, 0.6, vA * (1.0 - d * 1.6)); }` : `varying float vA; void main() { gl_FragColor = vec4(0.62, 0.7, 0.64, vA); }`,
  });
  const obj = kind === "ash" ? new THREE.Points(g, mat) : new THREE.LineSegments(g, mat);
  obj.frustumCulled = false;
  obj.renderOrder = 20;
  return { obj, uniforms };
}

const layers = [layer(900, "ash"), layer(700, "rain")];
const group = new THREE.Group();
group.name = "weather";
for (const l of layers) group.add(l.obj);
group.visible = false;

/** Show the weather on this scene (only on the blight theme). Safe to call on every map load. */
export function setWeather(scene: THREE.Scene, on: boolean) {
  if (group.parent !== scene) scene.add(group);
  group.visible = on;
}
export function tickWeather(t: number, target: THREE.Vector3) {
  if (!group.visible) return;
  for (const l of layers) { l.uniforms.uTime.value = t; l.uniforms.uCenter.value.copy(target); }
}
