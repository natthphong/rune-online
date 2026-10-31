// 1-vs-1 duels (2.4.0), re-implemented from rAthena: src/map/duel.cpp (duel_create / invite / accept / reject / leave) and the
// atcommands @duel / @accept / @reject / @leave (atcommand.cpp:9260-9380), plus the checks around it:
//   battle_check_target (battle.cpp:8081): a character in a duel can target ONLY its duel mate ("You can't target anything out of
//     your duel": monsters and every other player are refused) and, with duel_allow_pvp off, nobody outside the duel can hurt it.
//     The damage itself is the ordinary battle_calc_* path: no duel rate exists in conf/battle.
//   pc_dead (pc.cpp:9858, duel_autoleave_when_die: yes): dying leaves the duel (and rejects a pending invitation). The death is an
//     ordinary one: pc_dead's EXP penalty (pc.cpp:10003-10050) has no duel exemption (only MF_NOEXPPENALTY / gvg / novices).
//   unit_remove_map (unit.cpp:3687): a warp leaves the duel; a logout (map_quit) does the same.
// Differences, on purpose: the duel is created when the invitation is accepted (rAthena creates it on @duel and the invited one
// joins on @accept; with a limit of 2 that is the same thing), invitations expire after 30 s like a party invitation, and the
// duel_time_interval cooldown (60 min between duels) is not applied. There is no distance limit in rAthena either.
import type { Client } from "@colyseus/core";
import { Msg, type ChatEvent, type DuelEvent, type DuelInvitedEvent, type DuelInviteMsg, type DuelReplyMsg } from "../../shared/protocol.ts";
import { areaReceivers } from "./area.ts";
import type { MapRoom } from "./rooms/MapRoom.ts";

export const DUEL_INVITE_MS = 30_000;

type Duel = { a: string; b: string; since: number };
type Invite = { from: string; timer: ReturnType<typeof setTimeout> };
type RoomDuels = { duels: Map<string, Duel>; invites: Map<string, Invite>; outgoing: Map<string, string> };

const rooms = new WeakMap<MapRoom, RoomDuels>();
const of = (room: MapRoom): RoomDuels => {
  let r = rooms.get(room);
  if (!r) rooms.set(room, r = { duels: new Map(), invites: new Map(), outgoing: new Map() });
  return r;
};

const send = (room: MapRoom, sid: string, type: string, msg: unknown) => room.clients.getById(sid)?.send(type, msg);
const say = (room: MapRoom, sid: string, text: string) => { const c = room.clients.getById(sid); if (c) room.notice(c, text); };
const nameOf = (room: MapRoom, sid: string) => room.state.players.get(sid)?.name ?? "?";

/** The duel mate of `sid`, if it is in a duel (sd->duel_group). */
export function foe(room: MapRoom, sid: string): string | undefined {
  const d = of(room).duels.get(sid);
  return d ? (d.a === sid ? d.b : d.a) : undefined;
}
export const dueling = (room: MapRoom, sid: string) => of(room).duels.has(sid);

/** battle_check_target for a player source: may `src` hit `tgt` (a session id)? Only the duel mate. */
export function canTarget(room: MapRoom, src: string, tgt: string): boolean {
  return foe(room, src) === tgt;
}
/** Is this attacker -> victim pair allowed at all? Player-vs-player needs a shared duel; anything else is not our business. */
export function pairAllowed(room: MapRoom, src: string, tgt: string): boolean {
  if (!room.state.players.has(src) || !room.state.players.has(tgt)) return true;
  return canTarget(room, src, tgt);
}

function publish(room: MapRoom, sid: string) {
  const f = foe(room, sid), d = of(room).duels.get(sid);
  send(room, sid, Msg.duel, { duel: f && d ? { with: nameOf(room, f), withId: f, since: d.since } : null } satisfies DuelEvent);
}

function dropInviteOf(room: MapRoom, target: string, why?: string) {
  const r = of(room), inv = r.invites.get(target);
  if (!inv) return;
  clearTimeout(inv.timer);
  r.invites.delete(target);
  if (r.outgoing.get(inv.from) === target) r.outgoing.delete(inv.from);
  if (why) say(room, inv.from, why);
}

/** @duel <name>: challenge a character on this map (name, or a session id from the right-click menu). */
export function invite(room: MapRoom, client: Client, m: DuelInviteMsg) {
  const sid = client.sessionId, p = room.state.players.get(sid), b = room.brains.get(sid);
  if (!p || !b) return;
  const r = of(room), key = String(m?.name ?? "").trim();
  if (!key) return say(room, sid, "Duel: Please enter a player name (usage: /duel <char name>).");
  let tid: string | undefined = room.state.players.has(key) ? key : undefined;
  if (!tid) for (const [id, o] of room.state.players) if (o.name === key) { tid = id; break; }
  if (!tid) return say(room, sid, "Duel: Player not found."); // msg 352
  const t = room.state.players.get(tid)!, tb = room.brains.get(tid);
  if (tid === sid) return;
  if (p.dead) return say(room, sid, "Duel: You can't challenge while dead.");
  if (room.npcEngine.talking(sid) || b.shopNpc !== undefined) return say(room, sid, "Duel: Finish talking to the NPC first.");
  if (r.duels.has(sid)) return say(room, sid, "Duel: You are already in a duel.");
  if (r.outgoing.has(sid) || r.invites.has(sid)) return say(room, sid, "Duel: Answer or wait for the pending invitation first."); // msg 355
  if (t.dead || !tb) return say(room, sid, `Duel: ${t.name} can't duel right now.`);
  if (r.duels.has(tid) || r.invites.has(tid) || r.outgoing.has(tid)) return say(room, sid, "Duel: Player already in duel."); // msg 353
  if (room.npcEngine.talking(tid) || tb.shopNpc !== undefined) return say(room, sid, `Duel: ${t.name} is busy.`);
  const timer = setTimeout(() => {
    if (r.invites.get(tid!)?.timer !== timer) return;
    dropInviteOf(room, tid!, `Duel: ${t.name} did not answer the invitation.`);
    say(room, tid!, "Duel: The invitation expired.");
  }, DUEL_INVITE_MS);
  r.invites.set(tid, { from: sid, timer });
  r.outgoing.set(sid, tid);
  send(room, tid, Msg.duelInvited, { from: p.name, fromId: sid } satisfies DuelInvitedEvent); // msg 374
  say(room, sid, "Duel: Invitation has been sent."); // msg 354
}

/** @accept / @reject. */
export function reply(room: MapRoom, client: Client, m: DuelReplyMsg) {
  const sid = client.sessionId, r = of(room), inv = r.invites.get(sid);
  if (!inv) return say(room, sid, m?.accept ? "Duel: /accept without invitation." : "Duel: /reject without invitation."); // msg 360 / 362
  const from = inv.from, fp = room.state.players.get(from), p = room.state.players.get(sid);
  dropInviteOf(room, sid);
  if (!p || !fp) return;
  if (!m?.accept) { // duel_reject
    say(room, sid, "Duel: Invitation has been rejected.");
    return say(room, from, `Duel: ${p.name} has rejected the duel.`); // msg 377
  }
  if (p.dead || fp.dead) return say(room, sid, "Duel: The challenge is off.");
  if (r.duels.has(sid) || r.duels.has(from)) return say(room, sid, "Duel: Player already in duel.");
  const d: Duel = { a: from, b: sid, since: Date.now() };
  r.duels.set(from, d); r.duels.set(sid, d);
  say(room, sid, "Duel: Invitation has been accepted."); // msg 361
  say(room, from, `Duel: ${p.name} has accepted the duel.`); // msg 376
  publish(room, from); publish(room, sid);
}

/** @leave: duel_leave; the other side wins. */
export function leave(room: MapRoom, client: Client) {
  const sid = client.sessionId;
  if (!dueling(room, sid)) return say(room, sid, "Duel: /leave without a duel."); // msg 358
  end(room, sid, "left");
}

/** Close the duel `sid` is in. `loser` = who lost (died, left, logged out): the other one wins. */
export function end(room: MapRoom, loser: string, how: "died" | "left" | "gone", killer?: string) {
  const r = of(room), d = r.duels.get(loser);
  if (!d) return;
  const winner = d.a === loser ? d.b : d.a;
  r.duels.delete(d.a); r.duels.delete(d.b);
  for (const sid of [d.a, d.b]) { // nobody keeps swinging at the other
    const b = room.brains.get(sid);
    if (b && b.target && (b.target === d.a || b.target === d.b)) b.target = undefined;
    room.skills.dropGoal(sid);
    publish(room, sid);
  }
  const ln = nameOf(room, loser), wn = nameOf(room, winner);
  const text = how === "left" ? `${ln} left the duel: ${wn} won the duel against ${ln}.`
    : how === "gone" ? `${ln} quit the duel: ${wn} won the duel against ${ln}.`
    : killer === winner || killer === undefined ? `${wn} won the duel against ${ln}.` : `${ln} fell: the duel with ${wn} is over.`;
  const ev = { id: "duel", name: "Duel", text } satisfies ChatEvent;
  const anchor = room.state.players.has(winner) ? winner : loser;
  room.sendArea("AREA", anchor, Msg.chat, ev);
  // Both duelists get the line even far apart or gone from the map, but only those the area send missed (no duplicates).
  const a = room.state.players.get(anchor);
  const got = new Set(a ? areaReceivers("AREA", { id: anchor, ...room.cell(a) }, [...room.state.players].map(([id, p]) => [id, room.cell(p)] as const)) : []);
  for (const sid of [winner, loser]) if (!got.has(sid)) send(room, sid, Msg.chat, ev);
}

/** pc_dead: leave the duel (duel_autoleave_when_die) and reject a pending invitation. */
export function onDeath(room: MapRoom, sid: string, killer: string | undefined) {
  const r = of(room);
  dropInviteOf(room, sid);
  if (r.outgoing.has(sid)) dropInviteOf(room, r.outgoing.get(sid)!, "Duel: The challenger fell.");
  end(room, sid, "died", killer);
}

/** Logout / warp (unit_remove_map, map_quit): the duel and any pending invitation end. */
export function onGone(room: MapRoom, sid: string) {
  const r = of(room);
  dropInviteOf(room, sid);
  if (r.outgoing.has(sid)) dropInviteOf(room, r.outgoing.get(sid)!, "Duel: The challenger left.");
  end(room, sid, "gone");
}
