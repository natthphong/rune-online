// Monster item drops, floor items and loot priority — Renewal behaviour re-implemented from rAthena:
//   src/map/mob.cpp  MobDatabase::loadingFinished drop block (item_rate_* by item type / boss type, mob.cpp:6840-6905)
//   src/map/mob.cpp  mob_drop_adjust            (linear or logarithmic rate adjust + min/max clamp, mob.cpp:4808)
//   src/map/mob.cpp  mob_getdroprate            (killer LUK / drop bonuses / cap, RENEWAL_DROP level penalty, [1,10000])
//   src/map/mob.cpp  mob_dead item-drop block   (drop_modifier from first_sd ?: second_sd ?: third_sd, one roll per entry)
//   src/map/mob.cpp  mob_process_drop_list      (1st item on the corpse cell, then SE -> W -> N -> SE ...)
//   src/map/map.cpp  map_addflooritem / map_cell_free / map_search_freecell_dist (cell choice, loot ticks, lifetime)
//   src/map/pc.cpp   pc_takeitem                (pickup distance 2, first/second/third owner wait times)
// Defaults are the shipped conf/battle/drops.conf (+ misc.conf map_edge_size, monster.conf mob_size_influence).
import { ITEMS, type Rng } from "./items.ts";
import { levelPenaltyMod, applyRate, type PenaltyMapFlags } from "./penalty.ts";

export const DROP_CONF = {
  // drops.conf
  flooritem_lifetime: 60_000,
  item_first_get_time: 3000, item_second_get_time: 2000, item_third_get_time: 2000,
  mvp_item_first_get_time: 10_000, mvp_item_second_get_time: 10_000, mvp_item_third_get_time: 2000,
  item_rate_common: 100, item_rate_common_boss: 100, item_rate_common_mvp: 100, item_drop_common_min: 1, item_drop_common_max: 10000,
  item_rate_heal: 100, item_rate_heal_boss: 100, item_rate_heal_mvp: 100, item_drop_heal_min: 1, item_drop_heal_max: 10000,
  item_rate_use: 100, item_rate_use_boss: 100, item_rate_use_mvp: 100, item_drop_use_min: 1, item_drop_use_max: 10000,
  item_rate_equip: 100, item_rate_equip_boss: 100, item_rate_equip_mvp: 100, item_drop_equip_min: 1, item_drop_equip_max: 10000,
  item_rate_card: 100, item_rate_card_boss: 100, item_rate_card_mvp: 100, item_drop_card_min: 1, item_drop_card_max: 10000,
  item_logarithmic_drops: false,
  drop_rate0item: false,
  drop_rateincrease: false,
  drops_by_luk: 0,
  drops_by_luk2: 0,
  drop_rate_cap: 9000,
  // monster.conf
  mob_size_influence: false,
  // misc.conf
  map_edge_size: 15,
};
export type DropConf = typeof DROP_CONF;

/** The five item_rate_* groups of the drop block switch. */
export type DropGroup = "common" | "heal" | "use" | "equip" | "card";
/** e_mob_bosstype (s_mob_db::get_bosstype, mob.cpp:377): Mvp = MD_MVP, Boss = CLASS_BOSS, None otherwise. */
export type BossType = "None" | "Boss" | "Mvp";

/** Every item_rate_* key (for a server-wide rate like DROP_RATE=2 -> all 200). */
export function withItemRate(rate: number, conf: DropConf = DROP_CONF): DropConf {
  const out = { ...conf };
  for (const g of ["common", "heal", "use", "equip", "card"] as const)
    for (const s of ["", "_boss", "_mvp"]) (out as Record<string, unknown>)[`item_rate_${g}${s}`] = rate;
  return out;
}

/** The drop block's switch on item_data type (mob.cpp:6871-6898): IT_HEALING -> heal, IT_USABLE / IT_CASH -> use,
 *  IT_WEAPON / IT_ARMOR / IT_PETARMOR -> equip, IT_CARD -> card, everything else (Etc, DelayConsume, Ammo, PetEgg ...) -> common. */
export function dropGroup(itemType: string): DropGroup {
  switch (itemType) {
    case "Healing": return "heal";
    case "Usable": case "Cash": return "use";
    case "Weapon": case "Armor": case "PetArmor": return "equip";
    case "Card": return "card";
    default: return "common";
  }
}

/** mob_drop_adjust (mob.cpp:4808): rate * rate_adjust / 100 (or Ishizu-Chan's logarithmic curve), clamped to [min, max],
 *  truncated to an unsigned int. */
export function mobDropAdjust(baserate: number, rateAdjust: number, rateMin: number, rateMax: number, conf: DropConf = DROP_CONF) {
  let rate = baserate;
  if (conf.item_logarithmic_drops && rateAdjust > 0 && rateAdjust !== 100 && baserate > 0)
    rate = rate * Math.pow(5.0 - Math.log10(rate), Math.log(rateAdjust / 100) / Math.log(5.0)) + 0.5;
  else rate = (rate * rateAdjust) / 100;
  return Math.trunc(Math.max(rateMin, Math.min(rateMax, rate)));
}

/** MobDatabase::loadingFinished drop block (mob.cpp:6862-6905): the mob db rate of one drop entry after drop_rateincrease
 *  and the item_rate_* / item_drop_*_min/max of its item type and the monster's boss type. 0 = the entry is removed
 *  (rate_adjust 0). Treasure chests (RC2_TREASURE) and mob_item_ratio.yml overrides are not modelled yet. */
export function mobDbDropRate(rate: number, itemType: string, bossType: BossType = "None", conf: DropConf = DROP_CONF) {
  if (conf.drop_rateincrease && rate < 5000) rate++;
  const g = dropGroup(itemType);
  const suffix = bossType === "Mvp" ? "_mvp" : bossType === "Boss" ? "_boss" : "";
  const c = conf as unknown as Record<string, number>;
  const rateAdjust = c[`item_rate_${g}${suffix}`];
  if (rateAdjust === 0) return 0;
  return mobDropAdjust(rate, rateAdjust, c[`item_drop_${g}_min`], c[`item_drop_${g}_max`], conf);
}

/** The killer as mob_getdroprate sees `src`: LUK for drops_by_luk*, and for a player its drop_rate_bonus extras
 *  (bAddMonsterDropChance class/race bonuses, SC_ITEMBOOST, VIP ...; percent on top of 100, 0 = none). */
export type DropSource = { luk: number; pc?: { dropBonus?: number } };

/** mob_getdroprate (mob.cpp:2818): `baseRate` is the (load-adjusted) entry rate, `dropModifier` the RENEWAL_DROP level
 *  penalty percent. `size` is the monster's special_state.size (summoned size changes), only with mob_size_influence. */
export function mobGetDropRate(
  baseRate: number, dropModifier: number, src?: DropSource, conf: DropConf = DROP_CONF, factor = 1, size: "Small" | "Medium" | "Large" = "Small",
) {
  let dropRate = baseRate;
  if (conf.mob_size_influence) { // SZ_MEDIUM is the "small" summon size here, as in the source
    if (size === "Medium" && dropRate >= 2) dropRate = Math.trunc(dropRate / 2);
    else if (size === "Large") dropRate *= 2;
  }
  if (src) {
    if (conf.drops_by_luk) dropRate += Math.trunc((src.luk * conf.drops_by_luk) / 100) * factor;
    if (conf.drops_by_luk2) dropRate += Math.trunc(0.5 + (dropRate * src.luk * conf.drops_by_luk2) / 10000) * factor;
    if (src.pc) {
      const bonus = 100 + (src.pc.dropBonus ?? 0);
      const cap = conf.drop_rate_cap * factor;
      dropRate = Math.trunc(0.5 + (dropRate * bonus) / 100);
      if (dropRate > cap && baseRate < cap) dropRate = cap; // never above the cap unless it already was
    }
  }
  dropRate = applyRate(dropRate, dropModifier); // RENEWAL_DROP
  dropRate = Math.min(dropRate, 10000 * factor);
  return conf.drop_rate0item ? Math.max(dropRate, 0) : Math.max(dropRate, 1);
}

/** What the drop roll needs from the monster (a mobs.json row satisfies it). */
export type DropMob = { level: number; fixedItemDrop?: boolean; bossType?: string; drops: readonly { item: number; rate: number }[] };

/** mob_dead loot owners [first_sd, second_sd, third_sd] as char ids: first_sd starts as the killer when it is a player
 *  (mob.cpp:2953-2956) and the damage-log ranking (rules/dmglog.ts lootOwners) replaces all three only when it found an
 *  eligible attacker (mob.cpp:3054-3061). So a killer whose own entry was skipped (e.g. dead when its delayed hit landed)
 *  still owns the drops when nobody else qualifies. */
export function mobDeadLootOwners(ranked: readonly number[], killerCharId?: number): number[] {
  if (ranked.length) return ranked.slice(0, 3);
  return killerCharId ? [killerCharId] : [];
}

/** mob_dead (mob.cpp:3257-3260): drop_modifier = pc_level_penalty_mod(first_sd ?: second_sd ?: third_sd, PENALTY_DROP).
 *  `owners` are the loot owners in priority order (mobDeadLootOwners), resolved to their base level. */
export function mobDropModifier(owners: readonly ({ baseLevel: number } | undefined)[], mob: DropMob, map: PenaltyMapFlags = {}) {
  return levelPenaltyMod("Drop", owners.find((o) => o !== undefined), mob, map);
}

/** mob_dead regular drop loop (mob.cpp:3320-3346): for each mob db entry whose item exists, roll
 *  `rnd() % 10000 >= mob_getdroprate(...)` -> no drop. Returns the dropped item ids in db order (= floor order). */
export function rollMobDrops(
  mob: DropMob, opts: { modifier?: number; src?: DropSource; conf?: DropConf } = {}, r: Rng = Math.random,
): number[] {
  const conf = opts.conf ?? DROP_CONF, bossType = (mob.bossType ?? "None") as BossType;
  const out: number[] = [];
  for (const d of mob.drops) {
    const it = ITEMS.get(d.item);
    if (!it) continue; // item_db.find == nullptr (and removed at load)
    const base = mobDbDropRate(d.rate, it.type, bossType, conf);
    if (!base) continue; // removed at load (rate_adjust 0)
    const rate = mobGetDropRate(base, opts.modifier ?? 100, opts.src, conf);
    if (Math.floor(r() * 10000) >= rate) continue;
    out.push(d.item);
  }
  return out;
}

// ---------- floor placement ----------
/** Drop directions in our tile space (+y = south, toward the camera; rAthena's +y is north, so diry is mirrored).
 *  null = DIR_CENTER (the target cell itself). */
export type DropDir = { dx: number; dy: number } | null;
const SE: DropDir = { dx: 1, dy: 1 }, W: DropDir = { dx: -1, dy: 0 }, N: DropDir = { dx: 0, dy: -1 };

/** mob_process_drop_list (mob.cpp): the first regular drop lands at DIR_CENTER, looted items start at DIR_NORTH, and
 *  the direction then loops SE -> W -> N -> SE. Returns the direction for each of `count` items. */
export function dropDirections(count: number, looted = false): DropDir[] {
  const out: DropDir[] = [];
  let dir: DropDir = looted ? N : null;
  for (let i = 0; i < count; i++) {
    out.push(dir);
    dir = dir === null || dir === N ? SE : dir === SE ? W : N; // `dir <= DIR_NORTH` covers CENTER and NORTH
  }
  return out;
}

/** map_cell_free (map.cpp): passable, not occupied by the given block types, and not within the official edge band
 *  (min(map_edge_size, 5) cells; `x > xs - edge` like the source, so the band is not symmetric). */
export function mapCellFree(
  map: { w: number; h: number }, x: number, y: number, passable: (x: number, y: number) => boolean,
  occupied: (x: number, y: number) => boolean, conf: DropConf = DROP_CONF,
) {
  const edge = Math.min(conf.map_edge_size, 5);
  if (x < edge || x > map.w - edge || y < edge || y > map.h - edge) return false;
  return passable(x, y) && !occupied(x, y);
}

/** rnd_value(min, max) (random.hpp): uniform integer in [min, max]. */
const rndValue = (min: number, max: number, r: Rng) => min + Math.floor(r() * (max - min + 1));

/** map_search_freecell_dist (map.cpp:1757): random quadrant mirroring, then the 8 neighbour directions in a fixed order,
 *  each at a random distance in [distmin, distmax]; the first free cell wins. null = none free. */
export function searchFreecellDist(x: number, y: number, distmin: number, distmax: number, free: (x: number, y: number) => boolean, r: Rng = Math.random) {
  const mirrorx = Math.floor(r() * 2) ? -1 : 1, mirrory = Math.floor(r() * 2) ? -1 : 1;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      if (!i && !j) continue;
      const cx = x + mirrorx * i * rndValue(distmin, distmax, r), cy = y + mirrory * j * rndValue(distmin, distmax, r);
      if (free(cx, cy)) return { x: cx, y: cy };
    }
  }
  return null;
}

/** map_addflooritem cell choice for a monster drop (flags 4, type BL_CHAR|BL_PET, so items may share a cell): step from
 *  the corpse cell by `dir`; a non-center cell that isn't free moves to a free neighbour within 1 (2 with flags&2); if
 *  none is free the item stays on the stepped cell (BL_ITEM is not in `type`). DIR_CENTER is never moved. */
export function floorItemCell(x: number, y: number, dir: DropDir, free: (x: number, y: number) => boolean, r: Rng = Math.random, wide = false) {
  if (dir) { x += dir.dx; y += dir.dy; }
  if (dir && !free(x, y)) {
    const c = searchFreecellDist(x, y, 1, wide ? 2 : 1, free, r);
    if (c) return c;
  }
  return { x, y };
}

// ---------- loot priority ----------
/** flooritem_data owner fields: char ids (0 = none) and the absolute times at which each priority window ends. */
export type FloorLoot = { first: number; second: number; third: number; firstTick: number; secondTick: number; thirdTick: number };

/** map_addflooritem loot ticks: boss/MVP drops (bosstype != NONE) or MVP prizes (flags&1) use the longer mvp_item_* times. */
export function floorLoot(now: number, owners: readonly number[], bossType: BossType = "None", mvpItem = false, conf: DropConf = DROP_CONF): FloorLoot {
  const ext = mvpItem || bossType !== "None";
  const firstTick = now + (ext ? conf.mvp_item_first_get_time : conf.item_first_get_time);
  const secondTick = firstTick + (ext ? conf.mvp_item_second_get_time : conf.item_second_get_time);
  const thirdTick = secondTick + (ext ? conf.mvp_item_third_get_time : conf.item_third_get_time);
  return { first: owners[0] ?? 0, second: owners[1] ?? 0, third: owners[2] ?? 0, firstTick, secondTick, thirdTick };
}

/** pc_takeitem (pc.cpp): earliest time `charId` may take the item. Owner 1 (or no owner) at once, owner 2 after the first
 *  window, owner 3 after the second, everyone else after the third — even when there is no 2nd/3rd owner. Party loot
 *  share (p->party.item&1) is not modelled: there are no parties yet. */
export function takeItemTick(f: FloorLoot, charId: number) {
  if (!f.first || f.first === charId) return 0;
  if (f.second > 0 && f.second === charId) return f.firstTick;
  if (f.third > 0 && f.third === charId) return f.secondTick;
  return f.thirdTick;
}

/** pc_takeitem: check_distance_bl(fitem, sd, 2) — square distance, in cells. */
export const PICKUP_RANGE = 2;
