// The public outfit string of a job (Player.outfit). The art itself is checked in paperdoll.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_OUTFITS, outfitOf } from "../look.ts";

test("jobs without an outfit of their own fall back to the Novice outfit", () => {
  assert.equal(outfitOf("Novice"), "novice");
  assert.equal(outfitOf("NoSuchJob"), "novice");
  for (const [job, outfit] of Object.entries(JOB_OUTFITS)) assert.equal(outfitOf(job), outfit);
});
