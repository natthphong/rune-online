// Golden tests for permanent monster spawns (shared/rules/spawn.ts), values worked out by hand from rAthena npc.cpp
// (npc_parse_mob, npc_parse_mob2), mob.cpp (mob_spawn, mob_setdelayspawn), map.cpp (map_search_freecell) and
// conf/battle/monster.conf defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type GameMap } from "../map.ts";
import { DUNGEONS, FIELDS, FIELD_MOBS, HUNT_MAPS, MAP_NAMES, MVP_HALL, WARPS, buildMap } from "../maps.ts";
import { MOB_BY_ID } from "./data.ts";
import * as MAPS from "../maps.ts";
import { MD } from "./mobai.ts";
import { SPAWN_CONF, mobSpawnCell, parseSpawnLine, parseSpawns, respawnDelay, searchFreeCell, spawnCenter, type SpawnData } from "./spawn.ts";

function openMap(w: number, h: number, blocked: [number, number][] = []): GameMap {
  const m: GameMap = { w, h, height: new Float32Array(w * h), kind: new Uint8Array(w * h), blocked: new Uint8Array(w * h), props: [] };
  for (const [x, y] of blocked) m.blocked[y * w + x] = 1;
  return m;
}
const exists = (id: number) => MOB_BY_ID.has(id);
/** A scripted rnd_value: returns the queued values in order and records every (min, max) it was asked for. */
function scripted(values: number[]) {
  const calls: [number, number][] = [];
  const fn = (min: number, max: number) => {
    calls.push([min, max]);
    assert.ok(values.length, `unexpected rnd_value(${min}, ${max})`);
    return values.shift()!;
  };
  return { fn, calls, left: () => values.length };
}

test("npc_parse_mob: 0,0 = anywhere, delay1 5000, monster lines lose delay2 (mob_spawn_variance 1)", () => {
  const m = openMap(40, 40);
  const a = parseSpawnLine("f1,0,0\tmonster\tPuddlebloom\t1002,42,5000", m, exists);
  assert.deepEqual(a, { map: "f1", x: -1, y: -1, xs: 0, ys: 0, boss: false, name: "Puddlebloom", mobId: 1002, num: 42, delay1: 5000, delay2: 0 });
  // no delay column: 5000 (npc.cpp delay = 5000 default)
  assert.equal(parseSpawnLine("f1,0,0\tmonster\tPuddlebloom\t1002,3", m, exists).delay1, 5000);
  // a given delay below mob_respawn_time 1000 (and not 5000) falls back to 5000; 1000 itself is kept
  assert.equal(parseSpawnLine("f1,0,0\tmonster\tPuddlebloom\t1002,3,500", m, exists).delay1, 5000);
  assert.equal(parseSpawnLine("f1,0,0\tmonster\tPuddlebloom\t1002,3,1000", m, exists).delay1, 1000);
  // monster line 1800000,900000 (like a field plant): variance dropped -> delay2 0
  const plant = parseSpawnLine("f1,20,21\tmonster\tPuddlebloom\t1002,1,1800000,900000", m, exists);
  assert.deepEqual([plant.delay1, plant.delay2], [1800000, 0]);
  // fixed cell 20,21: xs/ys 0 with non-zero x/y become 1
  assert.deepEqual([plant.x, plant.y, plant.xs, plant.ys], [20, 21, 1, 1]);
  // boss_monster keeps it
  const boss = parseSpawnLine("f1,0,0\tboss_monster\tMosspaw\t1167,1,3600000,600000", m, exists);
  assert.deepEqual([boss.boss, boss.delay1, boss.delay2], [true, 3600000, 600000]);
  // mob_spawn_variance 2 (normal only): the other way round
  const v2 = { ...SPAWN_CONF, mob_spawn_variance: 2 };
  assert.equal(parseSpawnLine("f1,0,0\tboss_monster\tMosspaw\t1167,1,3600000,600000", m, exists, v2).delay2, 0);
  assert.equal(parseSpawnLine("f1,0,0\tmonster\tPuddlebloom\t1002,1,1800000,900000", m, exists, v2).delay2, 900000);
});

test("npc_parse_mob: areas, unreachable fixed cell, mob_count_rate, bad lines", () => {
  const m = openMap(40, 40, [[5, 6]]);
  const a = parseSpawnLine("f1,20,22,8,3\tmonster\tPuddlebloom\t1002,5,5000", m, exists);
  assert.deepEqual([a.x, a.y, a.xs, a.ys], [20, 22, 8, 3]);
  // only y fixed: x spans the area, ys becomes 1
  const b = parseSpawnLine("f1,20,22,8\tmonster\tPuddlebloom\t1002,5,5000", m, exists);
  assert.deepEqual([b.xs, b.ys], [8, 1]);
  // fixed cell that can't be stood on -> anywhere
  const c = parseSpawnLine("f1,5,6\tmonster\tPuddlebloom\t1002,1,5000", m, exists);
  assert.deepEqual([c.x, c.y, c.xs, c.ys], [-1, -1, 0, 0]);
  // force_random_spawn
  const f = parseSpawnLine("f1,20,22,8,3\tmonster\tPuddlebloom\t1002,5,5000", m, exists, { ...SPAWN_CONF, force_random_spawn: true });
  assert.deepEqual([f.x, f.y, f.xs, f.ys], [-1, -1, 0, 0]);
  // mob_count_rate 50: 5 -> 2 (integer), 1 stays 1 (only lines of more than one are scaled)
  const half = { ...SPAWN_CONF, mob_count_rate: 50 };
  assert.equal(parseSpawnLine("f1,0,0\tmonster\tPuddlebloom\t1002,5", m, exists, half).num, 2);
  assert.equal(parseSpawnLine("f1,0,0\tmonster\tPuddlebloom\t1002,1", m, exists, half).num, 1);
  for (const bad of [
    "f1,0,0 monster Puddlebloom 1002,5", // spaces, not tabs
    "f1,0,0\tmonster\tPuddlebloom\t9999,5", // unknown id
    "f1,0,0\tmonster\tPuddlebloom\t1002,0", // amount 0
    "f1,40,0\tmonster\tPuddlebloom\t1002,1", // x out of range
    "f1,a,0\tmonster\tPuddlebloom\t1002,1",
    "f1,0,0\tmonster\tPuddlebloom,5\t1002,1", // level override: not supported yet
    "f1,0,0\twarp\tPuddlebloom\t1002,1",
  ]) assert.throws(() => parseSpawnLine(bad, m, exists), Error, bad);
});

const RARE_DELAY = new Map([[1019, 90000]]); // W01 r2: Gravewalkers are an ordinary Mire species now (5000)
test("spawn file: every map's lines parse, ids exist, names are the mobs.json names, normal field delay 5000", () => {
  const text = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  const lines = MAP_NAMES.flatMap((m) => parseSpawns(text, m, buildMap(m, 1337), exists));
  assert.ok(lines.length > 0);
  // every line names one of our maps
  for (const l of text.split("\n")) if (l && !l.startsWith("//")) assert.ok(MAP_NAMES.includes(l.split(",")[0] as never), `map of: ${l}`);
  for (const sd of lines) {
    assert.equal(sd.name, MOB_BY_ID.get(sd.mobId)!.name);
    // C11: the rare species (Stridebeak 1019) carries its own longer delay1; every other line is the field's 5000
    if (sd.boss && MOB_BY_ID.get(sd.mobId)!.bossType === "Mvp") { // W03: the floor's MVP, back 60-120 min after its death (owner's call)
      assert.ok(sd.num === 1 && sd.delay1 === 3_600_000 && sd.delay2 === 3_600_000, `${sd.name} MVP line`);
      continue;
    }
    if (sd.boss) { // C14 mini-bosses: one per field, back 30-60 min after death (+ up to 10 min)
      assert.ok(sd.num === 1 && sd.delay1 >= 1_800_000 && sd.delay1 <= 3_600_000 && sd.delay2 > 0 && sd.delay2 <= 600_000, `${sd.name} mini-boss line`);
      continue;
    }
    assert.equal(respawnDelay(sd, MOB_BY_ID.get(sd.mobId)!.mode, 123456789), RARE_DELAY.get(sd.mobId) ?? 5000);
  }
  assert.deepEqual(parseSpawns(text, "no_such_map", openMap(40, 40), exists), []);
});

test("W01: each field's species (FIELD_MOBS, what the client navigates by) are exactly its spawn lines, one field per species, levels in the band", () => {
  const text = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  const { MAP_INFO } = MAPS;
  const owner = new Map<number, string>();
  for (const f of FIELDS) {
    const lines = parseSpawns(text, f, buildMap(f, 1337), exists);
    const ids = [...new Set(lines.filter((s) => !s.boss).map((s) => s.mobId))].sort();
    assert.deepEqual([...FIELD_MOBS[f].mobs].sort(), ids, `${f}: FIELD_MOBS matches spawns.txt (monster lines)`);
    assert.ok(ids.length >= 3 && ids.length <= 7, `${f}: 3-7 species`);
    assert.ok(lines.filter((s) => s.boss).length <= 1, `${f}: at most one mini-boss`);
    for (const id of ids) {
      assert.ok(!owner.has(id), `${MOB_BY_ID.get(id)!.name} lives on one field only (${owner.get(id)}, ${f})`);
      owner.set(id, f);
      const lv = MOB_BY_ID.get(id)!.level, [lo, hi] = MAP_INFO[f].band!;
      // a band's rare species may stand above it (Stridebeak); none below the band's floor by more than 2
      assert.ok(lv >= lo - 2, `${MOB_BY_ID.get(id)!.name} Lv ${lv} fits ${f} (${lo}-${hi})`);
    }
  }
});

test("W03: each catacomb level's species are its spawn lines, a species on at most two neighbouring levels and on no field, the MVP in B3's hall", () => {
  const text = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  const { MAP_INFO } = MAPS;
  const fieldIds = new Set(FIELDS.flatMap((f) => FIELD_MOBS[f].mobs));
  const levels = new Map<number, number[]>();
  DUNGEONS.forEach((d, n) => {
    const lines = parseSpawns(text, d, buildMap(d, 1337), exists);
    const ids = [...new Set(lines.filter((s) => !s.boss).map((s) => s.mobId))].sort();
    assert.deepEqual([...FIELD_MOBS[d].mobs].sort(), ids, `${d}: FIELD_MOBS matches spawns.txt (monster lines)`);
    assert.ok(ids.length >= 2 && ids.length <= 5, `${d}: 2-5 species`);
    for (const id of ids) {
      assert.ok(!fieldIds.has(id), `${MOB_BY_ID.get(id)!.name} lives in the catacombs only`);
      levels.set(id, [...(levels.get(id) ?? []), n]);
      const lv = MOB_BY_ID.get(id)!.level, [lo] = MAP_INFO[d].band!;
      assert.ok(lv >= lo - 2, `${MOB_BY_ID.get(id)!.name} Lv ${lv} fits ${d}`);
    }
    for (const s of lines) if (!s.boss) assert.ok(s.x >= 0 && s.xs > 0, `${d}: ${s.name} has its own chamber`);
    const bosses = lines.filter((s) => s.boss);
    if (d === MVP_HALL.map) {
      assert.equal(bosses.length, 1);
      assert.deepEqual([bosses[0].mobId, bosses[0].x, bosses[0].y], [3810, MVP_HALL.x, MVP_HALL.y], "Gloopking on its hall cell");
    } else assert.equal(bosses.length, 0, `${d}: no boss`);
  });
  for (const [id, on] of levels) assert.ok(on.length <= 2 && on[on.length - 1] - on[0] <= 1, `${MOB_BY_ID.get(id)!.name} on levels ${on}`);
});

test("npc_parse_mob2: randomize_center_cell picks a centre in x +-(xs-1), x first; a span of 1 stays fixed", () => {
  const sd = { x: 20, y: 22, xs: 5, ys: 3 } as SpawnData;
  const r = scripted([17, 23]);
  assert.deepEqual(spawnCenter(sd, r.fn), { x: 17, y: 23 });
  assert.deepEqual(r.calls, [[16, 24], [20, 24]]);
  const fixedY = scripted([24]);
  assert.deepEqual(spawnCenter({ ...sd, ys: 1 }, fixedY.fn), { x: 24, y: 22 });
  assert.deepEqual(fixedY.calls, [[16, 24]]);
  const off = scripted([]);
  assert.deepEqual(spawnCenter(sd, off.fn, { ...SPAWN_CONF, randomize_center_cell: false }), { x: 20, y: 22 });
  // anywhere (-1,-1): no centre roll
  assert.deepEqual(spawnCenter({ x: -1, y: -1, xs: 0, ys: 0 } as SpawnData, off.fn), { x: -1, y: -1 });
});

test("map_search_freecell: skips the centre, the 5-cell edge band and blocked cells; map-wide keeps map_edge_size", () => {
  const m = openMap(40, 40, [[18, 22]]);
  // (20,20) is the centre -> skipped; (18,22) blocked; (21,19) free
  const r = scripted([20, 20, 18, 22, 21, 19]);
  assert.deepEqual(searchFreeCell(m, 20, 20, 2, 2, 8, r.fn), { x: 21, y: 19 });
  assert.deepEqual(r.calls, [[18, 22], [18, 22], [18, 22], [18, 22], [18, 22], [18, 22]]);
  // edge: x 4 < 5 is out, x 35 = 40 - 5 is still in, 36 is out
  const e = scripted([4, 10, 36, 10, 35, 10]);
  assert.deepEqual(searchFreeCell(m, 33, 10, 4, 0, 8, e.fn), { x: 35, y: 10 });
  // tries run out -> undefined
  const t = scripted([20, 20, 20, 20]);
  assert.equal(searchFreeCell(m, 20, 20, 1, 1, 2, t.fn), undefined);
  // map-wide: x and y in [map_edge_size, size - map_edge_size - 1] = [15, 24]
  const w = scripted([15, 24]);
  assert.deepEqual(searchFreeCell(m, -1, -1, -1, -1, 50, w.fn), { x: 15, y: 24 });
  assert.deepEqual(w.calls, [[15, 24], [15, 24]]);
  // no range: just the centre
  assert.deepEqual(searchFreeCell(m, 7, 7, 0, 0, 8, scripted([]).fn), { x: 7, y: 7 });
  assert.equal(searchFreeCell(m, 18, 22, 0, 0, 8, scripted([]).fn), undefined);
});

test("mob_spawn: centre with chance 1/(xs*ys), else 8 area tries, else centre, else 50 map-wide tries", () => {
  const m = openMap(40, 40, [[10, 10]]);
  const sd = { x: 20, y: 20, xs: 3, ys: 3, boss: false } as SpawnData;
  // rnd_value(1, 9) = 1 -> the free centre
  const hit = scripted([1]);
  assert.deepEqual(mobSpawnCell(m, sd, { x: 20, y: 20 }, hit.fn), { x: 20, y: 20 });
  assert.deepEqual(hit.calls, [[1, 9]]);
  // rnd_value(1, 9) = 2 -> area search within xs-1 = 2 of the centre
  const miss = scripted([2, 22, 18]);
  assert.deepEqual(mobSpawnCell(m, sd, { x: 20, y: 20 }, miss.fn), { x: 22, y: 18 });
  assert.deepEqual(miss.calls, [[1, 9], [18, 22], [18, 22]]);
  // fixed cell (xs = ys = 1): rnd_value(1, 1) always 1 -> stands on it, no search
  const fixed = scripted([1]);
  assert.deepEqual(mobSpawnCell(m, { ...sd, xs: 1, ys: 1 }, { x: 20, y: 20 }, fixed.fn), { x: 20, y: 20 });
  // centre blocked, every area try fails (all land on the centre) -> 50 map-wide tries
  const blocked = scripted([1, ...Array(16).fill(10), 16, 17]);
  assert.deepEqual(mobSpawnCell(m, sd, { x: 10, y: 10 }, blocked.fn), { x: 16, y: 17 });
  assert.equal(blocked.left(), 0);
  // centre free but every area try fails -> the centre
  const back = scripted([5, ...Array(16).fill(20)]);
  assert.deepEqual(mobSpawnCell(m, sd, { x: 20, y: 20 }, back.fn), { x: 20, y: 20 });
  // anywhere (-1,-1, spans 0): no centre roll, straight to a map-wide search (8 tries)
  const any = scripted([15, 16]);
  assert.deepEqual(mobSpawnCell(m, { ...sd, x: -1, y: -1, xs: 0, ys: 0 }, { x: -1, y: -1 }, any.fn), { x: 15, y: 16 });
  assert.deepEqual(any.calls, [[15, 24], [15, 24]]);
  // nothing anywhere: undefined (retry after mob_respawn_time)
  const full = openMap(40, 40);
  full.blocked.fill(1);
  const none = scripted([2, ...Array(16).fill(19), ...Array(100).fill(15)]);
  assert.equal(mobSpawnCell(full, sd, { x: 20, y: 20 }, none.fn), undefined);
  assert.equal(none.left(), 0);
  // a boss_monster line on one fixed cell skips the search entirely (no roll)
  assert.deepEqual(mobSpawnCell(m, { ...sd, xs: 1, ys: 1, boss: true }, { x: 20, y: 20 }, scripted([]).fn), { x: 20, y: 20 });
});

test("mob_setdelayspawn: delay1 + rnd%delay2, rate per type (divide by 100 first), floor 1000 ms", () => {
  const normal = MOB_BY_ID.get(1002)!.mode; // 0x83
  assert.equal(respawnDelay({ delay1: 5000, delay2: 0 }, normal, 987654321), 5000);
  assert.equal(respawnDelay({ delay1: 3600000, delay2: 600000 }, normal, 1234567), 3600000 + 34567);
  // mob_spawn_delay 50: 5050/100*50 = 50*50 = 2500 (not 2525)
  assert.equal(respawnDelay({ delay1: 5050, delay2: 0 }, normal, 0, { ...SPAWN_CONF, mob_spawn_delay: 50 }), 2500);
  // 1500 at 50% = 750 -> floor 1000
  assert.equal(respawnDelay({ delay1: 1500, delay2: 0 }, normal, 0, { ...SPAWN_CONF, mob_spawn_delay: 50 }), 1000);
  const plant = MD.IGNOREMELEE | MD.IGNOREMAGIC | MD.IGNORERANGED | MD.IGNOREMISC;
  const rates = { ...SPAWN_CONF, mob_spawn_delay: 300, plant_spawn_delay: 200, boss_spawn_delay: 50 };
  assert.equal(respawnDelay({ delay1: 360000, delay2: 0 }, plant, 0, rates), 720000);
  assert.equal(respawnDelay({ delay1: 360000, delay2: 0 }, MD.IGNOREMELEE, 0, rates), 1080000); // one bit isn't a plant
  assert.equal(respawnDelay({ delay1: 3600000, delay2: 0 }, MD.STATUSIMMUNE | plant, 0, rates), 1800000); // boss first
});

test("passive ground: no aggressive spawn area near a warp, an arrival cell, any NPC or quest navi cell, on any field", async () => {
  const { NPCS } = await import("../content/npcs.ts");
  const { QUEST_INFO } = await import("../content/quest_db.ts");
  const MARGIN = 8; // cells between an aggressive area's edge and any place a quest, a gate or an NPC sends a climber to
  const text = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  let checked = 0, collected = 0;
  for (const f of HUNT_MAPS) {
  const places: [string, number, number][] = [];
  for (const w of WARPS) { if (w.map === f) places.push([`warp ${w.name}`, w.x, w.y]); if (w.to.map === f) places.push([`arrival of ${w.name}`, w.to.x, w.to.y]); }
  for (const n of NPCS) if (n.map === f) places.push([n.name, n.x, n.y]);
  for (const [id, info] of QUEST_INFO) if (info.Navi?.map === f) places.push([`quest ${id} navi`, info.Navi.x, info.Navi.y]);
  collected += places.length;
  const sd = parseSpawns(text, f, buildMap(f, 1337), exists);
  for (const s of sd) {
    if (!(MOB_BY_ID.get(s.mobId)!.mode & MD.AGGRESSIVE)) continue;
    checked++;
    if (s.x < 0) assert.fail(`aggressive ${s.name} spawns anywhere on the map`);
    for (const [what, px, py] of places) {
      const near = px >= s.x - s.xs - MARGIN && px <= s.x + s.xs + MARGIN && py >= s.y - s.ys - MARGIN && py <= s.y + s.ys + MARGIN;
      assert.ok(!near, `${f}: aggressive ${s.name} area (${s.x},${s.y} +-${s.xs},${s.ys}) is within ${MARGIN} cells of ${what} (${px},${py})`);
    }
  }
  }
  assert.ok(collected > 15, "warps, NPCs and navi cells were collected");
  assert.ok(checked >= 2, "the roster has aggressive species outside the passive zone");
});
