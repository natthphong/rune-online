// Spawn protection (rAthena's "invincible timer"), re-implemented from rAthena:
//   src/map/pc.cpp     pc_setinvincibletimer (start / restart; the map flag invincible_time overrides the config value),
//                      pc_invincible_timer (expiry), pc_delinvincibletimer (early end)
//   src/map/clif.cpp   clif_parse_LoadEndAck:10803 -> pc_setinvincibletimer: EVERY map entry starts it — login, the respawn
//                      warp (pc_respawn -> pc_setpos(save point) -> client map load), any later warp such as a Blink Feather
//   src/map/battle.cpp battle_check_target:7916: a PC whose timer runs "cannot be targeted yet" (-1 for every source and flag);
//                      battle_delay_damage_sub:393: a delayed hit that lands on such a PC is thrown away
//   src/map/mob.cpp    mob_ai_sub_hard: active search :1333, change-chase :1380, the held-target check :1905-1918 (timer at
//                      :1912) and the attacked-event switch :1960 all end in the two functions above, so a monster can
//                      neither pick, keep nor switch to a protected player
// Which client requests end it early is a column of the request table in msgguard.ts (clif_parse_WalkToXY:11415,
// clif_parse_ActionRequest_sub:11731 and the skill requests call pc_delinvincibletimer; sitting, items, equipment, NPC
// clicks and chat do not). The state is one number per player — the room-clock time the protection ends — so there is no
// timer to keep in step with the world.

/** conf/battle/player.conf, defaults of the shipped file. Keys keep the conf names. */
export const INVINCIBLE_CONF = {
  player_invincible_time: 3000, // ms of protection after entering a map (player.conf:54). 0 turns the protection off
};

/**
 * pc_setinvincibletimer: the end time after (re)starting the protection at `now`. The map flag `invincible_time` (ms, > 0)
 * replaces the configured duration for that map. A duration <= 0 returns without touching the existing timer, so the
 * previous end time is returned unchanged. A running timer is deleted and replaced (the new end is now + duration, never
 * the later of the two).
 */
export function setInvincibleTimer(until: number | undefined, now: number, mapFlagMs = 0, conf = INVINCIBLE_CONF): number | undefined {
  const ms = mapFlagMs > 0 ? mapFlagMs : conf.player_invincible_time;
  return ms <= 0 ? until : now + ms;
}

/** `invincible_timer != INVALID_TIMER`: protected from the moment the timer is set until pc_invincible_timer fires at its end
 *  time (so exactly at `until` the protection is already over). pc_delinvincibletimer is `until = undefined`. */
export const isInvincible = (until: number | undefined, now: number) => until !== undefined && now < until;

/**
 * Can a monster pick, keep or switch to this player as its target? Dead players never (status_check_skilluse), protected
 * ones never (battle_check_target). One predicate for every AI check listed in the header.
 */
export const pcTargetable = (pc: { dead: boolean; invincibleUntil: number | undefined }, now: number) =>
  !pc.dead && !isInvincible(pc.invincibleUntil, now);
