// 2.5.0 gear grades and the boss-only rule for rare drops (data from tools/rathena/gear250.ts through the importer).
import test from "node:test";
import assert from "node:assert/strict";
import itemsJson from "../data/items.json" with { type: "json" };
import mobsJson from "../data/mobs.json" with { type: "json" };
import { GRADES, gradeRank, itemGrade, type Grade } from "./grade.ts";

const items = itemsJson as { id: number; name: string; type: string; grade?: string; shop: boolean; buy: number; sell: number; equipLevel: number }[];
const byId = new Map(items.map((i) => [i.id, i]));
const mobs = mobsJson as { id: number; name: string; class: string; drops: { item: number; rate: number }[]; mvpDrops: { item: number; rate: number }[] }[];
const rarePlus = (id: number) => gradeRank(itemGrade(byId.get(id) ?? {})) >= gradeRank("rare");
const CAP: Record<string, number> = { rare: 100, epic: 30, legendary: 5 }; // x/10000: 1 %, 0.3 %, 0.05 %

test("every weapon and armour has a valid grade, nothing else has one", () => {
  for (const i of items) {
    if (i.type === "Weapon" || i.type === "Armor") assert.ok((GRADES as readonly string[]).includes(i.grade ?? ""), `${i.name} grade`);
    else assert.equal(i.grade, undefined, `${i.name} is not gear`);
  }
  const n = (g: Grade) => items.filter((i) => i.grade === g).length;
  assert.ok(n("common") > 10 && n("fine") > 20 && n("rare") > 20 && n("epic") >= 5, "tiers are populated");
  assert.ok(n("legendary") >= 1 && n("legendary") <= 3, "legendary is hand-picked: 1-3 items");
});

test("rare / epic / legendary drop only from Boss class monsters, at low rates", () => {
  for (const m of mobs) for (const d of [...m.drops, ...m.mvpDrops]) {
    if (!rarePlus(d.item)) continue;
    const it = byId.get(d.item)!;
    assert.equal(m.class, "Boss", `${m.name} (${m.class}) drops ${it.name} (${it.grade})`);
    assert.ok(d.rate <= CAP[it.grade!], `${m.name} drops ${it.name} at ${d.rate / 100} %`);
  }
});

test("every rare+ item has a boss source; epic and legendary only from the MVP", () => {
  for (const it of items.filter((i) => rarePlus(i.id))) {
    const from = mobs.filter((m) => [...m.drops, ...m.mvpDrops].some((d) => d.item === it.id));
    assert.ok(from.length > 0, `${it.name} (${it.grade}) has no source`);
    if (it.grade === "epic" || it.grade === "legendary") assert.deepEqual(from.map((m) => m.id), [3810], `${it.name} is MVP-only`);
  }
});

test("rare+ gear is never sold in town; shop gear prices are sane", () => {
  for (const i of items) {
    if (rarePlus(i.id)) assert.equal(i.shop, false, `${i.name} must not be sold`);
    if (i.shop && (i.type === "Weapon" || i.type === "Armor")) {
      assert.ok(i.sell <= Math.floor(i.buy / 2), `${i.name}: sells for more than half its price`);
      assert.ok(i.buy <= 30_000, `${i.name} costs ${i.buy} z`);
      if (i.equipLevel <= 20 && i.type === "Weapon") assert.ok(i.buy <= 10_000, `${i.name} (level ${i.equipLevel}) costs ${i.buy} z`);
    }
  }
});
