// End-to-end duel check (2.4.0, server/src/duel.ts): three fresh characters on the same map (A, B duel; C watches).
// A challenges B, B rejects; A challenges again, B accepts (both get Msg.duel with the other's name + id); C cannot hit A and A
// cannot hit C (battle_check_target); A and B hit each other with normal attacks until one dies (Msg.hit between them, Msg.die,
// then Msg.duel null for both and the result line in chat); then a second duel that A ends with Msg.duelLeave, and finally
// nobody can hit anyone any more. Characters are deleted at the end.
//   pnpm --filter client duel [serverUrl]
import { Msg, type ChatEvent, type DieEvent, type DuelEvent, type DuelInvitedEvent, type HitEvent, type NoticeEvent } from "../../shared/protocol.ts";
import { deleteChar, joinAs, walkNear, type BotRoom } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 180 s"), 180_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);

type Bot = Awaited<ReturnType<typeof bot>>;
async function bot(account: string, name: string) {
  const j = await joinAs(url, account, name, true);
  const room: BotRoom = j.room;
  const o = {
    ...j, name, duel: undefined as DuelEvent["duel"] | undefined, invited: [] as DuelInvitedEvent[], notices: [] as string[],
    chat: [] as ChatEvent[], hits: [] as HitEvent[], dies: [] as DieEvent[], leaving: false,
    me: () => (room.state as any).players.get(room.sessionId),
  };
  room.onLeave((code: number) => { if (!o.leaving) fail(`${name} disconnected (code ${code})`); });
  room.onMessage(Msg.duel, (m: DuelEvent) => { o.duel = m.duel; });
  room.onMessage(Msg.duelInvited, (m: DuelInvitedEvent) => { o.invited.push(m); });
  room.onMessage(Msg.notice, (m: NoticeEvent) => { o.notices.push(m.text); });
  room.onMessage(Msg.chat, (m: ChatEvent) => { o.chat.push(m); });
  room.onMessage(Msg.hit, (m: HitEvent) => { o.hits.push(m); });
  room.onMessage(Msg.die, (m: DieEvent) => { o.dies.push(m); });
  room.onMessage("*", () => {});
  return o;
}
const quit = async (b: Bot) => { b.leaving = true; await b.room.leave(); await wait(500); };
const id = (b: Bot) => b.room.sessionId;

const a = await bot("duel_bot_a", "duelbot_a");
const b = await bot("duel_bot_b", "duelbot_b");
const c = await bot("duel_bot_c", "duelbot_c");
await until(() => a.me() && b.me() && c.me(), 5000, "bots not in the world");
if (a.room.map !== b.room.map || a.room.map !== c.room.map) fail(`bots on different maps ${a.room.map} ${b.room.map} ${c.room.map}`);
await Promise.all([walkNear(b.room, () => a.me(), 1, 20_000), walkNear(c.room, () => a.me(), 1, 20_000)]);
await wait(6000); // spawn protection (invincible_timer) of fresh logins
say(`3 bots on ${a.room.map}, no duel yet`);

// nobody can hit anybody outside a duel
const swing = async (x: Bot, y: Bot, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { x.room.send(Msg.attack, { id: id(y) }); await wait(500); } };
await swing(c, a, 3000); await swing(a, c, 2000);
if ([a, b, c].some((x) => x.hits.some((h) => (h.from === id(a) || h.from === id(b) || h.from === id(c)) && (h.to === id(a) || h.to === id(b) || h.to === id(c))))) fail("a player hit another outside a duel");
say("no player-vs-player hits outside a duel");

// refusals: unknown name, self
a.room.send(Msg.duelInvite, { name: "nobody_here" });
await until(() => a.notices.some((n) => /not found/i.test(n)), 3000, "no 'not found' notice");
a.room.send(Msg.duelReply, { accept: true });
await until(() => a.notices.some((n) => /without invitation/i.test(n)), 3000, "no 'accept without invitation' notice");

// A challenges B, B rejects
a.room.send(Msg.duelInvite, { name: b.name });
await until(() => b.invited.length === 1, 3000, "B got no invitation");
if (b.invited[0].from !== a.name || b.invited[0].fromId !== id(a)) fail(`bad invitation ${JSON.stringify(b.invited[0])}`);
c.room.send(Msg.duelInvite, { name: b.name });
await until(() => c.notices.some((n) => /already in duel/i.test(n)), 3000, "C could challenge B while B has a pending invitation");
b.room.send(Msg.duelReply, { accept: false });
await until(() => a.notices.some((n) => /rejected the duel/i.test(n)), 3000, "A not told about the rejection");
if (a.duel || b.duel) fail("duel exists after a rejection");
say("A challenged, B rejected");

// again, B accepts
a.room.send(Msg.duelInvite, { name: b.name });
await until(() => b.invited.length === 2, 3000, "B got no second invitation");
b.room.send(Msg.duelReply, { accept: true });
await until(() => a.duel?.withId === id(b) && b.duel?.withId === id(a), 3000, "duel did not start for both");
if (a.duel!.with !== b.name || b.duel!.with !== a.name) fail(`bad duel events ${JSON.stringify([a.duel, b.duel])}`);
say(`duel on: A sees ${a.duel!.with}, B sees ${b.duel!.with}`);

// a third party can't hit a dueler and a dueler can't hit a third party
const n0 = [a, b, c].map((x) => x.hits.length);
await swing(c, a, 3000); await swing(a, c, 2000);
const bad = [a, b, c].flatMap((x, i) => x.hits.slice(n0[i])).filter((h) => (h.from === id(c) && h.to === id(a)) || (h.from === id(a) && h.to === id(c)) || (h.from === id(c) && h.to === id(b)));
if (bad.length) fail(`hits that must not happen: ${JSON.stringify(bad[0])}`);
say("third party C: no hits either way");

// A and B fight until one dies
c.hits.length = 0;
const fighting = (async () => { while (!a.dies.length && !b.dies.length) { a.room.send(Msg.attack, { id: id(b) }); b.room.send(Msg.attack, { id: id(a) }); await wait(600); } })();
await until(() => a.dies.length + b.dies.length > 0, 90_000, "nobody died in the duel");
await fighting;
const dead = (a.dies[0] ?? b.dies[0]).id === id(a) ? a : b, win = dead === a ? b : a;
const dmg = (f: Bot, t: Bot) => win.hits.filter((h) => h.from === id(f) && h.to === id(t) && !h.miss && h.dmg > 0).length;
if (!dmg(a, b) && !dmg(b, a)) fail("no damaging hit between the duelists");
if (win.dies[0]?.id !== id(dead) && dead.dies[0]?.id !== id(dead)) fail(`die event is not the loser's: ${JSON.stringify([a.dies, b.dies, id(a), id(b)])}`);
say(`${dead.name} died (killer ${dead.dies[0]?.killer === id(win) ? win.name : dead.dies[0]?.killer}); hits A->B ${dmg(a, b)}, B->A ${dmg(b, a)}`);
await until(() => !a.duel && !b.duel, 3000, "Msg.duel null not sent to both after the death");
await until(() => [a, b].every((x) => x.chat.some((m) => m.id === "duel" && m.text === `${win.name} won the duel against ${dead.name}.`)), 3000, "no result line in chat");
say(`duel over: "${win.chat.find((m) => m.id === "duel")!.text}"`);
// the loser is dead; after the duel the winner can no longer hit anyone
const k = win.hits.length; win.room.send(Msg.attack, { id: id(dead) }); await wait(1500);
if (win.hits.slice(k).some((h) => h.from === id(win))) fail("winner can still hit after the duel");

// second duel: A leaves, B wins
dead.room.send(Msg.respawn);
await until(() => dead.me() && !dead.me().dead, 5000, "loser did not respawn");
await Promise.all([walkNear(b.room, () => a.me(), 1, 20_000)]);
await wait(6000); // spawn protection again
a.invited.length = 0; b.invited.length = 0;
b.room.send(Msg.duelInvite, { name: a.name });
await until(() => a.invited.length === 1, 3000, "A got no invitation");
a.room.send(Msg.duelReply, { accept: true });
await until(() => !!(a.duel && b.duel), 3000, "second duel did not start");
a.room.send(Msg.duelLeave);
await until(() => !a.duel && !b.duel, 3000, "duelLeave did not end the duel");
await until(() => b.chat.some((m) => m.id === "duel" && m.text.includes(`${b.name} won the duel against ${a.name}`)), 3000, "no result line after leaving");
const k2 = b.hits.length; await swing(b, a, 2000);
if (b.hits.slice(k2).some((h) => h.from === id(b) && h.to === id(a))) fail("hit after leaving");
a.room.send(Msg.duelLeave);
await until(() => a.notices.some((n) => /without a duel/i.test(n)), 3000, "no notice for /leave without a duel");
say("second duel: A left, B won, no hits afterwards");

for (const x of [a, b, c]) await quit(x);
await deleteChar(url, a.token, a.char); await deleteChar(url, b.token, b.char); await deleteChar(url, c.token, c.char);
clearTimeout(timeout);
say("OK: duel invite / reject / accept / fight / death / leave / third-party isolation");
process.exit(0);
