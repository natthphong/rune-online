// The card album (2.4.0 content): an Old Card Album in rAthena (item 616, `getgroupitem(IG_CardAlbum)` -> itemdb.cpp
// ItemGroupDatabase / pc_get_itemgroup, one weighted random entry of the group). rAthena's own group lists cards we don't ship, so ours
// is built from the cards we have: every Card of items.json, a normal card with weight NORMAL_WEIGHT, a boss / MVP card (rarity "boss")
// with BOSS_WEIGHT, and never the legendary one (rarity "legendary", dropped only by Gloopking).
import { ITEMS } from "./items.ts";

export const NORMAL_WEIGHT = 100;
export const BOSS_WEIGHT = 20;

/** The card's rarity as items.json spells it: absent = normal. */
export const rarityOf = (it: object): "normal" | "boss" | "legendary" => {
  const r = (it as { rarity?: string }).rarity;
  return r === "legendary" || r === "boss" ? r : "normal";
};

/** The album's pool, in item id order: [card item id, weight]. */
export function albumPool(items: Iterable<{ id: number; type: string; rarity?: string }> = ITEMS.values()): [number, number][] {
  return [...items].filter((i) => i.type === "Card").sort((a, b) => a.id - b.id)
    .flatMap((i): [number, number][] => { const r = rarityOf(i); return r === "legendary" ? [] : [[i.id, r === "boss" ? BOSS_WEIGHT : NORMAL_WEIGHT]]; });
}

/** One draw: `roll` in [0, 1) picks the entry whose weight span holds roll * total. */
export function pickAlbumCard(roll: number, pool: readonly [number, number][] = albumPool()): number {
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let at = Math.min(Math.max(roll, 0), 0.999999999) * total;
  for (const [id, w] of pool) { if (at < w) return id; at -= w; }
  return pool[pool.length - 1][0];
}
