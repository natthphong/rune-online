// 2.9.0 end-to-end check of the Tower rule on floors 1-3 (shared/tower.ts, shared/wilds.ts, server/src/tower.ts), dev server only
// (planted character, Msg.devBoss). One sturdy climber starts on the Sunken Mire with the wardens' seal:
//   floor 1  the Ascent Stair is SEALED while floor 1's guardian stands; into the Greenhollow Wilds (f1_field05); the guardian Gloopking
//            is somewhere else on it (>= 28 cells, Msg.tower hint); the bot finds it by the hint only, kills it (dev), tower_f1 is set;
//            back to the Mire, the Ascent Stair now lets it up to floor 2;
//   floor 2  to the Sunscour Ruins (f2_field03) through Cinderwatch Heights; Devo found by the hint, killed, tower_f2; the stair to 3 opens;
//   floor 3  up to Witherwick; Morrowgast found by the hint, killed, tower_f3;
//   scaling  the three guardians' max HP as the client saw them: floor 1 < floor 2 < floor 3.
//   pnpm --filter client floors [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg, type AnnounceEvent, type DevBossMsg, type NpcMesEvent, type TowerEvent } from "../../shared/protocol.ts";
import { F1_WILD, F2_TOWN, F2_WILD, F3_MAP, MIRE, MIRE_ASCENT, MIRE_ASCENT_IN, MIRE_WILDS, buildMap, type MapName } from "../../shared/maps.ts";
import { TOWER, hintText } from "../../shared/tower.ts";
import { distance, walkable } from "../../shared/map.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 720 s"), 720_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(50); } };

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const token = await login(url, "floors_bot");
const NAME = "Climber";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "F", hair: 1 });
await db.query("UPDATE characters SET job = 'Swordman', level = 99, vit = 99, agi = 70, str = 60, hp = NULL, last_map = $2, x = $3, y = $4 WHERE id = $1",
  [char.id, MIRE, MIRE_WILDS.x + 3, MIRE_WILDS.y]);
await db.query("DELETE FROM char_reg_num WHERE char_id = $1", [char.id]).catch(() => {});
const room = await botRoom(url, token, char, MIRE as MapName);
const mes: string[] = [], announces: string[] = [], notices: string[] = [], towers: TowerEvent[] = [];
room.onMessage(Msg.npcMes, (m: NpcMesEvent) => mes.push(m.text));
room.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => room.send(Msg.npcClose, { npc: m.npc }));
room.onMessage(Msg.npcNextBtn, (m: { npc: string }) => room.send(Msg.npcNext, { npc: m.npc }));
room.onMessage(Msg.announce, (m: AnnounceEvent) => announces.push(m.text));
room.onMessage(Msg.notice, (m: { text: string }) => notices.push(m.text));
room.onMessage(Msg.tower, (m: TowerEvent) => towers.push(m));
room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) fail(`the Lv 99 climber died on ${room.map}`); });
room.onMessage("*", () => {});
const S = () => room.state as any;
const me = () => S().players?.get(room.sessionId);
const cellOf = (e: any) => ({ x: Math.round(e.x), y: Math.round(e.y) });
const dev = (m: DevBossMsg) => room.send(Msg.devBoss, m);
await until(() => me() && room.map === MIRE, 8000, "my character on the Sunken Mire");
dev({ op: "var", id: "-", move: "f1_seal", dmg: 1 }); // Warden Orrin's seal (the dungeon bot plays that quest)
await wait(500);

const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [1, 1, 0, -1, -1, -1, 0, 1]; // Msg.tower dir: 0 = south (+y), 2 = east
const hp: number[] = [];
/** On a floor map: the guardian is elsewhere; walk by the hint only until it is in sight; kill it (dev); the floor is cleared. */
async function clearFloor(n: number) {
  const f = TOWER[n - 1];
  await until(() => room.map === f.map && me(), 10_000, `on ${f.map}`);
  towers.length = 0;
  const first = await until(() => towers.find((t) => t.floor === n), 8000, `no Msg.tower on floor ${n}`);
  if (!first.alive || first.cleared) fail(`floor ${n} first hint: alive ${first.alive}, cleared ${first.cleared}`);
  if (first.dist < 20) fail(`floor ${n}: the guardian is only ${first.dist} cells away on arrival (random spots keep 30 from the arrival)`);
  say(`floor ${n} (${f.map}): ${first.boss} is ${hintText(first)} (${first.dist} cells)`);
  const map = buildMap(f.map as MapName, S().seed), last = () => towers[towers.length - 1];
  const found = () => [...S().monsters.entries()].find(([, m]: any) => m.mobId === f.guardian && !m.dead && distance(Math.round(m.x) - cellOf(me()).x, Math.round(m.y) - cellOf(me()).y) <= 9) as [string, any] | undefined;
  const tHunt = Date.now();
  let legs = 0;
  while (!found() && last().dist > 7) {
    if (Date.now() - tHunt > 150_000) fail(`floor ${n}: did not reach the guardian in 150 s (${hintText(last())})`);
    const h = last(), c = cellOf(me()), step = Math.min(12, h.dist - 5);
    let goal: { x: number; y: number } | undefined;
    for (let r = 0; r < 10 && !goal; r++) for (let dy = -r; dy <= r && !goal; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = c.x + DX[h.dir] * step + dx, y = c.y + DY[h.dir] * step + dy;
      if (walkable(map, x, y)) { goal = { x, y }; break; }
    }
    if (!goal) fail("no walkable cell along the hint");
    await walkNear(room, () => goal, 2, 12_000);
    legs++;
    const k = towers.length;
    await until(() => towers.length > k, 4000, "no fresh hint");
  }
  const [gid, g] = await until(() => found(), 20_000, `floor ${n}: the guardian is not where the hint led`);
  hp.push(g.maxHp);
  say(`floor ${n}: found ${f.title}'s guardian at ${Math.round(g.x)},${Math.round(g.y)} after ${legs} legs / ${Math.round((Date.now() - tHunt) / 1000)} s (HP ${g.maxHp})`);
  announces.length = notices.length = 0;
  dev({ op: "kill", id: gid });
  await until(() => announces.some((a) => a.includes(`Floor ${n}:`) && a.includes("has fallen")), 5000, `floor ${n}: no server-wide announce`);
  await until(() => notices.some((t) => t.includes(`Floor ${n} cleared`)), 5000, `floor ${n}: no "cleared" notice`);
  let saved = 0; // write-through: the row lands a moment after the kill
  for (let i = 0; i < 30 && saved !== 1; i++) {
    const { rows } = await db.query("SELECT * FROM char_reg_num WHERE char_id = $1", [char.id]);
    const row = rows.find((r: any) => Object.values(r).includes(f.clearVar));
    saved = Number(row?.value ?? 0);
    if (saved !== 1) await wait(200);
  }
  if (saved !== 1) fail(`floor ${n}: ${f.clearVar} not saved`);
  say(`OK floor ${n}: guardian down, ${f.clearVar} = 1 in the database`);
}

// ---- floor 1: the Ascent Stair is sealed while Gloopking stands ----
mes.length = 0;
if (!(await walkNear(room, () => MIRE_ASCENT_IN, 1, 40_000))) fail("could not reach the Ascent Stair");
room.send(Msg.move, { x: MIRE_ASCENT.x, y: MIRE_ASCENT.y });
await until(() => mes.some((t) => t.includes("guardian still stands")), 8000, `the Ascent Stair did not say the guardian stands (mes: ${mes.slice(-2).join(" | ")})`);
await wait(800);
if (room.map !== MIRE) fail("the Ascent Stair let an uncleared climber up");
say("OK floor 1: the Ascent Stair is sealed while the floor's guardian stands");
await room.travel(F1_WILD as MapName, 90_000);
await clearFloor(1);
// back down to the Mire and up the stair
await room.travel(F2_TOWN as MapName, 180_000);
say(`OK floor 1 -> 2: the Ascent Stair let the climber up to ${room.map}`);
await room.travel(F2_WILD as MapName, 180_000);
await clearFloor(2);
await room.travel(F3_MAP as MapName, 240_000);
say("OK floor 2 -> 3: the stair to floor 3 opened");
await clearFloor(3);
if (!(hp[0] < hp[1] && hp[1] < hp[2])) fail(`guardian HP not rising: ${hp}`);
say(`OK scaling: guardian HP floor 1 ${hp[0]} < floor 2 ${hp[1]} < floor 3 ${hp[2]}`);

await room.leave();
await deleteChar(url, token, char);
await db.end();
console.log("PASS: floors bot");
process.exit(0);
