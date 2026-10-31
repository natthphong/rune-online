// Auto-navigation (RO's navigation system / the quest tracker's auto-walk): plan the whole route on the client with
// shared/navi.ts and walk it as ordinary `move` requests, each one a click the server accepts unchanged (walkPath:
// max_walk_path, OFFICIAL_WALKPATH). The server never sees anything but normal intents. On arrival: an NPC target is
// clicked (talk), a monster target is attacked; any manual click or death stops it.
//
// A goal is a promise to walk, not a walk in progress. While the character can't act it is HELD (the label stays up, nothing is
// sent) and the walk goes on the moment that ends: an open NPC window locks the character (pc_cant_act: the server drops every
// walk request, clif_parse_WalkToXY), so a <NAVI> link clicked inside a dialog or a tracker click made while one is open arms the
// goal and the character walks when the window closes. A sitting character can't walk either (unit_can_move, unit.cpp:1819):
// it is stood up first (the sit request toggles) instead of the walk silently going nowhere.
//
// W01, across maps: a goal on another map (a cell / NPC / quest fallback with a `map`, an NPC of shared/maps.ts NPC_HOMES, or a
// monster that lives on another field, FIELD_MOBS) first walks to the next warp on the shortest chain of warps (warpRoute, a
// breadth-first search over WARPS); the warp changes the room, main.ts carries the goal over (takeNavi / resumeNavi) and the walk
// goes on in the next map until the goal's own map is reached.
import type { Room } from "@colyseus/sdk";
import { Msg } from "../../shared/protocol.ts";
import { type GameMap } from "../../shared/map.ts";
import { FIELD_MOBS, NPC_HOMES, exitToward, habitatOf, isHuntMap, mapOfState } from "../../shared/maps.ts";
import { naviNextStep, naviRoute, nearestWalkable } from "../../shared/navi.ts";
import { setWalkGoal } from "./motion.ts";
// the chat-log line for "You have arrived." / why a walk gave up: set by the HUD (ui/quests.ts), so this module has no DOM
// import and runs in a node bot too (scripts/auto.ts drives the same planner)
let log: (kind: "system", text: string) => void = () => {};
export function setNaviLog(f: (kind: "system", text: string) => void) { log = f; }

export type NaviTarget =
  | { kind: "cell"; x: number; y: number; within: number; map?: string }
  | { kind: "npc"; id: string }
  | { kind: "mob"; mobIds: number[]; fallback?: { x: number; y: number; map?: string } };

type Cell = { x: number; y: number };
const cheb = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const STEP_MS = 120; // how often the route is re-planned / the next request is considered
const CUE_MS = 900; // a <NAVI> click is acknowledged this long at least (label up), even when the character already stands there
const STAND_RETRY_MS = 1200; // a stand-up request is answered within a patch or two; resend only if it clearly got lost
const STAND_TRIES = 3;

let room: Room | undefined;
let map: GameMap | undefined, seed = -1;
let target: NaviTarget | undefined, label = "";
let sent: Cell | undefined, stuck = 0, nextAt = 0;
let held = false; // armed, but the character can't act right now (an NPC window is open): nothing is sent until it can
let standAt = 0, standTries = 0;
let startedAt = 0, walked = false;
let onWarpSince = 0; // when the character came to stand on the warp it is crossing by (0 = not on one) // when the goal was set, and whether a walk request went out for it
const listeners = new Set<(active: boolean, label: string, held: boolean) => void>();
const blockers = new Set<() => boolean>();
/** What the label says: the goal's name, plus why nothing moves yet while the walk is held. */
const shown = () => (held ? [label, "starts when the window closes"].filter(Boolean).join(" · ") : label);
const emit = () => { for (const f of listeners) f(!!target, shown(), held); };
/** The character can't act (pc_cant_act): `blocked` from the caller's frame loop, or anything registered with addNaviBlocker. */
const locked = (blocked = false) => blocked || [...blockers].some((f) => f());

/** The room navigation sends its requests to (undefined = left the world). */
export function setNaviRoom(r: Room | undefined) { stopNavi(); room = r; }
/** Called whenever navigation starts, stops or is held / released (the "Auto-navigating..." label). */
export function onNavi(f: (active: boolean, label: string, held: boolean) => void) { listeners.add(f); }
/** Register something that locks the character while it returns true (the NPC dialog): a goal armed meanwhile waits for it. */
export function addNaviBlocker(f: () => boolean) { blockers.add(f); }
export const naviActive = () => !!target;

export function startNavi(t: NaviTarget, what = "") {
  if (!room) return;
  target = t; label = what; sent = undefined; stuck = 0; nextAt = 0; standTries = 0; held = locked();
  startedAt = performance.now(); walked = false;
  emit();
}
export function stopNavi() {
  if (!target) return;
  target = undefined; sent = undefined; held = false;
  emit();
}
/** A map change is under way (main.ts): hand the goal over (and drop it here); resumeNavi re-arms it in the next room. */
export function takeNavi() {
  const t = target ? { target, label } : undefined;
  target = undefined; sent = undefined; held = false;
  return t;
}
export function resumeNavi(t: { target: NaviTarget; label: string }) { if (room) startNavi(t.target, t.label); }
/** The map a goal is on, seen from the room's map `here` (undefined = this map, or unknown). */
function goalMap(t: NaviTarget, S: any, here: string): string | undefined {
  if (t.kind === "cell") return t.map;
  if (t.kind === "npc") return S.npcs?.get(t.id) ? here : NPC_HOMES[t.id]?.map;
  let seen = false;
  S.monsters?.forEach((m: any) => { if (!m.dead && t.mobIds.includes(m.mobId)) seen = true; });
  if (seen) return here;
  return t.fallback?.map ?? habitatOf(t.mobIds, here) ?? here;
}

/** Give up with a reason: a walk that just stops is indistinguishable from a click that did nothing. */
function giveUp(why: string) { log("system", why); stopNavi(); }

/** Every frame: re-plan from where the character stands and send the next walk request once the last one is (nearly)
 *  done. `blocked` = the character can't act (an NPC window is open): the goal is held, not dropped. */
export function tickNavi(now: number, blocked: boolean) {
  if (!target || !room || now < nextAt) return;
  nextAt = now + STEP_MS;
  const S = room.state as any;
  const me = S.players?.get(room.sessionId);
  if (!me || me.dead) return stopNavi();
  const lock = locked(blocked);
  if (lock !== held) { held = lock; sent = undefined; stuck = 0; emit(); } // held <-> released: the last request is stale either way
  if (held) return;
  map = mapOfState(S); // the room's own map
  const here = { x: Math.round(me.x), y: Math.round(me.y) };
  let goal: Cell | undefined, within = 1, arrive: (() => void) | undefined;
  const t = target, there = goalMap(t, S, S.map), crossing = !!(there && S.map && there !== S.map);
  if (crossing) { // W01: another map: head for the next warp on the way (its area moves us on)
    const w = exitToward(S.map, there);
    if (!w) return giveUp("There is no way to get there from this map.");
    goal = { x: w.x, y: w.y }; within = 0;
  } else if (t.kind === "cell") { goal = t; within = t.within; }
  else if (t.kind === "npc") {
    const n = S.npcs?.get(t.id);
    if (!n) return stopNavi();
    goal = { x: Math.round(n.x), y: Math.round(n.y) }; within = 2; arrive = () => room?.send(Msg.npc, { id: t.id });
  } else {
    let best: { id: string; x: number; y: number } | undefined, bd = Infinity;
    S.monsters?.forEach((m: any, id: string) => {
      if (m.dead || !t.mobIds.includes(m.mobId)) return;
      const d = cheb(here, { x: Math.round(m.x), y: Math.round(m.y) });
      if (d < bd) { bd = d; best = { id, x: Math.round(m.x), y: Math.round(m.y) }; }
    });
    if (best) { const b = best; goal = b; within = 4; arrive = () => room?.send(Msg.attack, { id: b.id }); }
    else if (t.fallback) { goal = t.fallback; within = 3; }
    else {
      const f: unknown = S.map, home = isHuntMap(f) ? FIELD_MOBS[f] : undefined;
      if (!home || !home.mobs.some((id) => t.mobIds.includes(id))) return stopNavi();
      goal = home.hunt; within = 3; // none in sight: their hunting ground
    }
  }
  if (!crossing || cheb(here, goal) > within) onWarpSince = 0;
  if (cheb(here, goal) <= within) {
    if (crossing) { // on the warp: the server moves us on (Msg.changeMap), and main.ts carries the goal over
      // W03: a scripted door (the stair) runs once per entry into its area: if it fired while we couldn't act, step out and in again
      onWarpSince ||= now;
      if (now - onWarpSince > 2500 && !me.moving) {
        const out = [[3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dy]) => ({ x: goal!.x + dx, y: goal!.y + dy })).find((c) => naviRoute(map!, here.x, here.y, c.x, c.y).length);
        if (out) { room.send(Msg.move, out); setWalkGoal(out); sent = out; onWarpSince = 0; nextAt = now + 1500; }
      }
      return;
    }
    if (t.kind === "cell") { // a place: nobody talks or fights on arrival, so say it (a click that visibly does nothing is a dead control)
      if (now < startedAt + CUE_MS) return;
      log("system", walked ? "You have arrived." : "You are already there.");
    }
    stopNavi(); arrive?.(); return;
  }
  if (me.moving && sent && cheb(here, sent) > 1) return; // the last request is still being walked
  if (me.sitting) { // unit_can_move refuses a sitting unit: stand up first (sit toggles, so only ask once per round trip)
    if (standTries >= STAND_TRIES) return giveUp("You can't walk while sitting.");
    if (now >= standAt) { room.send(Msg.sit); standAt = now + STAND_RETRY_MS; standTries++; }
    return;
  }
  standTries = 0;
  const g = nearestWalkable(map!, goal.x, goal.y);
  if (!g) return giveUp("There is no way to get there.");
  // stop where the route first comes within range (an NPC is talked to from beside it, a monster attacked from 4 cells)
  const full = naviRoute(map!, here.x, here.y, g.x, g.y);
  const cut = full.findIndex((c) => cheb(c, goal) <= within);
  const step = naviNextStep(map!, cut >= 0 ? full.slice(0, cut + 1) : full, here);
  if (!step) return giveUp("There is no way to get there from here."); // no route (or none from here)
  if (sent && step.x === sent.x && step.y === sent.y && !me.moving) { if (++stuck > 6) return giveUp("Something is in the way."); } else stuck = 0;
  room.send(Msg.move, { x: step.x, y: step.y });
  setWalkGoal(step);
  sent = { x: step.x, y: step.y };
  walked = true;
}
