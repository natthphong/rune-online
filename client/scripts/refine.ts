// End-to-end refiner check: a fresh character is given zeny and Rough Ore straight in the dev database (offline, like a
// shop purchase would), talks to Forgemaster Brann and refines the worn Knife to +4 (the safe levels of a Lv 1 weapon go
// through without a warning), then checks the +N in the inventory snapshot, the Postgres row, the zeny / ore paid, the
// "+4 Knife" name the client builds, and that a relog keeps it. Dev schema only.
//   pnpm --filter client refine [serverUrl]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg, type InvEvent, type NpcMenuEvent, type NpcMesEvent, type StatusEvent } from "../../shared/protocol.ts";
import { itemDisplayName } from "../../shared/rules/cards.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { itemNamed } from "../../shared/rules/quest.ts";
import { refineCost } from "../../shared/rules/refine.ts";
import { npcCheckNear } from "../../shared/rules/npc.ts";
import { TOWN_NPC } from "../../shared/content/f1/town.ts";
import { botRoom, deleteChar, joinAs, walkNear } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string) => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 120 s"), 120_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing to touch schema ${schema}: run against a local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const KNIFE = 1201, ORE = refineCost(ITEMS.get(KNIFE)!, 0)!, ORE_ID = ORE.material, ZENY = 5000, ORES = 10;
const ACCOUNT = process.env.REFINE_BOT ?? "refine_bot";

// 1) a fresh character, then given zeny + ore while offline (the next session reads them from Postgres)
let { room: r, token, char } = await joinAs(url, ACCOUNT, ACCOUNT, true);
await wait(800);
await r.leave();
await wait(800);
await db.query("UPDATE characters SET zeny = $2 WHERE id = $1", [char.id, ZENY]);
await db.query("INSERT INTO inventory (char_id, item_id, amount) VALUES ($1, $2, $3)", [char.id, ORE_ID, ORES]);
r = await botRoom(url, token, char);

let inv: InvEvent | undefined, status: StatusEvent | undefined;
r.onMessage(Msg.inv, (m: InvEvent) => { inv = m; });
r.onMessage(Msg.status, (m: StatusEvent) => { status = m; });
for (const t of [Msg.quests, Msg.questMark, Msg.cutin, Msg.emotion, Msg.npcTalk, Msg.hit, Msg.chat, Msg.exp, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.notice, Msg.itemGet, Msg.zenyGet, Msg.takeItem, Msg.skills]) r.onMessage(t, () => {});
type Ev = { t: "mes"; text: string } | { t: "next" } | { t: "close" } | { t: "menu"; options: string[] } | { t: "end" };
const events: Ev[] = [];
let read = 0;
r.onMessage(Msg.npcMes, (m: NpcMesEvent) => events.push({ t: "mes", text: m.text }));
r.onMessage(Msg.npcNextBtn, () => events.push({ t: "next" }));
r.onMessage(Msg.npcCloseBtn, () => events.push({ t: "close" }));
r.onMessage(Msg.npcMenuList, (m: NpcMenuEvent) => events.push({ t: "menu", options: m.options }));
r.onMessage(Msg.npcEnd, () => events.push({ t: "end" }));
const S: any = new Proxy({}, { get: (_t, k) => (r.state as any)[k] });
const stack = (id: number) => inv?.items.find((s) => s.itemId === id);
const count = (id: number) => inv?.items.filter((s) => s.itemId === id).reduce((n, s) => n + s.amount, 0) ?? 0;

/** Click Brann and answer the dialog: Next on every page, the menu choices in order, Close at the end. Returns his lines. */
async function talk(choices: (number | string)[]) {
  const n = S.npcs.get(TOWN_NPC.refiner);
  if (!n) fail("Forgemaster Brann is not in the room state");
  const me = () => S.players.get(r.sessionId);
  if (!npcCheckNear({ x: Math.round(me().x), y: Math.round(me().y) }, n)) {
    if (!(await walkNear(r, () => ({ x: n.x, y: n.y }), 3, 60_000))) fail("could not walk to Brann");
    await wait(600);
  }
  read = events.length;
  r.send(Msg.npc, { id: TOWN_NPC.refiner });
  const lines: string[] = [];
  for (;;) {
    await until(() => events.length > read, 6000, `dialog stalled after: ${lines.slice(-2).join(" / ")}`);
    const ev = events[read++];
    if (ev.t === "mes") lines.push(ev.text);
    else if (ev.t === "next") { await wait(60); r.send(Msg.npcNext, { npc: TOWN_NPC.refiner }); }
    else if (ev.t === "menu") {
      const pick = choices.shift(); // a number, or the start of an option's text (empty entries are not sent, so numbers shift)
      if (pick === undefined) fail(`unexpected menu ${ev.options.join(" / ")}`);
      const c = typeof pick === "string" ? ev.options.findIndex((o) => o.startsWith(pick)) + 1 : pick!;
      if (!c) fail(`no menu option "${pick}" in ${ev.options.join(" / ")}`);
      lines.push(`> ${ev.options[c - 1]}`);
      await wait(60); r.send(Msg.npcMenu, { npc: TOWN_NPC.refiner, choice: c });
    } else if (ev.t === "close") { await wait(60); r.send(Msg.npcClose, { npc: TOWN_NPC.refiner }); await wait(250); if (events.length === read) break; }
    else break;
  }
  if (choices.length) fail(`menu choices left over: ${choices}\n${lines.join("\n")}`);
  await wait(300);
  return lines;
}

await until(() => !!inv && !!status, 4000, "no inventory / status snapshot");
if (inv!.zeny !== ZENY || count(ORE_ID) !== ORES) fail(`given goods missing: ${inv!.zeny} z, ${count(ORE_ID)} ore`);
const knife = () => inv!.items.find((s) => s.itemId === KNIFE && s.equip === "weapon")!;
if (!knife() || knife().refine !== 0) fail("worn Knife expected at +0");
const uid = knife().uid;

// 2) refine to +4: menu 1 = Refine, the Weapon entry, 1 = Yes (safe levels: no warning, no second question)
for (let want = 1; want <= 4; want++) {
  const lines = await talk([1, "Weapon", 1]);
  if (lines.some((l) => /destroyed/.test(l))) fail(`a warning at the safe level +${want - 1}`);
  await until(() => inv!.items.find((s) => s.uid === uid)?.refine === want, 4000, `refine +${want} not in the snapshot (${lines.slice(-3).join(" / ")})`);
  console.log(`OK: +${want} Knife (${inv!.zeny} z, ${count(ORE_ID)} ore left)`);
}
if (inv!.zeny !== ZENY - 4 * ORE.price || count(ORE_ID) !== ORES - 4) fail(`paid wrong: ${inv!.zeny} z, ${count(ORE_ID)} ore`);
const name = itemDisplayName(ITEMS.get(KNIFE)!, [], knife().refine);
if (name !== "+4 Knife [3]" && !name.startsWith("+4 Knife")) fail(`display name ${name}`);

// 3) Postgres has it, and a relog keeps it
const row = (await db.query("SELECT refine, equip FROM inventory WHERE uid = $1", [uid])).rows[0];
if (row?.refine !== 4 || row.equip !== "weapon") fail(`DB row ${JSON.stringify(row)}`);
const zrow = (await db.query("SELECT zeny FROM characters WHERE id = $1", [char.id])).rows[0];
if (Number(zrow.zeny) !== ZENY - 4 * ORE.price) fail(`DB zeny ${zrow.zeny}`);
console.log(`OK: Postgres: ${name}, equip=weapon, zeny ${zrow.zeny}`);
await r.leave();
await wait(800);
inv = undefined;
r = await botRoom(url, token, char);
r.onMessage(Msg.inv, (m: InvEvent) => { inv = m; });
await until(() => !!inv, 4000, "no inventory after relog");
if (knife().refine !== 4) fail("relog lost the refine");
console.log("OK: relog keeps +4");

await r.leave();
await deleteChar(url, token, char);
await db.end();
clearTimeout(timeout);
console.log("refine bot: all checks passed");
process.exit(0);
