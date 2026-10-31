// Golden tests for cards: drop rates (mob.cpp mob_dead drop loop + drops.conf item_rate_card), compounding (pc_insert_card pc.cpp:5596,
// clif_use_card clif.cpp:7074), the carded name (client getItemName rule) and the card scripts' bonuses (status.cpp "Parse Cards" 4098).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEMS, gearOf, weaponOf } from "./items.ts";
import { MOB_BY_ID, MOBS } from "./data.ts";
import { compoundBlock, cardTargets, itemDisplayName, withCard } from "./cards.ts";
import { DROP_CONF, mobDbDropRate, rollMobDrops, withItemRate } from "./drops.ts";
import { mobStatus, playerStatus } from "./status.ts";
import { BL, playerAttack, type Target } from "./battle.ts";

const id = (name: string) => [...ITEMS.values()].find((i) => i.name === name)!.id;
const LEAFGRUB = id("Leafgrub Card"), PUDDLEBLOOM = id("Puddlebloom Card"), ROOTGRIN = id("Rootgrin Card"), PUPA = id("Silkwrap Card");
const KNIFE4 = 1202, KNIFE3 = 1201, SHIRT1 = 2302, SHIRT0 = 2301, GUARD1 = 2102, BOW4 = 1702;
const card = (i: number) => ITEMS.get(i)!;
const row = (itemId: number, cards: number[] = [], equip: string | null = null) => ({ itemId, cards, equip });

test("every roster monster drops its card at mob_db's rate (Rate 1 = 0.01%), as the only Card in its table", () => {
  const rate: Record<number, number> = { 1002: 20, 1113: 20, 1063: 20, 1049: 20, 1010: 10, 1009: 1, 1012: 1, 1167: 1, 1008: 1, 1011: 20, 1007: 20, 1020: 1, 1052: 1, 1015: 10, 1025: 10, 1019: 1,
    1047: 1, 1004: 20, 1107: 1, 1001: 1, 1014: 10, 1094: 1, 1024: 1, 1051: 20, 1174: 1, 1175: 1, 1005: 1, 1076: 10,
    // 2.4.0 owner's decision (tools/rathena/import.ts BOSS_CARD_RATE / MVP_CARD, bosscards.test.ts): the four field bosses 86 / 48 / 30 / 100, Gloopking 10
    1093: 86, 1090: 48, 1091: 30, 1089: 100, 3810: 10,
    // 2.5.0 floor 2 (rAthena Rate 1 each); Cinderwarden, the mini-boss, is on the boss line at its Lv42 (import.ts F2_MINIBOSS)
    1128: 1, 1176: 1, 1033: 1, 1028: 1, 1123: 1, 1013: 1, 1391: 1, 1250: 48,
    // 2.5.4 floor 2's MVP Devo (import.ts DEVO_CARD): Baphomet__Card at 0.05 %
    3999: 5 };
  const roster = MOBS.filter((m) => !(m as { petOnly?: boolean }).petOnly); // legendary pets' species ship no drops
  assert.equal(roster.length, 42);
  for (const m of roster) {
    // 2.4.0 CARDS: Gloopking also drops the legendary card (0.01 %, album.test.ts), the one Card of its own is the other
    const cards = m.drops.filter((d) => ITEMS.get(d.item)?.type === "Card" && (ITEMS.get(d.item) as { rarity?: string }).rarity !== "legendary");
    assert.equal(cards.length, 1, m.name);
    assert.equal(cards[0].rate, rate[m.id], m.name);
    assert.equal(ITEMS.get(cards[0].item)!.mobId, m.id); // the card knows its monster
  }
});

test("card drop roll: floor(r * 10000) < rate, item_rate_card scales it, the level penalty cuts it, never below 1 (mob_getdroprate)", () => {
  const leafgrub = MOB_BY_ID.get(1007)!, only = { ...leafgrub, drops: leafgrub.drops.filter((d) => d.item === LEAFGRUB) }; // rate 20 = 0.20%
  const roll = (r: number, opts = {}) => rollMobDrops(only, opts, () => r);
  assert.deepEqual([roll(0.0019), roll(0.002)], [[LEAFGRUB], []]); // 19 < 20, 20 is not
  assert.equal(mobDbDropRate(20, "Card"), 20);
  assert.equal(mobDbDropRate(20, "Card", "None", withItemRate(300)), 60); // item_rate_card 300
  assert.deepEqual(roll(0.0059, { conf: withItemRate(300) }), [LEAFGRUB]);
  assert.deepEqual(roll(0.006, { conf: withItemRate(300) }), []);
  assert.deepEqual(roll(0.0009, { modifier: 50 }), [LEAFGRUB]); // 20 at 50% = 10: 9 < 10
  assert.deepEqual(roll(0.001, { modifier: 50 }), []);
  const rarest = { ...MOB_BY_ID.get(1020)!, drops: MOB_BY_ID.get(1020)!.drops.filter((d) => d.item === ROOTGRIN) }; // Rate 1
  assert.deepEqual([rollMobDrops(rarest, {}, () => 0.00009), rollMobDrops(rarest, {}, () => 0.0001)], [[ROOTGRIN], []]);
  assert.deepEqual(rollMobDrops(rarest, { modifier: 1 }, () => 0), [ROOTGRIN]); // 1 * 1% -> floored to the minimum 1 (drop_rate0item off)
  assert.equal(DROP_CONF.item_rate_card, 100);
});

test("compounding rules: location overlap, weapon / armor only, free slot, unequipped (pc_insert_card order)", () => {
  assert.equal(compoundBlock(card(LEAFGRUB), row(KNIFE4)), null); // Right_Hand card -> weapon
  assert.equal(compoundBlock(card(LEAFGRUB), row(KNIFE3)), null); // the shop knife has 3 slots
  assert.equal(compoundBlock(card(LEAFGRUB), row(BOW4)), null); // a two-handed bow is Both_Hand: includes the right hand
  assert.match(compoundBlock(card(LEAFGRUB), row(SHIRT1))!, /doesn't fit/); // Right_Hand card, Armor piece
  assert.match(compoundBlock(card(PUDDLEBLOOM), row(KNIFE4))!, /doesn't fit/); // Armor card, weapon
  assert.equal(compoundBlock(card(PUDDLEBLOOM), row(SHIRT1)), null);
  assert.match(compoundBlock(card(PUDDLEBLOOM), row(GUARD1))!, /doesn't fit/); // the shield slot is Left_Hand, not Armor
  assert.match(compoundBlock(card(PUDDLEBLOOM), row(SHIRT0))!, /no slots/); // Cotton Shirt [0]
  assert.match(compoundBlock(card(PUDDLEBLOOM), row(SHIRT1, [PUPA]))!, /no free slot/); // [1] already full
  assert.equal(compoundBlock(card(LEAFGRUB), row(KNIFE3, [LEAFGRUB, LEAFGRUB])), null); // 2 of 3 used
  assert.match(compoundBlock(card(LEAFGRUB), row(KNIFE3, [LEAFGRUB, LEAFGRUB, LEAFGRUB]))!, /no free slot/);
  assert.match(compoundBlock(card(LEAFGRUB), row(KNIFE4, [], "weapon"))!, /take it off/); // worn
  assert.match(compoundBlock(card(LEAFGRUB), row(card(LEAFGRUB).id))!, /only weapons and armor/); // a card is no target
  // a shield card (Left_Hand only) never goes on a weapon, even a two-hander (clif_use_card: IT_WEAPON && ep == EQP_SHIELD)
  const shieldCard = { ...card(PUDDLEBLOOM), locations: ["Left_Hand"] } as typeof card extends (i: number) => infer R ? R : never;
  assert.match(compoundBlock(shieldCard, row(BOW4))!, /shield card/);
  assert.equal(compoundBlock(shieldCard, row(GUARD1)), null);
});

test("cardTargets = clif_use_card's list: unequipped gear with a free slot the card fits", () => {
  const rows = [{ uid: 1, ...row(KNIFE4) }, { uid: 2, ...row(KNIFE3, [], "weapon") }, { uid: 3, ...row(SHIRT1) }, { uid: 4, ...row(SHIRT0) },
    { uid: 5, ...row(BOW4, [LEAFGRUB, LEAFGRUB, LEAFGRUB, LEAFGRUB]) }, { uid: 6, ...row(GUARD1) }, { uid: 7, ...row(1202, [LEAFGRUB]) }];
  assert.deepEqual(cardTargets(card(LEAFGRUB), rows).map((r) => r.uid), [1, 7]);
  assert.deepEqual(cardTargets(card(PUDDLEBLOOM), rows).map((r) => r.uid), [3]);
  assert.deepEqual(withCard([LEAFGRUB], PUDDLEBLOOM), [LEAFGRUB, PUDDLEBLOOM]); // first free slot
});

test("carded names: Double / Triple for repeats, prefixes before and suffixes after, then [slots] (client getItemName)", () => {
  const knife = card(KNIFE4);
  assert.equal(itemDisplayName(knife), "Knife [4]");
  assert.equal(itemDisplayName(knife, [LEAFGRUB]), "Sturdy Knife [4]");
  assert.equal(itemDisplayName(knife, [LEAFGRUB, LEAFGRUB]), "Double Sturdy Knife [4]");
  assert.equal(itemDisplayName(knife, [LEAFGRUB, LEAFGRUB, LEAFGRUB, LEAFGRUB]), "Quadruple Sturdy Knife [4]");
  const wil = id("Loambloom Card"); // suffix card: "of Insight"
  assert.equal(itemDisplayName(knife, [LEAFGRUB, LEAFGRUB, PUDDLEBLOOM, wil], 5), "+5 Double Sturdy Lucky Knife of Insight [4]"); // order of first appearance
  assert.equal(itemDisplayName(card(SHIRT0)), "Cotton Shirt");
});

test("card scripts run after the worn pieces and add to the status (status.cpp:4098 Parse Cards)", () => {
  const worn = (item: number, cards: number[], refine = 0) => ({ item: card(item), refine, cards });
  const g = gearOf([worn(KNIFE4, [LEAFGRUB]), worn(SHIRT1, [PUDDLEBLOOM])]);
  assert.equal(g.equip.param.vit, 1); assert.equal(g.equip.hp, 100);
  assert.equal(g.equip.param.luk, 2); assert.equal(g.equip.flee2, 10);
  assert.equal(gearOf([worn(KNIFE4, [])]).equip.param.vit, 0);
  assert.equal(g.weapon.atk, 17); // a card never touches the weapon's own ATK
  // two of one card add up; the Rootgrin card (bonus2 bAddEle,Ele_Wind,20) fills the weapon's addEle table
  assert.equal(gearOf([worn(KNIFE4, [LEAFGRUB, LEAFGRUB])]).equip.hp, 200);
  assert.deepEqual(gearOf([worn(KNIFE4, [ROOTGRIN])]).equip.addEle, { Wind: 20 });
  // an unequipped / unknown card id does nothing
  assert.equal(gearOf([worn(KNIFE4, [999999])]).equip.hp, 0);
  // the status carries them: VIT 1 -> maxHP rises by the bonus (100 flat) plus the VIT term
  const stats = { str: 9, agi: 1, vit: 1, int: 1, dex: 9, luk: 1 };
  const base = playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats, ...gearOf([worn(KNIFE4, [])]) });
  const carded = playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats, ...g });
  assert.ok(carded.maxHp > base.maxHp + 99);
});

test("a card's element bonus reaches the damage: Rootgrin card vs Dartwing (Wind, Small, DEF 27): 44 -> 47 before DEF (cardfix 1000 -> 1200)", () => {
  // Novice Lv10 STR 9 DEX 9 with a Knife (18 on the top roll): status ATK 26 + weapon 18 (Dagger vs Small 100%, Neutral vs Wind1 100%) = 44.
  // DEF 27, soft def (Lv5 + VIT 4) / 2 = 4: trunc(44 * 4027 / 4270) = 41 - 4 = 37. With the card: weapon 18 - trunc(18 * (1000 - 1200) / 1000) = 21,
  // 26 + 21 = 47 -> trunc(47 * 4027 / 4270) = 44 - 4 = 40.
  const stats = { str: 9, agi: 1, vit: 1, int: 1, dex: 9, luk: 1 };
  const vsMob: Target = { type: BL.MOB, targeted: 1 };
  const rolls = () => { const v = [0.999, 0, 0.999]; let i = 0; return () => v[i++ % 3]; };
  const dart = mobStatus(MOB_BY_ID.get(1011)!);
  const hit = (cards: number[]) => playerAttack(playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats, ...gearOf([{ item: card(KNIFE4), refine: 0, cards }]) }), weaponOf(card(KNIFE4)), dart, vsMob, rolls()).dmg;
  assert.deepEqual([hit([]), hit([ROOTGRIN])], [37, 40]);
});

test("Gravewalker card: bHPrecovRate 20 -> natural HP regen x120% (status_calc_regen: val * hprecov_rate / 100)", async () => {
  const { hpRegen } = await import("./status.ts");
  const ZOMBIE = id("Gravewalker Card"), SANDALS1 = 2402;
  assert.ok(card(ZOMBIE).bonuses.some((b) => b.type === "bHPrecovRate" && b.value === 20));
  const stats = { str: 1, agi: 1, vit: 50, int: 1, dex: 1, luk: 1 };
  const mk = (cards: number[]) => playerStatus({ job: "Novice", level: 10, jobLevel: 1, stats, ...gearOf([{ item: card(SANDALS1), refine: 0, cards }]) });
  const plain = hpRegen(mk([])); // vit 50 / 5 = 10 + max(1, maxHp / 200)
  const carded = hpRegen(mk([ZOMBIE]));
  assert.equal(mk([ZOMBIE]).hpRecovRate, 120);
  assert.equal(carded, Math.trunc((plain * 120) / 100));
  assert.ok(carded > plain);
});
