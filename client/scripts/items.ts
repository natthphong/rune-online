// End-to-end item check: starter kit, consumables, equip toggling, loot pickup, NPC shop sell + buy. Mira talks first: her
// Buy / Sell / Cancel menu, then close2 + callshop opens the sell or the buy list of her floating shop.
//   pnpm --filter client items [serverUrl]
import { Msg, type InvEvent, type ItemGetEvent, type NpcMenuEvent, type ShopEvent } from "../../shared/protocol.ts";
import { ITEMS, STARTER_KIT } from "../../shared/rules/items.ts";
import { MOBS } from "../../shared/rules/data.ts";
import { npcCheckNear } from "../../shared/rules/npc.ts";
import { walkPath, walkable } from "../../shared/map.ts";
import { FIELD, FIELD_MOBS, TOWN, mapOfState } from "../../shared/maps.ts";
import { deleteChar, joinAs } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string) => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 240 s"), 240_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };

const { room: r, token, char } = await joinAs(url, "item_bot", "item_bot", true);
let inv: InvEvent | undefined, shop: ShopEvent | undefined;
const got: ItemGetEvent[] = [];
r.onMessage(Msg.inv, (m: InvEvent) => { inv = m; });
r.onMessage(Msg.shop, (m: ShopEvent) => { shop = m; });
r.onMessage(Msg.itemGet, (m: ItemGetEvent) => got.push(m));
let shopClosed = 0;
r.onMessage(Msg.shopClose, () => { shopClosed++; });
let menu: NpcMenuEvent | undefined, closeBtn = false;
r.onMessage(Msg.npcMenuList, (m: NpcMenuEvent) => { menu = m; });
r.onMessage(Msg.npcCloseBtn, () => { closeBtn = true; });
for (const t of [Msg.quests, Msg.questMark, Msg.npcMes, Msg.npcNextBtn, Msg.npcEnd, Msg.npcClear, Msg.cutin, Msg.emotion, Msg.npcTalk]) r.onMessage(t, () => {});
for (const t of [Msg.hit, Msg.chat, Msg.exp, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.notice, Msg.status, Msg.takeItem]) r.onMessage(t, () => {});
r.onMessage(Msg.die, (m: { id: string }) => { if (m.id === r.sessionId) r.send(Msg.respawn); });
const me = () => (r.state as any).players.get(r.sessionId);
const stack = (id: number) => inv?.items.find((s) => s.itemId === id);

// 1) starter kit, worn
await until(() => !!inv, 3000, "no inventory snapshot");
for (const k of STARTER_KIT) if ((stack(k.id)?.amount ?? 0) < k.amount) fail(`starter kit missing ${ITEMS.get(k.id)!.name}`);
if (stack(1201)?.equip !== "weapon" || stack(2301)?.equip !== "armor") fail("starter gear not worn");
console.log("OK: starter kit present and worn");

// 2) use a tonic, 3) unequip + re-equip the knife
const tonic = STARTER_KIT.find((k) => ITEMS.get(k.id)!.type === "Healing")!.id;
r.send(Msg.useItem, { uid: stack(tonic)!.uid });
await until(() => stack(tonic)?.amount === 4, 3000, "tonic not consumed");
const knife = stack(1201)!.uid;
r.send(Msg.unequip, { uid: knife });
await until(() => stack(1201)?.equip === null, 3000, "unequip failed");
r.send(Msg.equip, { uid: knife });
await until(() => stack(1201)?.equip === "weapon", 3000, "equip failed");
console.log("OK: consumable used, knife unequipped and re-equipped");

// 4) hunt until something drops, then pick it up: out the west gate (W01: the town has no monsters)
const weakest = MOBS.filter((m) => FIELD_MOBS[FIELD].mobs.includes(m.id)).sort((a, b) => a.level - b.level)[0];
await r.travel(FIELD);
const before = got.length;
const loop = setInterval(() => {
  const p = me();
  if (!p || r.map !== FIELD) return;
  const floor = [...(r.state as any).floor.entries()].sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (floor.length && Math.hypot(floor[0][1].x - p.x, floor[0][1].y - p.y) < 6) { r.send(Msg.pickup, { id: floor[0][0] }); return; }
  const live = [...(r.state as any).monsters.entries()].filter(([, m]: any) => !m.dead && m.mobId === weakest.id)
    .sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (live.length) r.send(Msg.attack, { id: live[0][0] });
}, 1500);
await until(() => got.length > before, 120_000, "no loot picked up");
clearInterval(loop);
const loot = got[got.length - 1];
console.log(`OK: looted ${ITEMS.get(loot.itemId)!.name}`);

// 5) NPC shop: back to Hearthmoor, where Mira keeps her stall. A click never walks (npc_click); it opens only within
//    npc_checknear range (15 cells). So walk into range with ordinary move requests first (each within max_walk_path), then click.
await r.travel(TOWN);
await wait(500);
const npc = (r.state as any).npcs.get("npc_merchant");
if (!npc) fail("Mira is not in Hearthmoor's room state");
const map = mapOfState(r.state as any);
const cell = () => ({ x: Math.round(me().x), y: Math.round(me().y) });
if (!npcCheckNear(cell(), npc)) {
  r.send(Msg.npc, { id: "npc_merchant" }); // out of range: nothing happens, no walking
  const c0 = cell();
  await wait(800);
  if (shop) fail("merchant opened from out of range");
  if (cell().x !== c0.x || cell().y !== c0.y) fail("clicking a far NPC moved the character");
  console.log("OK: far merchant click ignored (no shop, no walk)");
}
for (let hop = 0; hop < 30 && !npcCheckNear(cell(), npc); hop++) {
  const c = cell();
  let best: { x: number; y: number } | undefined, bd = Infinity;
  for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
    const x = c.x + dx, y = c.y + dy, d = Math.max(Math.abs(npc.x - x), Math.abs(npc.y - y));
    if (d < bd && walkable(map, x, y) && walkPath(map, c.x, c.y, x, y).length) { bd = d; best = { x, y }; }
  }
  if (!best) fail("no walkable hop toward the merchant");
  r.send(Msg.move, best!);
  await until(() => !me().moving && cell().x === best!.x && cell().y === best!.y, 8000, "hop toward the merchant did not finish");
}
/** Click Mira, pick Buy (1) or Sell (2) in her menu, press Close: her script runs callshop, the list opens. */
async function viaMira(choice: 1 | 2) {
  menu = undefined; closeBtn = false; shop = undefined;
  r.send(Msg.npc, { id: "npc_merchant" });
  await until(() => !!menu, 2000, "Mira did not answer the click with her menu");
  if (menu!.options.join("/") !== "Buy/Sell/Cancel") fail(`Mira's menu: ${menu!.options.join("/")}`);
  if (shop) fail("the shop opened before the menu was answered");
  r.send(Msg.npcMenu, { npc: "npc_merchant", choice });
  await until(() => closeBtn, 2000, "no Close button after the menu (close2)");
  r.send(Msg.npcClose, { npc: "npc_merchant" });
  await until(() => !!shop, 2000, "callshop did not open the shop");
  if (shop!.type !== choice) fail(`shop window type ${shop!.type}, expected ${choice}`);
}
const c1 = cell();
await viaMira(2);
if (cell().x !== c1.x || cell().y !== c1.y || me().moving) fail("talking to the merchant moved the character");
console.log(`OK: Mira talked at once from ${Math.max(Math.abs(npc.x - c1.x), Math.abs(npc.y - c1.y))} cells (Buy/Sell/Cancel), then callshop opened her sell list (${shop!.npc}), no walk`);
await wait(300);
const sellable = inv!.items.find((s) => s.itemId === loot.itemId && !s.equip)!;
const zeny0 = inv!.zeny;
r.send(Msg.shopSell, { npc: shop!.npc, items: [{ uid: sellable.uid, amount: 1 }] });
await until(() => inv!.zeny > zeny0 || ITEMS.get(loot.itemId)!.sell === 0, 3000, "sell did not pay");
console.log(`OK: sold ${ITEMS.get(loot.itemId)!.name} for ${inv!.zeny - zeny0} z`);
// every buy / sell list ends the shop session (clif.cpp:12324 / 12359: npc_shopid = 0, the list window closes): the server
// says so with shopClose, and a second deal needs a new click on the merchant
await until(() => shopClosed > 0, 2000, "the sell did not end the shop session (no shopClose)");
const zBefore = inv!.zeny;
r.send(Msg.shopBuy, { npc: "npc_merchant", items: [{ itemId: 501, amount: 1 }] });
await wait(500);
if (inv!.zeny !== zBefore) fail("bought without an open shop session");
console.log("OK: the sell closed the shop; a buy without a new click is refused");
await viaMira(1);
if (inv!.zeny >= 10) {
  const reds = stack(501)?.amount ?? 0;
  r.send(Msg.shopBuy, { npc: shop!.npc, items: [{ itemId: 501, amount: 1 }] });
  await until(() => (stack(501)?.amount ?? 0) === reds + 1, 3000, "buy failed");
  console.log("OK: bought a Red Tonic");
}
clearTimeout(timeout);
await r.leave();
await wait(300);
await deleteChar(url, token, char);
process.exit(0);
