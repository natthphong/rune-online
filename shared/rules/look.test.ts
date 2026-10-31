// Job outfits: a job only switches body when its art is complete (both genders x every sheet), so nobody turns invisible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { GENDERS, JOB_OUTFITS, SHEETS, outfitOf } from "../look.ts";

const ANIM = new URL("../../client/public/sprites/anim/", import.meta.url);

test("every listed job outfit has all sheets for both genders", () => {
  for (const outfit of ["novice", ...Object.values(JOB_OUTFITS)])
    for (const g of GENDERS)
      for (const s of SHEETS)
        for (const ext of ["png", "json"])
          assert.ok(existsSync(new URL(`pc_${g}_${outfit}_${s}.${ext}`, ANIM)), `missing pc_${g}_${outfit}_${s}.${ext}`);
});

test("jobs without art fall back to the Novice outfit", () => {
  assert.equal(outfitOf("Novice"), "novice");
  assert.equal(outfitOf("NoSuchJob"), "novice");
  for (const [job, outfit] of Object.entries(JOB_OUTFITS)) assert.equal(outfitOf(job), outfit);
});
