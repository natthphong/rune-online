// NPC contact rules, re-implemented from rAthena src/map/npc.cpp (npc_checknear, npc_click, npc_buysellsel, npc_buylist,
// npc_selllist) and src/map/clif.cpp (clif_parse_NpcClicked, clif_parse_NpcBuyListSend, clif_parse_NpcSellListSend).
// Clicking an NPC never moves the character: the server only checks the range and opens the NPC, or does nothing.
import { BATTLE_CONF } from "./battle.ts";
import type { BuyResult } from "./shop.ts";

/** AREA_SIZE (map.hpp: `#define AREA_SIZE battle_config.area_size`, conf/battle/client.conf:39 area_size: 14). */
export const AREA_SIZE = BATTLE_CONF.area_size;
/** npc_checknear's reach on each axis: AREA_SIZE + 1 = 15 cells (npc.cpp:2157-2160). */
export const NPC_CHECKNEAR_RANGE = AREA_SIZE + 1;

export type Cell = { x: number; y: number };

/** npc_checknear (npc.cpp:2143-2163): the NPC is usable when it is on the player's map and within AREA_SIZE + 1 cells on
 *  both axes (a square, not a circle), measured from the player's cell (bl->x/bl->y). Same map is implied (one room = one
 *  map). Class-less NPCs (class_ < 0, clickable from anywhere) don't exist here yet. */
export function npcCheckNear(pc: Cell, npc: Cell, areaSize = BATTLE_CONF.area_size): boolean {
  const r = areaSize + 1;
  return npc.x >= pc.x - r && npc.x <= pc.x + r && npc.y >= pc.y - r && npc.y <= pc.y + r;
}

/** The e_purchase_result a buy request gets before its list is looked at: clif_parse_NpcBuyListSend answers
 *  PURCHASE_FAIL_MONEY when no shop session is open (sd->npc_shopid == 0, clif.cpp:12305-12306), and npc_buylist answers
 *  PURCHASE_FAIL_COUNT when npc_checknear fails for that shop (npc.cpp:2805-2807). "ok" = go on to buyList. */
export function buyGate(shopOpen: boolean, near: boolean): BuyResult {
  if (!shopOpen) return "money";
  if (!near) return "count";
  return "ok";
}

/** clif_parse_NpcSellListSend / npc_selllist (clif.cpp:12353-12356, npc.cpp:3040-3043): no shop session or the shop out of
 *  npc_checknear range both fail the deal (ZC_PC_SELL_RESULT 1, "The deal has failed."). true = go on to sellList. */
export const sellGate = (shopOpen: boolean, near: boolean) => shopOpen && near;
