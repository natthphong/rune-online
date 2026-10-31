// 2.3.0 friend list + whisper check (server/src/friends.ts), two fresh characters on a local server:
//   A asks B by name (B must be online), B accepts -> both lists show each other online; whispers A -> B and B -> A with B on
//   another map; a refused request; an unknown name -> notice; B logs out -> A sees it offline; remove -> both lists empty.
//   pnpm --filter client friends [url]
import { Msg, type ChannelChatEvent, type FriendReqEvent, type FriendsEvent, type NoticeEvent } from "../../shared/protocol.ts";
import { FIELD } from "../../shared/maps.ts";
import { deleteChar, joinAs } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 240 s"), 240_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(50); } };
const say = (m: string) => console.log(m);

const A = "FriendA", B = "FriendB";
const a = await joinAs(url, "friend_bot_a", A, true);
const b = await joinAs(url, "friend_bot_b", B, true);
const seen = { aList: undefined as FriendsEvent | undefined, bList: undefined as FriendsEvent | undefined, aChat: [] as ChannelChatEvent[], bChat: [] as ChannelChatEvent[],
  aNotes: [] as string[], bNotes: [] as string[], bReq: [] as FriendReqEvent[] };
a.room.onMessage(Msg.friends, (m: FriendsEvent) => { seen.aList = m; });
b.room.onMessage(Msg.friends, (m: FriendsEvent) => { seen.bList = m; });
a.room.onMessage(Msg.channelChat, (m: ChannelChatEvent) => seen.aChat.push(m));
b.room.onMessage(Msg.channelChat, (m: ChannelChatEvent) => seen.bChat.push(m));
a.room.onMessage(Msg.notice, (m: NoticeEvent) => seen.aNotes.push(m.text));
b.room.onMessage(Msg.notice, (m: NoticeEvent) => seen.bNotes.push(m.text));
b.room.onMessage(Msg.friendReq, (m: FriendReqEvent) => seen.bReq.push(m));
const aHas = (name: string, online: boolean) => !!seen.aList?.list.some((f) => f.name === name && f.online === online);

await until(() => !!seen.aList && !!seen.bList, 5000, "no initial Msg.friends on login");
if (seen.aList!.list.length || seen.bList!.list.length) fail("fresh characters should have empty lists");
say("ok  login sends an empty list");

// unknown name: notice, no request
a.room.send(Msg.friendAdd, { name: "NoSuchHero" });
await until(() => seen.aNotes.some((t) => /not online/.test(t)), 4000, "no notice for an unknown friend name");
say("ok  add unknown name -> notice");

// refused request
a.room.send(Msg.friendAdd, { name: B });
await until(() => seen.bReq.length === 1, 4000, "B got no friendReq");
if (seen.bReq[0].name !== A) fail(`friendReq names ${seen.bReq[0].name}`);
b.room.send(Msg.friendReply, { charId: seen.bReq[0].charId, accept: false });
await until(() => seen.aNotes.some((t) => /refused/.test(t)), 4000, "A got no refusal notice");
if (seen.aList!.list.length) fail("a refusal must not add anyone");
say("ok  refused request -> notice to the asker, no rows");

// accepted request
a.room.send(Msg.friendAdd, { name: B });
await until(() => seen.bReq.length === 2, 4000, "B got no second friendReq");
b.room.send(Msg.friendReply, { charId: seen.bReq[1].charId, accept: true });
await until(() => aHas(B, true) && !!seen.bList?.list.some((f) => f.name === A && f.online), 5000, "lists do not show each other online");
say("ok  accepted -> both lists show each other online");

// a reply without a request is ignored
b.room.send(Msg.friendReply, { charId: seen.bReq[1].charId, accept: true });
await wait(400);
if (seen.aList!.list.length !== 1) fail("duplicate reply changed the list");

// whispers across maps
say(`B walking from ${b.room.map}`);
await b.room.travel(FIELD, 80_000);
say(`B now on ${b.room.map}`);
if (a.room.map === b.room.map) fail("expected different maps");
a.room.send(Msg.whisper, { to: B, text: "hello from A" });
await until(() => seen.bChat.some((c) => c.text === "hello from A"), 5000, "B did not get A's whisper");
await until(() => seen.aChat.some((c) => c.text === "hello from A"), 5000, "A got no copy of its own whisper");
const w1 = seen.bChat.find((c) => c.text === "hello from A")!;
if (w1.channel !== "whisper" || w1.from !== A || w1.to !== B) fail(`bad whisper event ${JSON.stringify(w1)}`);
b.room.send(Msg.whisper, { to: A, text: "hi back" });
await until(() => seen.aChat.some((c) => c.text === "hi back" && c.from === B), 5000, "A did not get B's whisper");
await until(() => seen.bChat.some((c) => c.text === "hi back"), 5000, "B got no copy");
say(`ok  whispers A (${a.room.map}) <-> B (${b.room.map})`);
if (!aHas(B, true)) fail("B flickered offline in A's list after a map change");

// whisper to nobody
a.room.send(Msg.whisper, { to: "Nobody", text: "anyone?" });
await until(() => seen.aNotes.some((t) => /Nobody is not online/.test(t)), 4000, "no notice for whispering an unknown name");
say("ok  whisper to unknown name -> notice");

// B logs out -> offline in A's list
await b.room.leave();
await until(() => aHas(B, false), 6000, "A never saw B go offline");
say("ok  B logged out -> offline in A's list");

// B back (same room objects are gone, rejoin) then remove from A's side
const b2 = await joinAs(url, "friend_bot_b", B);
let bList: FriendsEvent | undefined;
b2.room.onMessage(Msg.friends, (m: FriendsEvent) => { bList = m; });
await until(() => aHas(B, true), 6000, "A never saw B come back online");
await until(() => !!bList && bList.list.some((f) => f.name === A && f.online), 5000, "B's list lost A across a relog");
say("ok  B relog -> online again, list persisted");
a.room.send(Msg.friendRemove, { charId: seen.aList!.list.find((f) => f.name === B)!.charId });
await until(() => seen.aList!.list.length === 0 && bList!.list.length === 0, 5000, "remove did not clear both lists");
say("ok  remove -> both lists empty");

await b2.room.leave(); await a.room.leave();
await deleteChar(url, a.token, a.char).catch(() => {});
await deleteChar(url, b2.token, b2.char).catch(() => {});
clearTimeout(timeout);
say("friends: all ok");
process.exit(0);
