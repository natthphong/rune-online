// The Tower rule on a floor's guardian map (shared/tower.ts; our own, not rAthena): one guardian boss per floor.
//   spawn    on a floor built for the rule (`random`) the guardian has no spawn line: it rises at a random valid spot of the map (a
//            walkable cell with room around it, reachable from the arrival, far from the arrival and the camp) and at ANOTHER one each
//            time it comes back; on the older floors it keeps its hall (its boss_monster line);
//   announce server-wide when it rises and when it falls (who felled it);
//   hint     Msg.tower to everyone on the map every 2 s: the compass direction and distance to it, whether this character cleared the floor;
//   unlock   when it dies, the permanent character variable `clearVar` is set for the winner (top damage), the killer and every member
//            of their parties who is on the map: the stair / gate to the next floor reads it (shared/content/f3/witherwick.ts).
import { Msg, type TowerEvent } from "../../shared/protocol.ts";
import { TOWER_BY_MAP, hintText, towerHint, type TowerFloor } from "../../shared/tower.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
import { walkable } from "../../shared/map.ts";
import { WARPS } from "../../shared/maps.ts";
import { npcsOn } from "../../shared/content/npcs.ts";
import type { SpawnData } from "../../shared/rules/spawn.ts";
import { partyIdOf } from "./party.ts";
import type { MapRoom, Monster } from "./rooms/MapRoom.ts";

/** Cells between the guardian's spot and the arrival / an NPC. */
const FAR_FROM_ARRIVAL = 30, FAR_FROM_NPC = 12;
const HINT_MS = 2000;

export class TowerSystem {
  /** this map's floor row, if a floor guardian lives here */
  get floor(): TowerFloor | undefined { return TOWER_BY_MAP.get(this.room.mapName); }
  /** the guardian's monster id while its spawn slot exists (alive or waiting to rise again) */
  guardianId: string | undefined;
  private spots: { x: number; y: number }[] | undefined;
  private hintAt = 0;
  private respawnAt = 0;
  private room: MapRoom;

  constructor(room: MapRoom) {
    this.room = room;
  }

  /** After the map's spawn lines: a random floor's guardian rises at its first spot. */
  start() {
    if (this.floor?.random) this.rise();
  }

  /** Every valid spot of the map (computed once): reachable from the arrival, 3x3 open, far from the arrival and from every NPC. */
  private validSpots() {
    if (this.spots) return this.spots;
    const m = this.room.map, arrivals = WARPS.filter((w) => w.to.map === this.room.mapName).map((w) => w.to);
    const start = arrivals[0] ?? { x: m.w >> 1, y: m.h >> 1 };
    const seen = new Uint8Array(m.w * m.h), queue = [start.y * m.w + start.x];
    seen[queue[0]] = 1;
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i] % m.w, y = (queue[i] - x) / m.w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, k = ny * m.w + nx;
        if ((dx || dy) && walkable(m, nx, ny) && !seen[k]) { seen[k] = 1; queue.push(k); }
      }
    }
    const npcs = npcsOn(this.room.mapName), out: { x: number; y: number }[] = [];
    const cheb = (a: { x: number; y: number }, x: number, y: number) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y));
    for (const k of queue) {
      const x = k % m.w, y = (k - x) / m.w;
      if (arrivals.some((a) => cheb(a, x, y) < FAR_FROM_ARRIVAL) || npcs.some((n) => cheb(n, x, y) < FAR_FROM_NPC)) continue;
      let open = true;
      for (let dy = -2; dy <= 2 && open; dy++) for (let dx = -2; dx <= 2; dx++) if (!walkable(m, x + dx, y + dy)) { open = false; break; }
      if (open) out.push({ x, y });
    }
    return (this.spots = out);
  }
  /** A random valid spot, at least 25 cells from `not` (where it stood last) when there is one. */
  pickSpot(not?: { x: number; y: number }) {
    const all = this.validSpots(), far = not ? all.filter((s) => Math.max(Math.abs(s.x - not.x), Math.abs(s.y - not.y)) >= 25) : all;
    const pool = far.length ? far : all;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
  }

  /** The guardian's spawn slot at a random spot (or at `at`, the dev shortcut), replacing any old one. */
  rise(at?: { x: number; y: number }) {
    const f = this.floor, room = this.room;
    if (!f) return;
    if (this.guardianId) { // dev: move it
      const old = this.guardianId;
      room.mobSpawns.delete(old); room.state.monsters.delete(old); room.brains.delete(old);
      this.guardianId = undefined;
    }
    const spot = at ?? this.pickSpot();
    if (!spot) { console.error(`[tower] floor ${f.floor}: no valid spot on ${room.mapName}`); return; }
    const def = MOB_BY_ID.get(f.guardian)!;
    const sd: SpawnData = { map: room.mapName, x: spot.x, y: spot.y, xs: 1, ys: 1, boss: true, name: def.name, mobId: f.guardian, num: 1, delay1: f.respawnMs, delay2: f.respawnVar };
    const id = `m${room.nextMonsterId++}`;
    room.mobSpawns.set(id, { sd, center: { ...spot } });
    room.spawnMonster(id);
  }

  /** BossSystem.spawned: the guardian is on the map (first rise or back from the dead). */
  spawned(id: string, mon: Monster) {
    const f = this.floor;
    if (!f || mon.mobId !== f.guardian || !this.room.mobSpawns.has(id)) return;
    const again = this.guardianId === id;
    this.guardianId = id;
    this.respawnAt = 0;
    this.hintAt = 0;
    if (again || f.random) this.room.announce(`[Tower] Floor ${f.floor}: ${MOB_BY_ID.get(f.guardian)!.name}, the floor guardian, ${again ? "has risen again" : "stirs"} somewhere in ${this.room.mapTitle}.`);
  }

  /** BossSystem.dead: the guardian fell. The floor is cleared for the winners' parties; a random floor's guardian will rise elsewhere. */
  dead(id: string, mon: Monster, sids: (string | undefined)[]) {
    const f = this.floor, room = this.room;
    if (!f || id !== this.guardianId) return;
    const winners = new Set<string>();
    const parties = new Set<number>();
    for (const sid of sids) {
      if (!sid || !room.state.players.has(sid)) continue;
      winners.add(sid);
      const c = room.charIdOf(sid), pid = c === undefined ? undefined : partyIdOf(c);
      if (pid !== undefined) parties.add(pid);
    }
    for (const [sid] of room.state.players) {
      const c = room.charIdOf(sid), pid = c === undefined ? undefined : partyIdOf(c);
      if (pid !== undefined && parties.has(pid)) winners.add(sid);
    }
    const names: string[] = [];
    for (const sid of winners) {
      room.npcEngine.setCharVar(sid, f.clearVar, 1);
      names.push(room.state.players.get(sid)!.name);
      room.clients.getById(sid)?.send(Msg.notice, { text: `Floor ${f.floor} cleared! The way to floor ${f.floor + 1} is open for you.` });
    }
    const def = MOB_BY_ID.get(f.guardian)!;
    room.announce(`[Tower] Floor ${f.floor}: ${def.name} has fallen to ${names.length ? names.join(", ") : "nobody known"}! The way to floor ${f.floor + 1} opens for them.`);
    const slot = room.mobSpawns.get(id);
    this.respawnAt = Date.now() + f.respawnMs;
    if (f.random && slot) { // it rises somewhere else next time
      const next = this.pickSpot(room.cell(mon));
      if (next) { slot.sd.x = next.x; slot.sd.y = next.y; slot.center = { ...next }; }
    }
    this.hintAt = 0;
  }

  /** Every HINT_MS: where the guardian is, to everyone on the map. */
  tick(now: number) {
    const f = this.floor, room = this.room;
    if (!f || now < this.hintAt) return;
    this.hintAt = now + HINT_MS;
    const mon = this.guardianId ? room.state.monsters.get(this.guardianId) : undefined, alive = !!mon && !mon.dead;
    const boss = MOB_BY_ID.get(f.guardian)!.name;
    for (const [sid, p] of room.state.players) {
      const h = alive ? towerHint(Math.round(p.x), Math.round(p.y), Math.round(mon!.x), Math.round(mon!.y)) : { dir: 0, dist: 0 };
      const ev: TowerEvent = { floor: f.floor, boss, alive, ...h, cleared: room.npcEngine.charVar(sid, f.clearVar) > 0, ...(alive || !this.respawnAt ? {} : { respawnAt: this.respawnAt }) };
      room.clients.getById(sid)?.send(Msg.tower, ev);
    }
  }

  /** The hint in words (the dev shortcut's reply and the keeper's line). */
  where(x: number, y: number) {
    const mon = this.guardianId ? this.room.state.monsters.get(this.guardianId) : undefined;
    return mon && !mon.dead ? hintText(towerHint(x, y, Math.round(mon.x), Math.round(mon.y))) : "nowhere (defeated)";
  }
}
