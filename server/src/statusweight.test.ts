// The owner learns a changed carry limit at once: status_calc_pc sends SP_MAXWEIGHT whenever max_weight changes
// (status.cpp:3693-3697) and pc_updateweightstatus SP_WEIGHT; here both ride Msg.status through flushStatus.
import test from "node:test";
import assert from "node:assert/strict";
import { Msg } from "../../shared/protocol.ts";
import { maxWeight } from "../../shared/rules/items.ts";

// config.ts demands env at import; the test only calls two methods on a stand-in room, so nothing connects (no DB / Redis).
process.env.GAME_NAME ??= "ro_test"; process.env.DATABASE_URL ??= "postgres://unused"; process.env.REDIS_URL ??= "redis://unused";
const { MapRoom } = await import("./rooms/MapRoom.ts");
const proto = MapRoom.prototype as any;
const player = (over: object = {}) => ({
  level: 1, jobLevel: 1, exp: 0, jobExp: 0, statPoints: 10, skillPoints: 0, hp: 40, maxHp: 40, sp: 11, maxSp: 11,
  job: "Novice", str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1, ...over,
});

test("Msg.status carries weight and max weight (job max + STR * 300)", () => {
  const inv = { weight: () => 1234 };
  const s = proto.ownerStatus.call({}, player({ str: 11 }), inv);
  assert.equal(s.weight, 1234);
  assert.equal(s.maxWeight, maxWeight("Novice", 11)); // 20000 + 11 * 300 = 23300
  assert.equal(s.maxWeight, 23300);
});

test("flushStatus resends when only the max weight changed (STR raise), not when nothing changed", () => {
  const p = player(), sent: [string, any][] = [];
  const b: any = { inv: { weight: () => 500 } };
  const client = { send: (t: string, m: any) => sent.push([t, m]) };
  const room: any = { state: { players: new Map([["a", p]]) }, brains: new Map([["a", b]]), clients: { getById: () => client }, ownerStatus: proto.ownerStatus };
  proto.flushStatus.call(room, "a", client);
  proto.flushStatus.call(room, "a", client);
  assert.equal(sent.length, 1, "unchanged numbers are not resent");
  p.str += 10; // statUp: the carry limit grows by 3000
  proto.flushStatus.call(room, "a", client);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0], Msg.status);
  assert.equal(sent[1][1].maxWeight - sent[0][1].maxWeight, 3000);
  p.job = "Swordman"; // a job change moves it too (job max weight differs)
  proto.flushStatus.call(room, "a", client);
  assert.equal(sent.length, 3);
  assert.equal(sent[2][1].maxWeight, maxWeight("Swordman", 11));
});
