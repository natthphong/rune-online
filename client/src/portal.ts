// Warp portals (W01): every warp cell of the map (shared/maps.ts WARPS, rAthena npc/re/warps) gets a glowing portal, our own
// procedural effect: a bright ring on the ground with a soft inner disc, a column of light rising from it (additive, open-ended
// cylinder whose alpha fades upward) and motes drifting up inside the column. tickPortals animates them.
import * as THREE from "three";

const time = { value: 0 };
const COLOR = new THREE.Color("#3f9bff"), CORE = new THREE.Color("#bfe6ff");

const columnMat = new THREE.ShaderMaterial({
  uniforms: { uTime: time, uColor: { value: COLOR }, uCore: { value: CORE } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime; uniform vec3 uColor, uCore; varying vec2 vUv;
    void main() {
      float up = vUv.y;                                     // 0 at the ground .. 1 at the top
      float fade = pow(1.0 - up, 1.6);
      float bands = 0.65 + 0.35 * sin(up * 18.0 - uTime * 3.0 + vUv.x * 6.2832 * 2.0);
      float a = fade * bands * 0.55;
      gl_FragColor = vec4(mix(uColor, uCore, fade * 0.35) * 0.85, a);
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
});
const ringMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
const discMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
const moteMat = new THREE.PointsMaterial({ color: CORE, size: 0.12, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
const ringGeo = new THREE.RingGeometry(0.5, 0.72, 40).rotateX(-Math.PI / 2);
const discGeo = new THREE.CircleGeometry(0.5, 40).rotateX(-Math.PI / 2);
const columnGeo = new THREE.CylinderGeometry(0.55, 0.62, 2.6, 32, 1, true).translate(0, 1.3, 0);

const motes: { pts: THREE.Points; base: Float32Array }[] = [];

/** A portal standing on ground height `z` at cell (x, y). */
export function makePortal(x: number, y: number, z: number) {
  const g = new THREE.Group();
  g.name = "warp";
  g.position.set(x, z + 0.04, y);
  const ring = new THREE.Mesh(ringGeo, ringMat), disc = new THREE.Mesh(discGeo, discMat), column = new THREE.Mesh(columnGeo, columnMat);
  ring.renderOrder = disc.renderOrder = column.renderOrder = 5;
  const n = 18, base = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + i * 1.7, r = 0.15 + ((i * 37) % 10) / 10 * 0.4;
    base.set([Math.cos(a) * r, (i / n) * 2.4, Math.sin(a) * r], i * 3);
  }
  const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(base.slice(), 3)), moteMat);
  pts.frustumCulled = false;
  motes.push({ pts, base });
  g.add(ring, disc, column, pts); // no point light: a light per portal would recompile every lit material on each map change
  return g;
}

/** Every frame (seconds): bands climb the column, motes rise and wrap, the ring breathes. */
export function tickPortals(t: number) {
  time.value = t;
  ringMat.opacity = 0.7 + 0.2 * Math.sin(t * 2.4);
  for (let k = motes.length - 1; k >= 0; k--) {
    const { pts, base } = motes[k];
    let root: THREE.Object3D = pts;
    while (root.parent) root = root.parent;
    if (!(root instanceof THREE.Scene)) { motes.splice(k, 1); continue; } // its map was unloaded
    const pos = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, (base[i * 3 + 1] + t * 0.6) % 2.4);
    pos.needsUpdate = true;
  }
}

// W01 r2: the sealed stair, once the wardens have opened it for this character (quest 1018 done, f1_seal): a faint warm glow
// rising out of the stairwell instead of a full portal (the scripted door still decides; this only shows it is open).
const doorColumn = columnMat.clone();
doorColumn.uniforms = { uTime: time, uColor: { value: new THREE.Color("#ffb347") }, uCore: { value: new THREE.Color("#fff1c4") } };
const doorDisc = new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
export function makeDoorGlow(x: number, y: number, z: number) {
  const g = new THREE.Group();
  g.name = "warp";
  g.position.set(x, z + 0.06, y);
  const disc = new THREE.Mesh(discGeo, doorDisc), column = new THREE.Mesh(columnGeo, doorColumn);
  disc.scale.set(1.6, 1, 2.2);
  column.scale.set(1.5, 0.6, 1.9);
  disc.renderOrder = column.renderOrder = 5;
  g.add(disc, column);
  return g;
}
