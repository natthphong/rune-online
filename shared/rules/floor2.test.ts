// Floor 2 (2.5.0): Lanternrest, the Emberlit Terraces, Cinderwatch Heights and the Emberhollow Vault (shared/floor2.ts): the maps are
// deterministic and fully reachable, the warp graph links them to floor 1 through the Ascent Stair, every monster has a sprite, and
// FIELD_MOBS / the spawn lines agree. The NPC scripts and the quest chain are tested in content.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { walkable } from "../map.ts";
import {
  F2_ARRIVAL, F2_BOSS_HALL, F2_DUN, F2_DUN_STAIRS, F2_FIELD1, F2_FIELD2, F2_FIELDS, F2_SAVE, F2_TOWN, FIELD_MOBS, MAP_INFO, MAP_NAMES, MIRE,
  MIRE_ASCENT, MIRE_ASCENT_IN, NPC_HOMES, TOWN, WARPS, buildMap, fieldForLevel, habitatOf, roomOf, warpRoute,
} from "../maps.ts";
import { NPCS } from "../content/npcs.ts";
import { F2_GATE_LEVEL } from "../content/f2/chapter2.ts";
import { parseSpawns } from "./spawn.ts";
import { MOB_BY_ID } from "./data.ts";

const SEED = 1337;
const flood = (map: string, from: { x: number; y: number }) => {
  const m = buildMap(map as never, SEED), seen = new Set([from.y * m.w + from.x]), q = [from];
  for (let i = 0; i < q.length; i++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = q[i].x + dx, y = q[i].y + dy, k = y * m.w + x;
    if (!seen.has(k) && walkable(m, x, y)) { seen.add(k); q.push({ x, y }); }
  }
  let open = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (walkable(m, x, y)) open++;
  return { m, seen, open };
};

test("floor 2 maps are in the world, titled, with a music track that exists and a level band where there is something to hunt", () => {
  for (const n of [F2_TOWN, ...F2_FIELDS, F2_DUN] as const) {
    assert.ok(MAP_NAMES.includes(n), n);
    assert.ok(existsSync(new URL(`../../client/public/audio/music/${MAP_INFO[n].music}.mp3`, import.meta.url)), `${n}: music ${MAP_INFO[n].music}`);
    assert.equal(roomOf(n), n);
    assert.deepEqual(buildMap(n, SEED).blocked, buildMap(n, SEED).blocked, `${n} deterministic`);
  }
  assert.equal(MAP_INFO[F2_TOWN].town, true);
  assert.equal(MAP_INFO[F2_TOWN].band, undefined);
  assert.deepEqual(([F2_FIELD1, F2_FIELD2, F2_DUN] as const).map((n) => MAP_INFO[n].band), [[30, 36], [38, 46], [34, 46]]);
  assert.deepEqual([buildMap(F2_FIELD1, SEED).theme, buildMap(F2_FIELD2, SEED).theme, buildMap(F2_TOWN, SEED).theme, buildMap(F2_DUN, SEED).theme], ["dusk", "ash", "dusk", "cave"]);
});

test("the way up: Hearthmoor -> Mire -> Ascent Stair (a scripted door) -> Lanternrest -> fields -> vault; and back down", () => {
  assert.deepEqual(warpRoute(TOWN, F2_TOWN)!.map((w) => w.map), [TOWN, MIRE]);
  assert.equal(warpRoute(TOWN, F2_TOWN)![1].npc, "f1_ascent");
  assert.equal(warpRoute(TOWN, F2_TOWN, false), undefined, "without the door no route leads up");
  assert.deepEqual(warpRoute(F2_TOWN, F2_DUN)!.map((w) => w.map), [F2_TOWN, F2_FIELD2]);
  assert.deepEqual(warpRoute(F2_DUN, TOWN)!.map((w) => w.map), [F2_DUN, F2_FIELD2, F2_TOWN, MIRE], "stairs, gate, the Ascent Stair down, the south road");
  assert.deepEqual(warpRoute(F2_FIELD1, F2_FIELD2)!.map((w) => w.map), [F2_FIELD1, F2_TOWN]);
  // the town's south gate leads down to the Mire's chapel, 4 cells off the Ascent Stair; the stair leads to the town's south gate inside the wall
  const down = WARPS.find((w) => w.name === "town02_field04")!, up = WARPS.find((w) => w.npc === "f1_ascent")!;
  assert.deepEqual([down.to, up.to], [MIRE_ASCENT_IN, F2_ARRIVAL]);
  assert.deepEqual([up.map, up.x, up.y], [MIRE_ASCENT.map, MIRE_ASCENT.x, MIRE_ASCENT.y]);
  assert.equal(F2_GATE_LEVEL, 30);
  assert.deepEqual(F2_SAVE.map, F2_TOWN);
});

test("floor 2 maps: every walkable cell reachable from the gate / stair, NPCs and warps inside; town and fields are the planned size", () => {
  const t = flood(F2_TOWN, F2_ARRIVAL);
  assert.equal(t.m.w, 41);
  assert.equal(t.seen.size, t.open, "Lanternrest: everything walkable is reachable from the arrival");
  for (const n of NPCS.filter((n) => n.map === F2_TOWN)) assert.ok(t.seen.has(n.y * t.m.w + n.x), `${n.id} reachable`);
  assert.ok(t.seen.has(F2_SAVE.y * t.m.w + F2_SAVE.x), "save cell reachable");
  for (const w of WARPS.filter((w) => w.map === F2_TOWN)) assert.ok(t.seen.has(w.y * t.m.w + w.x), `${w.name} reachable`);
  for (const f of F2_FIELDS) {
    const gate = WARPS.find((w) => w.map === f)!, r = flood(f, gate);
    assert.ok(r.m.w === 80 && r.m.h === 80, `${f} 80x80`);
    assert.equal(r.seen.size, r.open, `${f}: everything walkable is reachable from the gate`);
    assert.ok(r.open > 80 * 80 * 0.4, `${f}: an open field`);
    assert.ok(r.seen.has(FIELD_MOBS[f].hunt.y * r.m.w + FIELD_MOBS[f].hunt.x), `${f}: hunting ground`);
  }
  const stair = buildMap(F2_FIELD2, SEED);
  assert.ok(stair.props.some((p) => p.type === "stair" && p.x === 66 && p.y === 18), "the vault's stair is drawn");
  const d = flood(F2_DUN, F2_DUN_STAIRS.up);
  assert.equal(d.seen.size, d.open, "the vault: everything reachable from the stair up");
  assert.ok(d.seen.has(F2_BOSS_HALL.y * d.m.w + F2_BOSS_HALL.x), "the boss hall");
  assert.ok(d.open > d.m.w * d.m.h * 0.18 && d.open < d.m.w * d.m.h * 0.45, "a dungeon, not an open field");
});

test("floor 2 spawns: FIELD_MOBS are the monster lines, every species has a sprite and sits in its band, one mini-boss in the Heights, the boss in the hall", () => {
  const text = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  for (const f of [F2_FIELD1, F2_FIELD2, F2_DUN] as const) {
    const lines = parseSpawns(text, f, buildMap(f, SEED), (id) => MOB_BY_ID.has(id));
    const ids = [...new Set(lines.filter((s) => !s.boss).map((s) => s.mobId))].sort();
    assert.deepEqual([...FIELD_MOBS[f].mobs].sort(), ids, `${f}: FIELD_MOBS match spawns.txt`);
    const [lo] = MAP_INFO[f].band!;
    for (const id of ids) {
      assert.ok(MOB_BY_ID.get(id)!.level >= lo - 2, `${MOB_BY_ID.get(id)!.name} Lv ${MOB_BY_ID.get(id)!.level} fits ${f}`);
      for (const part of ["move", "act"]) assert.ok(existsSync(new URL(`../../client/public/sprites/anim/mob_${id}_${part}.json`, import.meta.url)), `sprite sheet mob_${id}_${part}`);
    }
    const bosses = lines.filter((s) => s.boss);
    if (f === F2_FIELD2) assert.deepEqual(bosses.map((b) => b.mobId), [1250], "Cinderwarden on the Heights");
    else if (f === F2_DUN) {
      assert.equal(bosses.length, 1);
      assert.deepEqual([bosses[0].mobId, bosses[0].x, bosses[0].y], [3999, F2_BOSS_HALL.x, F2_BOSS_HALL.y], "Devo on its hall cell");
    } else assert.equal(bosses.length, 0);
  }
  assert.equal(habitatOf([3999], TOWN), undefined, "a boss is not a navigation habitat");
  assert.equal(habitatOf([1128], TOWN), F2_FIELD1, "Ashbeetles live on the Terraces only");
  assert.equal(habitatOf([1013], F2_TOWN), F2_FIELD2, "Ashhounds: from Lanternrest the Heights are nearer than the vault");
  // the auto-hunt stays on floor 1
  assert.deepEqual([25, 30, 40, 99].map((lv) => fieldForLevel(lv, true)), ["f1_dun02", "f1_dun03", "f1_dun03", "f1_dun03"]);
  assert.deepEqual([25, 99].map((lv) => fieldForLevel(lv)), ["f1_field04", "f1_field04"]);
});

test("every floor 2 NPC is listed in NPC_HOMES and stands on its own map", () => {
  for (const id of ["npc_f2_keeper", "npc_f2_sentinel", "f2_shop", "f2_crystal", "f1_crystal"]) {
    const n = NPCS.find((n) => n.id === id)!;
    assert.deepEqual(NPC_HOMES[id], { map: n.map, name: n.name });
  }
});
