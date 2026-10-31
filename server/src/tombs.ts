// MVP tombs and the boss flag on the wire, host-free (no room, no database) so they can be tested on a fake clock; server/src/boss.ts
// wires them to a MapRoom. mob.cpp mvptomb_create / mvptomb_setdelayspawn / mvptomb_delayspawn / mvptomb_destroy.
import type { Mob } from "../../shared/rules/data.ts";
import { MVP_CONF } from "../../shared/rules/mvp.ts";

/** Monster.boss on the wire: what the client colours the name / marks the unit by (0 = ordinary). */
export const BOSS_KIND = { none: 0, boss: 1, mvp: 2 } as const;
export const bossKindOf = (def: Pick<Mob, "bossType">) => (def.bossType === "Mvp" ? BOSS_KIND.mvp : def.bossType === "Boss" ? BOSS_KIND.boss : BOSS_KIND.none);

/** The tomb NPC's sprite (client/public/sprites/npc_tomb.png) and name (msg 656). */
export const TOMB_SPRITE = "npc_tomb";
export const TOMB_NAME = "Tomb";

/** One tomb: nd->u.tomb (kill_time, killer_name, the monster's db entry) at the death cell. */
export type Tomb = { id: string; mobKey: string; mobName: string; x: number; y: number; killedAt: Date; killer: string; shown: boolean };

/**
 * The tombs of a room: one per boss monster, created at its death (mvptomb_create: any earlier one is destroyed first), shown
 * mvp_tomb_delay later (mvptomb_setdelayspawn / mvptomb_delayspawn), destroyed when the monster spawns again (mvptomb_destroy).
 * Host-free so the lifecycle is testable with a fake clock: `later` = a cancellable timer, `show` / `hide` = the NPC in the room.
 */
export class Tombs {
  private byMob = new Map<string, { tomb: Tomb; timer: { clear(): void } }>();
  private byNpc = new Map<string, Tomb>();
  private io: { show(t: Tomb): void; hide(t: Tomb): void; later(fn: () => void, ms: number): { clear(): void } };
  private delay: number;
  constructor(io: { show(t: Tomb): void; hide(t: Tomb): void; later(fn: () => void, ms: number): { clear(): void } }, delay = MVP_CONF.mvp_tomb_delay) {
    this.io = io;
    this.delay = delay;
  }

  create(mobKey: string, info: Pick<Tomb, "mobName" | "x" | "y" | "killedAt" | "killer">): Tomb {
    this.destroy(mobKey);
    const tomb: Tomb = { id: `tomb_${mobKey}`, mobKey, ...info, shown: false };
    const timer = this.io.later(() => { tomb.shown = true; this.io.show(tomb); }, this.delay);
    this.byMob.set(mobKey, { tomb, timer });
    this.byNpc.set(tomb.id, tomb);
    return tomb;
  }
  /** mvptomb_destroy: the NPC leaves (clif_clearunit_area) and a tomb that never appeared never will. */
  destroy(mobKey: string) {
    const e = this.byMob.get(mobKey);
    if (!e) return;
    e.timer.clear();
    this.byMob.delete(mobKey);
    this.byNpc.delete(e.tomb.id);
    if (e.tomb.shown) this.io.hide(e.tomb);
  }
  /** A tomb a player can click (only one that is on the map). */
  visible(npcId: string): Tomb | undefined { const t = this.byNpc.get(npcId); return t?.shown ? t : undefined; }
  get size() { return this.byMob.size; }
}

