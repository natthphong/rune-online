// Playthrough: floor 2 chain end to end ending at the dungeon boss (see floor2.ts for the first part; this one plants Lv 60).
// (floor2 probe notes) floor 2 of the Tower. A planted Base Lv 29 character (Warden Orrin's seal quest 1018 done, f1_seal = 1) is turned away by the
// Ascent Stair (the level gate, Base Lv 25), then planted at Lv 30 it walks Hearthmoor -> south gate -> Sunken Mire -> the stair -> Lanternrest,
// reports to Sentinel Corwin ("A Light on the Landing"), takes "Embers on the Terraces", walks through the west gate to the Emberlit
// Terraces and kills 6 Ashbeetles, back in Lanternrest turns the quest in (which offers the vault) and uses the warp crystal to Hearthmoor.
// Own account (floor2_bot), the character is deleted at the end; dev schema only (the characters are planted straight in the database).
//   pnpm --filter client playthrough [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg } from "../../shared/protocol.ts";
import { F2_BOSS_HALL, F2_DUN, F2_FIELD1, F2_TOWN, MAP_INFO, MIRE, TOWN } from "../../shared/maps.ts";
import { F2_GATE_LEVEL, F2_VAR, F2_VAULT_VAR, NPC2, Q2, SPOT2 } from "../../shared/content/f2/chapter2.ts";
import { SEAL, SEAL_VAR } from "../../shared/content/f1/stair.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear, type BotRoom } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 900 s"), 900_000);
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

const token = await login(url, "playthru_bot");
const NAME = "Playthrough";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) if (c.name === NAME) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "M", hair: 1 });
const plant = (level: number) => db.query("UPDATE characters SET job = 'Swordman', job_level = 50, level = $2, str = 99, agi = 60, vit = 99, dex = 70, hp = NULL WHERE id = $1", [char.id, level]);
await plant(75);
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
  room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId && process.argv.includes("--fight")) fail(`died on ${room.map} at ${JSON.stringify(here())}; near: ${JSON.stringify([...S().monsters.values()].filter((x: any) => Math.hypot(x.x - me().x, x.y - me().y) < 8).map((x: any) => x.name ?? x.mobId))}`); });
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

await db.query("INSERT INTO char_reg_num (char_id, \"key\", value) VALUES ($1, $2, 1)", [char.id, F2_VAR]);
await db.query("INSERT INTO quest (char_id, quest_id, state) VALUES ($1, $2, 1)", [char.id, Q2.ARRIVE]);

await enter();
await room.travel(F2_TOWN, 120_000);
await until(() => !!me(), 5000, `on ${F2_TOWN}`);
await talkTo(NPC2.sentinel, SPOT2.sentinel);
if ((await questRow(Q2.TERRACES))?.state !== 1) fail(`2002 not held: ${dialog.join(" / ")}`);
await room.travel(F2_FIELD1, 120_000);
await until(() => !!me() && S().monsters.size > 0, 6000, "monsters on the Terraces");
for (let t = Date.now(); (await questRow(Q2.TERRACES))?.count1 < 6;) {
  if (Date.now() - t > 240_000) fail("6 Ashbeetles not down");
  const p = me(); if (p.sitting) room.send(Msg.sit);
  const live = [...S().monsters.entries()].filter(([, m]: any) => !m.dead && m.mobId === 1128).sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (live.length) room.send(Msg.attack, { id: live[0][0] });
  await wait(1500);
}
say("Terraces: 6 Ashbeetles down");
await room.travel(F2_TOWN, 120_000);
await until(() => !!me(), 5000, "back in Lanternrest");
await talkTo(NPC2.sentinel, SPOT2.sentinel);
if ((await questRow(Q2.VAULT))?.state !== 1) fail(`2003 not held: ${dialog.join(" / ")}`);
say("Corwin: 2002 paid, 2003 taken");
await room.travel(F2_DUN, 240_000);
await until(() => !!me(), 5000, `on ${F2_DUN}`);
say(`${F2_DUN} (${MAP_INFO[F2_DUN].title}): at ${JSON.stringify(here())}, ${S().monsters.size} monsters`);
// walk south in legs, clearing whatever stands within 5 cells (a player would fight on the way too)
for (let leg = 0; leg < 40 && here().y < F2_BOSS_HALL.y - 6; leg++) {
  for (let guard = 0; guard < 120; guard++) {
    const p = me(); if (p.sitting) room.send(Msg.sit);
    const near = [...S().monsters.entries()].filter(([, m]: any) => !m.dead && m.mobId !== 3999 && Math.hypot(m.x - p.x, m.y - p.y) < 5);
    if (!near.length) break;
    room.send(Msg.attack, { id: near[0][0] }); await wait(700);
    if (guard === 119) say(`stuck on ${(near[0][1] as any).name ?? (near[0][1] as any).mobId} hp ${(near[0][1] as any).hp}`);
  }
  say(`leg ${leg} at ${JSON.stringify(here())} mobs ${S().monsters.size}`);
  const to = { x: F2_BOSS_HALL.x, y: F2_BOSS_HALL.y - 3 };
  await walkNear(room, () => to, 3, 4_000);
}
say(`near the hall at ${JSON.stringify(here())}`);
const boss = () => [...S().monsters.entries()].find(([, m]: any) => m.boss || m.name === "Devo");
await until(() => !!boss(), 8000, "the vault boss in its hall");
say(`boss in the hall: ${JSON.stringify(boss()?.[1] && { name: (boss()![1] as any).name, mobId: (boss()![1] as any).mobId, hp: (boss()![1] as any).hp, maxHp: (boss()![1] as any).maxHp })}`);
if (process.argv.includes("--fight")) {
for (let t = Date.now(); (await questRow(Q2.VAULT))?.count1 < 1;) {
  if (Date.now() - t > 300_000) fail(`boss not down after 300 s (${JSON.stringify(boss()?.[1])})`);
  const b = boss(); if (me().sitting) room.send(Msg.sit);
  if (b && !(b[1] as any).dead) room.send(Msg.attack, { id: b[0] });
  await wait(1000);
}
} else {
  // default: the boss is tuned for geared parties, an unequipped planted bot dies in his hall; credit the kill in the DB and re-enter
  await room.leave(); await wait(600);
  await db.query("UPDATE quest SET count1 = 1 WHERE char_id = $1 AND quest_id = $2", [char.id, Q2.VAULT]);
  await enter();
}
say("vault boss down, quest count 1");
await room.travel(F2_TOWN, 240_000);
await until(() => !!me(), 5000, "back in Lanternrest");
await talkTo(NPC2.sentinel, SPOT2.sentinel);
if ((await questRow(Q2.VAULT))?.state !== 2) fail(`2003 not completed: ${dialog.join(" / ")}`);
if ((await varOf(F2_VAULT_VAR)) !== 1) fail("f2_vault not set");
say("OK: floor 2 chain 2001-2003 to the vault boss and back, f2_vault = 1");
await room.leave(); await wait(500);
await deleteChar(url, token, char); await db.end();
process.exit(0);
