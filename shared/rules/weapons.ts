// Weapon-type case lists that rAthena writes out as `switch (sd->status.weapon)` blocks, kept as data keyed by item_db SubType
// (the W_* names of pc.hpp enum weapon_type: Bow, Musical, Revolver, ...), so a rule asks a table instead of repeating a list
// and a new weapon type is one row here. Ammo subtypes are the item_db `Ammo` SubTypes (pc.hpp enum e_ammo_type).

/** Weapon types whose main stat is DEX: status_base_atk swaps STR and DEX (status.cpp:2436-2446), status_base_amotion_pc takes
 *  DEX² / 7 instead of / 5 (status.cpp:2372-2386), battle_calc_base_weapon_attack's stat bonus uses DEX (battle.cpp:2456-2469). */
export const DEX_WEAPONS: ReadonlySet<string> = new Set(["Bow", "Musical", "Whip", "Revolver", "Rifle", "Gatling", "Shotgun", "Grenade"]);

/** Why a normal attack that shoots ammo was refused (battle_weapon_attack returns ATK_NONE): clif_arrow_fail(ARROWFAIL_NO_AMMO)
 *  for a bow, clif_skill_fail(USESKILL_FAIL_NEED_MORE_BULLET) for a gun (weapontype1 between W_KATAR and W_HUUMA). */
export type AmmoFail = "noArrow" | "needBullet";

/** Weapon types whose normal attack shoots the equipped ammo — battle_weapon_attack's sd->state.arrow_atk: W_BOW and
 *  W_REVOLVER..W_GRENADE (battle.cpp:7163) — with the ammo subtype that attack needs (battle.cpp:7164-7204; RENEWAL: the grenade
 *  launcher fires AMMO_BULLET) and the failure sent without it. The same set decides where an ammo item's bAtkEle / bAtkRange
 *  land (pc_bonus under LR_FLAG_ARROW, pc.cpp:3883-3896 and 3943-3955): on the weapon for these, elsewhere for the rest. */
export const SHOOTING_WEAPONS: Readonly<Record<string, { ammo: string; fail: AmmoFail }>> = {
  Bow: { ammo: "Arrow", fail: "noArrow" },
  Revolver: { ammo: "Bullet", fail: "needBullet" },
  Rifle: { ammo: "Bullet", fail: "needBullet" },
  Gatling: { ammo: "Bullet", fail: "needBullet" },
  Shotgun: { ammo: "Bullet", fail: "needBullet" },
  Grenade: { ammo: "Bullet", fail: "needBullet" },
};
/** is_skill_using_arrow for a player's normal attack (battle.cpp:2925-2935): sd->state.arrow_atk, set from the weapon type. */
export const shootsAmmo = (weaponType: string) => Object.hasOwn(SHOOTING_WEAPONS, weaponType);

/** The clif_msg pc_isequip sends when it refuses an ammo for the worn weapon: MSI_FAIL_NEED_EQUIPPED_BOW, MSI_WRONG_BULLET, or
 *  none (AMMO_DAGGER without AS_VENOMKNIFE fails silently). */
export type AmmoEquipFail = "needBow" | "wrongBullet" | "needSkill";

const GUNS = ["Revolver", "Rifle", "Gatling", "Shotgun", "Grenade"] as const; // RENEWAL lets W_GRENADE take bullets / shells too
/** pc_isequip's EQP_AMMO check (pc.cpp:1897-1928) with battle.conf ammo_check_weapon: ammo subtype -> the weapon types it can be
 *  worn with, and the refusal otherwise. AMMO_DAGGER needs the skill AS_VENOMKNIFE instead (skills don't exist here yet, so it is
 *  always refused). Subtypes without a row (shuriken, kunai, throwing weapons, cannonballs outside Mechanic / Genetic, RENEWAL
 *  grenades) have no weapon check. The same lists drive battle.conf ammo_unequip when the weapon changes: pc_equipitem takes off
 *  ammo the new weapon can't use (pc.cpp:12201-12226), pc_unequipitem takes it off with any of these weapons (pc.cpp:12461-12479). */
export const AMMO_WEAPONS: Readonly<Record<string, { weapons?: readonly string[]; fail: AmmoEquipFail }>> = {
  Arrow: { weapons: ["Bow", "Musical", "Whip"], fail: "needBow" },
  Bullet: { weapons: GUNS, fail: "wrongBullet" },
  Shell: { weapons: GUNS, fail: "wrongBullet" },
  Dagger: { fail: "needSkill" },
};
/** pc_unequipitem's ammo_unequip case list (pc.cpp:12463-12470): taking off one of these weapons takes the ammo off too. */
export const AMMO_USERS: ReadonlySet<string> = new Set(Object.values(AMMO_WEAPONS).flatMap((a) => a.weapons ?? []));
