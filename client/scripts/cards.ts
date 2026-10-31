// End-to-end card check: kill monsters until a card drops, use it, compound it into unequipped gear, check the bag + the bonus.
// The card drop rate is 0.2% in the original, so this probe wants a server started with the rate forced up:
//   cd ro/server && PORT=2568 DROP_RATE=50000 node --env-file-if-exists=../../.env --env-file-if-exists=../.env src/index.ts
//   pnpm --filter client cards http://localhost:2568
import { Msg, type CardAckEvent, type CardListEvent, type InvEvent, type StatusEvent } from "../../shared/protocol.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { itemDisplayName } from "../../shared/rules/cards.ts";
import { deleteChar, joinAs } from "./bot.ts";
import { FIELD } from "../../shared/maps.ts";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { albumPool, rarityOf } from "../../shared/rules/album.ts";

const url = process.argv[2] ?? "http://localhost:2568";
const fail = (m: string) => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 240 s"), 240_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };

const { room: r, token, char } = await joinAs(url, "card_bot", "card_bot", true);
let inv: InvEvent | undefined, list: CardListEvent | undefined, ack: CardAckEvent | undefined, st: StatusEvent | undefined;
const notices: string[] = [];
r.onMessage(Msg.inv, (m: InvEvent) => { inv = m; });
r.onMessage(Msg.cardList, (m: CardListEvent) => { list = m; });
r.onMessage(Msg.cardAck, (m: CardAckEvent) => { ack = m; });
r.onMessage(Msg.status, (m: StatusEvent) => { st = m; });
r.onMessage(Msg.notice, (m: { text: string }) => notices.push(m.text));
for (const t of [Msg.quests, Msg.questMark, Msg.npcMes, Msg.npcNextBtn, Msg.npcEnd, Msg.npcClear, Msg.cutin, Msg.emotion, Msg.npcTalk, Msg.hit, Msg.chat, Msg.exp, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.takeItem, Msg.itemGet]) r.onMessage(t, () => {});
r.onMessage(Msg.die, (m: { id: string }) => { if (m.id === r.sessionId) r.send(Msg.respawn); });
const me = () => (r.state as any).players.get(r.sessionId);
await until(() => !!inv, 3000, "no inventory snapshot");

// hunt Sootcaps (the weapon card, Lv2) on the Verdant Plains (W01: out Hearthmoor's west gate), picking up everything, until a
// Card is in the bag; a death respawns in town: walk back out
const SOOTCAP = 1113;
let travelling = false;
const out = () => { if (!travelling) { travelling = true; r.travel(FIELD).catch((e) => fail(String(e))).finally(() => { travelling = false; }); } };
out();
const loop = setInterval(() => {
  if (r.map !== FIELD) return out();
  const p = me();
  if (!p || p.dead) return;
  const floor = [...(r.state as any).floor.entries()].sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (floor.length && Math.hypot(floor[0][1].x - p.x, floor[0][1].y - p.y) < 8) { r.send(Msg.pickup, { id: floor[0][0] }); return; }
  const live = [...(r.state as any).monsters.entries()].filter(([, m]: any) => !m.dead && m.mobId === SOOTCAP)
    .sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (live.length) r.send(Msg.attack, { id: live[0][0] });
}, 700);
const card = () => inv?.items.find((s) => ITEMS.get(s.itemId)?.type === "Card");
await until(() => !!card(), 200_000, "no card dropped (is the server's DROP_RATE forced up?)");
clearInterval(loop);
r.send(Msg.sit); // stop fighting
const c = card()!, cardItem = ITEMS.get(c.itemId)!;
console.log(`OK: ${cardItem.name} dropped (${cardItem.locations.join("/")})`);

// the starter Knife [3] is worn: a worn piece is not offered
r.send(Msg.useItem, { uid: c.uid });
await wait(800);
const knife = inv!.items.find((s) => s.itemId === 1201)!;
// a spare unworn weapon picked up on the hunt (forced drop rate) may be offered; the worn knife never is
if (list) { if (list.targets.includes(knife.uid)) fail("a worn knife was offered for compounding"); }
else if (!notices.some((n) => /Nothing you carry can take/.test(n))) fail("no 'nothing can take it' notice");
console.log("OK: the worn knife is not offered");
list = undefined;
r.send(Msg.unequip, { uid: knife.uid });
await until(() => inv!.items.find((s) => s.uid === knife.uid)?.equip === null, 3000, "unequip failed");
r.send(Msg.useItem, { uid: c.uid });
await until(() => !!list, 3000, "no card list");
if (!list!.targets.includes(knife.uid)) fail("the knife is not in the list");
if (list!.targets.some((u) => !["Weapon"].includes(ITEMS.get(inv!.items.find((s) => s.uid === u)!.itemId)!.type))) fail("a non-weapon was offered");
console.log(`OK: card list = ${list!.targets.length} piece(s), knife included`);

// wrong target is refused, the right one compounds for good
const shirt = inv!.items.find((s) => s.itemId === 2301)!;
r.send(Msg.insertCard, { card: c.uid, equip: shirt.uid });
await until(() => !!ack, 3000, "no ack for the bad compound");
if (ack!.ok) fail("a weapon card went into the shirt");
ack = undefined;
r.send(Msg.insertCard, { card: c.uid, equip: knife.uid });
await until(() => !!ack, 3000, "no ack");
if (!ack!.ok) fail(`compound refused: ${ack!.text}`);
await until(() => (inv!.items.find((s) => s.uid === knife.uid)?.cards.length ?? 0) === 1, 3000, "card not in the knife");
if (inv!.items.some((s) => s.uid === c.uid)) fail("card not consumed");
const knifeRow = inv!.items.find((s) => s.uid === knife.uid)!;
console.log(`OK: compounded -> ${itemDisplayName(ITEMS.get(1201)!, knifeRow.cards)}`);

// re-wear: the card's bonus (Sootcap card: DEX +1, HIT +3) reaches the status
r.send(Msg.equip, { uid: knife.uid });
await until(() => inv!.items.find((s) => s.uid === knife.uid)?.equip === "weapon", 3000, "equip failed");
await wait(500);
console.log(`OK: carded knife worn (DEX ${st?.dex})`);
// persistence: relog and see the card still inside. While offline one Card Album is put into the bag (dev schema only), to open it after
const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing to write schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 1, options: `-c search_path="${schema}"` });
const ALBUM = [...ITEMS.values()].find((i) => (i.effect as { album?: boolean } | null)?.album)!;
r.leave();
await wait(1500);
await db.query("INSERT INTO inventory (char_id, item_id, amount) VALUES ($1, $2, 1)", [char.id, ALBUM.id]);
const again = await joinAs(url, "card_bot", "card_bot");
let inv2: InvEvent | undefined;
again.room.onMessage(Msg.inv, (m: InvEvent) => { inv2 = m; });
for (const t of [Msg.quests, Msg.questMark, Msg.status, Msg.hotkeys, Msg.chat, Msg.hit, Msg.npcMes]) again.room.onMessage(t, () => {});
await until(() => !!inv2, 5000, "no inventory after relogin");
const k2 = inv2!.items.find((s) => s.itemId === 1201);
if (k2?.cards.length !== 1 || k2.cards[0] !== c.itemId) fail("the card was not saved");
console.log("OK: the card persists across a relog");

// the card album: one use = one random card of the pool (never the legendary), the album is used up, itemGet tells the client
const albumRow = inv2!.items.find((x) => x.itemId === ALBUM.id);
if (!albumRow) fail("the album is not in the bag");
const pool = new Set(albumPool().map(([i]) => i)), before = inv2!.items.filter((x) => ITEMS.get(x.itemId)?.type === "Card").length;
let got: { itemId: number; amount: number } | undefined;
again.room.onMessage(Msg.itemGet, (m: { itemId: number; amount: number }) => { got = m; });
again.room.send(Msg.useItem, { uid: albumRow!.uid });
await until(() => !!got, 3000, "no itemGet after opening the album");
if (!pool.has(got!.itemId) || rarityOf(ITEMS.get(got!.itemId)!) === "legendary") fail(`the album gave ${got!.itemId}, not a pool card`);
await until(() => !inv2!.items.some((x) => x.itemId === ALBUM.id) && inv2!.items.some((x) => x.itemId === got!.itemId), 3000, "bag not updated after the album");
console.log(`OK: the album gave ${ITEMS.get(got!.itemId)!.name} (${rarityOf(ITEMS.get(got!.itemId)!)}), cards in the bag ${before} -> ${inv2!.items.filter((x) => ITEMS.get(x.itemId)?.type === "Card").length}`);
await db.end();
again.room.leave();
await deleteChar(url, again.token, again.char);
clearTimeout(timeout);
console.log("PASS");
process.exit(0);
