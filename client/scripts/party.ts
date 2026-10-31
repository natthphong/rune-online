// End-to-end party check (2.3.0, server/src/party.ts): two fresh characters; A is planted Job Lv 10 with 9 skill points in the dev
// schema (the deployed schema is refused) and learns Basic Training 7 (party creation needs it, basic_skill_check). Then, through
// the ordinary protocol: A creates a party, invites B, B accepts, both get the 2-member list; party chat both ways; EXP share
// "even"; on the Verdant Plains A kills monsters while B only stands by, and B still gets EXP from A's kill (party_exp_share);
// B leaves and A's list drops to 1; A leaves (the party breaks up) and both characters are deleted.
//   pnpm --filter client party [serverUrl]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Msg, type ChannelChatEvent, type ExpEvent, type PartyEvent, type PartyInvitedEvent, type PartyNoticeEvent, type PartyUpdateEvent, type SkillsEvent,
} from "../../shared/protocol.ts";
import { FIELD } from "../../shared/maps.ts";
import { SKILL_ID } from "../../shared/rules/skill.ts";
import { deleteChar, joinAs, walkNear, type BotRoom } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 240 s"), 240_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);

// ---------- Postgres (the dev schema the server uses; never the deployed one) ----------
const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing to plant into schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

type Bot = Awaited<ReturnType<typeof bot>>;
async function bot(account: string, name: string, fresh: boolean) {
  const j = await joinAs(url, account, name, fresh);
  const room: BotRoom = j.room;
  const o = {
    ...j, name, party: undefined as PartyEvent["party"] | undefined, invited: [] as PartyInvitedEvent[], chat: [] as ChannelChatEvent[],
    notices: [] as string[], updates: [] as PartyUpdateEvent[], exp: [] as ExpEvent[], skills: undefined as SkillsEvent | undefined, leaving: false,
    me: () => (room.state as any).players.get(room.sessionId),
  };
  room.onLeave((code: number) => { if (!o.leaving) fail(`${name} disconnected (code ${code})`); });
  room.onMessage(Msg.party, (m: PartyEvent) => { o.party = m.party; });
  room.onMessage(Msg.partyInvited, (m: PartyInvitedEvent) => { o.invited.push(m); });
  room.onMessage(Msg.channelChat, (m: ChannelChatEvent) => { o.chat.push(m); });
  room.onMessage(Msg.partyNotice, (m: PartyNoticeEvent) => { o.notices.push(m.text); });
  room.onMessage(Msg.partyUpdate, (m: PartyUpdateEvent) => { o.updates.push(m); });
  room.onMessage(Msg.exp, (m: ExpEvent) => { o.exp.push(m); });
  room.onMessage(Msg.skills, (m: SkillsEvent) => { o.skills = m; });
  room.onMessage("*", () => {});
  return o;
}
const quit = async (b: Bot) => { b.leaving = true; await b.room.leave(); await wait(500); };

// ---- fresh characters; A planted Job Lv 10 / 9 skill points
let a = await bot("party_bot_a", "partybot_a", true);
await quit(a);
await db.query("UPDATE characters SET job_level = 10, skill_points = 9 WHERE id = $1", [a.char.id]);
a = await bot("party_bot_a", "partybot_a", false);
const b = await bot("party_bot_b", "partybot_b", true);
await until(() => a.party === null && b.party === null, 5000, "no Msg.party {party: null} at login");
say("both logged in, no party (Msg.party null at map entry)");

// party creation needs Basic Training 7
a.room.send(Msg.partyCreate, { name: "too early" });
await wait(600);
if (a.party) fail("party created without Basic Training 7");
for (let i = 0; i < 7; i++) a.room.send(Msg.skillUp, { id: SKILL_ID.NV_BASIC });
await until(() => a.skills?.list.find((s) => s.id === SKILL_ID.NV_BASIC)?.lv === 7, 5000, "Basic Training not learned to 7");

const PARTY = `pbot${Math.floor(Math.random() * 1e6)}`;
a.room.send(Msg.partyCreate, { name: PARTY });
await until(() => a.party?.name === PARTY && a.party.members.length === 1 && a.party.members[0].leader, 5000, "party not created");
say(`A created "${PARTY}"`);

// invite -> accept
a.room.send(Msg.partyInvite, { name: b.name });
await until(() => b.invited.length > 0, 5000, "B got no invitation");
if (b.invited[0].partyName !== PARTY || b.invited[0].from !== a.name) fail(`bad invitation ${JSON.stringify(b.invited[0])}`);
b.room.send(Msg.partyReply, { partyId: b.invited[0].partyId, accept: true });
await until(() => a.party?.members.length === 2 && b.party?.members.length === 2, 5000, "both should see 2 members");
const bm = a.party!.members.find((m) => m.name === b.name)!;
if (!bm.online || bm.leader || bm.map !== b.room.map || !(bm.maxHp > 0)) fail(`B's member row on A: ${JSON.stringify(bm)}`);
say(`B joined: A sees ${a.party!.members.map((m) => `${m.name}${m.leader ? "*" : ""} ${m.map} ${m.hp}/${m.maxHp}`).join(", ")}`);

// party chat both ways (any map, the speaker too)
a.room.send(Msg.partyChat, { text: "hello party" });
await until(() => b.chat.some((c) => c.channel === "party" && c.from === a.name && c.text === "hello party"), 5000, "B did not hear A's party chat");
b.room.send(Msg.partyChat, { text: "hi leader" });
await until(() => a.chat.some((c) => c.channel === "party" && c.from === b.name && c.text === "hi leader"), 5000, "A did not hear B's party chat");
say("party chat round trip");

// leader change (same map) and back
a.room.send(Msg.partyLeader, { charId: b.char.id });
await until(() => b.party?.members.find((m) => m.name === b.name)?.leader === true && a.party?.members.find((m) => m.name === a.name)?.leader === false, 5000, "leader not changed to B");
b.room.send(Msg.partyLeader, { charId: a.char.id });
await until(() => a.party?.members.find((m) => m.name === a.name)?.leader === true, 5000, "leader not changed back to A");
say("leadership A -> B -> A");

// a non-leader can't change options; the leader sets EXP share even
b.room.send(Msg.partyOption, { exp: "even" });
await wait(500);
if (a.party?.exp !== "each") fail("a member changed the EXP option");
a.room.send(Msg.partyOption, { exp: "even" });
await until(() => a.party?.exp === "even" && b.party?.exp === "even", 5000, "EXP share not even");
say("EXP share: even");

// both to the Verdant Plains; B gets A's map change
await Promise.all([a.room.travel(FIELD), b.room.travel(FIELD)]);
await until(() => b.party?.members.find((m) => m.name === a.name)?.map === FIELD || b.updates.some((u) => u.map === FIELD), 8000, "B was not told A's map");
say(`both on ${a.room.map}; party list refilled after the warp: ${a.party?.members.length} members`);

// A hunts; B follows and never attacks: B must still get EXP from A's kill
let hunting = true;
void (async () => { while (hunting) { await walkNear(b.room, () => a.me(), 3, 1500); await wait(300); } })();
const bExp0 = b.exp.length;
const posUpdates0 = b.updates.filter((u) => u.x !== undefined).length;
const end = Date.now() + 150_000;
const skip = new Set<string>();
while (!b.exp.slice(bExp0).some((e) => e.base > 0 && !e.quest && !e.lost)) {
  if (Date.now() > end) fail("no shared EXP reached B");
  const S = a.room.state as any, p = a.me();
  if (!p || p.dead) { if (p?.dead) a.room.send(Msg.respawn); await wait(1000); continue; }
  const mobs = [...S.monsters.entries()].filter(([id, m]: any) => !m.dead && !skip.has(id))
    .sort(([, m1]: any, [, m2]: any) => Math.hypot(m1.x - p.x, m1.y - p.y) - Math.hypot(m2.x - p.x, m2.y - p.y));
  if (!mobs.length) { await wait(1000); continue; }
  const [id] = mobs[0];
  if (!(await walkNear(a.room, () => S.monsters.get(id), 1, 8000))) { skip.add(id); continue; }
  for (let i = 0; i < 20 && S.monsters.get(id) && !S.monsters.get(id).dead; i++) { a.room.send(Msg.attack, { id }); await wait(1000); }
}
hunting = false;
const got = b.exp.slice(bExp0).find((e) => e.base > 0)!;
say(`B got ${got.base} base / ${got.job} job EXP from A's kill (A got ${a.exp.at(-1)?.base} / ${a.exp.at(-1)?.job})`);
if (b.updates.filter((u) => u.x !== undefined).length === posUpdates0) fail("B got no position update of A on the same map");
say("position updates arrive while walking");

// B leaves: A's list drops to 1, B's party is null
b.room.send(Msg.partyLeave);
await until(() => b.party === null && a.party?.members.length === 1, 5000, "B's leave not seen");
if (!a.notices.some((n) => n.includes(b.name))) fail("A got no notice of B leaving");
say("B left; A's party has 1 member");

// re-invite B and expel it
b.invited.length = 0;
a.room.send(Msg.partyInvite, { name: b.name });
await until(() => b.invited.length > 0, 5000, "B got no second invitation");
b.room.send(Msg.partyReply, { partyId: b.invited[0].partyId, accept: true });
await until(() => a.party?.members.length === 2 && b.party?.members.length === 2, 5000, "B did not rejoin");
a.room.send(Msg.partyKick, { charId: b.char.id });
await until(() => b.party === null && a.party?.members.length === 1, 5000, "B was not expelled");
say("B rejoined and was expelled");

// clean up: the leader leaves (the party breaks up), back to town, characters deleted
a.room.send(Msg.partyLeave);
await until(() => a.party === null, 5000, "A's leave not seen");
const rows = (await db.query("SELECT count(*)::int AS n FROM party WHERE name = $1", [PARTY])).rows[0].n;
if (rows !== 0) fail("party row left behind");
await quit(a); await quit(b);
await deleteChar(url, a.token, a.char); await deleteChar(url, b.token, b.char);
await db.end();
clearTimeout(timeout);
say("OK: party create / invite / accept / chat / even EXP share / leave / disband");
process.exit(0);
