// The world's maps and their warps (shared/maps.ts): every warp / arrival / save / start cell stands on walkable ground, a warp's
// area is its cell +- span (npc_touch_areanpc), arrivals lie outside every warp area (no warp ping-pong), the warp graph links
// every map both ways (W01: the hub world), and the fields are deterministic, reachable and themed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { walkable } from "../map.ts";
import {
  DUN1, DUN2, DUN3, DUNGEONS, DUNGEON_STAIRS, DUNGEON_THEMES, FIELDS, FIELD_MOBS, FIELD_THEMES, HUNT_MAPS, MAP_INFO, MAP_NAMES, MIRE,
  MIRE_STAIR, MVP_HALL, NPC_HOMES, TOWN, TOWN_SAVE, TOWN_START, WARPS, buildMap, exitToward, fieldForLevel, habitatOf, huntPlaceFor, mapOfState,
  warpAt, warpRoute, type MapPos,
} from "../maps.ts";
import { NPCS } from "../content/npcs.ts";

const SEED = 1337;
test("warp, arrival, save and start cells are walkable; arrivals are outside every warp area", () => {
  const cells: MapPos[] = [TOWN_SAVE, TOWN_START, ...WARPS.flatMap((w) => [w, w.to])];
  for (const p of cells) assert.ok(walkable(buildMap(p.map, SEED), p.x, p.y), `${p.map} ${p.x},${p.y}`);
  for (const w of WARPS) assert.equal(warpAt(w.to.map, w.to.x, w.to.y), undefined, `${w.name} arrives outside any warp`);
  // W03: nor inside a scripted door's trigger (the sealed stair would send a climber coming up straight back down)
  const doors = NPCS.filter((n) => WARPS.some((w) => w.npc === n.id));
  for (const w of WARPS) for (const n of doors) if (n.trigger && n.map === w.to.map)
    assert.ok(Math.abs(w.to.x - n.x) > n.trigger.x || Math.abs(w.to.y - n.y) > n.trigger.y, `${w.name} arrives outside ${n.id}'s trigger`);
  // a scripted door sits on its NPC, whose trigger covers the door's cell
  for (const w of WARPS.filter((w) => w.npc)) {
    const n = NPCS.find((n) => n.id === w.npc)!;
    assert.ok(n && n.map === w.map && n.x === w.x && n.y === w.y && n.trigger, `${w.name}: door NPC ${w.npc}`);
    assert.equal(warpAt(w.map, w.x, w.y), undefined, "warpAt leaves a scripted door to its NPC");
  }
  for (const n of NPCS.filter((n) => n.map === TOWN)) assert.ok(walkable(buildMap(TOWN, SEED), n.x, n.y), `NPC ${n.id} on a walkable cell`);
});
test("a warp's area is its cell +- spanx / spany (npc_touch_areanpc), on its own map only", () => {
  const w = WARPS[0];
  assert.equal(warpAt(w.map, w.x + w.spanx, w.y - w.spany), w);
  assert.equal(warpAt(w.map, w.x + w.spanx + 1, w.y), undefined);
});
test("hub world: town in the middle, one gate pair per field, every map reaches every other over the warps", () => {
  assert.equal(WARPS.filter((w) => w.map === TOWN).length, 4);
  for (const f of FIELDS) {
    assert.deepEqual(warpRoute(TOWN, f)!.map((w) => w.map), [TOWN], `town -> ${f} is one warp`);
    assert.deepEqual(warpRoute(f, TOWN)!.map((w) => w.map), [f]);
    for (const g of FIELDS) if (g !== f) assert.deepEqual(warpRoute(f, g)!.map((w) => w.map), [f, TOWN], `${f} -> ${g} through town`);
    // the town gate toward a field and the field's gate back point at each other's sides
    const out = exitToward(TOWN, f)!, back = exitToward(f, TOWN)!;
    assert.equal(out.to.map, f);
    assert.equal(back.to.map, TOWN);
  }
  assert.deepEqual(warpRoute(TOWN, TOWN), []);
  assert.equal(warpRoute(TOWN, "nowhere"), undefined);
});
test("W03 catacombs: town -> Mire -> the stair -> B1 -> B2 -> B3 and back up, stairs both ways; the stair is a scripted door", () => {
  assert.deepEqual(warpRoute(TOWN, DUN3)!.map((w) => w.map), [TOWN, MIRE, DUN1, DUN2]);
  assert.deepEqual(warpRoute(DUN3, TOWN)!.map((w) => w.map), [DUN3, DUN2, DUN1, MIRE]);
  assert.equal(warpRoute(TOWN, DUN1)![1].npc, "f1_stair", "the way down is the sealed stair's NPC");
  assert.equal(warpRoute(TOWN, DUN1, false), undefined, "without the door no route leads down");
  assert.deepEqual(warpRoute(MIRE, TOWN, false)!.map((w) => w.map), [MIRE]);
  for (let i = 0; i + 1 < DUNGEONS.length; i++) {
    const down = exitToward(DUNGEONS[i], DUNGEONS[i + 1])!, up = exitToward(DUNGEONS[i + 1], DUNGEONS[i])!;
    assert.deepEqual([down.x, down.y, down.to], [DUNGEON_STAIRS[DUNGEONS[i]].down!.x, DUNGEON_STAIRS[DUNGEONS[i]].down!.y, { map: DUNGEONS[i + 1], ...DUNGEON_STAIRS[DUNGEONS[i + 1]].upIn }]);
    assert.deepEqual(up.to, { map: DUNGEONS[i], ...DUNGEON_STAIRS[DUNGEONS[i]].downIn });
  }
  assert.deepEqual(WARPS.filter((w) => w.npc).map((w) => w.npc), ["f1_stair", "f1_ascent"]); // the sealed stair and the 2.5.0 Ascent Stair
  assert.deepEqual([MIRE_STAIR.x, MIRE_STAIR.y], [FIELD_THEMES[MIRE].stair!.x, FIELD_THEMES[MIRE].stair!.y]);
});
test("W03 catacombs: three cave levels, 60-80 cells, chambers on fixed cells, everything reachable from the stair up, the MVP's paved hall", () => {
  const themes = new Set<string>();
  for (const d of DUNGEONS) {
    const m = buildMap(d, SEED), t = DUNGEON_THEMES[d];
    themes.add(m.theme!);
    assert.deepEqual(m.blocked, buildMap(d, SEED).blocked, `${d} deterministic`);
    assert.notDeepEqual(m.blocked, buildMap(d, SEED + 1).blocked, `${d} varies with the seed`);
    assert.ok(m.w >= 60 && m.w <= 80 && m.h >= 60 && m.h <= 80, `${d} size`);
    const up = DUNGEON_STAIRS[d].up, seen = new Set([up.y * m.w + up.x]), q = [up];
    for (let i = 0; i < q.length; i++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = q[i].x + dx, y = q[i].y + dy, k = y * m.w + x;
      if (!seen.has(k) && walkable(m, x, y)) { seen.add(k); q.push({ x, y }); }
    }
    let open = 0;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (walkable(m, x, y)) open++;
    assert.equal(seen.size, open, `${d}: every walkable cell is reachable from the stair up`);
    assert.ok(open > m.w * m.h * 0.18 && open < m.w * m.h * 0.45, `${d}: a dungeon, not an open field (${open} open cells)`);
    for (const c of t.chambers) assert.ok(seen.has(c.y * m.w + c.x), `${d}: chamber ${c.x},${c.y}`);
    for (const c of Object.values(DUNGEON_STAIRS[d])) assert.ok(seen.has(c.y * m.w + c.x), `${d}: stair cell ${c.x},${c.y}`);
    assert.ok(m.props.filter((p) => p.type === "torch").length >= 15, `${d}: torch-lit`);
    for (const p of m.props) assert.ok(m.blocked[p.y * m.w + p.x], `${d}: a ${p.type} stands on a blocked cell`);
    // the edge is solid rock two cells deep
    for (let x = 0; x < m.w; x++) for (const y of [0, 1, m.h - 2, m.h - 1]) assert.ok(m.blocked[y * m.w + x]);
  }
  assert.deepEqual([...themes], ["cave"]);
  const b3 = buildMap(DUN3, SEED), hall = b3.kind[MVP_HALL.y * b3.w + MVP_HALL.x];
  assert.ok(walkable(b3, MVP_HALL.x, MVP_HALL.y) && hall !== undefined);
  assert.ok(Math.max(...DUNGEONS.map((d) => MAP_INFO[d].band![1])) === 30 && MAP_INFO[DUN1].music === "dungeon");
});
test("fields: deterministic per name + seed, themed, 100-110 cells (W01 r2), every warp / keep place reachable from the gate", () => {
  for (const m of MAP_NAMES) assert.deepEqual(buildMap(m, SEED).blocked, buildMap(m, SEED).blocked);
  assert.notDeepEqual(buildMap(FIELDS[0], SEED).blocked, buildMap(FIELDS[0], SEED + 1).blocked);
  assert.equal(mapOfState({ seed: SEED, map: TOWN }), mapOfState({ seed: SEED, map: TOWN }));
  const themes = new Set<string>();
  for (const f of FIELDS) {
    const m = buildMap(f, SEED), t = FIELD_THEMES[f];
    themes.add(m.theme!);
    assert.ok(m.w >= 100 && m.w <= 110 && m.h >= 100 && m.h <= 110, `${f} size`);
    // flood from the field's gate: everything walkable is reachable (the generator floods unreachable pockets)
    const gate = WARPS.find((w) => w.map === f)!, seen = new Set([gate.y * m.w + gate.x]), q = [gate];
    for (let i = 0; i < q.length; i++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = q[i].x + dx, y = q[i].y + dy, k = y * m.w + x;
      if (!seen.has(k) && walkable(m, x, y)) { seen.add(k); q.push({ ...q[i], x, y }); }
    }
    let open = 0;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (walkable(m, x, y)) open++;
    assert.equal(seen.size, open, `${f}: every walkable cell is reachable from the gate`);
    for (const k of t.keep) assert.ok(seen.has(k.y * m.w + k.x), `${f}: keep place ${k.x},${k.y} reachable`);
    if (t.stair) assert.ok(walkable(m, t.stair.x, t.stair.y) && m.props.some((p) => p.type === "stair"), `${f}: the stair cell`);
  }
  assert.equal(themes.size, 4, "four different themes");
  const spawns = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  assert.ok(!spawns.includes(TOWN));
});
test("level bands: consecutive, and the auto-hunt's field follows the level", () => {
  assert.deepEqual(FIELDS.map((f) => MAP_INFO[f].band), [[1, 5], [5, 10], [10, 15], [15, 20]]);
  assert.deepEqual([1, 5, 6, 10, 11, 15, 16, 30].map((lv) => fieldForLevel(lv)), [FIELDS[0], FIELDS[0], FIELDS[1], FIELDS[1], FIELDS[2], FIELDS[2], FIELDS[3], FIELDS[3]]);
  // W03: once the stair is open the catacombs take over from Lv 21
  assert.deepEqual([16, 20, 21, 23, 24, 26, 27, 40].map((lv) => fieldForLevel(lv, true)), [MIRE, MIRE, DUN1, DUN1, DUN2, DUN2, DUN3, DUN3]);
  assert.deepEqual(DUNGEONS.map((d) => MAP_INFO[d].band), [[20, 24], [23, 27], [26, 30]]);
  assert.equal(habitatOf([1076], TOWN), DUN2); // Rattlebones: B2 is nearer than B3
  assert.equal(habitatOf([1051], MIRE), DUN1); // Pilferbug: B1
  assert.equal(habitatOf([1002], TOWN), FIELDS[0]); // Puddlebloom: the plains
  assert.equal(habitatOf([1010], FIELDS[0]), FIELDS[1]); // Loambloom: the woods
  assert.equal(habitatOf([999999], TOWN), undefined);
  // 2.5.1: quest 1011's Navi is the Tumhog thicket on the plains; its Loambloom target must send auto-play to the woods
  const tumhogs = { map: FIELDS[0] as string, x: 60, y: 56 };
  assert.equal(huntPlaceFor([1063], tumhogs, FIELDS[0]), tumhogs);
  assert.deepEqual(huntPlaceFor([1010], tumhogs, FIELDS[0]), { ...FIELD_MOBS[FIELDS[1]].hunt, map: FIELDS[1] });
  assert.equal(huntPlaceFor([999999], tumhogs, TOWN), tumhogs);
  for (const f of HUNT_MAPS) assert.ok(walkable(buildMap(f, SEED), FIELD_MOBS[f].hunt.x, FIELD_MOBS[f].hunt.y), `${f} hunting ground cell`);
  assert.ok(Object.values(NPC_HOMES).every((h) => MAP_NAMES.includes(h.map)));
});

test("Hearthmoor: from every walkable cell, clicking 10 cells along the route (what a player or bot does) is accepted by the server's walk rules and reaches every gate", async () => {
  const { naviRoute } = await import("../navi.ts");
  const { walkRequestPath, walkSubPath } = await import("./walk.ts");
  const { TOWN_GATE_CELLS } = await import("../town.ts");
  const m = buildMap(TOWN, SEED);
  const gates = Object.values(TOWN_GATE_CELLS);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (!walkable(m, x, y)) continue;
    for (const g of gates) {
      let at = { x, y }, clicks = 0;
      while (at.x !== g.x || at.y !== g.y) {
        const route = naviRoute(m, at.x, at.y, g.x, g.y);
        assert.ok(route.length, `no route ${x},${y} -> ${g.x},${g.y} (at ${at.x},${at.y})`);
        const step = route[Math.min(9, route.length - 1)];
        assert.ok(walkRequestPath(m, at, step), `walk request ${at.x},${at.y} -> ${step.x},${step.y} refused (from ${x},${y} to gate ${g.x},${g.y})`);
        assert.ok(walkSubPath(m, at, step), `walk ${at.x},${at.y} -> ${step.x},${step.y} has no path`);
        at = step;
        assert.ok(++clicks < 40, `${x},${y} -> ${g.x},${g.y} does not converge`);
      }
    }
  }
});
