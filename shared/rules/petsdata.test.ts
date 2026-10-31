// pets.json (tools/rathena/import.ts, rAthena db/re/pet_db.yml + our overrides): every pet points at a roster monster and real items.
import { test } from "node:test";
import assert from "node:assert/strict";
import petsJson from "../data/pets.json" with { type: "json" };
import { MOBS } from "./data.ts";
import { ITEMS } from "./items.ts";
import { NPCS, PET_STOCK } from "../content/npcs.ts";

test("every pet's monster, egg, taming item, food and accessory exist", () => {
  assert.ok(petsJson.length >= 6);
  const seen = new Set<number>();
  for (const p of petsJson) {
    assert.ok(!seen.has(p.mobId), `one row per monster ${p.mobId}`); seen.add(p.mobId);
    assert.ok(MOBS.find((m) => m.id === p.mobId), `monster ${p.mobId}`);
    assert.equal(ITEMS.get(p.eggItem)?.type, "Petegg", `${p.name}: egg`);
    assert.equal(ITEMS.get(p.eggItem)?.name, `${p.name} Egg`);
    const legendary = (p as { rarity?: string }).rarity === "legendary"; // 2.4.0: never tamed (egg from the MVP only), no accessory
    if (!legendary) assert.ok(ITEMS.get(p.tameItem), `${p.name}: taming item`);
    assert.ok(ITEMS.get(p.foodItem), `${p.name}: food`);
    if (!legendary) assert.equal(ITEMS.get(p.equipItem)?.type, "Petarmor", `${p.name}: accessory`);
    assert.ok(["companion", "battle", "support"].includes(p.kind));
    assert.deepEqual(p.unsupported, [], `${p.name}: every pet bonus is modelled`);
    assert.ok(p.loyalBonus.length > 0 || p.bonus.length > 0);
    if (p.kind === "battle") assert.ok(p.attackRate > 0 || p.support.attacks.length > 0);
    if (p.kind === "support") assert.ok(p.support.skills.length + p.support.bonuses.length > 0);
    assert.ok(p.intimacyStart > 0 && p.captureRate > 0);
  }
  assert.ok(petsJson.filter((p) => p.kind === "battle").length >= 2, "at least two fighting pets");
  assert.ok(petsJson.filter((p) => p.kind === "support").length >= 2, "at least two support pets");
});

test("Tilda sells the taming items, foods and accessories (never eggs)", () => {
  const tools = NPCS.find((n) => n.name === "Tilda's Sundries")!;
  for (const p of petsJson) for (const id of [p.tameItem, p.foodItem, p.equipItem].filter((x) => x > 0)) assert.ok((tools.shop as number[]).includes(id), `${p.name}: item ${id} in the tool shop`);
  for (const id of PET_STOCK) assert.notEqual(ITEMS.get(id)!.type, "Petegg");
});
