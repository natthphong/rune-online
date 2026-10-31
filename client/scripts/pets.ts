// End-to-end pet check (2.4.0), dev server only (uses the dev-only Msg.devPet / Msg.devBoss shortcuts, refused in production):
// a fresh character (account pet_bot) gets Keeper Wren's starter egg through her errand, goes to the plains, tames a battle pet
// with its taming item (retrying; after 6 honest failures the dev "catch" shortcut makes the next roll succeed), hatches it, sees
// it follow, feeds it, returns it to its egg and hatches it again, relogs and finds it out again, fights a monster with it (a
// HitEvent from the pet's key), then starves it (dev: intimacy planted low, hunger 0) and checks it runs away for good (egg gone,
// pet null). The character is deleted at the end.
//   pnpm --filter client pets [serverUrl]
import { Msg, type DevBossMsg, type HitEvent, type NpcMenuEvent, type NpcMesEvent, type PetCatchResultEvent, type PetEggsEvent, type PetInfoEvent, type PetNoticeEvent } from "../../shared/protocol.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { FIELD, buildMap, type MapName } from "../../shared/maps.ts";
import { distance, walkable } from "../../shared/map.ts";
import { npcCheckNear } from "../../shared/rules/npc.ts";
import { botRoom, deleteChar, joinAs, walkNear } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 300 s"), 300_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(100); } };
const itemId = (name: string) => [...ITEMS.values()].find((i) => i.name === name)?.id ?? fail(`no item ${name}`);

const { room: r0, token, char } = await joinAs(url, process.env.PET_BOT_ACCOUNT ?? "pet_bot", "pet_bot", true);
let r = r0;
let info: PetInfoEvent["pet"] | undefined, eggs: number[] = [], inv: { uid: number; itemId: number; amount: number; petId?: number }[] = [];
const notices: string[] = [], hits: HitEvent[] = [], results: PetCatchResultEvent[] = [];
type Ev = { npc: string; t: string; options?: string[] };
const events: Ev[] = [];
let catchStart = 0;
function wire() {
  for (const t of [Msg.chat, Msg.exp, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.status, Msg.takeItem, Msg.quests, Msg.questMark, Msg.emotion, Msg.npcTalk,
    Msg.skills, Msg.cutin, Msg.announce, Msg.itemGet, Msg.petEmote, Msg.die, Msg.shop, Msg.scList, Msg.friends, Msg.party, Msg.duel]) if (t) r.onMessage(t, () => {});
  r.onMessage(Msg.petInfo, (m: PetInfoEvent) => { info = m.pet; });
  r.onMessage(Msg.petEggs, (m: PetEggsEvent) => { eggs = m.uids; });
  r.onMessage(Msg.petNotice, (m: PetNoticeEvent) => notices.push(m.text));
  r.onMessage(Msg.notice, (m: { text: string }) => notices.push(m.text));
  r.onMessage(Msg.petCatchStart, () => { catchStart++; });
  r.onMessage(Msg.petCatchResult, (m: PetCatchResultEvent) => results.push(m));
  r.onMessage(Msg.hit, (m: HitEvent) => hits.push(m));
  r.onMessage(Msg.inv, (m: { items: typeof inv }) => { inv = m.items; });
  r.onMessage(Msg.npcMes, (m: NpcMesEvent) => events.push({ npc: m.npc, t: "mes" }));
  r.onMessage(Msg.npcNextBtn, (m: { npc: string }) => events.push({ npc: m.npc, t: "next" }));
  r.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => events.push({ npc: m.npc, t: "close" }));
  r.onMessage(Msg.npcMenuList, (m: NpcMenuEvent) => events.push({ npc: m.npc, t: "menu", options: m.options }));
  r.onMessage(Msg.npcEnd, (m: { npc: string }) => events.push({ npc: m.npc, t: "end" }));
  r.onMessage(Msg.npcClear, (m: { npc: string }) => events.push({ npc: m.npc, t: "clear" }));
}
wire();
const S = () => r.state as any;
const me = () => S().players.get(r.sessionId);
const cell = () => ({ x: Math.round(me().x), y: Math.round(me().y) });
const myPet = () => [...S().pets.entries()].find(([, p]: any) => p.owner === r.sessionId) as [string, any] | undefined;
const devPet = (m: Record<string, unknown>) => r.send(Msg.devPet, m);
const devBoss = (m: DevBossMsg) => r.send(Msg.devBoss, m);
await until(() => me(), 8000, "no player");
await until(() => info !== undefined || inv.length, 4000, "no pet info / inventory at login");

// ---- Keeper Wren's errand: two Herb Teas -> a Puddlebloom egg (getitem on an egg -> pet_create_egg) ----
const KEEPER = "npc_beastkeeper";
let read = 0;
async function talk(choices: number[]) {
  const n = S().npcs.get(KEEPER) ?? fail("Keeper Wren is not in town");
  if (!npcCheckNear(cell(), n)) await walkNear(r, () => n, 2) || fail("could not reach Keeper Wren");
  read = events.length;
  r.send(Msg.npc, { id: KEEPER });
  for (;;) {
    await until(() => events.length > read, 6000, "Keeper Wren's dialog stalled");
    const ev = events[read++];
    if (ev.t === "next") { await wait(60); r.send(Msg.npcNext, { npc: KEEPER }); }
    else if (ev.t === "menu") { const c = choices.shift() ?? fail(`unexpected menu ${ev.options}`); await wait(60); r.send(Msg.npcMenu, { npc: KEEPER, choice: c }); }
    else if (ev.t === "close") { await wait(60); r.send(Msg.npcClose, { npc: KEEPER }); await wait(250); if (events.length === read) break; }
    else if (ev.t === "end") break;
  }
  await wait(300);
}
const TEA = itemId("Herb Tea");
await talk([3, 1]); // "I'd like a pet" -> "I'll bring them."
devPet({ op: "give", itemId: TEA, amount: 2 });
await until(() => inv.some((s) => s.itemId === TEA && s.amount >= 2), 3000, "dev give Herb Tea");
await talk([]); // ready: the egg
const BLOOM_EGG = itemId("Puddlebloom Egg");
await until(() => inv.some((s) => s.itemId === BLOOM_EGG && s.petId), 4000, "no Puddlebloom egg from Keeper Wren");
r.send(Msg.petCommand, { op: "info" }); // no pet out: the egg list comes with the info
await until(() => eggs.length === 1, 3000, `egg list ${JSON.stringify(eggs)}`);
console.log("ok   Keeper Wren's errand gave a Puddlebloom egg (pet row", inv.find((s) => s.itemId === BLOOM_EGG)!.petId, ")");

// ---- taming a battle pet on the plains ----
await r.travel(FIELD as MapName);
await until(() => me(), 5000, "not on the field");
console.log("ok   on", S().map);
const BEAST = 1049, TAME = itemId("Plump Worm"), FOOD = 507;
devPet({ op: "give", itemId: TAME, amount: 10 });
devPet({ op: "give", itemId: FOOD, amount: 5 });
await until(() => inv.some((s) => s.itemId === TAME), 3000, "no taming item");
const map = buildMap(S().map as MapName, S().seed);
const spawnBeast = async () => {
  const h = cell();
  const c = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]].map(([dx, dy]) => ({ x: h.x + dx, y: h.y + dy })).find((c) => walkable(map, c.x, c.y)) ?? fail("no cell");
  const before = new Set([...S().monsters.keys()]);
  devBoss({ op: "spawn", id: "", mobId: BEAST, x: c.x, y: c.y });
  return until(() => [...S().monsters.entries()].find(([k, m]: any) => !before.has(k) && m.mobId === BEAST && !m.dead)?.[0] as string, 4000, "beast did not spawn");
};
let tamed = false, tries = 0;
while (!tamed) {
  if (++tries > 12) fail("taming never succeeded");
  if (tries === 7) { devPet({ op: "catch" }); console.log("note 6 honest failures: dev shortcut makes the next roll succeed"); }
  const id = await spawnBeast();
  const st = inv.find((s) => s.itemId === TAME) ?? fail("out of taming items");
  const n0 = catchStart, k0 = results.length;
  r.send(Msg.useItem, { uid: st.uid });
  await until(() => catchStart > n0, 3000, "no petCatchStart");
  r.send(Msg.petCatch, { id });
  const res = await until(() => results[k0], 3000, "no petCatchResult");
  if (res.mobId !== BEAST) fail(`catch result for ${res.mobId}`);
  tamed = res.ok;
  console.log(`ok   taming try ${tries}: ${res.ok ? "success" : "failed"}`);
  if (!tamed) devBoss({ op: "kill", id });
  else await until(() => !S().monsters.get(id) || S().monsters.get(id).dead, 2000, "caught monster still on the map");
  await wait(400);
}
const BEAST_EGG = itemId("Cinderpaw Egg");
const egg = await until(() => inv.find((s) => s.itemId === BEAST_EGG && s.petId), 4000, "no egg after taming");
r.send(Msg.petCommand, { op: "info" });
await until(() => eggs.includes(egg.uid), 3000, "egg not in the egg list");

// ---- hatch, follow, feed, return, hatch ----
r.send(Msg.petHatch, { uid: egg.uid });
const [pkey] = await until(() => myPet(), 3000, "pet did not appear in state.pets");
await until(() => info?.mobId === BEAST, 2000, "no pet info after hatching");
if (pkey !== `pet${info!.petId}`) fail(`pet key ${pkey} vs petId ${info!.petId}`);
if (inv.some((s) => s.uid === egg.uid)) fail("egg still in the bag while the pet is out");
console.log("ok   hatched", pkey, info!.name, "intimacy", info!.intimacy, "hunger", info!.hunger, "kind", info!.kind);
const start = cell(), goal = [[8, 0], [-8, 0], [0, 8], [0, -8]].map(([dx, dy]) => ({ x: start.x + dx, y: start.y + dy })).find((c) => walkable(map, c.x, c.y)) ?? fail("no walk goal");
await walkNear(r, () => goal, 0, 15_000) || fail("bot could not walk");
await until(() => { const p = myPet()?.[1]; return p && distance(p.x - cell().x, p.y - cell().y) <= 3 && !p.moving; }, 6000, "pet did not follow");
console.log("ok   pet followed to within 3 cells");
const i0 = info!.intimacy;
devPet({ op: "hunger", value: 20 });
await until(() => info!.hunger === 20, 2000, "hunger plant");
r.send(Msg.petCommand, { op: "feed" });
await until(() => info!.hunger === 40 && info!.intimacy > i0, 2000, `feed: ${JSON.stringify(info)}`);
console.log("ok   fed: hunger 20 -> 40, intimacy", i0, "->", info!.intimacy);
r.send(Msg.petCommand, { op: "perform" });
r.send(Msg.petCommand, { op: "return" });
await until(() => info === null && !myPet(), 2000, "return to egg");
const back = await until(() => inv.find((s) => s.itemId === BEAST_EGG && s.petId === egg.petId), 3000, "egg did not come back");
console.log("ok   returned to its egg (same pet", back.petId, ")");
r.send(Msg.useItem, { uid: back.uid }); // an egg used from the bag hatches too
await until(() => myPet() && info?.petId === egg.petId && info!.hunger === 40, 3000, "re-hatch kept the pet");
console.log("ok   hatched again from the bag, hunger kept");

// ---- relog: the pet that was out comes out again ----
await r.leave();
await wait(800);
info = undefined;
r = await botRoom(url, token, char);
wire();
await until(() => me() && myPet() && info?.petId === egg.petId, 6000, "pet not out again after the relog");
console.log("ok   relog: pet out again on", S().map);

// ---- a battle pet helps from the fresh intimacy (no planting: neutral 250+ fights, our deviation from rAthena's 900) ----
console.log("     battle pet intimacy", info!.intimacy);
const map2 = buildMap(S().map as MapName, S().seed), h2 = cell();
const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: h2.x + dx, y: h2.y + dy })).find((c) => walkable(map2, c.x, c.y)) ?? fail("no cell");
const before = new Set([...S().monsters.keys()]);
devBoss({ op: "spawn", id: "", mobId: 1002, x: spot.x, y: spot.y });
const foe = await until(() => [...S().monsters.entries()].find(([k, m]: any) => !before.has(k) && m.mobId === 1002 && !m.dead)?.[0] as string, 4000, "no foe");
hits.length = 0;
const t0 = Date.now();
// the pet joins a fight with only AttackRate x intimacy band 0.5 = 10 % per owner swing (+ its own miss chance), and a Puddlebloom dies in
// 1-2 hits, so keep the plains stocked with foes and swing for up to 60 s (about 40 fights, ~60 swings)
while (!hits.some((h) => h.from === pkey && h.dmg > 0) && Date.now() - t0 < 60_000) {
  let live = [...S().monsters.entries()].find(([k, m]: any) => !before.has(k) && m.mobId === 1002 && !m.dead)?.[0];
  if (!live) {
    devBoss({ op: "spawn", id: "", mobId: 1002, x: spot.x, y: spot.y });
    live = await until(() => [...S().monsters.entries()].find(([k, m]: any) => !before.has(k) && m.mobId === 1002 && !m.dead)?.[0] as string, 4000, "no foe");
  }
  r.send(Msg.attack, { id: live });
  await wait(300);
}
const ph = hits.find((h) => h.from === pkey && h.dmg > 0) ?? fail("no damaging HitEvent from the battle pet");
if (ph.dmg <= 1) fail(`battle pet hit only ${ph.dmg}`);
console.log(`ok   battle pet hit ${ph.to} for ${ph.dmg}${ph.miss ? " (miss)" : ""}`);

// ---- starving: intimacy planted low, hunger 0 -> runs away for good ----
devPet({ op: "intimacy", value: 3 });
devPet({ op: "hunger", value: 0 });
await wait(200);
devPet({ op: "starve" });
await until(() => info === null && !myPet(), 3000, "pet did not run away");
if (!notices.some((n) => /ran away/.test(n))) fail(`no runaway notice: ${notices.slice(-3)}`);
if (inv.some((s) => s.petId === egg.petId)) fail("the runaway's egg is still in the bag");
console.log("ok   starved pet ran away for good:", notices.find((n) => /ran away/.test(n)));
if (!inv.some((s) => s.itemId === BLOOM_EGG && s.petId)) fail("the other egg went missing");

// Leftover foes from the fight would hit the owner (dead owner = no heal, no petloot) and loot the floor: kill what is near, twice
async function clearPlains() {
  for (let i = 0; i < 2; i++) {
    for (const [k, m] of [...S().monsters.entries()] as [string, any][]) if (!m.dead && distance(m.x - cell().x, m.y - cell().y) < 25) devBoss({ op: "kill", id: k });
    await wait(800);
  }
  if (me().dead) fail("the owner died");
}
// ---- a support pet heals: the Puddlebloom (petskillsupport AL_HEAL at HP <= 50 %, every 30 s) ----
await clearPlains();
const bloom = inv.find((s) => s.itemId === BLOOM_EGG && s.petId)!;
r.send(Msg.petHatch, { uid: bloom.uid });
await until(() => info?.kind === "support" && myPet(), 3000, "support pet did not hatch");
const heals: number[] = [];
r.onMessage(Msg.heal, (m: { id: string; hp?: number }) => { if (m.id === r.sessionId && m.hp) heals.push(m.hp); });
devPet({ op: "ownerHp", value: 30 });
const th = Date.now();
await until(() => { if (!heals.length && (Date.now() - th) % 5000 < 150) devPet({ op: "ownerHp", value: 30 }); return heals.length; }, 45_000, "the support pet never healed");
console.log(`ok   support pet healed its owner for ${heals[0]} HP`);

// ---- a companion pet gathers loot (petloot): Dartwing, tamed here; floor items within 4 cells reach the bag with no pickup request ----
r.send(Msg.petCommand, { op: "return" });
await until(() => info === null && !myPet(), 2000, "support pet return");
const DART = 1011, DART_TAME = 624, DART_EGG = 9006;
devPet({ op: "give", itemId: DART_TAME, amount: 5 });
devPet({ op: "catch" });
let dartId = "", dartTries = 0, dartOk = false;
while (!dartOk) {
  if (++dartTries > 5) fail("companion taming never succeeded");
  await until(() => inv.some((s) => s.itemId === DART_TAME), 3000, "no companion taming item");
  const h = cell(), c = [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dy]) => ({ x: h.x + dx, y: h.y + dy })).find((c) => walkable(map2, c.x, c.y)) ?? fail("no cell");
  const b4 = new Set([...S().monsters.keys()]);
  devBoss({ op: "spawn", id: "", mobId: DART, x: c.x, y: c.y });
  dartId = await until(() => [...S().monsters.entries()].find(([k, m]: any) => !b4.has(k) && m.mobId === DART && !m.dead)?.[0] as string, 4000, "companion mob did not spawn");
  const n0 = catchStart, k0 = results.length;
  r.send(Msg.useItem, { uid: inv.find((s) => s.itemId === DART_TAME)!.uid });
  await until(() => catchStart > n0, 3000, "no petCatchStart (companion)");
  r.send(Msg.petCatch, { id: dartId });
  dartOk = (await until(() => results[k0], 3000, "no petCatchResult (companion)")).ok;
  if (!dartOk) { devBoss({ op: "kill", id: dartId }); devPet({ op: "catch" }); }
  await wait(400);
}
const dartEgg = await until(() => inv.find((s) => s.itemId === DART_EGG && s.petId), 4000, "no companion egg");
r.send(Msg.petHatch, { uid: dartEgg.uid });
await until(() => info?.kind === "companion" && myPet(), 3000, "companion did not hatch");
console.log("ok   tamed + hatched companion", info!.name, "intimacy", info!.intimacy);
const count = (id: number) => inv.filter((s) => s.itemId === id).reduce((a, s) => a + s.amount, 0);
const FREE = 507, HELD = 508;
await clearPlains(); // monsters pick floor items up (mob_ai loot)
await until(() => ![...S().floor.values()].some((f: any) => distance(f.x - cell().x, f.y - cell().y) <= 4), 20_000, "the companion did not clear the kill drops near us"); // it gathers one per second
const free0 = count(FREE), held0 = count(HELD);
const itemGets: { itemId: number }[] = [];
r.onMessage(Msg.itemGet, (m: { itemId: number }) => itemGets.push(m));
itemGets.length = 0; notices.length = 0;
const tPlace = Date.now();
devPet({ op: "floor", itemId: HELD, value: 1 }); // another character has loot priority for 7 s
devPet({ op: "floor", itemId: FREE, value: 0 });
await until(() => count(FREE) === free0 + 1, 4000, `the companion did not gather the free floor item: floor ${JSON.stringify([...S().floor.values()].map((f: any) => [f.itemId, f.x, f.y]))} me ${JSON.stringify(cell())} pet ${JSON.stringify(myPet() && [myPet()![1].x, myPet()![1].y])} inv ${count(FREE)}/${count(HELD)}`);
console.log(`ok   companion gathered a floor item for the standing owner after ${Date.now() - tPlace} ms (no pickup sent)`);
if (itemGets.filter((g) => g.itemId === FREE).length !== 1) fail(`itemGet events ${JSON.stringify(itemGets)}`);
if (notices.some((n) => /belongs|Can't pick up/.test(n))) fail(`petloot was not quiet: ${notices}`);
if (Date.now() - tPlace < 6500) {
  if (count(HELD) !== held0) fail("the companion took an item that was still under another character's loot priority");
  console.log("ok   companion left the item held for another character alone");
}
// A wandering monster can loot the held item before its priority ends (mob_ai loot ignores loot priority, as in rAthena): that is the
// world, not a petloot bug. Keep the owner's surroundings clear and plant the item again if a monster took it.
const heldOnFloor = () => [...S().floor.values()].some((f: any) => f.itemId === HELD);
const tHeld = Date.now();
let replanted = 0;
for (let waited = 0; count(HELD) !== held0 + 1; waited += 250) {
  if (Date.now() - tHeld > 9000 + replanted * 9000) fail(`held item never gathered once its priority ran out: floor ${JSON.stringify([...S().floor.values()].filter((f: any) => distance(f.x - cell().x, f.y - cell().y) <= 6).map((f: any) => [f.itemId, f.x, f.y]))} me ${JSON.stringify(cell())} pet ${JSON.stringify(myPet() && [myPet()![1].x, myPet()![1].y])} inv ${count(FREE)}/${count(HELD)}`);
  for (const [k, m] of [...S().monsters.entries()] as [string, any][]) if (!m.dead && distance(m.x - cell().x, m.y - cell().y) < 14) devBoss({ op: "kill", id: k });
  if (!heldOnFloor() && count(HELD) === held0 && replanted < 3) { // a monster looted it: plant it again and wait out a fresh window
    replanted++; console.log("note held item was looted by a monster, planting it again");
    devPet({ op: "floor", itemId: HELD, value: 1 });
  }
  await wait(250);
}
console.log("ok   held item gathered after the priority window");

await r.leave();
await deleteChar(url, token, char);
console.log("PASS pets");
process.exit(0);
