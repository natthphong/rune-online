// C08 / W01 probe: a new character starts in Hearthmoor (the hub), the Hearthkeeper's save point, the town's side work and shops,
// all four gates (town -> field -> town: arrival cells, each field's own species), the sealed stair in the Sunken Mire, and a
// death on the field respawning at the saved town hearth. Uses its own test account (c08_bot) and deletes its character.
//   pnpm --filter client town [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Client, type Room } from "@colyseus/sdk";
import { Msg, type ChangeMapEvent } from "../../shared/protocol.ts";
import { FIELD, FIELDS, FIELD_ARRIVAL, FIELD_MOBS, FIELD_THEMES, MIRE, TOWN, TOWN_GATE, TOWN_SAVE, TOWN_START, WARPS, mapOfState, roomOf, type MapName } from "../../shared/maps.ts";
import { distance } from "../../shared/map.ts";
import { Q } from "../../shared/content/f1/chapter1.ts";
import { TOWN_NPC, TOWN_SPOT, TQ } from "../../shared/content/f1/town.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, deleteChar, login, routeTo } from "./bot.ts";
import { MAP_INFO } from "../../shared/maps.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
const MAP_INFO_TITLE = (m: MapName) => MAP_INFO[m].title;

const url = process.argv[2] ?? "http://localhost:2567";
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
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

const token = await login(url, "c08_bot");
const NAME = process.env.TOWN_NAME ?? "HearthProbe";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) if (c.name === NAME) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: Number(process.env.TOWN_SLOT ?? 0), name: NAME, gender: "F", hair: 1 });
// chapter 1 done: the warden's gate (Q.GATE) and the level check (Q.PROVEN) complete, so the road is open
// and Orrin's road step (C08 r1: "A Warm Hearth" held, Bren is the next Main stop)
// sturdy enough to cross the fields (104-108 cells, 75-83 monsters, aggressive ones among them): a Lv1 bot with 40 HP dies on the way,
// stays dead (a dead character ignores `move`) and the walk "gets stuck" wherever it fell. The death step at the end sets HP to 1 itself.
await db.query("UPDATE characters SET level = 30, vit = 60, hp = NULL WHERE id = $1", [char.id]);
await db.query("INSERT INTO quest (char_id, quest_id, state) VALUES ($1, $2, 2), ($1, $3, 2), ($1, $4, 1)", [char.id, Q.GATE, Q.PROVEN, TQ.HEARTH]);
const questState = async (id: number) => (await db.query("SELECT state FROM quest WHERE char_id = $1 AND quest_id = $2", [char.id, id])).rows[0]?.state;

let room!: Room;
// dialogs are answered like a player who takes the first option: Next, menu choice 1, Close (registered on every room joined)
let menu = false, closeBtn = false, dialog: string[] = [];
let changed: ChangeMapEvent | undefined, died = false;
async function join(map: MapName) {
  changed = undefined; died = false;
  room = await new Client(url).joinOrCreate(roomOf(map), { token, charId: char.id });
  room.onMessage(Msg.changeMap, (m: ChangeMapEvent) => { changed = m; });
  const r = room;
  r.onMessage(Msg.npcMes, (m: { text: string }) => { dialog.push(m.text); });
  r.onMessage(Msg.npcNextBtn, (m: { npc: string }) => { setTimeout(() => r.send(Msg.npcNext, { npc: m.npc }), 60); });
  r.onMessage(Msg.npcMenuList, (m: { npc: string }) => { menu = true; setTimeout(() => r.send(Msg.npcMenu, { npc: m.npc, choice: 1 }), 60); });
  r.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => { closeBtn = true; setTimeout(() => r.send(Msg.npcClose, { npc: m.npc }), 60); });
  room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) died = true; });
  room.onMessage("*", () => {});
  await until(() => !!(room.state as any).players?.get(room.sessionId), 5000, `my character on ${map}`);
  const S = room.state as any;
  if (S.map !== map) fail(`room map ${S.map}, expected ${map}`);
}
const me = () => (room.state as any).players.get(room.sessionId);
const here = () => ({ x: Math.round(me().x), y: Math.round(me().y) });
/** Click along a full route, 10 cells per click, until on (x, y), a map change or `stop()`. */
async function walkTo(x: number, y: number, stop?: () => boolean, near = 0) {
  const map = mapOfState(room.state as any), end = Date.now() + 150_000; // fields are 104-108 cells and the Mire is dense with aggressive monsters
  while (!changed && !stop?.()) {
    const h = here();
    if (distance(h.x - x, h.y - y) <= near) return;
    if (Date.now() > end) fail(`walk to ${x},${y} stuck at ${h.x},${h.y} (sitting ${me().sitting}, dead ${me().dead}, dialog lines ${dialog.length})`);
    const route = routeTo(map, h, { x, y });
    if (!route.length) fail(`no route ${h.x},${h.y} -> ${x},${y}`);
    const step = route[Math.min(9, route.length - 1)];
    room.send(Msg.move, step);
    const t = Date.now();
    while (!changed && !stop?.() && Date.now() - t < 3000 && distance(here().x - step.x, here().y - step.y) > 0) await wait(50);
  }
}
async function hop(to: MapName) {
  await until(() => !!changed, 5000, `changeMap to ${to}`);
  if (changed!.map !== to) fail(`changeMap to ${changed!.map}, expected ${to}`);
  await room.leave();
  await join(to);
}

// 1) a new character starts in Hearthmoor's plaza (W01: the town is the hub)
await join(TOWN);
if (distance(here().x - TOWN_START.x, here().y - TOWN_START.y) > 1) fail(`start cell ${JSON.stringify(here())}, expected ${JSON.stringify(TOWN_START)}`);
if ((room.state as any).monsters.size !== 0) fail("monsters in town");
say(`town: started at ${JSON.stringify(here())}; ${(room.state as any).npcs.size} NPC(s), no monsters`);

// 2) the Hearthkeeper: set the save point (Next, "Set my hearth here", Close)
await walkTo(TOWN_SAVE.x, TOWN_SAVE.y);
room.send(Msg.npc, { id: "npc_hearthkeeper" });
await until(() => menu && closeBtn, 6000, "Hearthkeeper dialog");
await wait(400);
say("town: hearth set at the Hearthkeeper");
if ((await questState(TQ.HEARTH)) !== 2 || (await questState(TQ.LESSON)) !== 1) fail(`Bren: quest ${TQ.HEARTH} / ${TQ.LESSON} states ${await questState(TQ.HEARTH)} / ${await questState(TQ.LESSON)}`);
say(`town: [Main] "A Warm Hearth" done, "The Fledgling's Last Lesson" held`);

// 2a) C08 r1: side work: Pella's errand ("I'll tell him."), then Woodcutter Garr takes it and offers the Sootcap hunt
for (const [id, spot] of [[TOWN_NPC.pella, TOWN_SPOT.pella], [TOWN_NPC.garr, TOWN_SPOT.garr]] as const) {
  menu = false; closeBtn = false;
  await walkTo(spot.x, spot.y + 1, undefined, 2); // beside them (another climber may stand on the cell)
  room.send(Msg.npc, { id });
  await until(() => menu && closeBtn, 6000, `${id} dialog`);
  await wait(400);
}
if ((await questState(TQ.DINNER)) !== 2 || (await questState(TQ.SOOT)) !== 1) fail(`side quests ${await questState(TQ.DINNER)} / ${await questState(TQ.SOOT)}`);
say(`town: "Dinner Bell" done at Garr, "Sootcaps in the Woodpile" held`);

// 2b) C08 r1: Hearthmoor's two shops (plain shop NPCs: a click opens the buy/sell list with their own stock)
let shop: { npc: string; stock: { itemId: number }[] } | undefined;
room.onMessage(Msg.shop, (m: { npc: string; stock: { itemId: number }[] }) => { shop = m; });
for (const [id, x, y, has, hasNot] of [["town_tools", TOWN_SPOT.tools.x, TOWN_SPOT.tools.y + 1, [501, 601, 1750], 1101], ["town_arms", TOWN_SPOT.arms.x, TOWN_SPOT.arms.y + 1, [1101, 2301], 501]] as const) {
  shop = undefined;
  await walkTo(x, y);
  room.send(Msg.npc, { id });
  await until(() => !!shop, 6000, `${id} shop list`);
  if (shop!.npc !== id) fail(`shop from ${shop!.npc}, expected ${id}`);
  const ids = new Set(shop!.stock.map((r) => r.itemId));
  if (!has.every((i) => ids.has(i)) || ids.has(hasNot)) fail(`${id} stock ${[...ids].join(",")}`);
  room.send(Msg.shopQuit, {});
  say(`town: ${id} sells ${ids.size} items`);
  await wait(300);
}

// 3) every gate: town -> field (arrival cell, the field's own species) -> back through the field's gate -> town
for (const f of FIELDS) {
  const out = WARPS.find((w) => w.map === TOWN && w.to.map === f)!, back = WARPS.find((w) => w.map === f && w.to.map === TOWN)!;
  await walkTo(out.x, out.y);
  await hop(f);
  if (distance(here().x - out.to.x, here().y - out.to.y) > 1) fail(`${f} arrival ${JSON.stringify(here())}, expected ${out.to.x},${out.to.y}`);
  await until(() => (room.state as any).monsters.size > 0, 3000, `${f}: no monsters`);
  const species = new Set<number>();
  (room.state as any).monsters.forEach((m: any) => species.add(m.mobId));
  // the field's own species, plus its mini-boss (boss_monster line) and the slaves that one summons
  const boss = [...species].filter((id) => MOB_BY_ID.get(id)?.bossType !== "None");
  const slaves = boss.flatMap((id) => ((MOB_BY_ID.get(id) as any)?.slaves ?? []).flatMap((s: { ids: number[] }) => s.ids));
  if (![...species].every((id) => FIELD_MOBS[f].mobs.includes(id) || boss.includes(id) || slaves.includes(id))) fail(`${f}: species ${[...species]} outside ${FIELD_MOBS[f].mobs}`);
  if (f === MIRE) { // the sealed stair under the old keep: its OnTouch area tells the way down is shut (W03 opens it)
    const st = FIELD_THEMES[MIRE].stair!;
    dialog = [];
    await walkTo(st.x, st.y, () => dialog.length > 0);
    await until(() => dialog.some((l) => l.includes("not open yet")), 8000, `the sealed stair's dialog (at ${JSON.stringify(here())}, dead ${me().dead}, lines ${JSON.stringify(dialog)})`);
    say(`${f}: the sealed stair at ${st.x},${st.y}: "${dialog.find((l) => l.includes("not open yet"))}"`);
    await wait(2500); // its Next / Close are pressed by the handlers above
    // the stair lies deep in the Lv15-20 Mire: a Lv1 bot walking 60 cells back is flinched by aggressive monsters for minutes,
    // so put it back on the Mire's arrival cell (relog) — the gate itself is what this test checks
    await room.leave();
    await wait(300);
    await db.query("UPDATE characters SET x = $1, y = $2 WHERE id = $3", [out.to.x, out.to.y, char.id]);
    await join(MIRE);
  }
  if (f === FIELD) {
    const row = (await db.query("SELECT last_map, save_map, save_x, save_y FROM characters WHERE id = $1", [char.id])).rows[0];
    if (row.save_map !== TOWN || row.save_x !== TOWN_SAVE.x || row.save_y !== TOWN_SAVE.y) fail(`save point row ${JSON.stringify(row)}`);
    if (row.last_map !== FIELD) fail(`last_map ${row.last_map}`);
  }
  say(`${f}: arrived at ${JSON.stringify(here())}, ${(room.state as any).monsters.size} monsters of ${species.size} species (${MAP_INFO_TITLE(f)})`);
  await walkTo(back.x, back.y);
  await hop(TOWN);
  if (distance(here().x - back.to.x, here().y - back.to.y) > 1) fail(`town arrival from ${f} ${JSON.stringify(here())}, expected ${back.to.x},${back.to.y}`);
}
say("all four gates: town -> field -> town");
await walkTo(TOWN_GATE.x, TOWN_GATE.y);
await hop(FIELD);
if (distance(here().x - FIELD_ARRIVAL.x, here().y - FIELD_ARRIVAL.y) > 1) fail(`field arrival ${JSON.stringify(here())}`);

// 4) die on the field (1 HP, pick fights) and return to the save point -> Hearthmoor
await room.leave();
await wait(300);
await db.query("UPDATE characters SET level = 1, vit = 1, hp = 1 WHERE id = $1", [char.id]);
await join(FIELD);
const end = Date.now() + 60_000;
while (!died) {
  if (Date.now() > end) fail("could not die on the field within 60 s");
  const h = here(), S = room.state as any;
  let best: [string, number] | undefined;
  S.monsters.forEach((m: any, id: string) => { if (!m.dead) { const d = distance(Math.round(m.x) - h.x, Math.round(m.y) - h.y); if (!best || d < best[1]) best = [id, d]; } });
  if (best) room.send(Msg.attack, { id: best[0] });
  await wait(800);
}
say("field: died");
room.send(Msg.respawn, {});
await hop(TOWN);
if (distance(here().x - TOWN_SAVE.x, here().y - TOWN_SAVE.y) > 1) fail(`respawn at ${JSON.stringify(here())}, expected the hearth ${JSON.stringify(TOWN_SAVE)}`);
if (me().dead) fail("still dead after respawn");
say(`respawned at the Hearthmoor hearth ${JSON.stringify(here())}`);

await room.leave();
await wait(500);
await deleteChar(url, token, char);
await db.end();
say("OK: start in town, Bren (Main step + save point), Pella -> Garr side quests, both shops, all four gates both ways, the sealed stair, death -> respawn at the town save point");
process.exit(0);
