// Test-bot helpers: log in (registering the first time) and join the map with a character.
// Bot accounts are test-only accounts on our own servers; the password below is not a secret.
import { Client, type Room } from "@colyseus/sdk";
import { Msg, type ChangeMapEvent } from "../../shared/protocol.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { OFFICIAL_WALKPATH, distance, walkable, type GameMap } from "../../shared/map.ts";
import { FIELD, exitToward, isMapName, mapOfState, roomOf, type MapName } from "../../shared/maps.ts";

const PASSWORD = "bot-test-password";

export async function apiCall<T>(url: string, method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}/api${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error ?? ""}`);
  return data as T;
}

export async function login(url: string, username: string) {
  try {
    return (await apiCall<{ token: string }>(url, "POST", "/login", undefined, { username, password: PASSWORD })).token;
  } catch {
    return (await apiCall<{ token: string }>(url, "POST", "/register", undefined, { username, password: PASSWORD })).token;
  }
}

/** Log in as `username` and join with character `name` (created in slot 0 if missing; recreated when fresh). */
export async function joinAs(url: string, username: string, name: string, fresh = false) {
  const token = await login(url, username);
  const list = await apiCall<CharacterSummary[]>(url, "GET", "/characters", token);
  let c = list.find((x) => x.name === name);
  if (c && fresh) { await apiCall(url, "DELETE", `/characters/${c.id}`, token, { confirmName: name }); c = undefined; }
  if (!c) {
    const used = new Set(list.filter((x) => x.name !== name || !fresh).map((x) => x.slot));
    const slot = [...Array(9).keys()].find((s) => !used.has(s)) ?? 0;
    c = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot, name, gender: "M", hair: 0 });
  }
  const room = await botRoom(url, token, c);
  return { room, token, char: c };
}

/** A bot's room that follows its character across maps (W01): it joins the room of the character's map, and whenever the
 *  server says the character now stands on another map (Msg.changeMap: a warp, a respawn at the save point, a Homing Feather)
 *  it leaves, joins that map's room and re-registers every handler the bot added with onMessage / onLeave. Everything else
 *  (state, sessionId, send, leave) goes to the current room. `travel(map)` walks through the warps to another map. */
export type BotRoom = Room & { travel(to: MapName, ms?: number): Promise<void>; readonly map: string };
export async function botRoom(url: string, token: string, char: CharacterSummary, first?: MapName): Promise<BotRoom> {
  const handlers: [string | number, (m: any) => void][] = [], leaves: ((code: number) => void)[] = [];
  let moving: Promise<void> | undefined, hops = 0, cur!: Room;
  // messages that arrive before the bot registered a handler for them (the login snapshot: status, inv, quests...) wait here
  // and are handed to the handler when it comes, as if it had been there all along
  let early: [string | number, any][] = [];
  const handled = (t: string | number) => handlers.some(([h]) => h === t || h === "*");
  const join = async (map: MapName) => {
    const r: Room = cur = await new Client(url).joinOrCreate(roomOf(map), { token, charId: char.id });
    early = [];
    const dispatch = (r as any).dispatchMessage.bind(r);
    (r as any).dispatchMessage = (type: string | number, m: any) => {
      if (type === Msg.changeMap || handled(type) || String(type).startsWith("__")) return dispatch(type, m);
      if (early.length < 500) early.push([type, m]);
    };
    let redirected = false;
    r.onMessage(Msg.changeMap, (m: ChangeMapEvent) => { if (isMapName(m.map)) { redirected = true; moving = follow(m.map); } });
    for (const [t, f] of handlers) r.onMessage(t, f);
    r.onLeave((code: number) => { if (!moving && cur === r) for (const f of leaves) f(code); });
    // a login into another map's room is sent on (clif_changemap) before any player appears
    const t0 = Date.now();
    while (!(r.state as any)?.players?.get(r.sessionId) && !redirected && Date.now() - t0 < 8000) await new Promise((ok) => setTimeout(ok, 50));
    return r;
  };
  const follow = async (map: MapName) => {
    await cur.leave().catch(() => {});
    await join(map);
    hops++;
    moving = undefined;
  };
  await join(first ?? (isMapName(char.map) ? char.map : FIELD));
  while (moving) await moving;
  const travel = async (to: MapName, ms = 90_000) => {
    const end = Date.now() + ms;
    while ((cur.state as any).map !== to) {
      if (Date.now() > end) throw new Error(`travel to ${to}: stuck on ${(cur.state as any).map}`);
      if (moving) { await moving; continue; }
      const S = cur.state as any, me = S?.players?.get(cur.sessionId), w = exitToward(S?.map, to);
      if (!w) throw new Error(`no warp from ${S.map} toward ${to}`);
      if (!me || me.dead) { await new Promise((ok) => setTimeout(ok, 300)); continue; }
      if (me.sitting) cur.send(Msg.sit);
      const map = mapOfState(S), here = { x: Math.round(me.x), y: Math.round(me.y) }, path = routeTo(map, here, w);
      const before = hops;
      if (path.length) cur.send(Msg.move, path[Math.min(path.length, OFFICIAL_WALKPATH - 4) - 1]);
      else { // standing on the warp and still here (a scripted door that ran while we were busy): step out of its area, then in again
        const out = [[3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dy]) => ({ x: w.x + dx, y: w.y + dy })).find((c) => walkable(map, c.x, c.y));
        if (out) { cur.send(Msg.move, out); await new Promise((ok) => setTimeout(ok, 1500)); }
      }
      for (let i = 0; i < 12 && hops === before && !moving; i++) await new Promise((ok) => setTimeout(ok, 100));
    }
  };
  return new Proxy({} as BotRoom, {
    get(_t, k) {
      if (k === "onMessage") return (type: string | number, f: (m: any) => void) => {
        const h: [string | number, (m: any) => void] = [type, f];
        handlers.push(h);
        let off = cur.onMessage(type, f) as unknown;
        const mine = early.filter(([t]) => type === "*" || t === type);
        early = early.filter((e) => !mine.includes(e));
        for (const [t, m] of mine) type === "*" ? (f as any)(t, m) : f(m);
        const at = cur;
        return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); if (cur === at && typeof off === "function") off(); off = undefined; };
      };
      if (k === "onLeave") return (f: (code: number) => void) => { leaves.push(f); };
      if (k === "travel") return travel;
      if (k === "map") return (cur.state as any)?.map;
      if (k === "leave") return async (consented?: boolean) => { const r = cur; moving = undefined; leaves.length = 0; return r.leave(consented); };
      const v = (cur as any)[k];
      return typeof v === "function" ? v.bind(cur) : v;
    },
  });
}

export async function deleteChar(url: string, token: string, char: CharacterSummary) {
  await apiCall(url, "DELETE", `/characters/${char.id}`, token, { confirmName: char.name });
}

type Cell = { x: number; y: number };
/** Shortest route between two cells over the whole map (breadth-first; a diagonal step needs both side cells passable, as
 *  path_search does). Unlike findPath (rAthena's path_search) it has no MAX_WALKPATH limit: bots plan long walks with it and
 *  click along it. [] when unreachable. */
export function routeTo(map: GameMap, from: Cell, to: Cell): Cell[] {
  const key = (x: number, y: number) => y * map.w + x, prev = new Map<number, number>([[key(from.x, from.y), -1]]);
  for (let queue = [from], i = 0; i < queue.length; i++) {
    const c = queue[i];
    if (c.x === to.x && c.y === to.y) {
      const out: Cell[] = [];
      for (let k = key(c.x, c.y); k !== key(from.x, from.y); k = prev.get(k)!) out.unshift({ x: k % map.w, y: Math.floor(k / map.w) });
      return out;
    }
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const x = c.x + dx, y = c.y + dy;
      if ((!dx && !dy) || prev.has(key(x, y)) || !walkable(map, x, y)) continue;
      if (dx && dy && (!walkable(map, c.x + dx, c.y) || !walkable(map, c.x, c.y + dy))) continue;
      prev.set(key(x, y), key(c.x, c.y));
      queue.push({ x, y });
    }
  }
  return [];
}

/** Walk the room's character until it stands within `within` cells (square distance) of `target()`, re-read every step so a
 *  moving target is followed: each click goes 10 cells along routeTo (well inside what one click may ask, max_walk_path /
 *  OFFICIAL_WALKPATH). Area events (chat, hits, level-ups) only reach players nearby, so tests bring their bots together with
 *  this. False if not there within `ms` (or the character / target is gone). */
export async function walkNear(room: Room, target: () => Cell | undefined, within: number, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const S = room.state as any, map = mapOfState(S);
    const me = S.players.get(room.sessionId), to = target();
    if (!me || !to) return false;
    const here = { x: Math.round(me.x), y: Math.round(me.y) }, goal = { x: Math.round(to.x), y: Math.round(to.y) };
    if (distance(goal.x - here.x, goal.y - here.y) <= within) return true;
    if (Date.now() - t0 > ms) return false;
    const path = routeTo(map, here, goal);
    if (path.length) room.send(Msg.move, path[Math.min(path.length, OFFICIAL_WALKPATH - 4) - 1]);
    await new Promise((ok) => setTimeout(ok, 400));
  }
}
