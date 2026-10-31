// Golden numbers for the refiner, checked against db/re/refine.yml (Normal cost rows) and npc/merchants/refine.txt refinemain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEMS } from "./items.ts";
import { refineBlock, refineCost, refineIsSafe, refinePercent, refineSafeLimit, refineSucceeds } from "./refine.ts";

const named = (n: string) => [...ITEMS.values()].find((i) => i.name === n)!;
/** a weapon of any level (the item set only has Lv 1-2 yet; the table covers Lv 1-5) */
const wp = (weaponLevel: number) => ({ type: "Weapon", weaponLevel, armorLevel: 0, refineable: true, locations: ["Right_Hand"] });
const matName = (id: number) => ITEMS.get(id)?.name;

test("safe limits are refinemain's .@safe (weapon Lv 1-4 = +7/+6/+5/+4, armor Lv 1 = +4)", () => {
  assert.deepEqual([1, 2, 3, 4].map((lv) => refineSafeLimit(wp(lv))), [7, 6, 5, 4]);
  assert.equal(refineSafeLimit(named("Cotton Shirt")), 4);
});

test("chances, ore and zeny come from refine.yml", () => {
  const knife = named("Knife"); // Lv 1 weapon
  assert.equal(refinePercent(knife, 7), 60); // +7 -> +8: Rate 6000
  assert.equal(refinePercent(knife, 9), 19); // +9 -> +10: Rate 1900
  assert.deepEqual([refineCost(knife, 0)!.price, matName(refineCost(knife, 0)!.material)], [50, "Rough Ore"]);
  const shirt = named("Cotton Shirt"); // Lv 1 armor
  assert.equal(refinePercent(shirt, 4), 60); // +4 -> +5: Rate 6000
  assert.equal(refinePercent(shirt, 9), 9);
  assert.deepEqual([refineCost(shirt, 5)!.price, matName(refineCost(shirt, 5)!.material), refineCost(shirt, 5)!.breakingRate], [2000, "Starsteel", 10000]);
  const lv3 = wp(3);
  assert.deepEqual([refinePercent(lv3, 5), refinePercent(lv3, 6), refineCost(lv3, 2)!.price, matName(refineCost(lv3, 2)!.material)], [60, 50, 5000, "Forgesteel"]);
  const lv2 = named("Cutter").weaponLevel === 2 ? named("Cutter") : wp(2);
  assert.deepEqual([refineCost(lv2, 0)!.price, matName(refineCost(lv2, 0)!.material)], [200, "Bright Ore"]);
});

test("safe attempts always succeed, risky ones follow the roll", () => {
  const knife = named("Knife");
  assert.ok(refineIsSafe(knife, 6) && !refineIsSafe(knife, 7));
  assert.ok(refineSucceeds(knife, 0, 99));
  assert.ok(refineSucceeds(knife, 7, 59) && !refineSucceeds(knife, 7, 60)); // 60 %: rolls 0-59 pass
});

test("the NPC stops at +10 and refuses unrefineable pieces", () => {
  assert.equal(refineBlock(named("Knife"), 3), null);
  assert.match(refineBlock(named("Knife"), 10)!, /as refined/);
  assert.match(refineBlock(named("Red Tonic") as never, 0)!, /can't be refined/);
});
