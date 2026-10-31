// Headless multiplayer smoke test: two bots join, one walks and chats, the other must see it.
//   pnpm --filter client smoke [serverUrl]      (default http://localhost:2567)
// Events reach only the players rAthena's clif_send reaches (server/src/area.ts: chat within area_size - 5 cells, hits within
// area_size of the target), so B first walks up to A and follows it. Stats, points, EXP, HP and SP reach only their owner.
import { Callbacks } from "@colyseus/sdk";
import { Msg, type ChatEvent, type HitEvent, type StatusEvent } from "../../shared/protocol.ts";
import { joinAs, walkNear } from "./bot.ts";
import { findPath } from "../../shared/map.ts";
import { FIELD, TOWN, mapOfState } from "../../shared/maps.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 150s"), 150_000);

// fixed names so repeated runs reuse the same two DB rows
// accounts + characters are created on first run and reused afterwards
// each bot listens for its own Msg.status right after joining (the first one is sent at once, with the inventory)
const statusA: StatusEvent[] = [], statusB: StatusEvent[] = [];
const { room: a } = await joinAs(url, "smoke_bot_a", "smoke_a");
a.onMessage(Msg.status, (m: StatusEvent) => statusA.push(m));
a.onMessage("*", () => {}); // other owner messages (inventory, hotkeys, quests ...) aren't checked here
const { room: b } = await joinAs(url, "smoke_bot_b", "smoke_b");
b.onMessage(Msg.status, (m: StatusEvent) => statusB.push(m));
b.onMessage("*", () => {});
// both start in Hearthmoor (a run that stopped half way may have left one of them on a field: walk it back first)
await Promise.all([a.travel(TOWN), b.travel(TOWN)]);
console.log(`joined ${a.sessionId} + ${b.sessionId} on ${url} (${a.map})`);

// owner-only numbers (clif_updatestatus / clif_couplestatus / clif_par_change are SELF): B's copy of A carries none of them,
// and each bot got its own Msg.status
await new Promise((r) => setTimeout(r, 300));
const PRIVATE = ["hp", "maxHp", "sp", "maxSp", "exp", "jobLevel", "jobExp", "statPoints", "skillPoints", "str", "agi", "vit", "int", "dex", "luk"];
const aOnB = (b.state as any).players.get(a.sessionId);
if (!aOnB) fail("B does not see A");
const leaked = PRIVATE.filter((k) => aOnB[k] !== undefined);
if (leaked.length) fail(`B's state copy of A carries ${leaked.join(", ")}`);
if (!statusA.length || !statusB.length) fail("a bot got no Msg.status of its own");
console.log(`OK: B sees A's look/name/job/level only (level ${aOnB.level}); A's own status: HP ${statusA.at(-1)!.hp}/${statusA.at(-1)!.maxHp}, ${statusA.at(-1)!.statPoints} points`);

// B walks up to A: public chat is heard within area_size - 5 = 9 cells (AREA_CHAT_WOC)
const posA = () => (b.state as any).players.get(a.sessionId);
if (!(await walkNear(b, posA, 3))) fail("B could not walk up to A");

a.onMessage(Msg.chat, () => {});
const sawChat = new Promise<void>((ok) => b.onMessage(Msg.chat, (m: ChatEvent) => { if (m.id === a.sessionId) ok(); }));
const sawMove = new Promise<void>((ok) => {
  const cb = Callbacks.get(b);
  const p = (b.state as any).players.get(a.sessionId), x0 = p.x, y0 = p.y;
  cb.onChange(p, () => { if (p.x !== x0 || p.y !== y0) ok(); });
});

const me = (a.state as any).players.get(a.sessionId);
// walk to the first reachable tile near A (saved positions can sit next to water/trees)
const world = mapOfState(a.state as any), mx = Math.round(me.x), my = Math.round(me.y);
const dest = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, -3], [3, -3], [-3, 3]]
  .map(([dx, dy]) => ({ x: mx + dx, y: my + dy }))
  .find((t) => findPath(world, mx, my, t.x, t.y).length > 0);
if (!dest) fail(`no reachable tile around ${mx},${my}`);
a.send(Msg.move, dest);
a.send(Msg.chat, { text: "hello from smoke test" });

await Promise.all([sawChat, sawMove]);
console.log("OK: B saw A move and chat");

// W01: the town has no monsters: both walk out through the west gate to the Verdant Plains (the bots follow the warp)
for (const t of [Msg.hit, Msg.die, Msg.levelUp]) { a.onMessage(t, () => {}); if (t !== Msg.hit) b.onMessage(t, () => {}); }
await Promise.all([a.travel(FIELD), b.travel(FIELD)]);
await new Promise((r) => setTimeout(r, 500));
console.log(`OK: both walked through the west gate to ${a.map}`);

// combat: A walks up to the nearest live monster it can reach and attacks it (the real client walks into range first: a far
// target behind a tree or water is dropped by the attack timer, rules/unit.ts), while B follows A; B must see A land a hit
// (clif_damage goes to the area of the target)
let hitBy: string | undefined;
const sawHit = new Promise<void>((ok) => b.onMessage(Msg.hit, (m: HitEvent) => { if (m.from === a.sessionId) { hitBy = m.to; ok(); } }));
let fighting = true;
void (async () => { while (fighting) { await walkNear(b, posA, 3, 1500); await new Promise((ok) => setTimeout(ok, 300)); } })();
void (async () => {
  const skip = new Set<string>();
  while (fighting) {
    const p = (a.state as any).players.get(a.sessionId);
    const mobs = [...(a.state as any).monsters.entries()].filter(([id, m]: any) => !m.dead && !skip.has(id))
      .sort(([, m1]: any, [, m2]: any) => Math.hypot(m1.x - p.x, m1.y - p.y) - Math.hypot(m2.x - p.x, m2.y - p.y));
    if (!mobs.length) fail("no reachable monster in room");
    const [id] = mobs[0];
    if (await walkNear(a, () => (a.state as any).monsters.get(id), 1, 8000)) a.send(Msg.attack, { id });
    else skip.add(id);
    await new Promise((ok) => setTimeout(ok, 2000));
  }
})();
await sawHit;
fighting = false;
clearTimeout(timeout);
console.log(`OK: A walked up to mob #${(a.state as any).monsters.get(hitBy!)?.mobId} (${hitBy}) and B saw it land a swing`);
await a.leave();
await b.leave();
process.exit(0);
