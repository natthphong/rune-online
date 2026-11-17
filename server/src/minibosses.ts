// 2.9.0 the roaming mini-bosses (shared/minibosses.ts; our own rule, not rAthena). One registry for the whole server (every map room
// runs in this process): each mini-boss is assigned a RANDOM floor 1-3 and rises on that floor's one big map (shared/tower.ts) at a
// random valid spot (TowerSystem.pickSpot: reachable, open, far from the arrival and the NPCs) as soon as that map's room is open and
// its time has come, with a server-wide announce. It grows with the floor: the floor's own row (MINI_SCALE). After its death it is
// rolled onto a random floor again. Ceruleen's phase change (it turns into its phase-2 form at 50 % HP) is BossSystem's (boss.ts).
import { MINIS, miniOf, type MiniBoss } from "../../shared/minibosses.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
import { TOWER, towerFloor } from "../../shared/tower.ts";
import { nearestWalkable } from "../../shared/maps.ts";
import type { SpawnData } from "../../shared/rules/spawn.ts";
import type { MapRoom } from "./rooms/MapRoom.ts";

type Floor = 1 | 2 | 3;
type Slot = { mini: MiniBoss; floor: Floor; dueAt: number; room?: MapRoom; id?: string; at?: { x: number; y: number } };
/** A fresh server: the first rise a minute after boot (dev: at once), so a restart does not drop them on the first player. */
const FIRST_MS = process.env.NODE_ENV === "production" ? 60_000 : 0;
const rollFloor = (): Floor => (1 + Math.floor(Math.random() * 3)) as Floor;
const slots: Slot[] = MINIS.map((mini) => ({ mini, floor: rollFloor(), dueAt: Date.now() + FIRST_MS }));
const mapOf = (f: Floor) => towerFloor(f)!.map;

/** Where every mini-boss is (the dev "mini" op's reply, the minibosses bot). */
export function miniStatus() {
  return slots.map((s) => ({ key: s.mini.key, floor: s.floor, map: mapOf(s.floor), alive: !!s.id, id: s.id, at: s.at, dueAt: s.dueAt }));
}

export class MiniBossSystem {
  private room: MapRoom;
  constructor(room: MapRoom) { this.room = room; }
  private get floor(): Floor | undefined { return TOWER.find((f) => f.map === this.room.mapName)?.floor as Floor | undefined; }

  /** Every tick: a mini-boss due on this map rises here. */
  tick(now: number) {
    const f = this.floor;
    if (!f) return;
    for (const s of slots) if (!s.id && s.floor === f && now >= s.dueAt) this.rise(s);
  }

  /** The room closes (nobody left on the map): a mini-boss standing here is gone with it and rises when the map opens again. */
  dispose() {
    for (const s of slots) if (s.room === this.room) { s.room = undefined; s.id = undefined; s.dueAt = 0; }
  }

  private rise(s: Slot, at?: { x: number; y: number }) {
    const room = this.room, f = this.floor!;
    const spot = at ? nearestWalkable(room.map, at.x, at.y) : room.tower.pickSpot();
    if (!spot) { s.dueAt = Date.now() + 60_000; return; }
    const mobId = s.mini.ids[f], def = MOB_BY_ID.get(mobId)!;
    // a spawn slot with no respawn of its own (the registry decides where it comes back)
    const sd: SpawnData = { map: room.mapName, x: spot.x, y: spot.y, xs: 1, ys: 1, boss: true, name: def.name, mobId, num: 1, delay1: 2 ** 30, delay2: 0 };
    const id = `m${room.nextMonsterId++}`;
    room.mobSpawns.set(id, { sd, center: { ...spot } });
    Object.assign(s, { floor: f, room, id, at: spot });
    room.spawnMonster(id);
    room.announce(`[Tower] ${s.mini.name} (Lv ${def.level}) has appeared on floor ${f}, somewhere in ${room.mapTitle}!`);
  }

  /** The dev shortcut (and the minibosses bot): bring `key` to THIS map now, at `at` or a random spot; any old one goes. */
  force(key: string, at?: { x: number; y: number }): string | undefined {
    const s = slots.find((x) => x.mini.key === key), f = this.floor;
    if (!s || !f) return undefined;
    if (s.id && s.room) s.room.removeMonster(s.id);
    s.id = undefined; s.room = undefined; s.floor = f;
    this.rise(s, at);
    return s.id;
  }

  /** Ceruleen's phase change put a new monster in its place (boss.ts transform): the registry follows the new id. */
  replaced(oldId: string, newId: string) {
    for (const s of slots) if (s.room === this.room && s.id === oldId) s.id = newId;
  }

  /** BossSystem.dead: a mini-boss fell. Its slot goes; it is rolled onto a random floor and rises there after its respawn time. */
  dead(id: string, mobId: number) {
    const s = slots.find((x) => x.room === this.room && x.id === id);
    if (!s || !miniOf(mobId)) return;
    this.room.mobSpawns.delete(id);
    const next = rollFloor();
    Object.assign(s, { id: undefined, room: undefined, at: undefined, floor: next, dueAt: Date.now() + s.mini.respawnMs + Math.floor(Math.random() * s.mini.respawnVar) });
    this.room.announce(`[Tower] ${s.mini.name} has been defeated on floor ${this.floor}! Rumour says it will rise again on floor ${next}.`);
  }
}
