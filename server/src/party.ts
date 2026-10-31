// Parties (2.3.0), re-implemented from rAthena: src/map/party.cpp (create / invite / reply / leave / expel / leader / option /
// message / party_send_xy_timer / party_exp_share / party_share_loot), the char-server side src/char/int_party.cpp (storage, the
// even-share level check, a leaving leader breaks the party) and the clif party packets. Pure rules in shared/rules/party.ts.
//
// The server is ONE process, so the party registry is module-level and spans every map room: a party is loaded when its first
// member logs in and dropped when its last member goes offline. Writes go straight to Postgres (tables party / party_member,
// migration 017). Members get Msg.party (ZC_GROUP_LIST, whole list) on membership / option / leader changes and
// Msg.partyUpdate (clif_party_xy / clif_party_hp / map / online) for the rest; position only to members on the same map.
import type { Client } from "@colyseus/core";
import { db } from "./db.ts";
import { redis } from "./redis.ts";
import {
  Msg, type ChannelChatEvent, type ChatMsg, type PartyCreateMsg, type PartyEvent, type PartyInviteMsg, type PartyInvitedEvent,
  type PartyKickMsg, type PartyLeaderMsg, type PartyMember, type PartyNoticeEvent, type PartyOptionMsg, type PartyReplyMsg, type PartyShare,
  type PartyUpdateEvent,
} from "../../shared/protocol.ts";
import { MAX_PARTY, PARTY_CONF, partyCheckExpShare, partyLootPick, partyName } from "../../shared/rules/party.ts";
import { BASIC_SKILL_NEED } from "../../shared/rules/skill.ts";
import { BATTLE_CONF } from "../../shared/rules/battle.ts";
import { distance } from "../../shared/map.ts";
import type { MapRoom } from "./rooms/MapRoom.ts";

/** A member's live session: the room it plays in and its session id there (party_data.data[i].sd). */
type Sd = { room: MapRoom; sid: string };
type Member = {
  charId: number; accountId: number; name: string; level: number; job: string; leader: boolean;
  online: boolean; map: string; x: number; y: number; hp: number; maxHp: number;
  sd?: Sd; // undefined while offline or between two map rooms (a warp: still online, like a map-server change)
  sent: { x: number; y: number; hp: number; maxHp: number; map: string }; // party_data.data[i].x / y / hp: last values sent out
  awayTimer?: ReturnType<typeof setTimeout>; // a map change that never arrives turns into a logout
};
type Party = { id: number; name: string; exp: PartyShare; item: PartyShare; members: Member[] };

const parties = new Map<number, Party>();
const partyOfChar = new Map<number, number>(); // charId -> party id, for characters of loaded parties
/** Every character in game (map_nick2sd / map_charid2sd across rooms), party or not. */
const onlineChars = new Map<number, Sd & { name: string; accountId: number }>();
/** sd->party_invite / party_invite_account: invitee charId -> the pending invite. */
const invites = new Map<number, { partyId: number; from: number; timer: ReturnType<typeof setTimeout> }>();
/** sd->party_creating / party_joining: a create or a join is being written. */
const busy = new Set<number>();

const shareOf = (v: number): PartyShare => (v ? "even" : "each");
const charSend = (charId: number, type: string, msg: unknown) => {
  const o = onlineChars.get(charId);
  o?.room.clients.getById(o.sid)?.send(type, msg);
};
const notice = (charId: number, text: string) => charSend(charId, Msg.partyNotice, { text } satisfies PartyNoticeEvent);
const pcOf = (sd: Sd | undefined) => (sd ? sd.room.state.players.get(sd.sid) : undefined);
const charIdOf = (room: MapRoom, sid: string) => room.charIdOf(sid);

function memberView(m: Member): PartyMember {
  return { charId: m.charId, name: m.name, online: m.online, map: m.map, x: m.x, y: m.y, hp: m.online ? m.hp : 0, maxHp: m.maxHp,
    level: m.level, job: m.job, leader: m.leader };
}
function partyView(p: Party): PartyEvent {
  return { party: { id: p.id, name: p.name, exp: p.exp, item: p.item, members: p.members.map(memberView) } };
}
/** clif_party_info to every online member (PARTY). */
function sendParty(p: Party) {
  const ev = partyView(p);
  for (const m of p.members) if (m.online) charSend(m.charId, Msg.party, ev);
}
function sendUpdate(p: Party, ev: PartyUpdateEvent, sameMapAs?: string, except?: number) {
  for (const m of p.members) {
    if (!m.online || m.charId === except) continue;
    if (sameMapAs !== undefined && m.map !== sameMapAs) continue;
    charSend(m.charId, Msg.partyUpdate, ev);
  }
}
function noticeAll(p: Party, text: string, except?: number) { for (const m of p.members) if (m.online && m.charId !== except) notice(m.charId, text); }

/** Live numbers of a member into its record (from the player it plays). */
function refresh(m: Member) {
  const pc = pcOf(m.sd);
  if (!pc || !m.sd) return;
  m.map = m.sd.room.mapName; m.x = Math.round(pc.x); m.y = Math.round(pc.y); m.hp = pc.hp; m.maxHp = pc.maxHp; m.level = pc.level; m.job = pc.job;
}

/** int_party_check_lv: even EXP share falls back to "each" when the online members' levels are too far apart. */
async function checkLevels(p: Party) {
  if (p.exp !== "even" || partyCheckExpShare(p.members.filter((m) => m.online).map((m) => m.level))) return false;
  p.exp = "each";
  await db.query("UPDATE party SET exp_share = 0 WHERE id = $1", [p.id]);
  noticeAll(p, `EXP share switched to "each": the members' levels are more than ${PARTY_CONF.party_share_level} apart.`);
  return true;
}

function unloadIfEmpty(p: Party) {
  if (p.members.some((m) => m.online)) return;
  parties.delete(p.id);
  for (const m of p.members) { partyOfChar.delete(m.charId); if (m.awayTimer) clearTimeout(m.awayTimer); }
}

async function loadParty(partyId: number): Promise<Party | undefined> {
  const pr = (await db.query("SELECT id, name, exp_share, item_share, leader_id FROM party WHERE id = $1", [partyId])).rows[0];
  if (!pr) return undefined;
  if (parties.has(partyId)) return parties.get(partyId); // loaded by another login meanwhile
  const rows = (await db.query(
    `SELECT c.id, c.account_id, c.name, c.level, c.job, c.last_map, c.x, c.y FROM party_member pm JOIN characters c ON c.id = pm.char_id
       WHERE pm.party_id = $1 ORDER BY pm.joined_at, c.id`, [partyId])).rows;
  const p: Party = {
    id: pr.id, name: pr.name, exp: shareOf(pr.exp_share), item: shareOf(pr.item_share),
    members: rows.map((r) => ({
      charId: Number(r.id), accountId: Number(r.account_id), name: r.name, level: r.level, job: r.job, leader: Number(r.id) === Number(pr.leader_id),
      online: false, map: r.last_map, x: r.x, y: r.y, hp: 0, maxHp: 0, sent: { x: -1, y: -1, hp: -1, maxHp: -1, map: "" },
    })),
  };
  if (parties.has(partyId)) return parties.get(partyId);
  parties.set(partyId, p);
  for (const m of p.members) partyOfChar.set(m.charId, p.id);
  return p;
}

// ---------- login / logout / map change ----------
/** party_member_joined at map entry (MapRoom.enter, after the player is in the state): the party is loaded if needed, the member
 *  is online on this map, the owner gets the whole list and the others the change. */
export async function enter(room: MapRoom, sid: string, charId: number, accountId: number) {
  const pc = room.state.players.get(sid);
  if (!pc) return;
  onlineChars.set(charId, { room, sid, name: pc.name, accountId });
  const pid = partyOfChar.get(charId) ?? (await db.query("SELECT party_id FROM party_member WHERE char_id = $1", [charId])).rows[0]?.party_id;
  const p = pid === undefined ? undefined : parties.get(Number(pid)) ?? (await loadParty(Number(pid)));
  if (onlineChars.get(charId)?.sid !== sid) return; // left again while loading
  const m = p?.members.find((x) => x.charId === charId);
  if (!p || !m) { room.clients.getById(sid)?.send(Msg.party, { party: null } satisfies PartyEvent); return; }
  const wasOnline = m.online;
  if (m.awayTimer) { clearTimeout(m.awayTimer); m.awayTimer = undefined; }
  m.sd = { room, sid }; m.online = true;
  refresh(m);
  m.sent = { x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, map: m.map };
  room.clients.getById(sid)?.send(Msg.party, partyView(p));
  if (wasOnline) sendUpdate(p, { charId, map: m.map, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp }, undefined, charId); // a warp (clif_party_info after a map change)
  else {
    sendUpdate(p, { charId, online: true, map: m.map, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, }, undefined, charId);
    if (await checkLevels(p)) sendParty(p);
  }
}

/** map_quit / a map change (MapRoom.evict). A map change keeps the member online until the next room loads it; a logout marks
 *  it offline (a leader logging out keeps the party, rAthena). Pending invites to the character are dropped. */
export function leave(room: MapRoom, sid: string, charId: number | undefined, changingMap: boolean) {
  if (charId === undefined) return;
  const o = onlineChars.get(charId);
  if (!o || o.room !== room || o.sid !== sid) return; // an older session (the new one already registered)
  onlineChars.delete(charId);
  const inv = invites.get(charId);
  if (inv) { clearTimeout(inv.timer); invites.delete(charId); }
  const p = parties.get(partyOfChar.get(charId) ?? -1), m = p?.members.find((x) => x.charId === charId);
  if (!p || !m) return;
  refresh(m);
  m.sd = undefined;
  const off = () => {
    m.awayTimer = undefined;
    if (m.sd) return;
    m.online = false;
    sendUpdate(p, { charId, online: false });
    unloadIfEmpty(p);
  };
  if (changingMap) m.awayTimer = setTimeout(off, 20_000);
  else off();
}

// ---------- requests (MapRoom.onGuarded handlers) ----------
/** clif_parse_CreateParty2 -> party_create -> party_created. */
export async function create(room: MapRoom, client: Client, m: PartyCreateMsg) {
  const charId = charIdOf(room, client.sessionId), pc = room.state.players.get(client.sessionId);
  if (charId === undefined || !pc) return;
  if (!room.skills.basicOk(client.sessionId, BASIC_SKILL_NEED.partyCreate)) return room.skills.fail(client.sessionId, 1, "basic"); // clif.cpp:13831
  const name = partyName(m?.name);
  if (!name) return;
  if (partyOfChar.has(charId) || busy.has(charId)) return notice(charId, "You are already in a party."); // clif_party_created(2)
  busy.add(charId);
  try {
    const r = await db.query(
      `WITH p AS (INSERT INTO party (name, leader_id) VALUES ($1, $2) RETURNING id)
         INSERT INTO party_member (party_id, char_id) SELECT id, $2 FROM p RETURNING party_id`, [name, charId]);
    const id = Number(r.rows[0].party_id);
    const o = onlineChars.get(charId);
    const me: Member = { charId, accountId: o?.accountId ?? 0, name: pc.name, level: pc.level, job: pc.job, leader: true, online: true,
      map: room.mapName, x: 0, y: 0, hp: 0, maxHp: 0, sd: o ? { room: o.room, sid: o.sid } : undefined, sent: { x: -1, y: -1, hp: -1, maxHp: -1, map: "" } };
    refresh(me);
    me.sent = { x: me.x, y: me.y, hp: me.hp, maxHp: me.maxHp, map: me.map };
    const p: Party = { id, name, exp: "each", item: "each", members: [me] };
    parties.set(id, p); partyOfChar.set(charId, id);
    notice(charId, `Party "${name}" created.`);
    sendParty(p);
    if (!o) leave(room, client.sessionId, charId, false); // logged out while it was written
  } catch (e) {
    if ((e as { code?: string }).code === "23505") notice(charId, "That party name is already taken."); // clif_party_created(1)
    else { console.error("[party] create", e); notice(charId, "The party could not be created."); }
  } finally {
    busy.delete(charId);
  }
}

/** clif_parse_PartyInvite2 -> party_invite (party.cpp:383): leader only, the invitee online (any map), not in a party and with no
 *  other invite pending; one character per account in a party (block_account_in_same_party). */
export function invite(room: MapRoom, client: Client, m: PartyInviteMsg) {
  const charId = charIdOf(room, client.sessionId);
  if (charId === undefined) return;
  const p = parties.get(partyOfChar.get(charId) ?? -1);
  if (!p) return notice(charId, "You are not in a party.");
  if (!p.members.find((x) => x.charId === charId)?.leader) return notice(charId, "You need to be a party leader to use this command."); // msg 282
  const name = String(m?.name ?? "").trim();
  const [tid, t] = [...onlineChars].find(([, o]) => o.name === name) ?? [];
  if (tid === undefined || !t) return notice(charId, `${name || "That character"} is not online.`); // PARTY_REPLY_OFFLINE
  if (tid === charId) return;
  if (PARTY_CONF.block_account_in_same_party && p.members.some((x) => x.accountId === t.accountId))
    return notice(charId, `${t.name} can't join: another character of that account is in the party.`); // PARTY_REPLY_DUAL
  if (p.members.length >= MAX_PARTY) return notice(charId, `${t.name} can't join: the party is full.`); // PARTY_REPLY_FULL
  if (partyOfChar.has(tid) || invites.has(tid) || busy.has(tid)) return notice(charId, `${t.name} is already in a party or answering another invitation.`); // PARTY_REPLY_JOIN_OTHER_PARTY
  const timer = setTimeout(() => {
    if (invites.get(tid)?.timer !== timer) return;
    invites.delete(tid);
    notice(charId, `${t.name} did not answer the invitation.`);
  }, PARTY_CONF.invite_timeout);
  invites.set(tid, { partyId: p.id, from: charId, timer });
  charSend(tid, Msg.partyInvited, { partyId: p.id, partyName: p.name, from: onlineChars.get(charId)?.name ?? "" } satisfies PartyInvitedEvent); // clif_party_invite
  notice(charId, `Invitation sent to ${t.name}.`);
}

/** clif_parse_ReplyPartyInvite -> party_reply_invite (party.cpp:571) -> party_member_added. */
export async function reply(room: MapRoom, client: Client, m: PartyReplyMsg) {
  const charId = charIdOf(room, client.sessionId), pc = room.state.players.get(client.sessionId);
  if (charId === undefined || !pc) return;
  const inv = invites.get(charId);
  if (!inv) return;
  clearTimeout(inv.timer); invites.delete(charId);
  if (inv.partyId !== Number(m?.partyId) || partyOfChar.has(charId)) return; // forged / already in a party: no answer (Aegis)
  const p = parties.get(inv.partyId);
  if (!m?.accept || !p) { if (p) notice(inv.from, `${pc.name} declined the invitation.`); return; } // PARTY_REPLY_REJECTED
  if (p.members.length >= MAX_PARTY) return notice(inv.from, `${pc.name} can't join: the party is full.`);
  busy.add(charId);
  try {
    await db.query("INSERT INTO party_member (party_id, char_id) VALUES ($1, $2)", [p.id, charId]);
  } catch (e) {
    console.error("[party] join", e);
    return notice(charId, "Could not join the party.");
  } finally {
    busy.delete(charId);
  }
  const o = onlineChars.get(charId);
  if (parties.get(p.id) !== p) { await db.query("DELETE FROM party_member WHERE char_id = $1", [charId]); return; } // broken up meanwhile
  const me: Member = { charId, accountId: o?.accountId ?? 0, name: pc.name, level: pc.level, job: pc.job, leader: false, online: !!o, map: room.mapName,
    x: 0, y: 0, hp: 0, maxHp: 0, sd: o ? { room: o.room, sid: o.sid } : undefined, sent: { x: -1, y: -1, hp: -1, maxHp: -1, map: "" } };
  refresh(me);
  me.sent = { x: me.x, y: me.y, hp: me.hp, maxHp: me.maxHp, map: me.map };
  p.members.push(me); partyOfChar.set(charId, p.id);
  notice(inv.from, `${pc.name} accepted the invitation.`); // PARTY_REPLY_ACCEPTED
  noticeAll(p, `${pc.name} joined the party.`, inv.from);
  await checkLevels(p);
  sendParty(p);
  if (!o) leave(room, client.sessionId, charId, false);
}

/** party_member_withdraw for one member: it gets an empty party, the rest the new list. */
async function withdraw(p: Party, m: Member, text: string, othersText: string) {
  await db.query("DELETE FROM party_member WHERE char_id = $1", [m.charId]);
  p.members = p.members.filter((x) => x !== m);
  partyOfChar.delete(m.charId);
  if (m.awayTimer) clearTimeout(m.awayTimer);
  if (m.online) { charSend(m.charId, Msg.party, { party: null } satisfies PartyEvent); notice(m.charId, text); }
  noticeAll(p, othersText);
  sendParty(p);
  unloadIfEmpty(p);
}

/** int_party.cpp mapif_parse_PartyLeave for the leader: every member is withdrawn and the party is deleted. */
async function breakUp(p: Party, why: string) {
  parties.delete(p.id);
  for (const x of p.members) partyOfChar.delete(x.charId);
  for (const [tid, inv] of invites) if (inv.partyId === p.id) { clearTimeout(inv.timer); invites.delete(tid); }
  await db.query("DELETE FROM party WHERE id = $1", [p.id]);
  for (const x of p.members) {
    if (x.awayTimer) clearTimeout(x.awayTimer);
    if (!x.online) continue;
    charSend(x.charId, Msg.party, { party: null } satisfies PartyEvent);
    notice(x.charId, why);
  }
}

/** clif_parse_LeaveParty -> party_leave. A leader leaving breaks the party up (int_party.cpp: "TODO: Official allow leaderless"). */
export async function leaveParty(room: MapRoom, client: Client) {
  const charId = charIdOf(room, client.sessionId);
  if (charId === undefined) return;
  const p = parties.get(partyOfChar.get(charId) ?? -1), m = p?.members.find((x) => x.charId === charId);
  if (!p || !m) return;
  if (m.leader) return breakUp(p, `The party "${p.name}" was disbanded: its leader left.`);
  await withdraw(p, m, `You left the party "${p.name}".`, `${m.name} left the party.`);
}

/** clif_parse_RemovePartyMember -> party_removemember (party.cpp:675): leader only; the member may be offline. */
export async function kick(room: MapRoom, client: Client, msg: PartyKickMsg) {
  const charId = charIdOf(room, client.sessionId);
  if (charId === undefined) return;
  const p = parties.get(partyOfChar.get(charId) ?? -1);
  if (!p?.members.find((x) => x.charId === charId)?.leader) return;
  const m = p.members.find((x) => x.charId === Number(msg?.charId));
  if (!m || m.charId === charId) return;
  await withdraw(p, m, `You were expelled from the party "${p.name}".`, `${m.name} was expelled from the party.`);
}

/** clif_parse_PartyChangeLeader -> party_changeleader (party.cpp:940): leader only, the new leader online in the party and, with
 *  change_party_leader_samemap, on the leader's map. */
export async function changeLeader(room: MapRoom, client: Client, msg: PartyLeaderMsg) {
  const charId = charIdOf(room, client.sessionId);
  if (charId === undefined) return;
  const p = parties.get(partyOfChar.get(charId) ?? -1), me = p?.members.find((x) => x.charId === charId);
  if (!p || !me) return;
  if (!me.leader) return notice(charId, "You need to be a party leader to use this command."); // msg 282
  const t = p.members.find((x) => x.charId === Number(msg?.charId));
  if (!t || !t.online || t === me) return notice(charId, "Target character must be online and in your current party."); // msg 283
  refresh(me); refresh(t);
  if (PARTY_CONF.change_party_leader_samemap && (!t.sd || t.map !== me.map)) return notice(charId, "Only a member on the same map can become the leader."); // MSI_PARTY_MASTER_CHANGE_SAME_MAP
  await db.query("UPDATE party SET leader_id = $2 WHERE id = $1", [p.id, t.charId]);
  me.leader = false; t.leader = true;
  notice(charId, "Leadership transferred."); // msg 284
  notice(t.charId, "You've become the party leader."); // msg 285
  noticeAll(p, `${t.name} is the new party leader.`, charId);
  sendParty(p);
}

/** clif_parse_PartyChangeOption -> party_changeoption -> mapif_parse_PartyChangeOption: even EXP share is refused (and the option
 *  stays "each") when party_check_exp_share fails. Leader only (the client offers it to the leader). */
export async function option(room: MapRoom, client: Client, msg: PartyOptionMsg) {
  const charId = charIdOf(room, client.sessionId);
  if (charId === undefined) return;
  const p = parties.get(partyOfChar.get(charId) ?? -1);
  if (!p) return;
  if (!p.members.find((x) => x.charId === charId)?.leader) return notice(charId, "You need to be a party leader to use this command.");
  for (const x of p.members) refresh(x);
  const ok = (v: unknown): v is PartyShare => v === "each" || v === "even";
  let exp = ok(msg?.exp) ? msg.exp : p.exp;
  const item = ok(msg?.item) ? msg.item : p.item;
  if (exp === "even" && !partyCheckExpShare(p.members.filter((x) => x.online).map((x) => x.level))) {
    exp = "each";
    notice(charId, `Even EXP share needs every online member within ${PARTY_CONF.party_share_level} base levels.`); // clif_party_option flag 0x01
  }
  if (exp === p.exp && item === p.item) return sendParty(p); // "There's been no change in the setting." (msg 286): the list is resent
  await db.query("UPDATE party SET exp_share = $2, item_share = $3 WHERE id = $1", [p.id, exp === "even" ? 1 : 0, item === "even" ? 1 : 0]);
  p.exp = exp; p.item = item;
  noticeAll(p, `Party settings: EXP ${exp === "even" ? "shared evenly" : "each takes"}, items ${item === "even" ? "shared" : "each takes"}.`);
  sendParty(p);
}

/** clif_parse_PartyMessage -> party_send_message -> clif_party_message (PARTY: every online member, any map, the speaker too).
 *  Rate limit as public chat: 5 lines / 5 s. */
export async function chat(room: MapRoom, client: Client, msg: ChatMsg) {
  const charId = charIdOf(room, client.sessionId), pc = room.state.players.get(client.sessionId);
  const text = String(msg?.text ?? "").trim().slice(0, 120);
  if (charId === undefined || !pc || !text) return;
  const p = parties.get(partyOfChar.get(charId) ?? -1);
  if (!p) return notice(charId, "You are not in a party.");
  const k = `party-chat-rate:${pc.name}`;
  if ((await redis.incr(k)) === 1) await redis.expire(k, 5);
  else if (Number(await redis.get(k)) > 5) return;
  const ev = { channel: "party", from: pc.name, text } satisfies ChannelChatEvent;
  for (const m of p.members) if (m.online) charSend(m.charId, Msg.channelChat, ev);
}

// ---------- what MapRoom asks ----------
/** The party id of a character when its party shares EXP evenly (mob_dead's pt[] check `p->party.exp`). */
export function evenExpParty(charId: number): number | undefined {
  const p = parties.get(partyOfChar.get(charId) ?? -1);
  return p?.exp === "even" ? p.id : undefined;
}

/** party_exp_share's receivers: sessions of the party's members playing in this room (same map), alive. */
export function aliveMembersIn(room: MapRoom, partyId: number): string[] {
  const p = parties.get(partyId);
  if (!p) return [];
  const out: string[] = [];
  for (const m of p.members) {
    if (!m.sd || m.sd.room !== room) continue;
    const pc = room.state.players.get(m.sd.sid);
    if (pc && !pc.dead) out.push(m.sd.sid);
  }
  return out;
}

/** mob_dead quest credit (mob.cpp:3575-3578): a killer in a party credits every member of that party within AREA_SIZE of the
 *  monster (map_foreachinallrange(quest_update_objective_sub, md, AREA_SIZE, BL_PC, party_id)); without a party, the killer. */
export function questKillers(room: MapRoom, killerSid: string, at: { x: number; y: number }): string[] {
  const charId = charIdOf(room, killerSid);
  const p = charId === undefined ? undefined : parties.get(partyOfChar.get(charId) ?? -1);
  if (!p) return [killerSid];
  const out: string[] = [];
  for (const m of p.members) {
    if (!m.sd || m.sd.room !== room) continue;
    const pc = room.state.players.get(m.sd.sid);
    if (pc && distance(Math.round(pc.x) - at.x, Math.round(pc.y) - at.y) <= BATTLE_CONF.area_size) out.push(m.sd.sid);
  }
  return out;
}

/** party_share_loot (party.cpp:1298) with item share "even" (party.item & 2, party_item_share_type 0 = random pick): who gets an
 *  item the session `sid` picks up. undefined = no sharing (the picker takes it as usual). */
export function lootReceiver(room: MapRoom, sid: string, canTake: (sid: string) => boolean): string | undefined {
  const charId = charIdOf(room, sid);
  const p = charId === undefined ? undefined : parties.get(partyOfChar.get(charId) ?? -1);
  if (!p || p.item !== "even") return undefined;
  return partyLootPick(aliveMembersIn(room, p.id), canTake, (n) => Math.floor(Math.random() * n));
}

// ---------- party_send_xy_timer ----------
/** Every party_update_interval: a member whose cell changed is sent to the members on its map (clif_party_xy, PARTY_SAMEMAP_WOS),
 *  HP / max HP changes to every member (clif_party_hp), a level change re-runs the even-share check (int_party_check_lv). */
function updateTick() {
  for (const p of parties.values()) {
    let levels = false;
    for (const m of p.members) {
      if (!m.sd || !m.online) continue;
      const lv = m.level;
      refresh(m);
      if (m.level !== lv) levels = true;
      const s = m.sent;
      if (m.map !== s.map) { sendUpdate(p, { charId: m.charId, map: m.map, x: m.x, y: m.y }, undefined, m.charId); s.map = m.map; s.x = m.x; s.y = m.y; }
      else if (m.x !== s.x || m.y !== s.y) { sendUpdate(p, { charId: m.charId, x: m.x, y: m.y }, m.map, m.charId); s.x = m.x; s.y = m.y; }
      if (m.hp !== s.hp || m.maxHp !== s.maxHp) { sendUpdate(p, { charId: m.charId, hp: m.hp, maxHp: m.maxHp }, undefined, m.charId); s.hp = m.hp; s.maxHp = m.maxHp; }
    }
    if (levels) void checkLevels(p).then(() => sendParty(p)).catch((e) => console.error("[party] level check", e));
  }
}
setInterval(updateTick, PARTY_CONF.party_update_interval).unref();

/** 2.5.0 (skills2.ts party buffs): the party id of a loaded character, or undefined. */
export const partyIdOf = (charId: number) => partyOfChar.get(charId);
