// Floor items (dropped loot) and NPCs in the 3D world: billboards + labels + click picking.
import * as THREE from "three";
import { ITEMS } from "../../shared/rules/items.ts";
import { MonsterSprite } from "./sprites.ts";

type Thing = { id: string; kind: "floor" | "npc"; obj: THREE.Sprite; label: HTMLDivElement; pos: THREE.Vector3; npc?: MonsterSprite; t0: number };
const things = new Map<string, Thing>();
const pickables: THREE.Object3D[] = [];

let atlas: { img: HTMLImageElement; size: number; cols: number; names: Record<string, number> } | null = null;
fetch("/icons/items.json").then((r) => r.json()).then((a) => {
  const img = new Image();
  img.onload = () => { atlas = { img, ...a }; };
  img.src = "/icons/items.png";
}).catch(() => {});

function itemTexture(itemId: number) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d")!;
  const it = ITEMS.get(itemId);
  const idx = it && atlas ? atlas.names[it.name] : undefined;
  if (atlas && idx !== undefined) {
    g.drawImage(atlas.img, (idx % atlas.cols) * atlas.size, Math.floor(idx / atlas.cols) * atlas.size, atlas.size, atlas.size, 0, 0, 64, 64);
  } else {
    g.fillStyle = "#f2d16b"; g.strokeStyle = "#5a4310"; g.lineWidth = 4;
    g.beginPath(); g.arc(32, 36, 18, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function addFloor(scene: THREE.Scene, labels: HTMLElement, id: string, itemId: number, x: number, y: number, z: number) {
  const obj = new THREE.Sprite(new THREE.SpriteMaterial({ map: itemTexture(itemId), alphaTest: 0.3 }));
  obj.scale.set(0.55, 0.55, 1);
  obj.center.set(0.5, 0);
  obj.position.set(x, z + 0.05, y);
  obj.userData.thingId = id;
  scene.add(obj);
  pickables.push(obj);
  const label = document.createElement("div");
  label.className = "label floor";
  label.textContent = ITEMS.get(itemId)?.name ?? "?";
  label.hidden = true;
  labels.append(label);
  things.set(id, { id, kind: "floor", obj, label, pos: obj.position.clone(), t0: performance.now() });
}

export function addNpc(scene: THREE.Scene, labels: HTMLElement, id: string, name: string, sprite: string, x: number, y: number, z: number) {
  const npc = new MonsterSprite("bloblet", "#f2e3c6", sprite, 1.75, false);
  npc.sprite.position.set(x, z, y);
  npc.sprite.userData.thingId = id;
  scene.add(npc.sprite);
  pickables.push(npc.sprite);
  const label = document.createElement("div");
  label.className = "label npc";
  label.textContent = name;
  labels.append(label);
  things.set(id, { id, kind: "npc", obj: npc.sprite, label, pos: npc.sprite.position.clone(), npc, t0: 0 });
}

export function removeThing(scene: THREE.Scene, id: string) {
  const t = things.get(id);
  if (!t) return;
  scene.remove(t.obj);
  pickables.splice(pickables.indexOf(t.obj), 1);
  if (t.npc) t.npc.dispose();
  else { (t.obj.material as THREE.SpriteMaterial).map?.dispose(); (t.obj.material as THREE.SpriteMaterial).dispose(); }
  t.label.remove();
  things.delete(id);
}
export function clearThings(scene: THREE.Scene) { for (const id of [...things.keys()]) removeThing(scene, id); }
/** Where the NPCs stand (world x, z = map x, y), for the minimap's town-info marks. */
export const npcSpots = () => [...things.values()].filter((t) => t.kind === "npc").map((t) => ({ id: t.id, x: t.pos.x, y: t.pos.z }));

export function pickThing(ray: THREE.Raycaster) {
  const hit = ray.intersectObjects(pickables)[0];
  return hit ? things.get(hit.object.userData.thingId) : undefined;
}
/** floor item lying within `r` tiles of a ground point (forgiving click, like monsters) */
export function nearestFloor(x: number, z: number, r: number) {
  let best: Thing | undefined, bd = r;
  for (const t of things.values()) {
    if (t.kind !== "floor") continue;
    const d = Math.hypot(t.pos.x - x, t.pos.z - z);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/** NPCs within `r` tiles of `from`, nearest first: props in front of them are dithered away like they are for fight units (props.ts). */
export function npcSeeUnits(from: THREE.Vector3, r: number): { at: THREE.Vector3; height: number }[] {
  const r2 = r * r, found: { at: THREE.Vector3; height: number; d: number }[] = [];
  for (const th of things.values()) {
    if (th.kind !== "npc") continue;
    const d = th.obj.position.distanceToSquared(from);
    if (d < r2) found.push({ at: th.obj.position, height: 1.75, d });
  }
  return found.sort((a, b) => a.d - b.d);
}

const tmp = new THREE.Vector3();
export function updateThings(camera: THREE.Camera, camYaw: number, t: number, hoveredId: string | undefined, showFloorNames: boolean) {
  for (const th of things.values()) {
    if (th.kind === "floor") {
      // drop pop: fall in with a little bounce, then idle bob
      const age = (performance.now() - th.t0) / 1000;
      const drop = age < 0.45 ? Math.abs(Math.cos(age * 7)) * (0.45 - age) * 2.2 : 0;
      th.obj.position.y = th.pos.y + drop + Math.sin(t * 3 + th.pos.x) * 0.02;
    } else th.npc!.update(0, camYaw, false, t);
    const show = showFloorNames || hoveredId === th.id; // names on mouse-over (or Alt held), NPCs included, like the original: no stacked labels on the plaza
    th.label.hidden = !show;
    if (!show) continue;
    tmp.copy(th.obj.position).project(camera);
    th.label.style.display = tmp.z < 1 ? "" : "none";
    th.label.style.left = `${(tmp.x * 0.5 + 0.5) * innerWidth}px`;
    th.label.style.top = `${(-tmp.y * 0.5 + 0.5) * innerHeight + 4}px`;
  }
}
