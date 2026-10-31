// Golden tests for spawn protection (shared/rules/invincible.ts), numbers worked out by hand from rAthena:
// conf/battle/player.conf:54 (player_invincible_time: 3000), pc.cpp pc_setinvincibletimer / pc_invincible_timer /
// pc_delinvincibletimer, battle.cpp battle_check_target:7916.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INVINCIBLE_CONF, isInvincible, pcTargetable, setInvincibleTimer } from "./invincible.ts";

test("player_invincible_time defaults to 3000 ms (player.conf:54)", () => {
  assert.equal(INVINCIBLE_CONF.player_invincible_time, 3000);
});

test("pc_setinvincibletimer: starts now + player_invincible_time, a restart replaces the timer", () => {
  assert.equal(setInvincibleTimer(undefined, 10_000), 13_000); // gettick() + val
  assert.equal(setInvincibleTimer(13_000, 11_500), 14_500); // delete_timer + add_timer: from the new start, not extended
  // replaced even when the old one would have lasted longer (map flag 20 s earlier, now the default 3 s): never the later of the two
  assert.equal(setInvincibleTimer(30_000, 10_000), 13_000);
});

test("pc_setinvincibletimer: the map flag invincible_time overrides the config when > 0", () => {
  assert.equal(setInvincibleTimer(undefined, 10_000, 5000), 15_000);
  assert.equal(setInvincibleTimer(undefined, 10_000, 0), 13_000); // getMapFlag(MF_INVINCIBLE_TIME) > 0 fails -> config
  assert.equal(setInvincibleTimer(undefined, 10_000, -1), 13_000);
  assert.equal(setInvincibleTimer(undefined, 10_000, 0, { player_invincible_time: 1500 }), 11_500); // another conf value
});

test("pc_setinvincibletimer: a duration <= 0 returns before touching the timer", () => {
  const off = { player_invincible_time: 0 };
  assert.equal(setInvincibleTimer(undefined, 10_000, 0, off), undefined); // no protection at all
  assert.equal(setInvincibleTimer(12_000, 10_000, 0, off), 12_000); // an old timer keeps running
  assert.equal(setInvincibleTimer(undefined, 10_000, 4000, off), 14_000); // the map flag still switches it on
});

test("invincible_timer is set until pc_invincible_timer fires at the end tick", () => {
  assert.equal(isInvincible(undefined, 5), false); // INVALID_TIMER
  assert.equal(isInvincible(13_000, 10_000), true); // just started
  assert.equal(isInvincible(13_000, 12_999), true); // last protected millisecond
  assert.equal(isInvincible(13_000, 13_000), false); // timer fires at its tick: protection over
  assert.equal(isInvincible(13_000, 20_000), false);
});

test("a monster may target only a living, unprotected player", () => {
  const alive = { dead: false, invincibleUntil: undefined as number | undefined };
  assert.equal(pcTargetable(alive, 0), true);
  assert.equal(pcTargetable({ dead: false, invincibleUntil: 3000 }, 2999), false); // battle_check_target -> -1
  assert.equal(pcTargetable({ dead: false, invincibleUntil: 3000 }, 3000), true);
  assert.equal(pcTargetable({ dead: true, invincibleUntil: undefined }, 0), false); // status_check_skilluse
  assert.equal(pcTargetable({ dead: true, invincibleUntil: 3000 }, 3000), false);
});

test("lifecycle: respawn at t=0 protects 0..2999, walking at t=1200 ends it early, otherwise it lapses at 3000", () => {
  const respawnAt = 40_000;
  let until = setInvincibleTimer(undefined, respawnAt); // pc_respawn -> LoadEndAck
  assert.equal(until, 43_000);
  const targetableAt = (ms: number) => pcTargetable({ dead: false, invincibleUntil: until }, respawnAt + ms);
  assert.deepEqual([0, 1199, 2999].map(targetableAt), [false, false, false]);
  assert.equal(targetableAt(3000), true);
  // another respawn on the same character: a walk at +1200 (clif_parse_WalkToXY -> pc_delinvincibletimer) ends it at once
  until = setInvincibleTimer(undefined, respawnAt);
  assert.equal(targetableAt(1199), false);
  until = undefined;
  assert.equal(targetableAt(1200), true);
});
