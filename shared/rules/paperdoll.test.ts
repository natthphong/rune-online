// Paper doll data (client/public/sprites/pd, written by tools/art/pd_build.py): what the client relies on, checked without a browser.
// A body is used only when it is COMPLETE (walk + act sheets, 5 facings each); these tests keep complete bodies drawable with every
// hair style, every starting weapon and the three gear pieces, so a look can never come out headless, bald or empty-handed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { GENDERS, HAIR_STYLES, PD_BODY, PD_SHIPPED, START_JOBS, START_WEAPON, pdBodyOf, visualsOf } from "../look.ts";

const PD = new URL("../../client/public/sprites/pd/", import.meta.url);
const json = (f: string) => JSON.parse(readFileSync(new URL(f, PD), "utf8"));
const ix = json("index.json") as { bodies: Record<string, { rows: number }>; heads: Record<string, unknown>; weapons: Record<string, { views: unknown[] }>; gear: Record<string, unknown> };
const complete = (key: string) => ix.bodies[`${key}_walk`]?.rows === 5 && ix.bodies[`${key}_act`]?.rows === 5;

test("every body sheet carries one finite anchor row per cell, inside its cell", () => {
  for (const key of Object.keys(ix.bodies)) {
    const m = json(`${key}.json`);
    assert.ok(existsSync(new URL(`${key}.png`, PD)), `${key}.png`);
    assert.equal(m.a.length, m.rows * m.cols, `${key}: anchors`);
    assert.equal(m.cols, 8, key);
    for (const a of m.a) {
      assert.equal(a.length, 13, `${key}: anchor fields`);
      assert.ok(a.every((v: number) => Number.isFinite(v)), `${key}: anchor numbers`);
      assert.ok(a[0] > 0 && a[0] < m.cellW && a[1] > -40 && a[1] < m.cellH, `${key}: head anchor ${a[0]}, ${a[1]} outside its cell`);
    }
    if (key.endsWith("_walk")) assert.ok(m.stride > 10, `${key}: stride`);
  }
});

test("jobs map to bodies: first jobs to their own, later jobs to their first job's body with a tint", () => {
  assert.deepEqual(pdBodyOf("Novice"), { body: "novice", hue: 0, bright: false });
  assert.deepEqual(pdBodyOf("Mage"), { body: "mage", hue: 0, bright: false });
  assert.deepEqual(pdBodyOf("Knight"), { body: "swordman", hue: 210, bright: false });
  assert.deepEqual(pdBodyOf("Lord_Knight"), { body: "swordman", hue: 210, bright: true });
  assert.equal(pdBodyOf("NoSuchJob").body, "novice");
  for (const job of START_JOBS) assert.ok(PD_BODY[job], job);
});

test("the equipped weapon picks the sprite (not the job)", () => {
  assert.equal(visualsOf([{ id: 1101, type: "Weapon", subType: "1hSword" }]).weapon, "sword");
  assert.equal(visualsOf([{ id: 1201, type: "Weapon", subType: "Dagger" }]).weapon, "knife");
  assert.equal(visualsOf([{ id: 1204, type: "Weapon", subType: "Dagger" }]).weapon, "dagger");
  assert.equal(visualsOf([{ id: 1601, type: "Weapon", subType: "Staff" }]).weapon, "rod");
  assert.equal(visualsOf([{ id: 1701, type: "Weapon", subType: "Bow" }]).weapon, "bow");
  assert.equal(visualsOf([{ id: 1, type: "Weapon", subType: "Knuckle" }]).weapon, null);
});

test("every starting job is shipped", () => {
  for (const job of START_JOBS) assert.ok(PD_SHIPPED.includes(PD_BODY[job]), `${job}: body ${PD_BODY[job]} is not in PD_SHIPPED`);
});

test("every shipped body is complete for both genders, with a head per hair style, its starting weapon and the gear", () => {
  for (const body of PD_SHIPPED) {
    for (const g of GENDERS) {
      assert.ok(complete(`body_${g}_${body}`), `body_${g}_${body} is not complete (walk + act x 5 facings)`);
      for (const s of HAIR_STYLES) {
        const k = `head_${g}_${s.key || "classic"}`;
        assert.ok(ix.heads[k], `${k} missing`);
        for (const f of [`${k}.png`, `${k}_hair.png`]) assert.ok(existsSync(new URL(f, PD)), f);
      }
    }
  }
  if (!PD_SHIPPED.length) return;
  for (const w of new Set(Object.values(START_WEAPON))) assert.ok(ix.weapons[`weapon_${w}`]?.views.length, `weapon_${w} missing`);
  for (const k of ["top_hat", "garment_hood", "shield_guard"]) assert.ok(ix.gear[k], `${k} missing`);
});
