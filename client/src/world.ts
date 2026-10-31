import * as THREE from "three";
import { TILE, type GameMap, type PropType } from "../../shared/map.ts";
import { lookOf } from "./themes.ts";
import { Props, rng } from "./props.ts";
import { Terrain, TerrainFields, WATER_Y, tickTerrain, vnoise, type Occluder } from "./terrain.ts";
import { makeFlames, tickTorches } from "./torch.ts";
import { buildTown, tickTown, townCovered } from "./town.ts";

export { setSeeThrough } from "./props.ts";

// Map renderer. Tile (x, y) maps to world (x, height, y); 1 tile = 1 unit. Everything is derived from the shared map
// (shared/maps.ts buildMap: the town layout or a themed field) plus client-only seeded decor in the map theme's look (themes.ts):
//  - terrain (terrain.ts): one ground mesh + shader driven by smooth material fields: painted ponds with banks, wet
//    soil, foam and ripples (water is part of the ground, so shadows fall across it), ragged path borders, a paved
//    plaza with a curb and broken stones, occlusion pooled under canopies and large-scale light variation
//  - props (props.ts): the server's blocking trees and rocks become painted trees and painted rock outcrops; a forest
//    ring stands outside the playable area
//  - decor (walk-through): undergrowth at tree and rock feet, meadow clumps (tufts, flowers, bush groups) that come
//    and go across the field, reeds/rushes/pebbles/stones along the shores, lily pads on open water

const terrains = new WeakMap<GameMap, Terrain>();

/** Height of the drawn ground at (x, y): units, items and NPCs stand on what is rendered. */
export function heightAt(m: GameMap, x: number, y: number) {
  const t = terrains.get(m);
  if (t) return t.heightAt(x, y);
  const ix = Math.min(m.w - 1, Math.max(0, Math.round(x))), iy = Math.min(m.h - 1, Math.max(0, Math.round(y)));
  return Math.max(0, m.height[iy * m.w + ix]);
}

export function tickWorld(t: number, camera?: THREE.PerspectiveCamera, height?: number) { tickTerrain(t); tickTorches(t, camera, height); tickTown(t); }

export function buildWorld(m: GameMap) {
  const group = new THREE.Group();
  const r = rng(m.w * 7919 + m.h);
  const fields = new TerrainFields(m);
  const shoreDist = (x: number, y: number) => fields.sample(fields.water, x, y); // + on land, tiles
  const plazaDist = (x: number, y: number) => fields.sample(fields.plaza, x, y); // + outside the paving

  // ---------- what stands on the map: the server's blocking trees / rocks + a forest ring outside it ----------
  type Tree = { x: number; y: number; R: number; seed: number; ring: boolean };
  const trees: Tree[] = [], rocks: { x: number; y: number; size: number; seed: number }[] = [];
  const others: { x: number; y: number; type: PropType; R: number; seed: number }[] = []; // pines, dead trees, stumps, ruins, the stair
  const look = lookOf(m.theme);
  for (const p of m.props) {
    const h = ((p.x * 73856093) ^ (p.y * 19349663)) >>> 0, u = (h % 997) / 997;
    if (p.type === "rock") { rocks.push({ x: p.x, y: p.y, size: 1.5 + u * 1.0, seed: h }); continue; }
    if (p.type !== "tree") { others.push({ x: p.x, y: p.y, type: p.type, R: 0.9 + u * 0.8, seed: h }); continue; }
    // canopy radius: young trees, ordinary ones and a few big old ones (a canopy is ~2-3x a character's height wide)
    trees.push({ x: p.x, y: p.y, R: u < 0.3 ? 1.05 + u : u < 0.75 ? 1.4 + (u - 0.3) * 0.9 : 1.85 + (u - 0.75) * 1.6, seed: h, ring: false });
  }
  // the scenery ring outside the playable area, in the theme's mix (W01: woods, crags and pines, dead trees)
  const ringCount = Math.round(look.ringCount * (m.w + m.h) / 144); // the themes count for a 72-cell map; W01 r2 fields are 104-108
  for (let i = 0; i < ringCount; i++) {
    const side = Math.floor(r() * 4), t = r() * (m.w + 8) - 4, d = 1.5 + r() * 8.5, R = 1.5 + r() * 1.0;
    const [x, y] = side === 0 ? [t, -d] : side === 1 ? [t, m.h - 1 + d] : side === 2 ? [-d, t] : [m.w - 1 + d, t];
    if (shoreDist(x, y) <= 1.2) continue; // ponds run on past the edge
    const type = look.ring[i % look.ring.length], seed = 1000003 + i * 7919;
    if (type === "tree") trees.push({ x, y, R, seed, ring: true });
    else if (type === "rock") rocks.push({ x, y, size: 1.8 + (R - 1.5) * 1.6, seed });
    else others.push({ x, y, type, R: R * 0.85, seed });
  }

  // ---------- terrain ----------
  // shade pools: under every canopy (skylight blocked) and tight at trunk and rock feet (contact)
  const occ: Occluder[] = [];
  for (const t of trees) occ.push({ x: t.x, y: t.y, r: t.R * 0.95, k: 0.32 }, { x: t.x, y: t.y, r: 0.42, k: 0.4 });
  for (const k of rocks) occ.push({ x: k.x, y: k.y, r: k.size * 0.42, k: 0.55 });
  for (const o of others) if (o.type === "pine") occ.push({ x: o.x, y: o.y, r: o.R * 0.8, k: 0.3 }); else if (o.type === "ruin" || o.type === "stalagmite") occ.push({ x: o.x, y: o.y, r: 0.6, k: 0.4 });
  // W01 r2 town: contact shade along the foot of every building
  if (m.town) for (const b of m.town.buildings) for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++)
    if (x === b.x0 || x === b.x1 || y === b.y0 || y === b.y1) occ.push({ x, y, r: 1.0, k: 0.22 });
  fields.occlude(occ);
  // W03 caves: a torch stands against the rock on the floor cell it faces; its light pools on the ground around it
  const torches: { x: number; y: number; fx: number; fy: number }[] = [];
  if (look.cave) {
    for (const o of others) {
      if (o.type !== "torch") continue;
      const open = [[0, 1], [1, 0], [-1, 0], [0, -1]].find(([dx, dy]) => {
        const x = o.x + dx, y = o.y + dy;
        return x >= 0 && y >= 0 && x < m.w && y < m.h && !m.blocked[y * m.w + x];
      });
      if (!open) continue;
      torches.push({ x: o.x + open[0] * 0.62, y: o.y + open[1] * 0.62, fx: o.x + open[0], fy: o.y + open[1] });
    }
    fields.light(torches, look.cave.dark);
  }
  const terrain = new Terrain(m, fields);
  terrains.set(m, terrain);
  group.add(terrain.group);
  const hAt = (x: number, y: number) => terrain.heightAt(x, y);

  // ---------- props ----------
  const props = new Props();
  props.leafTint = look.leaves;
  const kindAt = (x: number, y: number) => {
    const ix = Math.round(x), iy = Math.round(y);
    return ix < 0 || iy < 0 || ix >= m.w || iy >= m.h ? TILE.grass : m.kind[iy * m.w + ix];
  };
  // plants grow on grass and rocky ground, off the paving and clear of the water's edge
  const growsOn = (x: number, y: number) => {
    const k = kindAt(x, y);
    return (k === TILE.grass || k === TILE.stone) && shoreDist(x, y) > 0.3 && plazaDist(x, y) > 0.35;
  };
  /** a shrub mass: one bush with a smaller one or two leaning on it and tufts / flowers around the group */
  const bushGroup = (x: number, y: number, R: number, seed: number) => {
    const q = rng(seed * 7 + 5);
    props.bush(x, y, hAt(x, y), R, seed);
    const extra = 1 + Math.floor(q() * 2);
    for (let k = 0; k < extra; k++) {
      const a = q() * Math.PI * 2, d = R * (0.9 + q() * 0.5), bx = x + Math.cos(a) * d, by = y + Math.sin(a) * d;
      if (growsOn(bx, by)) props.bush(bx, by, hAt(bx, by), R * (0.55 + q() * 0.25), seed + 101 * (k + 1));
    }
    for (let k = 0; k < 3; k++) {
      const a = q() * Math.PI * 2, d = R * (1.0 + q() * 0.7), px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (growsOn(px, py)) props.plant(px, py, hAt(px, py), q() < 0.35 ? "flower" : "grass", 0.42 + q() * 0.18, seed + 13 * k);
    }
  };
  for (const t of trees) {
    props.tree(t.x, t.y, hAt(t.x, t.y), t.R, t.seed);
    const q = rng(t.seed * 31 + 7);
    if (t.ring) {
      if (q() < 0.4) bushGroup(t.x + (q() - 0.5) * 3, t.y + (q() - 0.5) * 3, 0.6 + q() * 0.4, t.seed + 3);
      continue;
    }
    // undergrowth: ferns and tufts at the roots, often a shrub mass beside the trunk
    const tufts = 2 + Math.floor(q() * 3);
    for (let k = 0; k < tufts; k++) {
      const a = q() * Math.PI * 2, d = 0.32 + q() * 0.55, px = t.x + Math.cos(a) * d, py = t.y + Math.sin(a) * d;
      if (growsOn(px, py)) props.plant(px, py, hAt(px, py), q() < 0.45 ? "fern" : "grass", 0.48 + q() * 0.24, t.seed + k);
    }
    if (q() < 0.42) {
      const a = q() * Math.PI * 2, d = 0.95 + q() * 0.6, bx = t.x + Math.cos(a) * d, by = t.y + Math.sin(a) * d;
      if (growsOn(bx, by)) bushGroup(bx, by, 0.5 + q() * 0.35, t.seed + 9);
    }
  }
  for (const k of rocks) props.rock(k.x, k.y, hAt(k.x, k.y), k.size, k.seed);
  for (const o of others) {
    const z = hAt(o.x, o.y);
    if (o.type === "pine") props.pine(o.x, o.y, z, o.R, o.seed);
    else if (o.type === "deadtree") props.deadTree(o.x, o.y, z, o.R, o.seed);
    else if (o.type === "stump") props.stump(o.x, o.y, z, o.seed);
    else if (o.type === "ruin") props.ruin(o.x, o.y, z, o.seed);
    else if (o.type === "stair") props.stair(o.x, o.y, z);
    else if (o.type === "stalagmite") props.stalagmite(o.x, o.y, z, o.seed);
  }
  const cups: { x: number; y: number; z: number }[] = [];
  for (const t of torches) {
    const z = hAt(t.fx, t.fy);
    props.torch(t.x, t.y, z);
    cups.push({ x: t.x, y: t.y, z: z + 1.5 });
  }
  if (m.town) { // W01 r2: Hearthmoor's buildings, wall and street furniture (town.ts); braziers add flames
    group.add(buildTown(m, props, cups));
    // any other blocked cell beside walkable ground gets a hedge, so the town has no invisible walls
    const covered = townCovered(m), propAt = new Set(m.props.map((p) => p.y * m.w + p.x));
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (!m.blocked[i] || covered.has(i) || propAt.has(i)) continue;
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const X = x + dx, Y = y + dy; return X >= 0 && Y >= 0 && X < m.w && Y < m.h && !m.blocked[Y * m.w + X]; });
      if (open) bushGroup(x, y, 0.62, i);
    }
  }
  if (cups.length) group.add(makeFlames(cups));
  // cave floor: old bones, pebbles and loose stones, a few pale mushrooms in the damp along the walls
  if (look.cave) for (let y = 1; y < m.h - 1; y++) for (let x = 1; x < m.w - 1; x++) {
    const i = y * m.w + x;
    if (m.blocked[i]) continue;
    const roll = r(), px = x + (r() - 0.5) * 0.7, py = y + (r() - 0.5) * 0.7, z = hAt(px, py);
    const byWall = m.blocked[i - 1] || m.blocked[i + 1] || m.blocked[i - m.w] || m.blocked[i + m.w];
    if (roll < 0.022) props.bones(px, py, z, i);
    else if (roll < 0.06) props.shore(px, py, z, r() < 0.5 ? "pebbles" : "stone", 0.32 + r() * 0.2, i);
    else if (byWall && roll < 0.085) props.plant(px, py, z, "mushroom", 0.3 + r() * 0.12, i);
  }

  // ---------- meadow decor: dense clumps in some stretches of the field, bare grass in others ----------
  if (!look.cave) for (let y = 1; y < m.h - 1; y++) for (let x = 1; x < m.w - 1; x++) {
    const i = y * m.w + x, k = m.kind[i];
    if (k === TILE.dirt && !m.blocked[i]) { // grass tufts creeping over the edges of paths
      const px = x + (r() - 0.5) * 0.9, py = y + (r() - 0.5) * 0.9, w = fields.sample(fields.dirt, px, py);
      if (w > 0.3 && w < 0.62 && r() < 0.35 && shoreDist(px, py) > 0.4 && plazaDist(px, py) > 0.4) props.plant(px, py, hAt(px, py), "grass", 0.4 + r() * 0.16, i);
      continue;
    }
    if (m.blocked[i] || (k !== TILE.grass && k !== TILE.stone)) continue;
    const roll = r(), jx = x + (r() - 0.5) * 0.8, jy = y + (r() - 0.5) * 0.8, more = r();
    // rocky ground: small painted stones and pebble heaps among the tufts
    if (k === TILE.stone && fields.sample(fields.stone, jx, jy) > 0.55 && roll < 0.1 && growsOn(jx, jy)) {
      props.shore(jx, jy, hAt(jx, jy), more < 0.45 ? "stone" : "pebbles", 0.5 + more * 0.35, i);
      continue;
    }
    const meadow = vnoise(x * 0.19, y * 0.19, 77), dens = 2.4 * meadow * meadow; // 0 .. 2.4, mean ~0.8
    if (!growsOn(jx, jy) || roll > 0.085 * dens * look.decor) continue;
    // theme mix: flowers thin out in the woods and the mire, mushrooms come up there instead (themes.ts)
    const z = hAt(jx, jy), f = roll / (dens * look.decor), bloom = more < look.flowers, shroom = more * 4 < look.mushrooms - 1;
    if (shroom && f < 0.03) props.plant(jx, jy, z, "mushroom", 0.36 + more * 0.12, i);
    else if (f < 0.045) {
      props.plant(jx, jy, z, "grass", 0.5 + more * 0.2, i);
      if (more < 0.5) props.plant(jx + 0.3, jy + 0.15, hAt(jx + 0.3, jy + 0.15), more < 0.2 && bloom ? "flower" : "grass", 0.4 + more * 0.3, i + 7);
    } else if (f < 0.062) props.plant(jx, jy, z, bloom ? "flower" : "fern", 0.42 + more * 0.14, i);
    else if (f < 0.068) props.plant(jx, jy, z, "fern", 0.62 + more * 0.2, i);
    else if (f < 0.071 + 0.004 * look.mushrooms) props.plant(jx, jy, z, "mushroom", 0.36 + more * 0.1, i);
    else if (f < 0.076 + 0.004 * look.mushrooms) bushGroup(jx, jy, 0.42 + more * 0.3, i);
  }

  // ---------- shores: reeds and rushes in clumps on the waterline, pebbles and stones on the bank ----------
  for (let y = -2; y < m.h + 2; y++) for (let x = -2; x < m.w + 2; x++) {
    const d0 = shoreDist(x, y);
    if (d0 > 1.4 || d0 < -2.2) continue;
    for (let s = 0; s < 4; s++) {
      const px = x - 0.25 + (s & 1) * 0.5 + (r() - 0.5) * 0.45, py = y - 0.25 + (s >> 1) * 0.5 + (r() - 0.5) * 0.45;
      const ds = shoreDist(px, py), clump = vnoise(px * 0.65, py * 0.65, 91), roll = r(), seed = (y + 9) * 1031 + (x + 9) * 7 + s;
      if (plazaDist(px, py) < 0.5) continue;
      if (ds > -0.32 && ds < 0.1 && clump > 0.48 && roll < 0.6 && !look.cave) props.shore(px, py, hAt(px, py), r() < 0.55 ? "reed" : "rush", 0.6 + r() * 0.32, seed);
      else if (ds > 0.04 && ds < 0.45 && roll < 0.05) props.shore(px, py, hAt(px, py), "pebbles", 0.34 + r() * 0.16, seed);
      else if (ds > -0.24 && ds < 0.06 && roll < 0.035) props.shore(px, py, hAt(px, py), "stone", 0.46 + r() * 0.24, seed);
    }
  }
  // lily pads: small groups on open water, a few in flower
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (m.kind[y * m.w + x] !== TILE.water || r() > 0.05 || look.cave) continue;
    const n = 1 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const px = x + (r() - 0.5) * 1.2, py = y + (r() - 0.5) * 1.2;
      if (shoreDist(px, py) < -0.5) props.lily(px, py, WATER_Y + 0.012, 0.36 + r() * 0.3, y * m.w + x + k * 977, r() < 0.22);
    }
  }

  group.add(props.build());
  return { group, ground: terrain.ground };
}
