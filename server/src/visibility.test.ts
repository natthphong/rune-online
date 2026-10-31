// Who receives what, against rAthena: a player's own numbers (stats, status / skill points, EXP, job level, HP, SP) reach
// only that player, and per-event messages reach only the players clif_send's target reaches.
//   SELF: clif_updatestatus -> clif_par_change (clif.cpp:3557), clif_couplestatus (3619), clif_statusupack (4299); another
//         player's HP only through clif_party_hp / clif_bg_hp / view_hpmeter (clif_update_hp, clif.cpp:3539-3546).
//   AREA: clif_misceffect (clif.cpp:4374) for NOTIFYEFFECT_BASE/JOB_LEVEL_UP (pc.cpp:8292, 8347), clif_damage (5292-5297);
//         area_size 14 (conf/battle/client.conf:39), square distance (map_foreachinallarea).
//   Order: pc_checkbaselevelup sends the owner's clif_updatestatus before clif_misceffect (pc.cpp:8271-8292).
// Runs the real MapRoom code (no server, no DB: the pg.Pool and the lazyConnect Redis never connect) with fake clients that
// record what they are sent, and the real Colyseus encoder + reflection decoder for the synced state.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GAME_NAME ??= "ro";
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.REDIS_URL ??= "redis://unused";
process.env.DB_SCHEMA ??= "ro_unit_test";
const { MapRoom, MapState, Monster, Player } = await import("./rooms/MapRoom.ts");
const { Encoder, Reflection } = await import("@colyseus/schema");
const { Msg } = await import("../../shared/protocol.ts");

type Sent = { type: string; msg: any };
const PRIVATE = ["hp", "maxHp", "sp", "maxSp", "exp", "jobLevel", "jobExp", "statPoints", "skillPoints", "str", "agi", "vit", "int", "dex", "luk"] as const;

/** A fresh Lv1 Novice (MaxHP 40, 48 status points) at x, y. */
const pc = (name: string, x: number, y: number, over: Partial<Record<string, unknown>> = {}) => new Player({
  name, gender: "M", hair: 0, outfit: "novice", weapon: "", shield: "", headgear: "", garment: "", x, y, dir: 0, moving: false, sitting: false, dead: false,
  job: "Novice", level: 1, hp: 40, maxHp: 40, sp: 11, maxSp: 11, exp: 0, jobLevel: 1, jobExp: 0, statPoints: 48, skillPoints: 0,
  str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1, ...over,
});

/** A MapRoom holding these players, each with a fake client that records what it is sent. */
function room(players: Record<string, InstanceType<typeof Player>>) {
  const r = new MapRoom() as any;
  r.state = new MapState();
  const got = new Map<string, Sent[]>();
  for (const [id, p] of Object.entries(players)) {
    r.state.players.set(id, p);
    r.brains.set(id, { path: [], nextAttack: 0, repathAt: 0, status: undefined });
    got.set(id, []);
    r.clients.push({ sessionId: id, send: (type: string, msg: unknown) => got.get(id)!.push({ type, msg }) });
  }
  r.npcEngine = { questinfo() {} };
  const of = (id: string, type: string) => got.get(id)!.filter((m) => m.type === type).map((m) => m.msg);
  return { r, got, of };
}

test("the synced state never carries another player's stats / points / EXP / HP / SP: full state at join and every patch", () => {
  const state = new MapState();
  const a = pc("A", 10, 12, { level: 12, hp: 33, maxHp: 140, sp: 9, maxSp: 25, exp: 400, jobLevel: 7, jobExp: 50, statPoints: 21, skillPoints: 6, str: 9, vit: 7 });
  state.players.set("a", a);
  const enc = new Encoder(state);
  const other = Reflection.decode(Reflection.encode(enc)); // what @colyseus/sdk builds from the handshake
  other.decode(enc.encodeAll());
  enc.discardChanges();
  const seen = (other.state as any).players.get("a");
  assert.deepEqual([seen.name, seen.job, seen.level, seen.x, seen.y], ["A", "Novice", 12, 10, 12]); // clif_set_unit_idle: name, class, clevel
  for (const k of PRIVATE) assert.equal(seen[k], undefined, k);
  assert.deepEqual([a.statPoints, a.hp, a.str], [21, 33, 9]); // the server's Player keeps them
  // a stat raise, a hit, EXP, a job level, a gear change: nothing to patch at all
  a.statPoints -= 2; a.str += 1; a.hp = 0; a.exp += 50; a.jobLevel += 1; a.sp -= 3; a.maxHp = 150;
  assert.equal(enc.hasChanges, false);
  a.level = 13; a.dead = true; // public changes patch as usual
  other.decode(enc.encode());
  enc.discardChanges();
  assert.deepEqual([seen.level, seen.dead], [13, true]);
  for (const k of PRIVATE) assert.equal(seen[k], undefined, k);
});

test("Msg.status goes to its owner only: at once, then again only when one of its numbers changed", () => {
  const { r, of } = room({ a: pc("A", 10, 10, { str: 5, statPoints: 40 }), b: pc("B", 11, 10) });
  r.tick(0.05);
  assert.deepEqual(of("a", Msg.status).map((s) => [s.str, s.statPoints]), [[5, 40]]);
  assert.deepEqual(of("b", Msg.status).map((s) => [s.str, s.statPoints]), [[1, 48]]);
  r.tick(0.05); // nothing changed: nothing sent
  const a = r.state.players.get("a");
  a.statPoints -= 2; a.str += 1; // pc_statusup(str, 1): clif_updatestatus SP_STR + SP_STATUSPOINT, SELF
  r.tick(0.05);
  assert.deepEqual(of("a", Msg.status).map((s) => [s.str, s.statPoints]), [[5, 40], [6, 38]]);
  assert.deepEqual(of("b", Msg.status).map((s) => [s.str, s.statPoints]), [[1, 48]]); // B never gets A's numbers
});

test("a level-up effect reaches the players within area_size 14 only, with no chat line and no level number", () => {
  const { r, got, of } = room({ a: pc("A", 10, 10), near: pc("Near", 15, 12), edge: pc("Edge", 24, 24), far: pc("Far", 30, 10) });
  r.reward("a", r.state.players.get("a"), 600, 0); // Novice Lv1 needs 548: Lv2, 52 left (below next - 1)
  assert.deepEqual(of("a", Msg.levelUp), [{ id: "a", kind: "base" }]); // AREA includes the player itself
  assert.deepEqual(of("near", Msg.levelUp), [{ id: "a", kind: "base" }]); // 5 cells
  assert.deepEqual(of("edge", Msg.levelUp), [{ id: "a", kind: "base" }]); // 14 cells on both axes: the area's corner
  assert.deepEqual(of("far", Msg.levelUp), []); // 20 cells
  for (const id of ["near", "edge", "far"]) assert.deepEqual(got.get(id)!.filter((m) => m.type !== Msg.levelUp), [], id);
  // the owner: Msg.status (new level, +3 status points, refilled HP) first, then the effect, then the EXP display
  assert.deepEqual(got.get("a")!.map((m) => m.type), [Msg.status, Msg.levelUp, Msg.exp]);
  const s = of("a", Msg.status)[0];
  assert.deepEqual([s.level, s.exp, s.statPoints, s.hp === s.maxHp], [2, 52, 51, true]);
  assert.deepEqual(of("a", Msg.exp), [{ base: 600, job: 0 }]);
});

test("a job level-up: same area, same order", () => {
  const { r, got, of } = room({ a: pc("A", 10, 10), b: pc("B", 10, 25) }); // 15 cells: just out
  r.reward("a", r.state.players.get("a"), 0, 12); // Novice job 1 needs 10
  assert.deepEqual(got.get("a")!.map((m) => m.type), [Msg.status, Msg.levelUp, Msg.exp]);
  assert.deepEqual([of("a", Msg.status)[0].jobLevel, of("a", Msg.status)[0].skillPoints], [2, 1]);
  assert.deepEqual(of("a", Msg.levelUp), [{ id: "a", kind: "job" }]);
  assert.deepEqual(got.get("b"), []);
});

test("a dead character's own HP display: never 0, max_hp / 2 for a Novice (clif_updatestatus SP_HP); the real HP stays 0", () => {
  const { r, of } = room({ n: pc("N", 10, 10, { hp: 0, dead: true }), s: pc("S", 12, 10, { job: "Swordman", hp: 0, maxHp: 120, dead: true }) });
  r.tick(0.05);
  assert.deepEqual([of("n", Msg.status)[0].hp, of("n", Msg.status)[0].maxHp], [20, 40]);
  assert.deepEqual([of("s", Msg.status)[0].hp, of("s", Msg.status)[0].maxHp], [1, 120]);
  assert.equal(r.state.players.get("n").hp, 0);
});

test("a hit on a monster reaches the players around the monster (clif_damage: the target's area)", () => {
  const { r, of } = room({ a: pc("A", 30, 10), b: pc("B", 45, 10), c: pc("C", 50, 30) });
  r.state.monsters.set("m1", new Monster({ mobId: 1002, x: 31, y: 10, dir: 0, moving: false, hp: 50, maxHp: 50, dead: false }));
  r.sendArea("AREA", "m1", Msg.hit, { from: "a", to: "m1" });
  assert.equal(of("a", Msg.hit).length, 1); // the attacker beside it
  assert.equal(of("b", Msg.hit).length, 1); // 14 cells from the monster
  assert.equal(of("c", Msg.hit).length, 0); // 20 cells away
});

test("a monster's swing in flight dies with it: nothing lands after its death (no hit after the kill / the MVP line)", () => {
  const { r } = room({ a: pc("A", 30, 10) });
  const mon = new Monster({ mobId: 1002, x: 31, y: 10, dir: 0, moving: false, hp: 50, maxHp: 50, dead: false });
  r.state.monsters.set("m1", mon);
  const a = r.state.players.get("a");
  const ev = (dmg: number) => ({ src: "m1", srcUnit: mon, target: "a", targetUnit: a, res: { dmg, dmgLv: 5, miss: false, crit: false, lucky: false }, reach: 14 });
  let landed: unknown[] | undefined;
  r.applyDamage = (...args: unknown[]) => { landed = args; };
  mon.dead = true; // killed (or taken along by its master) between the swing and its damage delay
  r.landDamage(ev(7), 0);
  assert.equal(landed, undefined);
  mon.dead = false; // alive: the same swing lands (battle_delay_damage_sub)
  r.landDamage(ev(7), 0);
  assert.deepEqual((landed as unknown as unknown[] | undefined)?.slice(0, 3), ["m1", "a", 7]);
});
