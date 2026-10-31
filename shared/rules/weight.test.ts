import { test } from "node:test";
import assert from "node:assert/strict";
import { overweightState, blocksNaturalRegen, blocksSkillCast } from "./weight.ts";

test("weight states: 69/70/89/90 percent of 1000", () => {
  assert.equal(overweightState(699, 1000), 0);
  assert.equal(overweightState(700, 1000), 1);
  assert.equal(overweightState(899, 1000), 1);
  assert.equal(overweightState(900, 1000), 2);
  assert.equal(blocksNaturalRegen(699, 1000), false);
  assert.equal(blocksNaturalRegen(700, 1000), true);
  assert.equal(blocksSkillCast(899, 1000), false);
  assert.equal(blocksSkillCast(900, 1000), true);
});
