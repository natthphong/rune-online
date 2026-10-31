// Item-use gates — rAthena pc_isUseitem / pc_useitem (pc.cpp) with default conf/battle/items.conf.

/** conf/battle/items.conf item_use_interval (ms): the minimum time between two item uses of one character. */
export const ITEM_USE_INTERVAL = 100;

/** pc_isUseitem (pc.cpp:6296-6299): refused while DIFF_TICK(sd->canuseitem_tick, gettick()) > 0. */
export const itemUseReady = (now: number, canUseAt: number): boolean => canUseAt - now <= 0;

/** pc_useitem (pc.cpp:6531): sd->canuseitem_tick = tick + item_use_interval once the item was used. */
export const nextItemUse = (now: number): number => now + ITEM_USE_INTERVAL;

/** pc_useitem (pc.cpp:6496-6500): a DelayConsume item (Blink / Homing Feather: the teleport effects) returns 0 while sitting
 *  (pc_issit): not used, not consumed. */
export const delayConsumeBlockedWhileSitting = (it: { effect: unknown }, sitting: boolean): boolean =>
  sitting && !!(it.effect as { teleport?: string } | null)?.teleport;
