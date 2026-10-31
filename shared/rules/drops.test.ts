// Golden values for monster drops / floor items / loot priority, hand-computed from rAthena (Renewal):
// mob.cpp mob_getdroprate + mob_drop_adjust + loadingFinished drop block + mob_process_drop_list, map.cpp map_addflooritem,
// pc.cpp pc_takeitem, db/re/level_penalty.yml Type Drop. Conf = shipped conf/battle/drops.conf.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOB_BY_ID } from "./data.ts";
import {
  DROP_CONF, PICKUP_RANGE, dropDirections, dropGroup, floorItemCell, floorLoot, mapCellFree, mobDbDropRate, mobDropAdjust,
  mobDeadLootOwners, mobDropModifier, mobGetDropRate, rollMobDrops, searchFreecellDist, takeItemTick, withItemRate,
} from "./drops.ts";
import { lootOwners, type DmgLog, type Receiver } from "./dmglog.ts";

const puddle = MOB_BY_ID.get(1002)!; // Lv1: Gel Bead 7000, weapon 100, ...
const loam = MOB_BY_ID.get(1010)!; // Lv8: 9000 / 100 / 2000 / 1000 / 3000 / 2000 / 1000
const moss = MOB_BY_ID.get(1167)!; // Lv14: 4500 ...
const pc = (baseLevel: number) => ({ baseLevel });

/** Effective rate per 10000 of the i-th drop entry: sweep the roll and count the rolls that drop it. */
function effective(mob: typeof puddle, modifier: number, item: number, conf = DROP_CONF) {
  const one = { ...mob, drops: mob.drops.filter((d) => d.item === item).slice(0, 1) };
  let n = 0;
  for (let roll = 0; roll < 10000; roll++) if (rollMobDrops(one, { modifier, conf }, () => (roll + 0.5) / 10000).length) n++;
  return n;
}

test("RENEWAL_DROP level penalty: diff = mob lv - owner lv (level_penalty.yml Drop)", () => {
  assert.equal(mobDropModifier([pc(1)], loam), 80); // diff 7
  assert.equal(mobDropModifier([pc(1)], moss), 60); // diff 13
  assert.equal(mobDropModifier([pc(20)], puddle), 50); // diff -19 -> -16 and beyond
  assert.equal(mobDropModifier([pc(10)], puddle), 80); // diff -9 -> filled from -7
  assert.equal(mobDropModifier([pc(5)], puddle), 90); // diff -4
  assert.equal(mobDropModifier([pc(3)], puddle), 100); // diff -2
  assert.equal(mobDropModifier([], puddle), 100); // no owner (nobody eligible) -> 100
  assert.equal(mobDropModifier([undefined, pc(20)], puddle), 50); // first_sd ?: second_sd ?: third_sd
  assert.equal(mobDropModifier([pc(20)], { ...puddle, fixedItemDrop: true }), 100); // MD_FIXEDITEMDROP
  assert.equal(mobDropModifier([pc(20)], puddle, { noRenewalDropPenalty: true }), 100);
});

test("mob_getdroprate applies the penalty with apply_rate, then [1, 10000]", () => {
  // the critic's examples
  assert.equal(mobGetDropRate(9000, 80), 7200);
  assert.equal(mobGetDropRate(100, 80), 80);
  assert.equal(mobGetDropRate(4500, 60), 2700);
  assert.equal(mobGetDropRate(7000, 50), 3500);
  assert.equal(mobGetDropRate(100, 50), 50);
  assert.equal(mobGetDropRate(7000, 80), 5600);
  assert.equal(mobGetDropRate(1, 50), 1); // apply_rate -> 0, drop_rate0item no -> 1
  assert.equal(mobGetDropRate(1, 50, undefined, { ...DROP_CONF, drop_rate0item: true }), 0);
  assert.equal(mobGetDropRate(10000, 100), 10000);
  // killer bonuses: drops_by_luk adds luk*rate/100; a player bonus is capped at drop_rate_cap unless the base was above it
  assert.equal(mobGetDropRate(100, 100, { luk: 50 }, { ...DROP_CONF, drops_by_luk: 100 }), 150);
  assert.equal(mobGetDropRate(8000, 100, { luk: 1, pc: { dropBonus: 25 } }), 9000); // 10000.5 -> 10000 > cap 9000
  assert.equal(mobGetDropRate(9500, 100, { luk: 1, pc: { dropBonus: 25 } }), 10000); // base >= cap: 11875 -> 10000 clamp
  assert.equal(mobGetDropRate(1000, 100, { luk: 1, pc: { dropBonus: 25 } }), 1250);
  assert.equal(mobGetDropRate(8000, 80, { luk: 1, pc: { dropBonus: 25 } }), 7200); // cap before the penalty
});

test("rollMobDrops: effective rate per 10000 with the owner's penalty", () => {
  assert.equal(effective(loam, mobDropModifier([pc(1)], loam), 902), 7200);
  assert.equal(effective(loam, mobDropModifier([pc(1)], loam), 1019), 80);
  assert.equal(effective(moss, mobDropModifier([pc(1)], moss), 919), 2700);
  assert.equal(effective(puddle, mobDropModifier([pc(20)], puddle), 909), 3500);
  assert.equal(effective(puddle, mobDropModifier([pc(10)], puddle), 909), 5600);
  assert.equal(effective(puddle, 100, 909), 7000);
  // roll 0 drops every entry whose item exists; a roll at the top drops nothing
  const known = rollMobDrops(puddle, {}, () => 0);
  assert.ok(known.length > 0 && known.includes(909));
  assert.deepEqual(rollMobDrops(puddle, {}, () => 0.9999), []);
});

test("item_rate_* by item type and boss type, mob_drop_adjust clamps and truncates", () => {
  assert.equal(dropGroup("Etc"), "common");
  assert.equal(dropGroup("DelayConsume"), "common"); // not in the switch -> default
  assert.equal(dropGroup("Healing"), "heal");
  assert.equal(dropGroup("Usable"), "use");
  assert.equal(dropGroup("Armor"), "equip");
  assert.equal(dropGroup("Card"), "card");
  assert.equal(mobDbDropRate(7000, "Etc"), 7000); // 100%
  assert.equal(mobDbDropRate(5, "Etc", "None", withItemRate(150)), 7); // 7.5 -> 7 (critic: Math.round gave 8)
  assert.equal(mobDbDropRate(7000, "Etc", "None", withItemRate(200)), 10000); // item_drop_common_max
  assert.equal(mobDbDropRate(1, "Etc", "None", withItemRate(10)), 1); // item_drop_common_min
  assert.equal(mobDbDropRate(100, "Weapon", "Boss", { ...DROP_CONF, item_rate_equip_boss: 300 }), 300);
  assert.equal(mobDbDropRate(100, "Weapon", "None", { ...DROP_CONF, item_rate_equip_boss: 300 }), 100);
  assert.equal(mobDbDropRate(100, "Card", "Mvp", { ...DROP_CONF, item_rate_card_mvp: 0 }), 0); // removed
  assert.equal(mobDbDropRate(100, "Etc", "None", { ...DROP_CONF, drop_rateincrease: true }), 101);
  assert.equal(mobDbDropRate(6000, "Etc", "None", { ...DROP_CONF, drop_rateincrease: true }), 6000); // only below 5000
  assert.equal(mobDropAdjust(100, 200, 1, 10000, { ...DROP_CONF, item_logarithmic_drops: true }), 161); // 100*3^(ln2/ln5)+.5
  // a weapon drop at 0% equip rate is removed at load: never drops even on roll 0
  assert.ok(!rollMobDrops(puddle, { conf: { ...DROP_CONF, item_rate_equip: 0 } }, () => 0).includes(1202));
});

test("mob_process_drop_list: center, then SE -> W -> N -> SE; looted items start north", () => {
  const SE = { dx: 1, dy: 1 }, W = { dx: -1, dy: 0 }, N = { dx: 0, dy: -1 };
  assert.deepEqual(dropDirections(6), [null, SE, W, N, SE, W]);
  assert.deepEqual(dropDirections(3, true), [N, SE, W]);
});

test("map_addflooritem cell: center never moves, busy cells move to a free neighbour or stay", () => {
  const all = () => true, none = () => false;
  assert.deepEqual(floorItemCell(30, 30, null, none), { x: 30, y: 30 });
  assert.deepEqual(floorItemCell(30, 30, { dx: 1, dy: 1 }, all), { x: 31, y: 31 });
  // SE cell (31,31) busy; r() = 0: no mirroring, first neighbour tried is (-1,-1) of the target
  const busy = (x: number, y: number) => !(x === 31 && y === 31);
  assert.deepEqual(floorItemCell(30, 30, { dx: 1, dy: 1 }, busy, () => 0), { x: 30, y: 30 });
  assert.deepEqual(floorItemCell(30, 30, { dx: -1, dy: 0 }, none, () => 0), { x: 29, y: 30 }); // nothing free: stays
  // map_search_freecell_dist mirroring: r() just under 1 -> both mirrors -1, first try is (+1,+1)
  assert.deepEqual(searchFreecellDist(10, 10, 1, 1, all, () => 0.99), { x: 11, y: 11 });
  assert.equal(searchFreecellDist(10, 10, 1, 1, none, () => 0), null);
  // map_cell_free: edge band min(map_edge_size, 5), x > xs - 5 is out
  const m = { w: 64, h: 64 };
  assert.equal(mapCellFree(m, 4, 30, all, none), false);
  assert.equal(mapCellFree(m, 5, 30, all, none), true);
  assert.equal(mapCellFree(m, 59, 59, all, none), true);
  assert.equal(mapCellFree(m, 60, 30, all, none), false);
  assert.equal(mapCellFree(m, 30, 30, none, none), false); // not passable
  assert.equal(mapCellFree(m, 30, 30, all, all), false); // a character on it
});

test("loot priority: first/second/third owner windows, then everyone (pc_takeitem)", () => {
  const f = floorLoot(1000, [11, 22, 33]);
  assert.deepEqual(f, { first: 11, second: 22, third: 33, firstTick: 4000, secondTick: 6000, thirdTick: 8000 });
  assert.equal(takeItemTick(f, 11), 0);
  assert.equal(takeItemTick(f, 22), 4000);
  assert.equal(takeItemTick(f, 33), 6000);
  assert.equal(takeItemTick(f, 99), 8000); // bystander waits 7 s
  const solo = floorLoot(1000, [11]);
  assert.equal(takeItemTick(solo, 99), 8000); // even with no 2nd/3rd owner
  assert.equal(takeItemTick(floorLoot(1000, []), 99), 0); // nobody eligible: free for all
  const boss = floorLoot(1000, [11], "Boss");
  assert.deepEqual([boss.firstTick, boss.secondTick, boss.thirdTick], [11000, 21000, 23000]); // mvp_item_*_get_time
  assert.equal(floorLoot(1000, [11], "None", true).thirdTick, 23000); // MVP prize (flags&1)
  assert.equal(DROP_CONF.flooritem_lifetime, 60000);
  assert.equal(PICKUP_RANGE, 2);
});

test("drop owner = top damage dealer (+30% first-attacker bonus), not the last hitter", () => {
  // A opens with 10, B hits 30, C (kill-stealer) lands the last 5. total 45, A gets +13 (45*30/100) -> 23.
  const log: DmgLog = [{ id: 1, flag: "normal", dmg: 10, dmgTanked: 0 }, { id: 2, flag: "normal", dmg: 30, dmgTanked: 0 },
    { id: 3, flag: "normal", dmg: 5, dmgTanked: 0 }];
  const lv: Record<number, Receiver> = { 1: { baseLevel: 1, dead: false }, 2: { baseLevel: 20, dead: false }, 3: { baseLevel: 1, dead: false } };
  const owners = mobDeadLootOwners(lootOwners(log, (id) => lv[id]), 3);
  assert.deepEqual(owners, [2, 1, 3]);
  assert.equal(mobDropModifier(owners.map((id) => lv[id]), puddle), 50); // penalty from B (Lv20), not the Lv1 killer
});

test("mob_dead first_sd falls back to the killing player when no damage-log entry is eligible", () => {
  // the killer (char 7) died before its delayed hit landed: its log entry is skipped (pc_isdead), nobody else hit
  const log: DmgLog = [{ id: 7, flag: "normal", dmg: 40, dmgTanked: 0 }];
  const ranked = lootOwners(log, () => ({ baseLevel: 30, dead: true }));
  assert.deepEqual(ranked, []);
  assert.deepEqual(mobDeadLootOwners(ranked, 7), [7]); // first_sd = sd (mob.cpp:2955)
  assert.equal(takeItemTick(floorLoot(0, mobDeadLootOwners(ranked, 7)), 99), 7000); // a bystander still waits
  assert.equal(mobDropModifier([{ baseLevel: 30 }], puddle), 50); // and the killer's level drives the penalty
  assert.deepEqual(mobDeadLootOwners([], undefined), []); // killed by a monster / script: no owner
  assert.deepEqual(mobDeadLootOwners([4, 5], 7), [4, 5]); // the ranking wins whenever it found someone
});
