// Friend list + whisper (2.3.0). rAthena: clif_parse_FriendsListAdd / FriendsListReply / FriendsListRemove (clif.cpp:15434-15600),
// clif_friendslist_* and char_friends (one row per side, MAX_FRIENDS 40); whisper = clif_parse_WisMessage + clif_wis_end.
// The server is one process, so "who is online" is a registry of character -> (room, client) shared by every map room.
import type { Client } from "@colyseus/core";
import { db } from "./db.ts";
import { redis } from "./redis.ts";
import {
  Msg, type ChannelChatEvent, type FriendAddMsg, type FriendRemoveMsg, type FriendReplyMsg, type FriendReqEvent, type FriendsEvent,
  type NoticeEvent, type WhisperMsg,
} from "../../shared/protocol.ts";

export const MAX_FRIENDS = 40;

type Who = { charId: number; name: string; client: Client };
const byChar = new Map<number, Who>();
const byName = new Map<string, Who>();
/** friend_req: asked character -> the asker (rAthena keeps it on both sides; one pending request per asked character). */
const pending = new Map<number, number>();
const offlineTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const onlineChar = (charId: number): Who | undefined => byChar.get(charId);
export const onlineName = (name: string): Who | undefined => byName.get(name);
const notice = (c: Client, text: string) => c.send(Msg.notice, { text } satisfies NoticeEvent);

async function friendIds(charId: number): Promise<number[]> {
  return (await db.query("SELECT friend_id FROM friends WHERE char_id = $1", [charId])).rows.map((r) => Number(r.friend_id));
}

/** ZC_FRIENDS_LIST: the whole list with online flags, to its owner. */
export async function sendFriends(charId: number) {
  const w = byChar.get(charId);
  if (!w) return;
  const rows = (await db.query(
    "SELECT c.id, c.name FROM friends f JOIN characters c ON c.id = f.friend_id WHERE f.char_id = $1 ORDER BY f.seq", [charId])).rows;
  const list = rows.map((r) => ({ charId: Number(r.id), name: String(r.name), online: byChar.has(Number(r.id)) }));
  if (byChar.get(charId) === w) w.client.send(Msg.friends, { list } satisfies FriendsEvent);
}

/** Tell every online friend of `charId` to refresh (it came online / went offline). rAthena's friend list is one-sided per row,
 *  so the ones who LIST this character are notified (clif_friendslist_toggle_sub). */
async function refreshWatchers(charId: number) {
  const rows = (await db.query("SELECT char_id FROM friends WHERE friend_id = $1", [charId])).rows;
  for (const r of rows) if (byChar.has(Number(r.char_id))) void sendFriends(Number(r.char_id));
}

/** A character entered a map room (login or map change). Announces "online" only when it was absent. */
export function friendsEnter(charId: number, name: string, client: Client) {
  const t = offlineTimers.get(charId);
  if (t) { clearTimeout(t); offlineTimers.delete(charId); }
  const had = byChar.has(charId);
  const w = { charId, name, client };
  byChar.set(charId, w);
  byName.set(name, w);
  void sendFriends(charId).catch((e) => console.error("[friends]", e));
  if (!had) void refreshWatchers(charId).catch((e) => console.error("[friends]", e));
}

/** The character's session in this room ended. A map change re-enters at once, so "offline" is announced after a short grace. */
export function friendsLeave(charId: number | undefined, sessionId: string) {
  if (charId === undefined) return;
  const w = byChar.get(charId);
  if (!w || w.client.sessionId !== sessionId) return; // already replaced by the next room / session
  byChar.delete(charId);
  if (byName.get(w.name) === w) byName.delete(w.name);
  for (const [to, from] of pending) if (to === charId || from === charId) pending.delete(to);
  offlineTimers.set(charId, setTimeout(() => {
    offlineTimers.delete(charId);
    if (!byChar.has(charId)) void refreshWatchers(charId).catch((e) => console.error("[friends]", e));
  }, 1500));
}

/** CZ_ADD_FRIENDS: the target must be online. */
export async function friendAdd(client: Client, me: number, m: FriendAddMsg) {
  const name = String(m?.name ?? "").trim();
  const asker = byChar.get(me);
  if (!asker || !name) return;
  const target = byName.get(name);
  if (!target) return notice(client, `${name || "That character"} is not online.`); // msg_txt 3
  if (target.charId === me) return;
  const mine = await friendIds(me);
  if (mine.length >= MAX_FRIENDS) return notice(client, "Your friend list is full."); // reqack type 2
  if (mine.includes(target.charId)) return notice(client, "Friend already exists."); // msg_txt 671
  pending.set(target.charId, me);
  target.client.send(Msg.friendReq, { charId: me, name: asker.name } satisfies FriendReqEvent);
}

/** CZ_ACK_REQ_ADD_FRIENDS: `me` answers the request of m.charId. */
export async function friendReply(client: Client, me: number, m: FriendReplyMsg) {
  const asker = Number(m?.charId);
  const self = byChar.get(me);
  if (!self || !Number.isInteger(asker) || asker === me) return;
  const from = byChar.get(asker);
  const valid = pending.get(me) === asker; // sd->friend_req must match on both sides
  if (valid) pending.delete(me);
  if (!from) return;
  if (!m.accept || !valid) return notice(from.client, `${self.name} refused your friend request.`); // reqack type 1
  // accepted: the asker's list gets the answerer, then (friend_auto_add) the answerer's list gets the asker
  const [a, b] = await Promise.all([friendIds(asker), friendIds(me)]);
  if (a.length >= MAX_FRIENDS) { notice(from.client, "Your friend list is full."); return notice(client, `${from.name}'s friend list is full.`); }
  if (b.length >= MAX_FRIENDS) { notice(client, "Your friend list is full."); return notice(from.client, `${self.name}'s friend list is full.`); }
  await db.query("INSERT INTO friends (char_id, friend_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING", [asker, me]);
  notice(from.client, `${self.name} is now your friend.`);
  notice(client, `${from.name} is now your friend.`);
  await Promise.all([sendFriends(asker), sendFriends(me)]);
}

/** CZ_DELETE_FRIENDS: the pair is removed on both sides. */
export async function friendRemove(client: Client, me: number, m: FriendRemoveMsg) {
  const other = Number(m?.charId);
  if (!Number.isInteger(other)) return;
  const had = (await db.query("DELETE FROM friends WHERE (char_id = $1 AND friend_id = $2) OR (char_id = $2 AND friend_id = $1)", [me, other])).rowCount;
  if (!had) return notice(client, "Name not found in list."); // msg_txt 672
  notice(client, "Friend removed."); // msg_txt 674
  await Promise.all([sendFriends(me), sendFriends(other)]);
}

/** CZ_WHISPER: any map; the sender gets its own copy, an offline / unknown target gets clif_wis_end(ACKWHISPER_TARGET_OFFLINE). */
export async function whisper(client: Client, me: number, m: WhisperMsg) {
  const w = byChar.get(me);
  const to = String(m?.to ?? "").trim().slice(0, 24);
  const text = String(m?.text ?? "").trim().slice(0, 120);
  if (!w || !to || !text) return;
  const k = `whisper-rate:${w.name}`;
  if ((await redis.incr(k)) === 1) await redis.expire(k, 5);
  else if (Number(await redis.get(k)) > 5) return; // 5 lines / 5 s, like chat
  const target = byName.get(to);
  if (!target) return notice(client, `${to} is not online.`);
  const ev = { channel: "whisper", from: w.name, to: target.name, text } satisfies ChannelChatEvent;
  target.client.send(Msg.channelChat, ev);
  if (target.client !== client) client.send(Msg.channelChat, ev);
}
