// 2.7.0 floor 3: Witherwick's ruined village. Houses, carts, fences and crates are built from the Quaternius Medieval Village MegaKit
// (CC0; ro/client/public/models/village, textures shrunk to 512 px jpg, glTF stripped to bare geometry), weathered by vertex colour
// (mould-grey walls, charred or caved-in roofs, tilted carts / fences). Wells, lampposts, gravestones and cauldrons are small
// procedural meshes. Every piece is merged by material: the whole village costs ~7 draw calls (+2 for the glowing lamps and brews).
// The models load asynchronously; the returned group fills in when they arrive.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PropType } from "../../shared/map.ts";
import { Solid, deepShadow, patched, rng, seeThrough, tex, type V3 } from "./props.ts";

export type VillagePiece = { type: PropType; x: number; y: number; seed: number };
type Key = "wood" | "plaster" | "tiles" | "rock" | "brick";
const KEY_OF: Record<string, Key> = { MI_WoodTrim: "wood", MI_WoodTrim_Wear: "wood", MI_Plaster: "plaster", MI_RoundTiles: "tiles", MI_RockTrim: "rock", MI_Brick: "brick", MI_UnevenBrick: "brick" };
const NAMES = ["Prop_Wagon", "Prop_Crate", "Prop_WoodenFence_Single", "Roof_RoundTiles_4x4", "Wall_Plaster_Straight", "Wall_Plaster_Door_Round", "Wall_Plaster_Door_Flat",
  "Wall_Plaster_Window_Wide_Flat", "Wall_UnevenBrick_Window_Wide_Round", "Wall_Plaster_WoodGrid", "Corner_Exterior_Wood", "Prop_Chimney", "Prop_Support"];
const HOUSE_S = 0.72; // kit metres -> tiles: a 4 m house = 2.9 cells
const WALL_FLIP = false; // set if the kit's outside face is the -z one
const ROOF_Y = 3.0;

type Part = { geo: THREE.BufferGeometry; key: Key };
let kit: Promise<Map<string, Part[]>> | undefined;
function loadKit() {
  kit ??= (async () => {
    const loader = new GLTFLoader(), out = new Map<string, Part[]>();
    await Promise.all(NAMES.map(async (n) => {
      const gltf = await loader.loadAsync(`/models/village/${n}.gltf`);
      gltf.scene.updateMatrixWorld(true);
      const parts: Part[] = [];
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        for (const a of Object.keys(g.attributes)) if (a !== "position" && a !== "normal" && a !== "uv") g.deleteAttribute(a);
        if (g.index) g = g.toNonIndexed();
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        parts.push({ geo: g, key: KEY_OF[mat.name] ?? "wood" });
      });
      out.set(n, parts);
    }));
    return out;
  })();
  return kit;
}

const texLoader = new THREE.TextureLoader();
const kitTex = new Map<string, THREE.Texture>();
function kitMap(file: string) {
  let t = kitTex.get(file);
  if (!t) {
    t = texLoader.load(`/models/village/${file}.jpg`);
    t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
    kitTex.set(file, t);
  }
  return t;
}
const mkMat = (map: THREE.Texture, key: string, side = THREE.DoubleSide) =>
  patched(new THREE.MeshLambertMaterial({ map, vertexColors: true, side }), `village-${key}`, seeThrough, deepShadow);

/** Collects kit parts (transformed + coloured) per material, then merges each into one mesh. */
class Merge {
  private by = new Map<Key, THREE.BufferGeometry[]>();
  add(parts: Part[], m: THREE.Matrix4, col: V3) {
    for (const p of parts) {
      const g = p.geo.clone().applyMatrix4(m), n = g.attributes.position.count, c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.set(col, i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(c, 3));
      (this.by.get(p.key) ?? this.by.set(p.key, []).get(p.key)!).push(g);
    }
  }
  into(group: THREE.Group) {
    for (const [key, list] of this.by) {
      const m = new THREE.Mesh(mergeGeometries(list, false)!, mkMat(kitMap(key), key));
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
  }
}

const mat4 = (pos: V3, rotY = 0, tilt: V3 = [0, 0, 0], s = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt[0], rotY, tilt[2], "YXZ")), new THREE.Vector3(s, s, s));

export function buildVillage(pieces: VillagePiece[], hAt: (x: number, y: number) => number, green: { x: number; y: number }): THREE.Group {
  const group = new THREE.Group();
  group.name = "village";
  const stone = new Solid(), wood = new Solid(), glow: { x: number; y: number; z: number; r: number }[] = [];

  // ---------- procedural pieces ----------
  for (const p of pieces) {
    const r = rng(p.seed * 31 + 7), z = hAt(p.x, p.y), x = p.x, y = p.y;
    if (p.type === "well") {
      const dark = 0.3 + r() * 0.08;
      stone.tube([x, z - 0.1, y], [x, z + 0.55, y], 0.7, 0.62, 10, 0, dark * 0.8, dark);
      stone.tube([x, z + 0.5, y], [x, z + 0.58, y], 0.62, 0.62, 10, 0, dark, dark);
      stone.cap([x, z + 0.56, y], 0.5, 10, 0.05); // the black water
      for (const s of [-1, 1]) wood.tube([x + s * 0.62, z, y], [x + s * 0.55, z + 1.7, y], 0.06, 0.05, 5, 0, 0.3, 0.4);
      wood.tube([x - 0.58, z + 1.65, y], [x + 0.6, z + 1.75, y], 0.05, 0.05, 5, 0, 0.35, 0.35);
      glow.push({ x, y, z: z + 0.6, r: 0.5 });
    } else if (p.type === "lamppost") {
      wood.tube([x, z - 0.1, y], [x + (r() - 0.5) * 0.12, z + 2.1, y], 0.07, 0.05, 6, 0, 0.18, 0.3);
      stone.tube([x, z + 2.0, y], [x, z + 2.28, y], 0.15, 0.12, 5, 0, 0.12, 0.16); // the lantern cage
      stone.cap([x, z + 2.28, y], 0.12, 5, 0.1);
      if (r() < 0.7) glow.push({ x, y, z: z + 2.14, r: 0.2 });
    } else if (p.type === "gravestone") {
      const lean = (r() - 0.5) * 0.25, shade = 0.34 + r() * 0.14, a = (r() - 0.5) * 0.5;
      if (r() < 0.35) { // a cross
        const top: V3 = [x + lean, z + 1.35, y];
        stone.tube([x, z - 0.1, y], top, 0.1, 0.08, 4, 0, shade * 0.8, shade);
        stone.tube([x + lean * 0.7 - 0.36 * Math.cos(a), z + 1.0, y - 0.36 * Math.sin(a)], [x + lean * 0.7 + 0.36 * Math.cos(a), z + 1.0, y + 0.36 * Math.sin(a)], 0.08, 0.08, 4, 0, shade, shade);
      } else {
        const h = 0.85 + r() * 0.4;
        stone.tube([x, z - 0.1, y], [x + lean, z + h, y], 0.34, 0.3, 4, 0, shade * 0.75, shade);
        stone.cap([x + lean, z + h, y], 0.3, 4, shade * 1.1);
      }
      if (r() < 0.5) stone.tube([x + 0.1, z - 0.05, y + 0.42], [x + 0.1, z + 0.08, y + 0.42], 0.35, 0.3, 6, 0, 0.28, 0.32); // a mound
    } else if (p.type === "cauldron") {
      stone.tube([x, z + 0.2, y], [x, z + 0.55, y], 0.42, 0.5, 9, 0, 0.1, 0.13);
      stone.tube([x, z + 0.55, y], [x, z + 0.64, y], 0.5, 0.52, 9, 0, 0.14, 0.14); // the rim
      stone.cap([x, z + 0.6, y], 0.44, 9, 0.5); // the brew (brightened by the glow below)
      for (let k = 0; k < 3; k++) { const a = k * 2.1; wood.tube([x + Math.cos(a) * 0.3, z + 0.28, y + Math.sin(a) * 0.3], [x + Math.cos(a) * 0.38, z - 0.05, y + Math.sin(a) * 0.38], 0.05, 0.04, 4, 0, 0.12, 0.12); }
      glow.push({ x, y, z: z + 0.7, r: 0.58 });
    }
  }
  const solidMat = (file: string, key: string) => patched(new THREE.MeshLambertMaterial({ map: tex(file, true), vertexColors: true }), key, seeThrough, deepShadow);
  for (const [s, file, key] of [[stone, "prop_rock.jpg", "village-stone"], [wood, "prop_bark.jpg", "village-wood"]] as const) {
    if (s.empty) continue;
    const m = s.mesh(solidMat(file, key));
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  if (glow.length) { // faint sickly lights: lantern cages, the wells, the witches' brews (additive, no real lights)
    const im = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({
      color: 0x58c418, transparent: true, opacity: 0.11, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }), glow.length);
    const m4 = new THREE.Matrix4();
    glow.forEach((g, i) => im.setMatrixAt(i, m4.compose(new THREE.Vector3(g.x, g.z, g.y), new THREE.Quaternion(), new THREE.Vector3(g.r, g.r * 0.7, g.r))));
    im.frustumCulled = false; im.renderOrder = 10;
    group.add(im);
  }

  // ---------- kit pieces (async) ----------
  void loadKit().then((k) => {
    const merge = new Merge(), P = (n: string) => k.get(n)!;
    for (const p of pieces) {
      const r = rng(p.seed * 17 + 3), z = hAt(p.x, p.y), x = p.x, y = p.y;
      const moss = (lo: number) => { const v = lo + r() * 0.22; return [v * 0.92, v, v * 0.78] as V3; };
      if (p.type === "wreck") {
        merge.add(P("Prop_Wagon"), mat4([x, z - 0.04, y], r() * Math.PI * 2, [(r() - 0.5) * 0.2, 0, 0.12 + r() * 0.12], 0.42), moss(0.3));
      } else if (p.type === "crates") {
        const n = 2 + Math.floor(r() * 2);
        for (let i = 0; i < n; i++) merge.add(P("Prop_Crate"), mat4([x + (i === 2 ? 0.1 : (i - 0.5) * 0.52), z + (i === 2 ? 0.34 : 0), y + (r() - 0.5) * 0.2], r() * 1.5, [0, 0, (r() - 0.5) * 0.16], 0.34), moss(0.32));
      } else if (p.type === "fence") {
        merge.add(P("Prop_WoodenFence_Single"), mat4([x, z, y], 0, [0, 0, (r() - 0.5) * 0.3], 0.5), moss(0.28));
      } else if (p.type === "house" || p.type === "housebig") {
        const dx = green.x - x, dz = green.y - y, face = Math.abs(dx) > Math.abs(dz) ? Math.atan2(Math.sign(dx), 0) : Math.atan2(0, Math.sign(dz));
        const H = new THREE.Matrix4().compose(new THREE.Vector3(x, z, y), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, face, 0)), new THREE.Vector3(HOUSE_S, HOUSE_S, HOUSE_S));
        const variant = p.seed % 7, roofless = variant === 5 || variant === 6, charred = variant === 3 || variant === 4 || variant === 2;
        const wallCol = moss(0.3);
        const door = r() < 0.5 ? "Wall_Plaster_Door_Round" : "Wall_Plaster_Door_Flat";
        const kinds = ["Wall_Plaster_Straight", "Wall_Plaster_Window_Wide_Flat", "Wall_UnevenBrick_Window_Wide_Round", "Wall_Plaster_WoodGrid"];
        for (let s = 0; s < 4; s++) for (let i = 0; i < 2; i++) {
          if (roofless && s > 0 && r() < 0.22) continue; // a collapsed panel
          const name = s === 0 && i === 0 ? door : s === 0 ? "Wall_Plaster_Window_Wide_Flat" : kinds[Math.floor(r() * kinds.length)];
          const L = new THREE.Matrix4().makeRotationY(s * Math.PI / 2).multiply(new THREE.Matrix4().makeTranslation(i ? 1 : -1, 0, 2));
          if (WALL_FLIP) L.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
          merge.add(P(name), H.clone().multiply(L), wallCol.map((c) => c * (0.9 + r() * 0.2)) as V3);
        }
        for (const [cx, cz] of [[-2, -2], [2, -2], [2, 2], [-2, 2]]) merge.add(P("Corner_Exterior_Wood"), H.clone().multiply(new THREE.Matrix4().makeTranslation(cx, 0, cz)), [0.3, 0.3, 0.26]);
        if (roofless) {
          merge.add(P("Prop_Chimney"), H.clone().multiply(new THREE.Matrix4().makeTranslation(1.1, 0, -1.1)), [0.3, 0.3, 0.28]);
        } else {
          const sag = variant === 4 ? 0.16 : 0.03 + r() * 0.04;
          const R = new THREE.Matrix4().compose(new THREE.Vector3(0, ROOF_Y - (variant === 4 ? 0.5 : 0), 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(sag * (r() - 0.3), (r() < 0.5 ? 0 : Math.PI / 2), sag, "YXZ")), new THREE.Vector3(1, 1, 1));
          merge.add(P("Roof_RoundTiles_4x4"), H.clone().multiply(R), charred ? [0.08, 0.075, 0.07] : [0.1 + r() * 0.08, 0.15 + r() * 0.08, 0.1 + r() * 0.05]);
          if (variant === 1) merge.add(P("Prop_Chimney"), H.clone().multiply(new THREE.Matrix4().makeTranslation(1.0, 2.6, -0.8)), [0.3, 0.3, 0.28]);
        }
      }
    }
    merge.into(group);
  }).catch((e) => console.warn("village models failed", e));
  return group;
}
