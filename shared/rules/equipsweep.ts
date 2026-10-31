// The sweep that takes off worn gear the character may no longer wear, re-implemented from rAthena: map_quit (map.cpp:2294-2299,
// logout), pc_jobchange (pc.cpp:10986-10991) and pc_setpos on a map change (pc.cpp:7003-7008) run, for every equip_index slot in
// order, `pc_isequip(sd, index) != ITEM_EQUIP_ACK_OK -> pc_unequipitem(sd, index, 2)`; pc_baselevelchanged (pc.cpp:8306-8313) does
// the same on a base level change with only the EquipLevelMax test (flag 3). pc_unequipitem without flag 4 takes the worn ammo off
// with a bow / instrument / whip / gun (ammo_unequip, pc.cpp:12460-12479), and every removal updates status.weapon before the next
// slot is tested, so loose arrows fail pc_isequip's ammo test (ammo_check_weapon) once the bow is gone. Not at login: rAthena's
// login pc_setpos runs before the inventory is loaded (critic B11-4).
import { ITEMS, ammoOffWithWeapon, equipBlock, isAmmo, type EquipSlot, type Item } from "./items.ts";
import type { JobKey } from "./data.ts";

/** enum equip_index order (pc.hpp: EQI_ACC_L .. EQI_HAND_R, ..., EQI_AMMO) over our slots: the order the loops test them in. */
export const EQUIP_INDEX_ORDER: readonly EquipSlot[] = ["shoes", "garment", "headLow", "headMid", "headTop", "armor", "shield", "weapon", "ammo"];

export type WornStack = { uid: number; itemId: number; equip: EquipSlot | null };

/** The uids the sweep takes off, in order. levelMaxOnly = pc_baselevelchanged (only EquipLevelMax fails count). */
export function equipSweep(worn: readonly WornStack[], job: JobKey, level: number, levelMaxOnly = false, items: Map<number, Item> = ITEMS): number[] {
  const on = new Map(worn.filter((s) => s.equip).map((s) => [s.uid, s]));
  const weaponType = () => { for (const s of on.values()) { const it = items.get(s.itemId); if (it?.type === "Weapon") return it.subType ?? "Fist"; } return "Fist"; };
  const off: number[] = [];
  const take = (uid: number) => {
    const s = on.get(uid); if (!s) return;
    on.delete(uid); off.push(uid);
    const it = items.get(s.itemId)!;
    if (it.type === "Weapon" && ammoOffWithWeapon(it.subType ?? "Fist")) { // pc_unequipitem flag 2: the ammo follows the weapon
      for (const a of [...on.values()]) if (isAmmo(items.get(a.itemId)!)) { on.delete(a.uid); off.push(a.uid); }
    }
  };
  for (const slot of EQUIP_INDEX_ORDER) {
    const s = [...on.values()].find((w) => w.equip === slot);
    if (!s) continue;
    const it = items.get(s.itemId);
    if (!it) continue;
    if (levelMaxOnly) {
      const max = (it as { equipLevelMax?: number }).equipLevelMax ?? 0;
      if (max > 0 && level > max) take(s.uid);
    } else if (equipBlock(it, job, level, weaponType())) take(s.uid);
  }
  return off;
}
