// Golden tests for shared/rules/pet.ts (rAthena pet.cpp numbers, worked by hand from the C++).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PET_INTIMATE, autoFeedDue, catchBlock, catchRate, feed, hungerTick, newPet, ownerDied, petBonuses, petHitDamage, petRow, rateFix, supportRate, supportReady, validPetName, petHealAmount } from "./pet.ts";

// a pet_db row like a starter pet (yml defaults left out on purpose)
const DB = petRow({ mobId: 1002, tameItem: 619, eggItem: 9001, foodItem: 531, fullness: 3, intimacyFed: 50, captureRate: 2000,
  bonus: { cordial: [{ type: "bLuk", value: 2 }], loyal: [{ type: "bLuk", value: 3 }] }, kind: "battle", attackRate: 1000, retaliateRate: 2000 });

test("petRow fills pet_db.yml defaults", () => {
  assert.equal(DB.hungryDelay, 60_000);
  assert.equal(DB.hungerIncrease, 20);
  assert.equal(DB.intimacyStart, 250);
  assert.equal(DB.intimacyOverfed, -100);
  assert.equal(DB.intimacyHungry, -5);
  assert.equal(DB.intimacyOwnerDie, -20);
  assert.equal(DB.allowAutoFeed, false);
  const n = newPet(DB, 1, "Pup");
  assert.deepEqual([n.hunger, n.intimacy, n.incubate], [100, 250, true]);
});

test("catch rate: pet_catch_process_end non-legacy formula", () => {
  assert.equal(catchRate(2000, 50, 50), 2000); // full HP: the base rate
  assert.equal(catchRate(2000, 25, 50), 3000); // 50 % HP: + 50 % of it
  assert.equal(catchRate(2000, 1, 50), 3960); // 2 % HP
  assert.equal(catchRate(0, 50, 50), 1); // at least 1
  assert.equal(catchBlock({ tameItem: 1, db: DB, distance: 1, bagFull: false }) !== null, true);
  assert.equal(catchBlock({ tameItem: 619, db: DB, distance: 6, bagFull: false }) !== null, true);
  assert.equal(catchBlock({ tameItem: 619, db: DB, distance: 5, bagFull: false }), null);
});

test("pet_hungry: fullness, starving, intimacy loss", () => {
  assert.deepEqual(hungerTick({ hunger: 100, intimacy: 250 }, DB), { hunger: 97, intimacy: 250, interval: 60_000, starving: false });
  assert.deepEqual(hungerTick({ hunger: 2, intimacy: 250 }, DB), { hunger: 0, intimacy: 245, interval: 20_000, starving: true });
  assert.equal(hungerTick({ hunger: 0, intimacy: 3 }, DB).intimacy, 0); // runs away
  assert.equal(autoFeedDue({ hunger: 50, autoFeed: true }, DB), false); // AllowAutoFeed false
});

test("pet_food: fed / half above neutral / overfed", () => {
  assert.deepEqual(feed({ hunger: 20, intimacy: 250 }, DB), { hunger: 40, intimacy: 300, overfed: false });
  assert.deepEqual(feed({ hunger: 80, intimacy: 250 }, DB), { hunger: 100, intimacy: 275, overfed: false });
  assert.deepEqual(feed({ hunger: 95, intimacy: 250 }, DB), { hunger: 100, intimacy: 150, overfed: true });
  assert.equal(feed({ hunger: 95, intimacy: 50 }, DB).intimacy, 0);
  assert.equal(ownerDied(250, DB), 230);
});

test("pet bonus tiers + battle support rate", () => {
  assert.deepEqual(petBonuses(DB, 749, 50), []);
  assert.deepEqual(petBonuses(DB, 750, 50), [{ type: "bLuk", value: 2 }]);
  assert.deepEqual(petBonuses(DB, 910, 50), [{ type: "bLuk", value: 3 }]);
  assert.deepEqual(petBonuses(DB, 910, 0), []);
  assert.equal(rateFix(900), 500);
  assert.equal(rateFix(1000), 1500);
  assert.equal(supportRate(DB, { intimacy: 249, hunger: 50 }, { retaliate: false, targetMobId: 1, masterDead: false }), 0);
  assert.equal(supportRate(DB, { intimacy: 250, hunger: 50 }, { retaliate: false, targetMobId: 1, masterDead: false }), 500); // neutral x0.5 of 1000
  assert.equal(supportRate(DB, { intimacy: 750, hunger: 50 }, { retaliate: false, targetMobId: 1, masterDead: false }), 750); // cordial x0.75
  assert.equal(supportRate(DB, { intimacy: 1000, hunger: 50 }, { retaliate: true, targetMobId: 1, masterDead: false }), 2000); // loyal x1.0
  assert.equal(supportRate(DB, { intimacy: 1000, hunger: 50 }, { retaliate: true, targetMobId: 1002, masterDead: false }), 0);
  assert.equal(petHitDamage(0, 100), 0);
  assert.equal(petHitDamage(30, 0, 1), 2); // never 0 on a hit
  // owner average hit 25 / 80 / 200 (Lv5 / Lv20 / Lv40 owner; pet Lv 3 / 8 / 15), pet ATK 30: roughly a sixth to a quarter of the owner's hit
  assert.deepEqual([[25, 3], [80, 8], [200, 15]].map(([o, l]) => petHitDamage(30, o, l)), [6, 15, 33]);
  assert.equal(petHitDamage(30, 25, 5) / 25 <= 0.25, true);
});

test("importer shape (pets.json)", () => {
  const r = petRow({ mobId: 1002, bonus: [{ type: "bLuk", value: 2 }], loyalBonus: [{ type: "bLuk", value: 3 }],
    support: { skills: [{ skill: 28, level: 1, delay: 30, hpPercent: 50, spPercent: 100 }], attacks: [], bonuses: [{ type: "bStr", value: 3, duration: 60, delay: 70 }] } });
  assert.deepEqual(r.bonus, { cordial: [{ type: "bLuk", value: 2 }], loyal: [{ type: "bLuk", value: 3 }] });
  assert.deepEqual(r.support, [{ type: "skill", skill: 28, lv: 1, delay: 30, hp: 50, sp: 100 },
    { type: "bonus", bonus: { type: "bStr", value: 3 }, duration: 60, delay: 70, hp: 100, sp: 100 }]);
  assert.equal(petHealAmount(4, 10, 1), 24); // floor
  assert.equal(petHealAmount(30, 50, 1), 120);
});

test("support timer thresholds + names", () => {
  const s = { type: "heal" as const, amount: 100, delay: 60, hp: 33, sp: 100 };
  assert.deepEqual(supportReady(s, { dead: false, hp: 50, maxHp: 100, sp: 10, maxSp: 10 }), { ok: false, waitMs: 5000 });
  assert.deepEqual(supportReady(s, { dead: false, hp: 33, maxHp: 100, sp: 10, maxSp: 10 }), { ok: true });
  assert.equal(validPetName("  Momo "), "Momo");
  assert.equal(validPetName(""), null);
  assert.equal(validPetName("x".repeat(24)), null);
  assert.equal(PET_INTIMATE.LOYAL, 910);
});
