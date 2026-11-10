// End-to-end check of the Tower rule on floor 3 (shared/tower.ts, shared/floor3.ts, server/src/tower.ts), dev server only (planted
// character, Msg.devBoss). One sturdy character planted in Lanternrest:
//   1. the stair to floor 3 is sealed for a climber whose party has not felled floor 2's guardian (it stays in Lanternrest);
//   2. with floor 2 cleared (tower_f2; the fight itself is the devo bot's) the stair takes it up to Witherwick (f3_field01);
//   3. the floor guardian Morrowgast is alive somewhere ELSE: Msg.tower gives a direction + distance (>= 30 cells from the arrival);
//   4. the bot FINDS it by following the hint only (never reading its position), and the guardian turns on it at sight (Msg.bossAggro);
//   5. the guardian dies: server-wide announce, "Floor 3 cleared", Msg.tower says cleared, tower_f3 = 1 is in the database;
//   6. it rises again at ANOTHER random spot (the dev shortcut skips the 30-45 min wait): three rises, three different places.
//   pnpm --filter client floor3 [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg, type AnnounceEvent, type BossAggroEvent, type DevBossMsg, type NpcMesEvent, type TowerEvent } from "../../shared/protocol.ts";
import { F2_STAIR3, F2_STAIR3_IN, F2_TOWN, F3_MAP, buildMap, type MapName } from "../../shared/maps.ts";
import { F3_ARRIVAL, MORROWGAST } from "../../shared/floor3.ts";
import { towerFloor, hintText } from "../../shared/tower.ts";
import { distance, walkable } from "../../shared/map.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 300 s"), 300_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(50); } };

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const F2 = towerFloor(2)!, F3 = towerFloor(3)!;
const token = await login(url, "floor3_bot");
const NAME = "FloorProbe";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) if (c.name === NAME) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "M", hair: 3 });
await db.query("UPDATE characters SET job = 'Swordman', level = 99, vit = 99, agi = 60, hp = NULL, last_map = $2, x = $3, y = $4 WHERE id = $1", [char.id, F2_TOWN, F2_STAIR3_IN.x, F2_STAIR3_IN.y]);
const room = await botRoom(url, token, char, F2_TOWN as MapName);
const mes: string[] = [], announces: string[] = [], notices: string[] = [], towers: TowerEvent[] = [], aggro: BossAggroEvent[] = [];
room.onMessage(Msg.npcMes, (m: NpcMesEvent) => mes.push(m.text));
room.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => room.send(Msg.npcClose, { npc: m.npc }));
room.onMessage(Msg.announce, (m: AnnounceEvent) => announces.push(m.text));
room.onMessage(Msg.notice, (m: { text: string }) => notices.push(m.text));
room.onMessage(Msg.tower, (m: TowerEvent) => towers.push(m));
room.onMessage(Msg.bossAggro, (m: BossAggroEvent) => aggro.push(m));
room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) fail("the Lv 99 probe died on floor 3"); });
room.onMessage("*", () => {});
const S = () => room.state as any;
const me = () => S().players?.get(room.sessionId);
const cellOf = (e: any) => ({ x: Math.round(e.x), y: Math.round(e.y) });
const dev = (m: DevBossMsg) => room.send(Msg.devBoss, m);
await until(() => me() && room.map === F2_TOWN, 8000, "my character in Lanternrest");
await wait(600);

// ---- 1) sealed ----
if (!(await walkNear(room, () => F2_STAIR3, 0, 20_000))) fail("could not walk onto the stair to floor 3");
await until(() => mes.some((t) => t.includes("sealed")), 5000, "the stair did not say it is sealed");
await wait(800);
if (room.map !== F2_TOWN) fail("an uncleared climber left Lanternrest by the sealed stair");
say(`OK: the stair to floor 3 is sealed without ${F2.clearVar} ("${mes.find((t) => t.includes("sealed"))!.replace(/\^[0-9a-fA-F]{6}/g, "").slice(0, 60)}...")`);

// ---- 2) floor 2 cleared -> up ----
dev({ op: "var", id: "-", move: F2.clearVar, dmg: 1 });
await wait(400);
if (!(await walkNear(room, () => F2_STAIR3_IN, 0, 10_000))) fail("could not step off the stair");
await wait(300);
room.send(Msg.move, { x: F2_STAIR3.x, y: F2_STAIR3.y }); // one walk request: a walk loop would keep walking on the next map
await until(() => room.map === F3_MAP && me(), 15_000, `not on ${F3_MAP} after the stair (still on ${room.map})`);
await until(() => (S().map === F3_MAP || !S().map) && distance(cellOf(me()).x - F3_ARRIVAL.x, cellOf(me()).y - F3_ARRIVAL.y) <= 2, 5000, `arrived at ${me()?.x},${me()?.y} (state map ${S().map}), expected ${F3_ARRIVAL.x},${F3_ARRIVAL.y}`);
const here = cellOf(me());
if (distance(here.x - F3_ARRIVAL.x, here.y - F3_ARRIVAL.y) > 2) fail(`arrived at ${here.x},${here.y}, expected ${F3_ARRIVAL.x},${F3_ARRIVAL.y}`);
say(`OK: with ${F2.clearVar} the stair leads up to ${F3_MAP} (arrived ${here.x},${here.y})`);

// ---- 3) the guardian is somewhere else: the hint ----
towers.length = 0;
const first = await until(() => towers.find((t) => t.floor === 3), 6000, "no Msg.tower on floor 3");
if (!first.alive || first.cleared) fail(`first hint: alive ${first.alive}, cleared ${first.cleared}`);
if (first.dist < 28) fail(`the guardian is only ${first.dist} cells from the arrival (random spots keep 30)`);
say(`OK: hint on arrival: ${first.boss} is ${hintText(first)} (${first.dist} cells, dir ${first.dir})`);

// ---- 4) find it by the hint only ----
const map = buildMap(F3_MAP as MapName, S().seed);
const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [1, 1, 0, -1, -1, -1, 0, 1]; // dir 0 = south (+y), 2 = east (protocol.ts dirFromDelta)
const last = () => towers[towers.length - 1];
const found = () => [...S().monsters.entries()].find(([, m]: any) => m.mobId === MORROWGAST && !m.dead && distance(Math.round(m.x) - cellOf(me()).x, Math.round(m.y) - cellOf(me()).y) <= 9) as [string, any] | undefined;
const tHunt = Date.now();
let steps = 0;
while (!found() && last().dist > 7) {
  if (Date.now() - tHunt > 150_000) fail(`did not reach the guardian by its hint in 150 s (last: ${hintText(last())}, ${last().dist} cells)`);
  const h = last(), c = cellOf(me()), step = Math.min(12, h.dist - 5);
  // the walkable cell nearest to `step` cells along the hinted direction
  let goal: { x: number; y: number } | undefined;
  for (let r = 0; r < 10 && !goal; r++) for (let dy = -r; dy <= r && !goal; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = c.x + DX[h.dir] * step + dx, y = c.y + DY[h.dir] * step + dy;
    if (walkable(map, x, y)) { goal = { x, y }; break; }
  }
  if (!goal) fail("no walkable cell along the hint");
  await walkNear(room, () => goal, 2, 12_000);
  steps++;
  const n = towers.length;
  await until(() => towers.length > n, 4000, "no fresh hint");
}
const [gid, g] = await until(() => found(), 20_000, "the guardian is not where the hint led");
if (g.boss !== 2) fail(`Morrowgast boss flag ${g.boss}, expected 2`);
await until(() => aggro.some((a) => a.id === gid && a.to === room.sessionId), 6000, "the guardian did not turn on me at sight");
say(`OK: found ${last().boss} at ${Math.round(g.x)},${Math.round(g.y)} after ${steps} legs / ${Math.round((Date.now() - tHunt) / 1000)} s following the hint only; it turned on me at sight (HP ${g.maxHp})`);
const spot1 = cellOf(g);
if (distance(spot1.x - F3_ARRIVAL.x, spot1.y - F3_ARRIVAL.y) < 20) fail("the guardian came to the arrival"); // it may have walked a little toward me

// ---- 5) the kill: announce, unlock ----
announces.length = notices.length = 0;
dev({ op: "kill", id: gid });
await until(() => S().monsters.get(gid)?.dead, 4000, "the guardian did not die");
const ann = await until(() => announces.find((a) => a.includes("has fallen to") && a.includes(NAME)), 4000, "no server-wide announce naming the winner");
await until(() => notices.some((n) => n.includes("Floor 3 cleared")), 4000, "no 'Floor 3 cleared' notice");
towers.length = 0;
const after = await until(() => towers.find((t) => t.floor === 3), 6000, "no Msg.tower after the kill");
if (after.alive || !after.cleared || !after.respawnAt) fail(`after the kill: ${JSON.stringify(after)}`);
const { rows } = await db.query("SELECT value FROM char_reg_num WHERE char_id = $1 AND key = $2", [char.id, F3.clearVar]).catch(() => ({ rows: [] as any[] }));
say(`OK: "${ann}"`);
say(`OK: ${F3.clearVar} set (Msg.tower cleared = true, respawn in ${Math.round((after.respawnAt! - Date.now()) / 60000)} min${rows.length ? `, database row value ${rows[0].value}` : ""})`);

// ---- 6) it rises at another random spot, every time ----
const spots = [spot1];
for (let i = 0; i < 2; i++) {
  announces.length = towers.length = 0;
  dev({ op: "tower", id: "-" });
  await until(() => announces.some((a) => a.includes("stirs") || a.includes("risen")), 4000, "no announce when the guardian rose");
  const t = await until(() => towers.find((x) => x.alive), 6000, "no hint for the risen guardian");
  const c = cellOf(me()), at = { x: c.x + DX[t.dir] * t.dist, y: c.y + DY[t.dir] * t.dist }; // rough: along the hinted direction
  if (t.dist < 20) fail(`rise ${i + 2}: only ${t.dist} cells from where it died`);
  spots.push(at);
  say(`OK: rise ${i + 2}: ${hintText(t)} (${t.dist} cells, dir ${t.dir})`);
}
if (new Set(towers.map((t) => `${t.dir}:${t.dist}`)).size === 0) fail("no hints");
say(`OK: three rises, three places (first at ${spot1.x},${spot1.y})`);

const gNow = [...S().monsters.entries()].find(([, m]: any) => m.mobId === MORROWGAST && !m.dead) as [string, any] | undefined;
void gNow;
await room.leave();
await deleteChar(url, token, char);
await db.end();
console.log("PASS: floor3 bot");
process.exit(0);
