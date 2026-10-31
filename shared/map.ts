// Deterministic tile map: server and client call generateMap(seed) and get the same world,
// so only the seed travels over the network. Swap for Tiled JSON maps once you have art.

export const TILE = { grass: 0, dirt: 1, water: 2, stone: 3, cobble: 4 } as const;
export type TileKind = (typeof TILE)[keyof typeof TILE];

export type GameMap = {
  w: number;
  h: number;
  height: Float32Array; // per tile, world units
  kind: Uint8Array;
  blocked: Uint8Array; // 1 = water / tree / rock
  props: { x: number; y: number; type: PropType }[];
  /** Field theme key (generateField), for the client's look; undefined = the legacy field / the town. */
  theme?: ThemeKey;
  /** W01 r2: a town's buildings, wall and street furniture (shared/town.ts); their cells are in `blocked`, the client draws them. */
  town?: TownLayout;
};

/** A building: an inclusive cell rectangle (all blocked) with its front (door) on one side. */
export type Building = {
  x0: number; y0: number; x1: number; y1: number;
  /** the side the door is on, and the door's cell along that side */
  face: "N" | "E" | "S" | "W"; door: number;
  kind: "house" | "shop" | "smithy" | "inn" | "chapel" | "guild";
  /** roof colour (index into the client's palette) and storeys (1-2) */
  roof: number; floors: number;
  /** a hanging sign over the door */
  sign?: string;
};
/** Street furniture: one cell each (blocked unless `walk`). */
export type TownDecor = {
  type: "fountain" | "lamp" | "stall" | "signpost" | "bed" | "brazier" | "well" | "anvil" | "dummy" | "barrels" | "crates" | "woodpile" | "bench" | "fence" | "tree" | "tower";
  x: number; y: number;
  /** signpost: its text (lines) and which way its arrow points; stall: canopy colour index; fence: the run's direction */
  label?: string[]; dir?: "N" | "E" | "S" | "W"; tint?: number;
};
export type TownLayout = {
  /** the town wall: a ring of cells at Chebyshev distance `ring` from the centre (cx, cy), open where the streets pass */
  cx: number; cy: number; ring: number; street: number;
  plaza: number;
  buildings: Building[];
  decor: TownDecor[];
};

/** What stands on a blocked cell (the client draws it; the server only sees `blocked`): broadleaf tree, rock outcrop, conifer,
 *  bare dead tree, tree stump, broken ruin wall / pillar, and the sealed stair of a dungeon entrance (walkable, drawn only).
 *  W03 (caves): a stalagmite (blocks its floor cell), a torch on a wall cell beside the floor (the wall is blocked anyway). */
export type PropType = "tree" | "rock" | "pine" | "deadtree" | "stump" | "ruin" | "stair" | "stalagmite" | "torch";
export type ThemeKey = "grass" | "forest" | "highland" | "swamp" | "cave" | "dusk" | "ash"; // dusk / ash: floor 2 (2.5.0)

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// value noise, bilinear between lattice points
function noise2(seed: number, w: number, h: number, cell: number) {
  const r = rng(seed);
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const g = Array.from({ length: gw * gh }, r);
  return (x: number, y: number) => {
    const fx = x / cell, fy = y / cell;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const v = (i: number, j: number) => g[j * gw + i];
    const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
    const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

export function generateMap(seed: number, w = 64, h = 64): GameMap {
  const n1 = noise2(seed, w, h, 12), n2 = noise2(seed + 1, w, h, 5), n3 = noise2(seed + 2, w, h, 3);
  const r = rng(seed + 3);
  const height = new Float32Array(w * h), kind = new Uint8Array(w * h), blocked = new Uint8Array(w * h);
  const props: GameMap["props"] = [];
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const e = n1(x, y) * 0.75 + n2(x, y) * 0.25;
      const dc = Math.hypot(x - cx, y - cy);
      const nearSpawn = dc < 6;
      // town plaza + four winding dirt roads leading out of it
      const plaza = dc < 4.6;
      const road = Math.abs(x - (cx + Math.round(Math.sin(y * 0.21) * 2.2))) <= 1 || Math.abs(y - (cy + Math.round(Math.sin(x * 0.17 + 1) * 2.2))) <= 1;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (e < 0.3 && !nearSpawn) {
        kind[i] = TILE.water; blocked[i] = 1; height[i] = -0.35;
        continue;
      }
      height[i] = plaza ? 0.05 : Math.max(0, (e - 0.3) * 2.2);
      kind[i] = plaza ? TILE.cobble : road || n3(x, y) > 0.7 ? TILE.dirt : e > 0.72 ? TILE.stone : TILE.grass;
      if (edge) { blocked[i] = 1; continue; }
      if (!nearSpawn && !road && kind[i] !== TILE.dirt) {
        const p = r();
        if (p < 0.06) { props.push({ x, y, type: "tree" }); blocked[i] = 1; }
        else if (p < 0.075) { props.push({ x, y, type: "rock" }); blocked[i] = 1; }
      }
    }
  }
  return { w, h, height, kind, blocked, props };
}

// ---------- themed fields (W01: floor 1's four hunting fields around Hearthmoor) ----------
export type Edge = "N" | "E" | "S" | "W";
type Spot = { x: number; y: number };
export type FieldTheme = {
  key: ThemeKey;
  w: number; h: number;
  /** elevation noise below this is water (0.3 plains .. 0.42 swamp) */
  water: number;
  /** height per unit of elevation above the water line (world units) */
  relief: number;
  /** elevation above this is rocky ground (TILE.stone) */
  stone: number;
  /** detail noise above this is bare earth (TILE.dirt) */
  dirt: number;
  /** blocking props per open cell: [type, chance] (summed, so the order only decides which wins a roll) */
  props: [PropType, number][];
  /** the 2-cell band along the map's edge: what lines it, and how densely (broken where a road leaves through a gate) */
  border: PropType[]; borderDensity: number;
  /** the road out of the map on each gated edge: the coordinate along that edge (the warp portal stands at the road's end) */
  gates: Partial<Record<Edge, number>>;
  /** places that must stay open ground (warp arrival cells, NPC camps, the dungeon entrance): no water or props within r,
   *  linked to the road network by a trail */
  keep: (Spot & { r: number })[];
  /** forced ponds / tarns (water discs), kept off the roads */
  lakes?: (Spot & { r: number })[];
  /** ruined walls: a rectangle outlined with broken wall pieces (gaps every few cells) over a patch of old paving */
  ruins?: (Spot & { w: number; h: number })[];
  /** a sealed stair down (a dungeon entrance): drawn at this cell, which stays walkable (the gate NPC's trigger area) */
  stair?: Spot;
};

/** The road cell where an edge's gate is: one cell in from the blocked edge row, so the warp portal stands on it. */
export function gateCell(t: Pick<FieldTheme, "w" | "h">, edge: Edge, at: number): Spot {
  return edge === "N" ? { x: at, y: 2 } : edge === "S" ? { x: at, y: t.h - 3 } : edge === "W" ? { x: 2, y: at } : { x: t.w - 3, y: at };
}

/**
 * A themed field, the same on server and client for one (theme, seed): elevation noise gives water, height and rocky
 * ground; roads run from every gate to the map's centre and trails to every `keep` place; props come from the theme's mix,
 * a denser band lines the edge (open only where a road leaves); then every patch of land a walker can't reach from the
 * first gate is flooded, so no monster spawns, and no quest cell lies, where nobody can walk.
 */
export function generateField(seed: number, t: FieldTheme): GameMap {
  const { w, h } = t;
  const n1 = noise2(seed, w, h, 12), n2 = noise2(seed + 1, w, h, 5), n3 = noise2(seed + 2, w, h, 3);
  const r = rng(seed + 3);
  const N = w * h, height = new Float32Array(N), kind = new Uint8Array(N), blocked = new Uint8Array(N);
  const road = new Uint8Array(N), keep = new Uint8Array(N);
  const props: GameMap["props"] = [];
  const at = (x: number, y: number) => y * w + x;
  const inside = (x: number, y: number) => x > 0 && y > 0 && x < w - 1 && y < h - 1;
  const hub = { x: w >> 1, y: h >> 1 };

  // roads: a wobbly line (half-width 1) from each gate to the hub; trails (half-width 0..1) from the hub to every keep place
  const paint = (a: Spot, b: Spot, half: number, phase: number) => {
    const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len; // sideways, for the wobble
    for (let i = 0; i <= len; i++) {
      const k = i / len, wob = Math.round(Math.sin(k * Math.PI * 2 + phase) * 2.2 * Math.sin(k * Math.PI));
      const cx = Math.round(a.x + (b.x - a.x) * k + nx * wob), cy = Math.round(a.y + (b.y - a.y) * k + ny * wob);
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) if (inside(cx + dx, cy + dy)) road[at(cx + dx, cy + dy)] = 1;
    }
  };
  const gates = (Object.entries(t.gates) as [Edge, number][]).map(([e, c]) => gateCell(t, e, c));
  gates.forEach((g, i) => paint(g, hub, 1, i * 1.7 + seed % 7));
  t.keep.forEach((k, i) => paint(hub, k, i % 2, i * 2.3 + 0.5));
  for (const k of t.keep) for (let y = k.y - k.r; y <= k.y + k.r; y++) for (let x = k.x - k.r; x <= k.x + k.r; x++)
    if (inside(x, y) && Math.hypot(x - k.x, y - k.y) <= k.r + 0.5) keep[at(x, y)] = 1;
  const lake = (x: number, y: number) => t.lakes?.some((l) => Math.hypot(x - l.x, y - l.y) <= l.r + (n2(x, y) - 0.5) * 2) ?? false;
  const nearGate = (x: number, y: number) => gates.some((g) => Math.max(Math.abs(g.x - x), Math.abs(g.y - y)) <= 3);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y), e = n1(x, y) * 0.75 + n2(x, y) * 0.25;
      const open = road[i] || keep[i];
      if (!open && ((e < t.water && !nearGate(x, y)) || lake(x, y))) {
        kind[i] = TILE.water; blocked[i] = 1; height[i] = -0.35;
        continue;
      }
      height[i] = Math.max(0, (e - t.water) * t.relief);
      kind[i] = road[i] || n3(x, y) > t.dirt ? TILE.dirt : e > t.stone ? TILE.stone : TILE.grass;
      if (!inside(x, y)) { blocked[i] = 1; continue; }
      if (open) continue;
      const edgeDist = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (edgeDist <= 2 && !nearGate(x, y)) {
        if (r() < t.borderDensity * (edgeDist === 1 ? 1 : 0.55)) { blocked[i] = 1; props.push({ x, y, type: t.border[Math.floor(r() * t.border.length)] }); }
        continue;
      }
      // keep a cell of clearance along the roads so a walker is never squeezed
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => road[at(x + dx, y + dy)])) continue;
      let p = r();
      for (const [type, chance] of t.props) {
        if (p < chance) { blocked[i] = 1; props.push({ x, y, type }); break; }
        p -= chance;
      }
    }
  }
  // ruins: an outline of broken wall pieces (a hashed third of the rim is gone, never on a road) over patches of old paving
  const hash = (x: number, y: number) => (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ seed) >>> 0) % 1000) / 1000;
  for (const ru of t.ruins ?? []) {
    for (let y = ru.y - ru.h; y <= ru.y + ru.h; y++) for (let x = ru.x - ru.w; x <= ru.x + ru.w; x++) {
      if (!inside(x, y)) continue;
      const i = at(x, y);
      if (kind[i] === TILE.water && !keep[i]) continue;
      const rim = Math.abs(x - ru.x) === ru.w || Math.abs(y - ru.y) === ru.h;
      if (rim && !road[i] && !keep[i] && hash(x, y) < 0.66) {
        if (!blocked[i]) { blocked[i] = 1; props.push({ x, y, type: "ruin" }); }
        continue;
      }
      if (!rim && hash(y, x) < 0.55 && !blocked[i]) kind[i] = TILE.cobble;
    }
  }
  if (t.stair) props.push({ x: t.stair.x, y: t.stair.y, type: "stair" });

  // reachability: flood from the first gate (or the hub); unreachable land becomes water
  const seen = new Uint8Array(N), start = gates[0] ?? hub, queue = [at(start.x, start.y)];
  seen[queue[0]] = 1;
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], cx = c % w, cy = (c - cx) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cx + dx, y = cy + dy, i = at(x, y);
      if (inside(x, y) && !seen[i] && !blocked[i]) { seen[i] = 1; queue.push(i); }
    }
  }
  for (let i = 0; i < N; i++) {
    if (blocked[i] || seen[i]) continue;
    const x = i % w, y = (i - x) / w;
    if (!inside(x, y)) continue;
    kind[i] = TILE.water; blocked[i] = 1; height[i] = -0.35;
  }
  return { w, h, height, kind, blocked, props, theme: t.key };
}

// ---------- dungeon levels (W03: floor 1's catacombs under the Sunken Mire) ----------
/** A chamber of a dungeon level: an irregular oval of floor (half-axes rx / ry) at a fixed cell, so spawn zones, warps and the
 *  boss hall stay where shared/data/spawns.txt and shared/maps.ts put them whatever the world seed; `hall` = old paving. */
export type Chamber = Spot & { rx: number; ry: number; hall?: boolean };
export type DungeonTheme = {
  key: "cave";
  w: number; h: number;
  /** the fixed chambers (entrance, exit, spawn zones, the boss hall), always carved and linked */
  chambers: Chamber[];
  /** extra chambers placed by the seed between the fixed ones (some hold a still pool) */
  extra: number;
  /** cells that must stay open and clear of props (warp cells, arrivals): radius r */
  keep: (Spot & { r: number })[];
  /** extra corridors beyond the spanning tree (loops), as a share of the chamber count */
  loops: number;
};

/**
 * A dungeon level, the same on server and client for one (theme, seed): solid rock everywhere, the theme's fixed chambers and a
 * few seeded ones carved out as ragged ovals, linked by winding three-cell corridors (a spanning tree over the chambers plus a
 * few loops); stalagmites stand in the chambers, torches on the walls beside the floor, a still pool in some extra chambers, and
 * every floor pocket a walker can't reach from the first chamber turns back to rock. Floor is dirt with stone patches (the
 * boss hall old paving), walls are high rocky ground (TILE.stone, blocked), drawn by the client as the cave's walls.
 */
export function generateDungeon(seed: number, t: DungeonTheme): GameMap {
  const { w, h } = t;
  const n1 = noise2(seed, w, h, 6), n2 = noise2(seed + 1, w, h, 3), n3 = noise2(seed + 2, w, h, 4);
  const r = rng(seed + 3);
  const N = w * h, height = new Float32Array(N), kind = new Uint8Array(N), blocked = new Uint8Array(N).fill(1);
  const floor = new Uint8Array(N), corridor = new Uint8Array(N), keep = new Uint8Array(N), hall = new Uint8Array(N), pool = new Uint8Array(N);
  const props: GameMap["props"] = [];
  const at = (x: number, y: number) => y * w + x;
  const inner = (x: number, y: number) => x >= 2 && y >= 2 && x <= w - 3 && y <= h - 3; // two rows of rock round the edge

  // chambers: the fixed ones, then seeded extras that keep 3 cells of rock from every other chamber
  const rooms: (Chamber & { extra?: boolean })[] = t.chambers.map((c) => ({ ...c }));
  for (let tries = 0, added = 0; added < t.extra && tries < 400; tries++) {
    const rx = 3 + Math.floor(r() * 3), ry = 3 + Math.floor(r() * 2);
    const x = 4 + rx + Math.floor(r() * (w - 8 - 2 * rx)), y = 4 + ry + Math.floor(r() * (h - 8 - 2 * ry));
    if (rooms.some((o) => Math.abs(o.x - x) < o.rx + rx + 4 && Math.abs(o.y - y) < o.ry + ry + 4)) continue;
    rooms.push({ x, y, rx, ry, extra: true });
    added++;
  }
  const carve = (x: number, y: number) => { if (inner(x, y)) floor[at(x, y)] = 1; };
  for (const c of rooms) {
    for (let y = c.y - c.ry - 1; y <= c.y + c.ry + 1; y++) for (let x = c.x - c.rx - 1; x <= c.x + c.rx + 1; x++) {
      const d = ((x - c.x) / (c.rx + 0.5)) ** 2 + ((y - c.y) / (c.ry + 0.5)) ** 2;
      if (d <= 1 + (n2(x, y) - 0.5) * 0.7) { carve(x, y); if (c.hall && inner(x, y)) hall[at(x, y)] = 1; }
    }
  }
  // corridors: Prim's spanning tree over the chamber centres, plus the shortest unused links as loops
  const links: [number, number][] = [], inTree = [0], dist = (a: Spot, b: Spot) => Math.hypot(a.x - b.x, a.y - b.y);
  while (inTree.length < rooms.length) {
    let best: [number, number] | undefined, bd = Infinity;
    for (const i of inTree) for (let j = 0; j < rooms.length; j++) {
      if (inTree.includes(j)) continue;
      const d = dist(rooms[i], rooms[j]);
      if (d < bd) { bd = d; best = [i, j]; }
    }
    links.push(best!); inTree.push(best![1]);
  }
  const spare: [number, number, number][] = [];
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++)
    if (!links.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) spare.push([i, j, dist(rooms[i], rooms[j])]);
  spare.sort((a, b) => a[2] - b[2]);
  for (const [i, j] of spare.slice(0, Math.round(rooms.length * t.loops))) links.push([i, j]);
  // a corridor bends through a displaced midpoint and wobbles along each leg; half-width 1 (three cells: two walkers pass)
  const leg = (a: Spot, b: Spot, phase: number) => {
    const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    for (let i = 0; i <= len; i++) {
      const k = i / len, wob = Math.round(Math.sin(k * Math.PI * 2 + phase) * 1.6 * Math.sin(k * Math.PI));
      const cx = Math.round(a.x + (b.x - a.x) * k + nx * wob), cy = Math.round(a.y + (b.y - a.y) * k + ny * wob);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inner(cx + dx, cy + dy)) { floor[at(cx + dx, cy + dy)] = 1; corridor[at(cx + dx, cy + dy)] = 1; }
    }
  };
  links.forEach(([i, j], k) => {
    const a = rooms[i], b = rooms[j], len = dist(a, b), off = (r() - 0.5) * len * 0.5;
    const mid = {
      x: Math.max(3, Math.min(w - 4, Math.round((a.x + b.x) / 2 - ((b.y - a.y) / (len || 1)) * off))),
      y: Math.max(3, Math.min(h - 4, Math.round((a.y + b.y) / 2 + ((b.x - a.x) / (len || 1)) * off))),
    };
    leg(a, mid, k * 1.3 + r() * 3); leg(mid, b, k * 2.1 + r() * 3);
  });
  for (const k of t.keep) for (let y = k.y - k.r; y <= k.y + k.r; y++) for (let x = k.x - k.r; x <= k.x + k.r; x++)
    if (inner(x, y)) { floor[at(x, y)] = 1; keep[at(x, y)] = 1; }
  // still pools in some extra chambers: water in the middle, at least two cells of floor around it
  for (const c of rooms) {
    if (!c.extra || Math.min(c.rx, c.ry) < 4 || r() < 0.4) continue;
    const pr = Math.min(c.rx, c.ry) - 2.5;
    for (let y = c.y - c.ry; y <= c.y + c.ry; y++) for (let x = c.x - c.rx; x <= c.x + c.rx; x++)
      if (Math.hypot(x - c.x, (y - c.y) * 1.2) <= pr + (n2(x, y) - 0.5) && floor[at(x, y)] && !keep[at(x, y)]) pool[at(x, y)] = 1;
  }

  // cells: floor (dirt, stone patches, the hall's paving), pools, rock
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y), e = n1(x, y);
    if (pool[i]) { kind[i] = TILE.water; blocked[i] = 1; height[i] = -0.35; continue; }
    if (floor[i]) {
      blocked[i] = 0;
      height[i] = 0.02 + n3(x, y) * 0.1;
      kind[i] = hall[i] && n2(y, x) < 0.8 ? TILE.cobble : n3(x, y) > 0.62 ? TILE.stone : TILE.dirt;
      continue;
    }
    kind[i] = TILE.stone;
    height[i] = 1.3 + e * 0.6 + n2(x, y) * 0.3;
  }
  // the hall's colonnade: old pillars (drawn like the fields' ruins) in two rows down its sides (a lone cell each: the hall stays open)
  for (const c of rooms) {
    if (!c.hall) continue;
    for (const sx of [-1, 1]) for (let k = -1; k <= 1; k++) {
      const x = c.x + sx * (c.rx - 2), y = c.y + k * Math.max(2, c.ry - 3), i = at(x, y);
      if (!blocked[i] && hall[i] && !keep[i]) { blocked[i] = 1; props.push({ x, y, type: "ruin" }); }
    }
  }
  // stalagmites in the chambers (never in a corridor, beside one, or near a kept cell)
  const clear = (x: number, y: number, d: number) => {
    for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
      const j = at(x + dx, y + dy);
      if (corridor[j] || keep[j] || pool[j]) return false;
    }
    return true;
  };
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const i = at(x, y);
    if (blocked[i] || hall[i] || !clear(x, y, 1) || r() > 0.035) continue;
    blocked[i] = 1; props.push({ x, y, type: "stalagmite" });
  }
  // torches: on rock cells that face open floor, at least 7 cells apart (a greedy scan in hashed order)
  const hash = (x: number, y: number) => (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ seed) >>> 0) % 1000) / 1000;
  const faces = (x: number, y: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !blocked[at(x + dx, y + dy)] && kind[at(x + dx, y + dy)] !== TILE.water);
  const wallCells: Spot[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (blocked[at(x, y)] && kind[at(x, y)] === TILE.stone && !props.some((p) => p.x === x && p.y === y) && faces(x, y)) wallCells.push({ x, y });
  wallCells.sort((a, b) => hash(a.x, a.y) - hash(b.x, b.y));
  const torches: Spot[] = [];
  // the kept cells (warps, arrivals) are lit first, then the rest of the walls
  for (const k of t.keep) {
    const near = wallCells.filter((c) => Math.max(Math.abs(c.x - k.x), Math.abs(c.y - k.y)) <= k.r + 2).sort((a, b) => dist(a, k) - dist(b, k))[0];
    if (near && !torches.some((o) => dist(o, near) < 4)) torches.push(near);
  }
  for (const c of wallCells) if (!torches.some((o) => dist(o, c) < 7)) torches.push(c);
  for (const c of torches) props.push({ x: c.x, y: c.y, type: "torch" });

  // reachability: flood from the first chamber; unreachable floor goes back to rock (no spawn or quest cell where nobody walks)
  const seen = new Uint8Array(N), s0 = at(t.chambers[0].x, t.chambers[0].y), queue = [s0];
  seen[s0] = 1;
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], cx = c % w, cy = (c - cx) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = at(cx + dx, cy + dy);
      if (!seen[i] && !blocked[i]) { seen[i] = 1; queue.push(i); }
    }
  }
  for (let i = 0; i < N; i++) if (!blocked[i] && !seen[i]) { blocked[i] = 1; kind[i] = TILE.stone; height[i] = 1.2; }
  return { w, h, height, kind, blocked, props, theme: t.key };
}

/**
 * !map_getcellp(m, x, y, CELL_CHKNOPASS) (map.cpp:3323): out of bounds is never passable, and neither are the last row
 * and column ("this intentionally overrides the last row and column", map.cpp:3329-3331).
 */
export function walkable(m: GameMap, x: number, y: number) {
  return x >= 0 && y >= 0 && x < m.w - 1 && y < m.h - 1 && !m.blocked[y * m.w + x];
}

/** src/map/path.hpp MOVE_COST / MOVE_DIAGONAL_COST: a diagonal step takes speed * 14 / 10 ms. */
export const MOVE_COST = 10;
export const MOVE_DIAGONAL_COST = 14;
/** src/map/path.hpp MAX_WALKPATH: the longest route path_search returns (walkpath_data.path holds 32 steps). */
export const MAX_WALKPATH = 32;

// --- path_search's open set: rAthena's BHEAP_*2 macros (common/db.hpp), "matching client bheap" ---
// The heap holds node slots and compares f_cost only (NODE_MINTOPCMP, path.cpp:48). Its exact sift order decides which
// of several equal-f nodes is expanded first, i.e. the route shape, so it is re-implemented step by step.

/** BHEAP_SIFTDOWN: move the item at `i` towards the root (not above `start`) while its parent is strictly larger. */
function heapSiftDown(heap: number[], f: Int32Array, start: number, i: number) {
  while (i > start) {
    const p = (i - 1) >> 1;
    if (f[heap[p]] - f[heap[i]] <= 0) break;
    const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
    i = p;
  }
}

/** BHEAP_SIFTUP: swap the item at `start` with its smaller child (right child on ties) down to a leaf, then sift back. */
function heapSiftUp(heap: number[], f: Int32Array, start: number) {
  let i = start;
  for (let l = 2 * i + 1; l < heap.length; l = 2 * i + 1) {
    const r = l + 1;
    const c = r >= heap.length || f[heap[l]] - f[heap[r]] < 0 ? l : r;
    const t = heap[i]; heap[i] = heap[c]; heap[c] = t;
    i = c;
  }
  heapSiftDown(heap, f, start, i);
}

/** BHEAP_PUSH2: append, then sift towards the root. */
function heapPush(heap: number[], f: Int32Array, slot: number) {
  heap.push(slot);
  heapSiftDown(heap, f, 0, heap.length - 1);
}

/** BHEAP_POP2: the last item replaces the top, then BHEAP_SIFTUP from the top. */
function heapPop(heap: number[], f: Int32Array) {
  const last = heap.pop()!;
  if (!heap.length) return;
  heap[0] = last;
  heapSiftUp(heap, f, 0);
}

/**
 * path_search (path.cpp:258), A* branch (flag 0, cell CELL_CHKNOPASS) — the search rAthena uses for every walk, and the
 * one the game client runs too. Returns the cells after `from` up to and including the target, or [] when rAthena
 * returns false. Same decisions as the C++:
 * - the start cell is not checked; the target must be passable;
 * - integer costs MOVE_COST 10 / MOVE_DIAGONAL_COST 14 and the deliberately inadmissible Manhattan*10 heuristic
 *   (path.cpp:55), so a diagonal is taken as early as possible;
 * - a diagonal is allowed only when both orthogonal cells beside it are passable (allowed_dirs, path.cpp:372-382);
 * - neighbours are pushed in the order (+1,-1) (+1,0) (+1,+1) (0,+1) (-1,+1) (-1,0) (-1,-1) (0,-1) (path.cpp:385-400)
 *   into the BHEAP_*2 heap above; an improved closed node is pushed again, an improved open node is re-sifted
 *   (add_path, path.cpp:224);
 * - nodes live in a fixed 32*32 table indexed by calc_index = (x + y*32) & 1023 (path.cpp:50). A new node whose slot
 *   already holds another cell aborts the whole search (add_path "Index is already taken"; the FIXME at path.cpp:340),
 *   and an empty slot reads as cell (0,0) — both kept, since they change which clicks are refused;
 * - a route longer than MAX_WALKPATH cells is refused (path.cpp:411-412).
 */
export function findPath(m: GameMap, fx: number, fy: number, tx: number, ty: number): { x: number; y: number }[] {
  if (fx < 0 || fx >= m.w || fy < 0 || fy >= m.h) return [];
  if (!walkable(m, tx, ty)) return [];
  const SLOTS = MAX_WALKPATH * MAX_WALKPATH;
  const sx = new Int32Array(SLOTS), sy = new Int32Array(SLOTS), g = new Int32Array(SLOTS), f = new Int32Array(SLOTS);
  const parent = new Int32Array(SLOTS).fill(-1);
  const closed = new Uint8Array(SLOTS); // flag: 0 = SET_OPEN, 1 = SET_CLOSED
  const heap: number[] = [];
  const index = (x: number, y: number) => (x + y * MAX_WALKPATH) & (SLOTS - 1);
  const heuristic = (x: number, y: number) => MOVE_COST * (Math.abs(tx - x) + Math.abs(ty - y));
  const pass = (x: number, y: number) => walkable(m, x, y);

  // add_path (path.cpp:224): false = slot collision, which makes path_search fail.
  const addPath = (x: number, y: number, cost: number, from: number): boolean => {
    const i = index(x, y);
    if (sx[i] === x && sy[i] === y) {
      if (cost < g[i]) {
        g[i] = cost; parent[i] = from; f[i] = cost + heuristic(x, y);
        if (closed[i]) heapPush(heap, f, i);
        else {
          const at = heap.indexOf(i); // heap_update_node: ARR_FIND, then BHEAP_UPDATE
          if (at < 0) return false;
          heapSiftDown(heap, f, 0, at);
          heapSiftUp(heap, f, at);
        }
        closed[i] = 0;
      }
      return true;
    }
    if (sx[i] || sy[i]) return false;
    sx[i] = x; sy[i] = y; g[i] = cost; parent[i] = from; f[i] = cost + heuristic(x, y); closed[i] = 0;
    heapPush(heap, f, i);
    return true;
  };

  const start = index(fx, fy);
  sx[start] = fx; sy[start] = fy; g[start] = 0; f[start] = heuristic(fx, fy);
  heapPush(heap, f, start);
  const xs = m.w - 1, ys = m.h - 1;
  let cur: number;
  for (;;) {
    if (!heap.length) return [];
    cur = heap[0];
    heapPop(heap, f);
    const x = sx[cur], y = sy[cur], cg = g[cur];
    closed[cur] = 1;
    if (x === tx && y === ty) break;
    const up = y < ys && pass(x, y + 1), down = y > 0 && pass(x, y - 1);
    const right = x < xs && pass(x + 1, y), left = x > 0 && pass(x - 1, y);
    let ok = true;
    if (ok && down && right && pass(x + 1, y - 1)) ok = addPath(x + 1, y - 1, cg + MOVE_DIAGONAL_COST, cur);
    if (ok && right) ok = addPath(x + 1, y, cg + MOVE_COST, cur);
    if (ok && up && right && pass(x + 1, y + 1)) ok = addPath(x + 1, y + 1, cg + MOVE_DIAGONAL_COST, cur);
    if (ok && up) ok = addPath(x, y + 1, cg + MOVE_COST, cur);
    if (ok && up && left && pass(x - 1, y + 1)) ok = addPath(x - 1, y + 1, cg + MOVE_DIAGONAL_COST, cur);
    if (ok && left) ok = addPath(x - 1, y, cg + MOVE_COST, cur);
    if (ok && down && left && pass(x - 1, y - 1)) ok = addPath(x - 1, y - 1, cg + MOVE_DIAGONAL_COST, cur);
    if (ok && down) ok = addPath(x, y - 1, cg + MOVE_COST, cur);
    if (!ok) return [];
  }
  const out: { x: number; y: number }[] = [];
  for (let k = cur; parent[k] >= 0; k = parent[k]) {
    out.push({ x: sx[k], y: sy[k] });
    if (out.length > MAX_WALKPATH) return [];
  }
  return out.reverse();
}

// ---------- walk requests (rAthena unit_walktoxy / path_search_long) ----------

/** conf/battle/client.conf `max_walk_path`: longest walk (in cells) a click may request. */
export const MAX_WALK_PATH = 17;
/** src/config/core.hpp OFFICIAL_WALKPATH: past this many cells the straight line must be clear too. */
export const OFFICIAL_WALKPATH = 14;

/**
 * path_search_long (path.cpp): walk the straight line from (x0,y0) to (x1,y1) with the same integer
 * stepping as rAthena; false when a cell strictly between the ends is not passable.
 */
export function pathSearchLong(m: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  let dx = x1 - x0;
  if (dx < 0) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; dx = -dx; }
  const dy = y1 - y0;
  const weight = dx > Math.abs(dy) ? dx : Math.abs(dy);
  let wx = 0, wy = 0;
  while (x0 !== x1 || y0 !== y1) {
    wx += dx; wy += dy;
    if (wx >= weight) { wx -= weight; x0++; }
    if (wy >= weight) { wy -= weight; y0++; }
    else if (wy < 0) { wy += weight; y0--; }
    if ((x0 !== x1 || y0 !== y1) && !walkable(m, x0, y0)) return false;
  }
  return true;
}

/**
 * The path checks of unit_walktoxy (unit.cpp) for a player's walk request: the path must exist, be at most
 * MAX_WALK_PATH cells, and a path longer than OFFICIAL_WALKPATH cells also needs a clear straight line.
 * Returns the path (cells after `from`), or [] when the request is refused.
 */
export function walkPath(m: GameMap, fx: number, fy: number, tx: number, ty: number) {
  const path = findPath(m, fx, fy, tx, ty);
  if (path.length > MAX_WALK_PATH) return [];
  if (path.length > OFFICIAL_WALKPATH && !pathSearchLong(m, fx, fy, tx, ty)) return [];
  return path;
}

// ---------- distances (path.cpp, square area: CIRCULAR_AREA is off by default) ----------

/** distance (path.cpp:448): cells between two points, Chebyshev. check_distance(dx, dy, d) is `distance(dx, dy) <= d`. */
export const distance = (dx: number, dy: number) => Math.max(Math.abs(dx), Math.abs(dy));

/** distance_client (path.cpp:510): the circular distance the game client uses for player attack range:
 *  (int)(sqrt(dx^2 + dy^2) - 0.1), floored at 0. So a straight line is one cell "shorter" than it looks. */
export const distanceClient = (dx: number, dy: number) => Math.max(0, Math.trunc(Math.sqrt(dx * dx + dy * dy) - 0.1));
