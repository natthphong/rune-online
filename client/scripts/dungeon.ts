// W03 probe: the way down into the Mirefall Catacombs. A Base Lv 15 character who finished Chapter 1 gets "The Wardens' Seal" from
// Warden Orrin, its 8 Dustcoils are written straight into the quest row (the kill credit itself is the quest bot's business), Orrin
// completes it and sets f1_seal; then the bot walks the warp graph like a player: Hearthmoor -> south gate -> Sunken Mire -> the
// stair under the keep (a scripted door: its OnTouch warps) -> B1 -> B2 -> B3, checking each arrival cell, each level's species
// and, at the bottom, Gloopking in its hall (or its tomb, if someone killed it within the last 1-2 h). Then all the way back up
// to the Mire (arriving off the stair's trigger). DUNGEON_KILL=1 also kills the MVP through the dev-only GM shortcut and checks
// the MVP fanfare + tomb (it then stays dead for 60-120 min on this server). Own account (dungeon_bot), character deleted at the end.
//   pnpm --filter client dungeon [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg, type MvpEvent } from "../../shared/protocol.ts";
import {
  DUN1, DUN2, DUN3, DUNGEONS, DUNGEON_STAIRS, FIELD_MOBS, MAP_INFO, MIRE, MIRE_STAIR_IN, MVP_HALL, TOWN, WARPS, type MapName,
} from "../../shared/maps.ts";
import { distance } from "../../shared/map.ts";
import { CHAPTER1, NPC, SPOT } from "../../shared/content/f1/chapter1.ts";
import { TQ } from "../../shared/content/f1/town.ts";
import { SEAL, SEAL_LEVEL, SEAL_VAR } from "../../shared/content/f1/stair.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear, type BotRoom } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 360 s"), 360_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) fail(`timeout: ${what}`); await wait(50); }
}

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const token = await login(url, "dungeon_bot");
const NAME = "DeepProbe";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) if (c.name === NAME) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "M", hair: 2 });
// Chapter 1 and Hearthmoor's first step done, Base Lv 15 (the seal's level), sturdy enough to walk past the catacombs' monsters
await db.query("UPDATE characters SET level = $2, vit = 60, hp = NULL WHERE id = $1", [char.id, SEAL_LEVEL]);
for (const id of [...CHAPTER1, TQ.HEARTH]) await db.query("INSERT INTO quest (char_id, quest_id, state) VALUES ($1, $2, 2)", [char.id, id]);
const questRow = async (id: number) => (await db.query("SELECT state, count1 FROM quest WHERE char_id = $1 AND quest_id = $2", [char.id, id])).rows[0];
const sealVar = async () => Number((await db.query(`SELECT value FROM char_reg_num WHERE char_id = $1 AND "key" = $2`, [char.id, SEAL_VAR])).rows[0]?.value ?? 0);

let room!: BotRoom;
let dialog: string[] = [], closed = false;
const mvps: MvpEvent[] = [];
async function enter() {
  room = await botRoom(url, token, char);
  dialog = [];
  // dialogs are answered like a player who takes the first option: Next, choice 1, Close
  room.onMessage(Msg.npcMes, (m: { text: string }) => { dialog.push(m.text); });
  room.onMessage(Msg.npcNextBtn, (m: { npc: string }) => { setTimeout(() => room.send(Msg.npcNext, { npc: m.npc }), 60); });
  room.onMessage(Msg.npcMenuList, (m: { npc: string }) => { setTimeout(() => room.send(Msg.npcMenu, { npc: m.npc, choice: 1 }), 60); });
  room.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => { closed = true; setTimeout(() => room.send(Msg.npcClose, { npc: m.npc }), 60); });
  room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) fail(`died on ${room.map}`); });
  room.onMessage(Msg.mvp, (m: MvpEvent) => mvps.push(m));
  room.onMessage("*", () => {});
  await until(() => !!(room.state as any).players?.get(room.sessionId), 8000, "my character in the room");
}
const S = () => room.state as any;
const me = () => S().players.get(room.sessionId);
const here = () => ({ x: Math.round(me().x), y: Math.round(me().y) });
async function talkToOrrin() {
  if (!(await walkNear(room, () => SPOT.warden, 3, 40_000))) fail(`could not reach Warden Orrin from ${JSON.stringify(here())}`);
  dialog = []; closed = false;
  room.send(Msg.npc, { id: NPC.warden });
  await until(() => closed, 8000, "Orrin's dialog");
  await wait(500);
}

// 1) Orrin hands out the seal at Base Lv 15
await enter();
if (room.map !== TOWN) fail(`started on ${room.map}`);
await talkToOrrin();
if ((await questRow(SEAL))?.state !== 1) fail(`"The Wardens' Seal" not held after Orrin (${JSON.stringify(await questRow(SEAL))}): ${dialog.join(" / ")}`);
say(`town: Orrin gave "The Wardens' Seal" (${dialog.find((l) => l.includes("Dustcoils"))?.slice(0, 80)}...)`);

// 2) eight Dustcoils (the counter written while offline), Orrin breaks the seal
await room.leave();
await wait(600);
await db.query("UPDATE quest SET count1 = 8 WHERE char_id = $1 AND quest_id = $2", [char.id, SEAL]);
await enter();
await talkToOrrin();
if ((await questRow(SEAL))?.state !== 2) fail(`seal quest not completed: ${dialog.join(" / ")}`);
await wait(500);
if ((await sealVar()) !== 1) fail(`${SEAL_VAR} not set`);
say(`town: seal broken, ${SEAL_VAR} = 1`);

// 3) down: town -> Mire -> the stair -> B1 -> B2 -> B3
const species = () => { const s = new Set<number>(); S().monsters.forEach((m: any) => s.add(m.mobId)); return s; };
async function down(to: MapName, arrival: { x: number; y: number }) {
  await room.travel(to, 120_000);
  await until(() => !!me(), 5000, `on ${to}`);
  if (distance(here().x - arrival.x, here().y - arrival.y) > 1) fail(`${to}: arrived at ${JSON.stringify(here())}, expected ${arrival.x},${arrival.y}`);
  await until(() => S().monsters.size > 0, 4000, `${to}: monsters`);
  const ids = species(), want = FIELD_MOBS[to as keyof typeof FIELD_MOBS]?.mobs ?? [];
  const stray = [...ids].filter((id) => !want.includes(id) && MOB_BY_ID.get(id)?.bossType === "None");
  if (stray.length) fail(`${to}: species ${stray} not in FIELD_MOBS ${want}`);
  if (!want.every((id) => ids.has(id))) fail(`${to}: missing species (${[...ids]} vs ${want})`);
  say(`${to} (${MAP_INFO[to].title}): arrived at ${JSON.stringify(here())}, ${S().monsters.size} monsters, species ${[...ids].map((id) => MOB_BY_ID.get(id)!.name).join(", ")}`);
}
await room.travel(MIRE, 60_000);
say(`${MIRE}: on the Sunken Mire at ${JSON.stringify(here())}, heading for the stair`);
const stairDown = WARPS.find((w) => w.map === MIRE && w.npc)!;
await down(DUN1, stairDown.to);
await down(DUN2, DUNGEON_STAIRS[DUN2].upIn);
await down(DUN3, DUNGEON_STAIRS[DUN3].upIn);

// 4) the MVP's hall
const mvpEntry = () => [...S().monsters.entries()].find(([, m]: any) => m.mobId === 3810) as [string, any] | undefined;
const tomb = () => [...S().npcs.keys()].find((k: string) => k.startsWith("tomb_"));
const mvp = mvpEntry();
if (mvp && !mvp[1].dead) {
  const [id, m] = mvp;
  if (m.boss !== 2) fail(`Gloopking boss flag ${m.boss}`);
  if (distance(Math.round(m.x) - MVP_HALL.x, Math.round(m.y) - MVP_HALL.y) > 14) fail(`Gloopking strayed from its hall: ${m.x},${m.y}`);
  say(`${DUN3}: Gloopking (MVP) in its hall at ${Math.round(m.x)},${Math.round(m.y)}, HP ${m.hp}/${m.maxHp}`);
  if (process.env.DUNGEON_KILL) {
    room.send(Msg.devBoss, { op: "kill", id });
    await until(() => mvps.length > 0, 5000, "the MVP fanfare");
    await until(() => !!tomb(), 15_000, "Gloopking's tomb");
    say(`${DUN3}: Gloopking slain (dev shortcut): MVP ${JSON.stringify(mvps[0])}, tomb up`);
  }
} else if (tomb()) say(`${DUN3}: Gloopking is dead (its tomb stands in the hall); it returns 60-120 min after its death`);
else fail(`${DUN3}: neither Gloopking nor its tomb`);

// 5) back up: B3 -> B2 -> B1 -> the Mire (arriving beside the stair, off its trigger, so it does not send us straight back down)
for (const [to, at] of [[DUN2, DUNGEON_STAIRS[DUN2].downIn!], [DUN1, DUNGEON_STAIRS[DUN1].downIn!], [MIRE, MIRE_STAIR_IN]] as const) {
  await room.travel(to, 120_000);
  await until(() => !!me(), 5000, `on ${to}`);
  if (distance(here().x - at.x, here().y - at.y) > 1) fail(`${to}: came up at ${JSON.stringify(here())}, expected ${at.x},${at.y}`);
  say(`up to ${to}: ${JSON.stringify(here())}`);
}
await wait(2500);
if (room.map !== MIRE) fail(`the stair sent us on to ${room.map}`);
if (DUNGEONS.length !== 3) fail("three levels");

await room.leave();
await wait(500);
await deleteChar(url, token, char);
await db.end();
say("OK: Orrin's seal (offer at Base Lv 15, report, f1_seal), town -> Mire -> stair -> B1 -> B2 -> B3 (arrivals, species), the MVP in its hall, stairs back up to the Mire");
process.exit(0);
