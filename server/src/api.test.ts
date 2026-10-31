// Character select (api.ts summarize, GET /api/characters) vs rAthena. The character list shows the saved status.hp / max_hp / sp /
// max_sp unchanged (char_mmo_char_tobuf, char.cpp:1795-1798); status_calc_pc_sub stores max_hp / max_sp from status_calc_maxhp_pc /
// status_calc_maxsp_pc with the worn equipment (status.cpp:4353, 4366) and pc_makesavestatus saves battle_status.hp / sp (pc.cpp:1394).
// So the list must show the same maximum the character has in game (gearOf + playerStatus, MapRoom.refreshStatus).
// Golden numbers are hand-computed from rAthena Renewal data (see each test).
//   cd ro && pnpm test   (globs shared/rules/*.test.ts and server/src/*.test.ts)
// api.ts reads server/src/config.ts (env) when it is imported, so dummy values are set first. Nothing here opens a connection: the
// pg.Pool and the lazyConnect Redis connect on first use, and summarize touches neither.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GAME_NAME ??= "ro";
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.REDIS_URL ??= "redis://unused";
process.env.DB_SCHEMA ??= "ro_unit_test";
const { summarize } = await import("./api.ts");
const { ITEMS } = await import("../../shared/rules/items.ts");

// Two rAthena items whose scripts the importer turns into plain bonuses; the shipped item set has none that touch VIT / INT /
// MaxHP / MaxSP yet, so they are added to this process's item map (modelled on real rows, with the rAthena ids and scripts):
//   1604: Right_Hand staff, ATK 25, MATK 45, weapon level 2, `bonus bInt,1;`
//   2370: Armor, DEF 15, `bonus bMaxHP,300; bonus bMaxSP,30; bonus bBaseAtk,10; bonus bAgi,1;`
const rows: { type: string; subType: string | null; locations: readonly string[]; refineable: boolean }[] = [...ITEMS.values()];
const staff = rows.find((i) => i.type === "Weapon" && i.subType === "Staff")!, armor = rows.find((i) => i.type === "Armor" && i.locations.includes("Armor") && i.refineable)!;
const WAND = 1604, COAT = 2370, GONE = 987654; // GONE: an inventory row whose item left the data set
(ITEMS as Map<number, unknown>).set(WAND, { ...staff, id: WAND, name: "probe wand", atk: 25, matk: 45, weaponLevel: 2, equipLevel: 12, bonuses: [{ type: "bInt", value: 1 }] });
(ITEMS as Map<number, unknown>).set(COAT, { ...armor, id: COAT, name: "probe coat", def: 15,
  bonuses: [{ type: "bMaxHP", value: 300 }, { type: "bMaxSP", value: 30 }, { type: "bBaseAtk", value: 10 }, { type: "bAgi", value: 1 }] });

// Novice Lv12, Job Lv10, STR 5 AGI 10 VIT 20 INT 30 DEX 20 LUK 5
const row = (hp: number | null, sp: number | null) => ({
  id: 1, slot: 0, name: "Probe", job: "Novice", level: 12, job_level: 10, exp: 0, job_exp: 0,
  str: 5, agi: 10, vit: 20, int: 30, dex: 20, luk: 5, hp, sp, gender: "M", hair_color: 0,
});
const wearing = [{ item_id: WAND, refine: 0 }, { item_id: COAT, refine: 4 }];
const bars = (s: { hp: number; maxHp: number; sp: number; maxSp: number }) => [s.hp, s.maxHp, s.sp, s.maxSp];

// Base HP 95 / SP 22 at Lv12 (db/re/job_basepoints.yml: BaseHp level 12 = 95, BaseSp level 12 = 22). Novice job bonus up to Job Lv10
// (job_stats): +1 VIT (level 6), +1 INT (level 9), also LUK/DEX/AGI/STR which don't enter max HP/SP.
test("character list: worn VIT / INT / bMaxHP / bMaxSP count toward the maximum, like rAthena's saved max_hp / max_sp", () => {
  // HP: VIT 20 + 1 job = 21 -> 95 * 1.21 = 114.95; + bMaxHP 300 = 414.95 -> 414                       (status_calc_maxhp_pc)
  // SP: INT 30 + 1 job + 1 worn = 32 -> 22 * 1.32 = 29.04; + 1 worn INT (param_equip) + bMaxSP 30 = 60.04 -> 60   (status_calc_maxsp_pc)
  assert.deepEqual(bars(summarize(row(414, 60), wearing)), [414, 414, 60, 60]);
  assert.deepEqual(bars(summarize(row(414, 60), [wearing[1], wearing[0]])), [414, 414, 60, 60], "the order of the rows doesn't matter");
});

test("character list: without gear the maximum is the bare one, and a stale saved HP/SP is cut to the maximum", () => {
  // HP 95 * 1.21 = 114.95 -> 114; SP 22 * 1.31 = 28.82 -> 28 (INT 30 + 1 job = 31)
  assert.deepEqual(bars(summarize(row(114, 28))), [114, 114, 28, 28]);
  assert.deepEqual(bars(summarize(row(414, 60))), [114, 114, 28, 28], "saved above the maximum (e.g. gear taken off): clamped to it");
  // the coat alone: HP as above; SP 22 * 1.31 = 28.82 + bMaxSP 30 = 58.82 -> 58, so a saved 60 is cut to the gear-inclusive 58
  assert.deepEqual(bars(summarize(row(414, 60), [{ item_id: COAT, refine: 0 }])), [414, 414, 58, 58]);
});

test("character list: a hurt character keeps its saved HP/SP, a never-saved one (NULL) is full", () => {
  assert.deepEqual(bars(summarize(row(200, 20), wearing)), [200, 414, 20, 60]);
  assert.deepEqual(bars(summarize(row(null, null), wearing)), [414, 414, 60, 60]);
});

test("character list: a bare item id is worn at +0, rows of items missing from the data are skipped, the look is still built", () => {
  const s = summarize(row(414, 60), [WAND, COAT, GONE]);
  assert.deepEqual(bars(s), [414, 414, 60, 60]);
  assert.equal(s.look.weapon, "blade"); // the wand's attack animation family (shared/look.ts visualsOf)
});
