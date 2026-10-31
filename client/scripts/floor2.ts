// 2.5.0 probe: floor 2 of the Tower. A planted Base Lv 29 character (Warden Orrin's seal quest 1018 done, f1_seal = 1) is turned away by the
// Ascent Stair (the level gate, Base Lv 25), then planted at Lv 30 it walks Hearthmoor -> south gate -> Sunken Mire -> the stair -> Lanternrest,
// reports to Sentinel Corwin ("A Light on the Landing"), takes "Embers on the Terraces", walks through the west gate to the Emberlit
// Terraces and kills 6 Ashbeetles, back in Lanternrest turns the quest in (which offers the vault) and uses the warp crystal to Hearthmoor.
// Own account (floor2_bot), the character is deleted at the end; dev schema only (the characters are planted straight in the database).
//   pnpm --filter client floor2 [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg } from "../../shared/protocol.ts";
import { F2_FIELD1, F2_TOWN, MAP_INFO, MIRE, TOWN } from "../../shared/maps.ts";
import { F2_GATE_LEVEL, F2_VAR, NPC2, Q2, SPOT2 } from "../../shared/content/f2/chapter2.ts";
import { SEAL, SEAL_VAR } from "../../shared/content/f1/stair.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear, type BotRoom } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 420 s"), 420_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) fail(`timeout: ${what}`); await wait(50); }
}

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const token = await login(url, "floor2_bot");
const NAME = "TowerProbe";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) if (c.name === NAME) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "M", hair: 1 });
const plant = (level: number) => db.query("UPDATE characters SET level = $2, str = 99, agi = 60, vit = 80, dex = 70, hp = NULL WHERE id = $1", [char.id, level]);
await plant(F2_GATE_LEVEL - 1);
await db.query("INSERT INTO quest (char_id, quest_id, state) VALUES ($1, $2, 2)", [char.id, SEAL]);
await db.query(`INSERT INTO char_reg_num (char_id, "key", value) VALUES ($1, $2, 1)`, [char.id, SEAL_VAR]);
const questRow = async (id: number) => (await db.query("SELECT state, count1 FROM quest WHERE char_id = $1 AND quest_id = $2", [char.id, id])).rows[0];
const varOf = async (key: string) => Number((await db.query(`SELECT value FROM char_reg_num WHERE char_id = $1 AND "key" = $2`, [char.id, key])).rows[0]?.value ?? 0);

let room!: BotRoom;
let dialog: string[] = [], closed = false;
async function enter() {
  room = await botRoom(url, token, char);
  dialog = [];
  // dialogs are answered like a player who takes the first option: Next, choice 1, Close
  room.onMessage(Msg.npcMes, (m: { text: string }) => { dialog.push(m.text); });
  room.onMessage(Msg.npcNextBtn, (m: { npc: string }) => { setTimeout(() => room.send(Msg.npcNext, { npc: m.npc }), 60); });
  room.onMessage(Msg.npcMenuList, (m: { npc: string }) => { setTimeout(() => room.send(Msg.npcMenu, { npc: m.npc, choice: 1 }), 60); });
  room.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => { closed = true; setTimeout(() => room.send(Msg.npcClose, { npc: m.npc }), 60); });
  room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) fail(`died on ${room.map}`); });
  room.onMessage("*", () => {});
  await until(() => !!(room.state as any).players?.get(room.sessionId), 8000, "my character in the room");
}
const S = () => room.state as any;
const me = () => S().players.get(room.sessionId);
const here = () => ({ x: Math.round(me().x), y: Math.round(me().y) });
async function talkTo(id: string, spot: { x: number; y: number }, warpsTo?: string) {
  if (!(await walkNear(room, () => spot, 3, 40_000))) fail(`could not reach ${id} from ${JSON.stringify(here())}`);
  dialog = []; closed = false;
  room.send(Msg.npc, { id });
  await until(() => (warpsTo ? room.map === warpsTo : closed), 10_000, `${id}'s ${warpsTo ? "warp to " + warpsTo : "dialog"}`);
  await wait(600);
}

// 1) Base Lv 24: the Ascent Stair turns the climber away (wardens' seal done, level short)
await enter();
if (room.map !== TOWN) fail(`started on ${room.map}`);
await room.travel(MIRE, 120_000);
say(`${MIRE}: on the Sunken Mire at ${JSON.stringify(here())}, Base Lv ${F2_GATE_LEVEL - 1}, heading for the Ascent Stair`);
let blocked = false;
try { await room.travel(F2_TOWN, 25_000); } catch { blocked = true; }
if (!blocked || room.map !== MIRE) fail(`the stair let a Lv ${F2_GATE_LEVEL - 1} climber through (on ${room.map})`);
if (!dialog.some((l) => l.includes(`Base Lv ${F2_GATE_LEVEL}`))) fail(`no level message: ${dialog.join(" / ")}`);
if ((await varOf(F2_VAR)) !== 0 || (await questRow(Q2.ARRIVE))) fail("the turned-away climber got f2_visit / quest 2001");
say(`${MIRE}: the Ascent Stair said no (${dialog.find((l) => l.includes("Base Lv"))?.replace(/\^[0-9a-f]{6}/g, "").slice(0, 70)})`);
await room.leave();
await wait(600);

// 2) Base Lv 30: up to Lanternrest
await plant(F2_GATE_LEVEL);
await enter();
await room.travel(F2_TOWN, 120_000);
await until(() => !!me(), 5000, `on ${F2_TOWN}`);
say(`${F2_TOWN} (${MAP_INFO[F2_TOWN].title}): up the stair, standing at ${JSON.stringify(here())}`);
await until(async () => (await varOf(F2_VAR)) === 1, 3000, "f2_visit not set");
if ((await questRow(Q2.ARRIVE))?.state !== 1) fail(`quest 2001 not held on arrival: ${JSON.stringify(await questRow(Q2.ARRIVE))}`);
if (S().monsters.size) fail("monsters in Lanternrest");

// 3) Sentinel Corwin: report, then the Terraces hunt is offered and taken
await talkTo(NPC2.sentinel, SPOT2.sentinel);
if ((await questRow(Q2.ARRIVE))?.state !== 2) fail(`2001 not completed: ${dialog.join(" / ")}`);
if ((await questRow(Q2.TERRACES))?.state !== 1) fail(`2002 not held: ${dialog.join(" / ")}`);
say(`${F2_TOWN}: Corwin paid "A Light on the Landing" and gave "Embers on the Terraces" (${dialog.find((l) => l.includes("Ashbeetles"))?.replace(/\^[0-9a-f]{6}|<[^>]*>/g, "").slice(0, 60)}...)`);

// 4) the Terraces: 6 Ashbeetles
await room.travel(F2_FIELD1, 120_000);
await until(() => !!me() && S().monsters.size > 0, 6000, "monsters on the Terraces");
say(`${F2_FIELD1} (${MAP_INFO[F2_FIELD1].title}): at ${JSON.stringify(here())}, ${S().monsters.size} monsters`);
const ASHBEETLE = 1128;
for (let t = Date.now(); (await questRow(Q2.TERRACES))?.count1 < 6;) {
  if (Date.now() - t > 240_000) fail(`6 Ashbeetles not down after 240 s (${JSON.stringify(await questRow(Q2.TERRACES))})`);
  const p = me();
  if (p.sitting) room.send(Msg.sit);
  const live = [...S().monsters.entries()].filter(([, m]: any) => !m.dead && m.mobId === ASHBEETLE).sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (live.length) room.send(Msg.attack, { id: live[0][0] });
  await wait(1500);
}
say(`${F2_FIELD1}: 6 Ashbeetles down (quest row ${JSON.stringify(await questRow(Q2.TERRACES))})`);

// 5) back in Lanternrest: turn it in (the vault is offered and taken), then the warp crystal down to Hearthmoor
await room.travel(F2_TOWN, 120_000);
await until(() => !!me(), 5000, `back on ${F2_TOWN}`);
await talkTo(NPC2.sentinel, SPOT2.sentinel);
if ((await questRow(Q2.TERRACES))?.state !== 2) fail(`2002 not completed: ${dialog.join(" / ")}`);
if ((await questRow(Q2.VAULT))?.state !== 1) fail(`2003 not held: ${dialog.join(" / ")}`);
say(`${F2_TOWN}: "Embers on the Terraces" paid, "Embers of the Vault" taken`);
await talkTo(NPC2.crystal, SPOT2.crystal, TOWN);
await until(() => !!me(), 5000, `on ${TOWN}`);
say(`${TOWN} (${MAP_INFO[TOWN].title}): the warp crystal took us home, standing at ${JSON.stringify(here())}`);

await room.leave();
await wait(500);
await deleteChar(url, token, char);
await db.end();
say("OK: Ascent Stair level gate (Lv 29 refused, Lv 30 up), f2_visit + 2001 on arrival, Corwin's reports, 6 Ashbeetles on the Terraces, 2003 taken, warp crystal back to Hearthmoor");
process.exit(0);
