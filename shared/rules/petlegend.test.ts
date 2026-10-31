// 2.4.0 legendary pets: the dragon wyrmling's data (pets.json / mobs.json from tools/rathena/import.ts LEGENDARY PETS) and its
// battle numbers (shared/rules/pet.ts legendaryHitDamage / breathChance / breathDamage), worked by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import petsJson from "../data/pets.json" with { type: "json" };
import { LEGENDARY_PET, breathChance, breathDamage, legendaryHitDamage, petHitDamage, petRow, supportRate } from "./pet.ts";
import { MOBS } from "./data.ts";
import { ITEMS } from "./items.ts";
import { SKILLS } from "./skill.ts";
import { attrFix } from "./battle.ts";

const RAW = petsJson as unknown as Record<string, unknown>[];
const legend = RAW.filter((p) => p.rarity === "legendary");

test("one legendary pet: the dragon wyrmling, a never-spawning battle pet with fire breath, its egg only from the MVP at 0.01 %", () => {
  assert.equal(legend.length, 1);
  const db = petRow(legend[0]), mob = MOBS.find((m) => m.id === db.mobId)!;
  assert.equal(mob.race, "Dragon");
  assert.equal((mob as { petOnly?: boolean }).petOnly, true);
  assert.deepEqual(mob.drops, []);
  assert.equal(db.kind, "battle");
  assert.equal(db.rarity, "legendary");
  assert.equal(db.rideable, true);
  assert.equal(db.tameItem, 0, "can't be tamed");
  assert.equal(ITEMS.get(db.eggItem)?.type, "Petegg");
  assert.equal(ITEMS.get(db.eggItem)?.name, `${mob.name} Egg`);
  assert.ok(db.fullness < 4, "hungers slower than rAthena's row (4)");
  assert.equal(db.attacks.length, 1);
  assert.equal(SKILLS.get(db.attacks[0].skill)?.key, "MG_FIREBALL");
  const droppers = MOBS.filter((m) => m.drops.some((d) => d.item === db.eggItem));
  assert.deepEqual(droppers.map((m) => [m.bossType, m.drops.find((d) => d.item === db.eggItem)!.rate]), [["Mvp", 1]]);
  for (const p of RAW) if (p !== legend[0]) assert.equal(p.rarity, "common");
});

test("legendary normal hit: 30 % of the owner + ATK/20, cap 38 % (common: 15 % + ATK/10, cap 25 %)", () => {
  assert.equal(legendaryHitDamage(0, 100), 0); // the pet missed
  assert.equal(legendaryHitDamage(400, 100), 38); // 30 + 20 -> cap 38
  assert.equal(legendaryHitDamage(400, 1000), 320); // 300 + 20 under the cap 380
  assert.equal(legendaryHitDamage(400, 5), 2); // floor 2, no Lv86 floor
  for (const own of [25, 80, 200, 600]) {
    const l = legendaryHitDamage(361, own), c = petHitDamage(30, own, 1);
    assert.ok(l > c, `stronger than a common battle pet at ${own}`);
    assert.ok(l <= own * LEGENDARY_PET.hitCap, `never above 38 % at ${own}`);
  }
});

test("fire breath: pet_attackskill chance, share per target, Fire element table", () => {
  const a = { rate: 15, bonusRate: 15 };
  assert.equal(breathChance(a, 250), 18); // 15 + trunc(250 * 15 / 1000)
  assert.equal(breathChance(a, 1000), 30);
  assert.equal(breathChance({ rate: 90, bonusRate: 100 }, 1000), 100);
  assert.equal(breathDamage(100, 66), 58); // trunc(55 + 3.3), under the 80 cap
  assert.equal(breathDamage(10, 66), 8); // 5 + 3 = 8 = the cap
  assert.equal(breathDamage(0, 0), 1);
  assert.equal(attrFix(breathDamage(100, 66), "Fire", "Earth", 1), 87); // x1.5 on Earth
  assert.ok(attrFix(breathDamage(100, 66), "Fire", "Water", 1) < breathDamage(100, 66));
});

test("the legendary pet fights from neutral intimacy like every battle pet (no extra gate)", () => {
  const db = petRow(legend[0]);
  assert.equal(supportRate(db, { intimacy: 250, hunger: 50 }, { retaliate: false, targetMobId: 1002, masterDead: false }), 2500);
  assert.equal(supportRate(db, { intimacy: 249, hunger: 50 }, { retaliate: false, targetMobId: 1002, masterDead: false }), 0);
  assert.equal(supportRate(db, { intimacy: 250, hunger: 0 }, { retaliate: false, targetMobId: 1002, masterDead: false }), 0);
});
