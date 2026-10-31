import { test } from "node:test";
import assert from "node:assert/strict";
import { PARTY_CONF, partyCheckExpShare, partyExpAggregate, partyExpSplit, partyLootPick, partyName } from "./party.ts";
import { mobDeadExp, mobDeadShares, penalized, type DmgLog, type Receiver } from "./dmglog.ts";

test("party_create: name cut to NAME_LENGTH - 1 and trimmed, empty refused", () => {
  assert.equal(partyName("  Wolves "), "Wolves");
  assert.equal(partyName("   "), undefined);
  assert.equal(partyName(undefined), undefined);
  assert.equal(partyName("x".repeat(30))!.length, 23);
});

test("party_check_exp_share: online members within party_share_level (15) base levels", () => {
  assert.equal(partyCheckExpShare([]), true);
  assert.equal(partyCheckExpShare([1]), true); // count < 2
  assert.equal(partyCheckExpShare([10, 25]), true); // 15 apart: allowed (<=)
  assert.equal(partyCheckExpShare([10, 26]), false);
  assert.equal(partyCheckExpShare([30, 20, 35]), true);
  assert.equal(partyCheckExpShare([30, 20, 44]), false);
  assert.equal(partyCheckExpShare([10, 26], { ...PARTY_CONF, party_share_level: 20 }), true);
});

test("party_exp_share: integer split among the members on the map, no bonus by default", () => {
  assert.deepEqual(partyExpSplit(150, 50, 1), { base: 150, job: 50 });
  assert.deepEqual(partyExpSplit(150, 50, 2), { base: 75, job: 25 });
  assert.deepEqual(partyExpSplit(151, 51, 3), { base: 50, job: 17 });
  assert.deepEqual(partyExpSplit(150, 50, 0), { base: 0, job: 0 });
  // party_even_share_bonus 10: 3 members -> +20%
  assert.deepEqual(partyExpSplit(150, 50, 3, { ...PARTY_CONF, party_even_share_bonus: 10 }), { base: 60, job: 19 });
});

const tumhog = { level: 4, baseExp: 150, jobExp: 50, hp: 48 };
const alive = (baseLevel = 4): Receiver => ({ baseLevel, dead: false });
const A = 1, B = 2, C = 3;

test("mob_dead: even-share party members' shares are added up per party, others paid directly", () => {
  const log: DmgLog = [{ id: A, flag: "normal", dmg: 30, dmgTanked: 0 }, { id: B, flag: "normal", dmg: 18, dmgTanked: 0 }, { id: C, flag: "normal", dmg: 0, dmgTanked: 5 }];
  const who = (id: number) => alive();
  const shares = mobDeadShares(log, tumhog, who);
  const { direct, parties } = partyExpAggregate(shares, (id) => (id === A || id === B ? 7 : undefined));
  assert.deepEqual(direct.map((s) => s.id), [C]);
  assert.equal(parties.length, 1);
  const a = shares.find((s) => s.id === A)!, b = shares.find((s) => s.id === B)!;
  assert.deepEqual(parties[0], { partyId: 7, base: a.base + b.base, job: a.job + b.job });
  // without a party the shares equal mobDeadExp (no level penalty at equal levels)
  assert.deepEqual(mobDeadExp(log, tumhog, who), shares);
});

test("party_exp_share: the Renewal level penalty is applied per member after the split", () => {
  const each = partyExpSplit(150, 50, 2);
  assert.deepEqual(penalized(each, { baseLevel: 4 }, tumhog), each);
  const far = penalized(each, { baseLevel: 40 }, tumhog); // 36 levels above the monster: reduced, never below 1
  assert.ok(far.base < each.base && far.base >= 1);
});

test("party_share_loot: random member, one who can't carry it is dropped from the draw", () => {
  const seq = [0, 0];
  const pick = partyLootPick(["a", "b", "c"], (m) => m !== "a", () => seq.shift() ?? 0);
  assert.equal(pick, "c"); // a refused -> swapped with c -> c
  assert.equal(partyLootPick(["a"], () => false, () => 0), undefined);
});
