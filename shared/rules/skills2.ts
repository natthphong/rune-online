// 2.5.0: the 2nd-job and transcendent skills we run, re-implemented from rAthena (Renewal): the per-skill classes in
// src/map/skills/<class>/*.cpp (calculateSkillRatio / applyAdditionalEffects / castendNoDamageId / castendPos), battle.cpp
// (battle_calc_misc_attack: traps, Blitz Beat; battle_calc_magic_attack: Turn Undead; battle_addmastery) and status.cpp (the buffs,
// shared/rules/status_change.ts). skill.ts merges SKILL_USE_2 into SKILL_USE and asks ratio2 for the ratios it doesn't know.
// Pure: no clock, no room. The server side is server/src/skills2.ts.

/** How the server runs one of these skills (beyond skill.ts's weapon / magic / selfSplash / groundSplash / heal / status). */
export type SkillUse2 =
  | { kind: "targetSplash"; magic?: boolean } // a hit on the target + every enemy in splash range of it (Bowling Bash, Grimtooth, Napalm Vulcan)
  | { kind: "selfMagic" } // magic on every enemy in splash range of the caster (Frost Nova, Sight Rasher)
  | { kind: "groundMagic" } // magic on every enemy in splash range of the cell, at once (Heaven's Drive)
  | { kind: "unit"; waves: number; interval: number; radius: number; hit: "magic" | "weapon" | "heal" | "meteor"; self?: boolean } // a ground unit acting in waves
  | { kind: "trap"; radius: number; effect: "damage" | "ankle" } // a trap: fires on the first enemy that steps next to it
  | { kind: "misc"; radius: number } // battle_calc_misc_attack on the target (+ splash): Blitz Beat
  | { kind: "aura" } // a buff on the caster and the party members around it (Gloria, Magnificat, the songs, Adrenaline Rush ...)
  | { kind: "spheres" } // MO_CALLSPIRITS: one more spirit sphere (up to the skill level)
  | { kind: "turnUndead" } // PR_TURNUNDEAD: instant kill chance on an Undead, else holy damage
  | { kind: "resurrect" } // ALL_RESURRECTION: a dead player stands up again (status_revive)
  | { kind: "pitcher" }; // AM_POTIONPITCHER: throws a potion of the skill level at an ally (aidpotion.cpp)

export const SKILL_USE_2: Record<string, SkillUse2 | { kind: "weapon" } | { kind: "magic" } | { kind: "selfSplash" } | { kind: "status" }> = {
  // Lancer (Knight)
  KN_PIERCE: { kind: "weapon" }, KN_SPEARSTAB: { kind: "weapon" }, KN_SPEARBOOMERANG: { kind: "weapon" }, KN_BRANDISHSPEAR: { kind: "selfSplash" },
  KN_BOWLINGBASH: { kind: "targetSplash" }, KN_TWOHANDQUICKEN: { kind: "status" },
  // Templar (Crusader)
  CR_AUTOGUARD: { kind: "status" }, CR_SHIELDCHARGE: { kind: "weapon" }, CR_SHIELDBOOMERANG: { kind: "weapon" }, CR_HOLYCROSS: { kind: "weapon" }, CR_SPEARQUICKEN: { kind: "status" },
  CR_GRANDCROSS: { kind: "unit", waves: 3, interval: 300, radius: 2, hit: "magic", self: true },
  // Magus (Wizard)
  MG_THUNDERSTORM: { kind: "groundMagic" }, MG_SIGHT: { kind: "status" }, // the first-job prerequisites of Sight Rasher / Vermilion
  WZ_JUPITEL: { kind: "magic" }, WZ_WATERBALL: { kind: "magic" }, WZ_EARTHSPIKE: { kind: "magic" }, WZ_HEAVENDRIVE: { kind: "groundMagic" },
  WZ_FROSTNOVA: { kind: "selfMagic" }, WZ_SIGHTRASHER: { kind: "selfMagic" },
  WZ_STORMGUST: { kind: "unit", waves: 10, interval: 450, radius: 4, hit: "magic" }, // skill_unit_db WZ_STORMGUST: 9x9, Interval 450
  WZ_VERMILION: { kind: "unit", waves: 4, interval: 1000, radius: 5, hit: "magic" }, // 11x11, 4 waves (Renewal: 20 hits spread)
  WZ_METEOR: { kind: "unit", waves: 7, interval: 1000, radius: 3, hit: "meteor" }, // meteors at random cells of the 7x7 area
  // Scholar (Sage)
  SA_FLAMELAUNCHER: { kind: "status" }, SA_FROSTWEAPON: { kind: "status" }, SA_LIGHTNINGLOADER: { kind: "status" }, SA_SEISMICWEAPON: { kind: "status" },
  SA_DISPELL: { kind: "status" },
  // Tracker (Hunter)
  HT_BLITZBEAT: { kind: "misc", radius: 1 },
  HT_LANDMINE: { kind: "trap", radius: 0, effect: "damage" }, HT_BLASTMINE: { kind: "trap", radius: 1, effect: "damage" },
  HT_CLAYMORETRAP: { kind: "trap", radius: 2, effect: "damage" }, HT_ANKLESNARE: { kind: "trap", radius: 0, effect: "ankle" },
  // Balladeer / Danseuse (Bard / Dancer)
  BA_MUSICALSTRIKE: { kind: "weapon" }, DC_THROWARROW: { kind: "weapon" }, BA_ASSASSINCROSS: { kind: "aura" }, DC_HUMMING: { kind: "aura" },
  BA_WHISTLE: { kind: "aura" }, DC_FORTUNEKISS: { kind: "aura" }, BA_APPLEIDUN: { kind: "aura" }, HW_MAGICPOWER: { kind: "status" }, HP_ASSUMPTIO: { kind: "status" },
  // Oracle (Priest)
  PR_ASPERSIO: { kind: "status" }, PR_GLORIA: { kind: "aura" }, PR_MAGNIFICAT: { kind: "aura" }, PR_IMPOSITIO: { kind: "aura" },
  ALL_RESURRECTION: { kind: "resurrect" }, AM_POTIONPITCHER: { kind: "pitcher" }, PR_LEXDIVINA: { kind: "status" }, PR_KYRIE: { kind: "status" }, PR_LEXAETERNA: { kind: "status" }, PR_STRECOVERY: { kind: "status" }, PR_TURNUNDEAD: { kind: "turnUndead" },
  PR_SANCTUARY: { kind: "unit", waves: 10, interval: 1000, radius: 2, hit: "heal" }, // 5x5, heals every second
  PR_MAGNUS: { kind: "unit", waves: 5, interval: 3000, radius: 3, hit: "magic" }, // 7x7 cross, a wave every 3 s
  // Ascetic (Monk)
  MO_CALLSPIRITS: { kind: "spheres" }, MO_FINGEROFFENSIVE: { kind: "weapon" }, MO_INVESTIGATE: { kind: "weapon" }, MO_EXTREMITYFIST: { kind: "weapon" },
  MO_EXPLOSIONSPIRITS: { kind: "status" },
  // Forgewright (Blacksmith)
  BS_ADRENALINE: { kind: "aura" }, BS_WEAPONPERFECT: { kind: "aura" }, BS_OVERTHRUST: { kind: "aura" },
  BS_HAMMERFALL: { kind: "unit", waves: 1, interval: 0, radius: 2, hit: "weapon" },
  // Apothecary (Alchemist)
  AM_ACIDTERROR: { kind: "weapon" }, AM_DEMONSTRATION: { kind: "unit", waves: 8, interval: 1000, radius: 1, hit: "weapon" },
  // Shade (Assassin)
  AS_SONICBLOW: { kind: "weapon" }, AS_GRIMTOOTH: { kind: "targetSplash" }, AS_ENCHANTPOISON: { kind: "status" },
  // Brigand (Rogue)
  RG_BACKSTAP: { kind: "weapon" }, RG_RAID: { kind: "selfSplash" }, RG_STRIPWEAPON: { kind: "status" }, RG_STRIPARMOR: { kind: "status" },
  // transcendent
  LK_SPIRALPIERCE: { kind: "weapon" }, LK_CONCENTRATION: { kind: "status" }, LK_AURABLADE: { kind: "status" },
  HW_NAPALMVULCAN: { kind: "targetSplash", magic: true }, SN_SHARPSHOOTING: { kind: "weapon" }, SN_WINDWALK: { kind: "aura" },
  CG_ARROWVULCAN: { kind: "weapon" }, ASC_BREAKER: { kind: "weapon" }, ASC_METEORASSAULT: { kind: "selfSplash" }, CH_PALMSTRIKE: { kind: "weapon" },
  PA_SHIELDCHAIN: { kind: "weapon" },
};

/** Passive skills wired by 2.5.0 (battle_addmastery, status_calc_pc): see masteryAtk2 / passive2. */
export const PASSIVE_IMPL_2 = [
  "KN_SPEARMASTERY", "PR_MACEMASTERY", "AS_KATAR", "MO_IRONHAND", "BS_WEAPONRESEARCH", "AM_AXEMASTERY", "HT_BEASTBANE", "SA_ADVANCEDBOOK",
  "BA_MUSICALLESSON", "DC_DANCINGLESSON", "CR_TRUST", "MO_DODGE", "HT_STEELCROW", "TF_DOUBLE", "MO_TRIPLEATTACK", "HT_FALCON",
] as const;

/** What the ratios read besides the skill level. */
export type Ctx2 = {
  baseLv?: number; str?: number; int?: number; sp?: number; // the caster
  undead?: boolean; demon?: boolean; tgtHpHalf?: boolean; // the target (Undead element / Demon race, below 50 % HP)
  weaponType?: string; learned?: (key: string) => number;
};
/** RE_LVL_DMOD(100): skillratio = skillratio * status_get_lv(src) / 100 (battle.cpp). */
const lvMod = (r: number, c: Ctx2) => Math.trunc((r * (c.baseLv ?? 100)) / 100);
const t = Math.trunc;

/**
 * The Renewal skill ratios (100 + calculateSkillRatio of each class): undefined = not one of ours (skill.ts falls back to 100).
 * bowlingbash.cpp +40 x lv; pierce.cpp +10 x lv; spearstab.cpp +20 x lv; spearboomerang.cpp +50 x lv; brandishspear.cpp (RENEWAL)
 * +300 + 100 x lv + STR x 3; smite.cpp +20 x lv; shieldboomerang.cpp (RENEWAL) 80 x lv; holycross.cpp +35 x lv (+70 with a two-handed
 * spear); grandcross: battle.cpp +40 x lv (the magic part); waterball.cpp +30 x lv; earthspike.cpp +100; heavensdrive.cpp +25;
 * stormgust.cpp (RENEWAL) -30 + 50 x lv; lordofvermilion.cpp (RENEWAL, player) +300 + 100 x lv; meteorstorm.cpp +25; sightrasher.cpp
 * +20 x lv; frostnova.cpp (RENEWAL) +10 x lv; magnusexorcismus.cpp +30 vs Undead / Demon; melodystrike.cpp / slingingarrow.cpp (RENEWAL)
 * +10 + 40 x lv; throwspiritsphere.cpp (RENEWAL) +500 + 200 x lv; occultimpaction.cpp (RENEWAL) 100 x lv; asurastrike.cpp +700 + SP x 10;
 * acidterror.cpp (RENEWAL) 200 x lv (+100 with Potion Research); bomb.cpp +20 x lv; sonicblow.cpp (RENEWAL) +100 + 100 x lv, x1.5
 * under 50 % HP; grimtooth.cpp +20 x lv; backstab.cpp +200 + 40 x lv; sightlessmind.cpp (RENEWAL) 50 + 150 x lv; spiralpierce.cpp
 * (RENEWAL) (+50 + 50 x lv) x lv/100; napalmvulcan.cpp (RENEWAL) 70 x lv x lv/100; focusedarrowstrike.cpp (RENEWAL) (300 + 300 x lv) x
 * lv/100; vulcanarrow.cpp (RENEWAL) (+400 + 100 x lv) x lv/100; souldestroyer.cpp (RENEWAL) (150 x lv + STR + INT) x lv/100;
 * meteorassault.cpp (RENEWAL) (+100 + 120 x lv) x lv/100; ragingpalmstrike.cpp (RENEWAL) (+100 + 100 x lv + STR) x lv/100;
 * shieldchain.cpp (RENEWAL) 300 + 200 x lv (+ the shield's weight / refine: not modelled).
 */
export function ratio2(key: string, lv: number, c: Ctx2 = {}): number | undefined {
  switch (key) {
    case "KN_BOWLINGBASH": return 100 + 40 * lv;
    case "KN_PIERCE": return 100 + 10 * lv;
    case "KN_SPEARSTAB": return 100 + 20 * lv;
    case "KN_SPEARBOOMERANG": return 100 + 50 * lv;
    case "KN_BRANDISHSPEAR": return 400 + 100 * lv + (c.str ?? 0) * 3;
    case "CR_SHIELDCHARGE": return 100 + 20 * lv;
    case "CR_SHIELDBOOMERANG": return 80 * lv;
    case "CR_HOLYCROSS": return 100 + (c.weaponType === "2hSpear" ? 70 : 35) * lv;
    case "CR_GRANDCROSS": return 100 + 40 * lv;
    case "WZ_WATERBALL": return 100 + 30 * lv;
    case "WZ_EARTHSPIKE": return 200;
    case "WZ_HEAVENDRIVE": case "WZ_METEOR": return 125;
    case "WZ_STORMGUST": return 70 + 50 * lv;
    case "WZ_VERMILION": return 400 + 100 * lv;
    case "WZ_SIGHTRASHER": return 100 + 20 * lv;
    case "WZ_FROSTNOVA": return 100 + 10 * lv;
    case "PR_MAGNUS": return 100 + (c.undead || c.demon ? 30 : 0);
    case "BA_MUSICALSTRIKE": case "DC_THROWARROW": return 110 + 40 * lv;
    case "MO_FINGEROFFENSIVE": return 600 + 200 * lv;
    case "MO_INVESTIGATE": return 100 * lv;
    case "MO_EXTREMITYFIST": return Math.min(500000, 800 + (c.sp ?? 0) * 10);
    case "AM_ACIDTERROR": return 200 * lv + ((c.learned?.("AM_LEARNINGPOTION") ?? 0) > 0 ? 100 : 0);
    case "AM_DEMONSTRATION": return 100 + 20 * lv;
    case "AS_SONICBLOW": { const r = 200 + 100 * lv; return c.tgtHpHalf ? r + t(r / 2) : r; }
    case "AS_GRIMTOOTH": return 100 + 20 * lv;
    case "RG_BACKSTAP": return 300 + 40 * lv;
    case "RG_RAID": return 50 + 150 * lv;
    case "BS_HAMMERFALL": return 100;
    case "LK_SPIRALPIERCE": return lvMod(150 + 50 * lv, c);
    case "HW_NAPALMVULCAN": return lvMod(70 * lv, c);
    case "SN_SHARPSHOOTING": return lvMod(300 + 300 * lv, c);
    case "CG_ARROWVULCAN": return lvMod(500 + 100 * lv, c);
    case "ASC_BREAKER": return lvMod(150 * lv + (c.str ?? 0) + (c.int ?? 0), c);
    case "ASC_METEORASSAULT": return lvMod(200 + 120 * lv, c);
    case "CH_PALMSTRIKE": return lvMod(200 + 100 * lv + (c.str ?? 0), c);
    case "PA_SHIELDCHAIN": return 300 + 200 * lv;
    default: return undefined;
  }
}

/** Hits that depend on the target: pierce.cpp div = target size + 1 (Small 1, Medium 2, Large 3). */
export function hits2(key: string, size: string | undefined): number | undefined {
  if (key === "KN_PIERCE") return size === "Large" ? 3 : size === "Medium" ? 2 : 1;
  return undefined;
}
/** Skills whose hit roll is skipped (DamageFlags IgnoreFlee in skill_db, or always hitting in their class): a large hit bonus. */
export const NEVER_MISS_2 = new Set(["RG_BACKSTAP", "AM_ACIDTERROR", "MO_INVESTIGATE", "MO_EXTREMITYFIST", "KN_SPEARBOOMERANG"]);

/** battle_addmastery's 2.5.0 rows (battle.cpp:2277): spear 4 x lv, axe 3 x lv (+ one-handed swords in Renewal), mace 3 x lv, fist /
 *  knuckle 3 x lv, instrument / whip 3 x lv, book 3 x lv, katar 3 x lv, Weaponry Research 2 x lv on every weapon (RENEWAL). */
export function masteryAtk2(type: string, lv: (key: string) => number) {
  let m = 2 * lv("BS_WEAPONRESEARCH");
  switch (type) {
    case "1hSword": m += 3 * lv("AM_AXEMASTERY"); break;
    case "1hSpear": case "2hSpear": m += 4 * lv("KN_SPEARMASTERY"); break;
    case "1hAxe": case "2hAxe": m += 3 * lv("AM_AXEMASTERY"); break;
    case "Mace": case "2hMace": m += 3 * lv("PR_MACEMASTERY"); break;
    case "Fist": case "Knuckle": m += 3 * lv("MO_IRONHAND"); break;
    case "Musical": m += 3 * lv("BA_MUSICALLESSON"); break;
    case "Whip": m += 3 * lv("DC_DANCINGLESSON"); break;
    case "Book": m += 3 * lv("SA_ADVANCEDBOOK"); break;
    case "Katar": m += 3 * lv("AS_KATAR"); break;
  }
  return m;
}
/** battle_addmastery: Beast Bane +4 x lv against Brute / Insect (race-dependent, added per target). */
export const beastBane = (lv: number, race: string) => (race === "Brute" || race === "Insect" || race === "Player_Doram" ? 4 * lv : 0);
/** status_calc_pc passives: Faith (CR_TRUST) +200 MaxHP per level (status_calc_maxhp_pc bonus), Dodge (MO_DODGE) flee + lv x 3 / 2,
 *  Weaponry Research + 2 HIT per level. */
export const passive2 = (lv: (key: string) => number) => ({
  maxHp: 200 * lv("CR_TRUST"), flee: (lv("MO_DODGE") * 3) >> 1, hit: 2 * lv("BS_WEAPONRESEARCH"),
});

/** battle_calc_misc_attack (RENEWAL): HT_LANDMINE / HT_BLASTMINE / HT_CLAYMORETRAP: lv x DEX x (3 + base level / 100) x (1 + INT / 35),
 *  +/- 10 % (rnd() % 20 - 10). HT_BLITZBEAT: lv x 20 + Steel Crow x 6 + (AGI / 2) x 2 + (DEX / 10) x 2 (battle.cpp:6354-6383). */
export function trapDamage(lv: number, s: { dex: number; int: number; baseLv: number }, r: () => number = Math.random) {
  let d = Math.trunc(lv * s.dex * (3 + s.baseLv / 100) * (1 + s.int / 35));
  d += Math.trunc((d * (Math.floor(r() * 20) - 10)) / 100);
  return Math.max(1, d);
}
export const blitzDamage = (lv: number, steelCrow: number, s: { agi: number; dex: number }) =>
  lv * 20 + steelCrow * 6 + t(s.agi / 2) * 2 + t(s.dex / 10) * 2;

/** battle_calc_magic_attack PR_TURNUNDEAD (RENEWAL, battle.cpp:5901): chance (1/1000) = 10 x lv + LUK + INT + base level + 300 - 300 x
 *  HP / MaxHP, capped at 700; a boss (MD_STATUSIMMUNE) is never killed outright. */
export const turnUndeadChance = (lv: number, s: { luk: number; int: number; baseLv: number }, hp: number, maxHp: number) =>
  Math.min(700, 10 * lv + s.luk + s.int + s.baseLv + 300 - t((300 * hp) / Math.max(1, maxHp)));
/** ...and its damage when it doesn't kill: (base level + INT + 10 x lv) (battle.cpp RENEWAL turn undead fail damage). */
export const turnUndeadDamage = (lv: number, s: { int: number; baseLv: number }) => s.baseLv + s.int + lv * 10;

/** resurrection.cpp: the HP percent a revived player gets (status_revive(target, per, 0)): 10 / 30 / 50 / 80. */
export const resurrectPercent = (lv: number) => [10, 30, 50, 80][Math.min(4, Math.max(1, lv)) - 1];

/** aidpotion.cpp: the potion a level throws (skill_db ItemCost: Red / Orange / Yellow / White / Blue Potion = item 501..505) and its HP:
 *  the item's itemheal roll x (100 + 10 x lv + 5 x Potion Research) / 100, then x (100 + target VIT x 2) / 100, then x (100 + the
 *  target's Second Wind x 10) / 100. */
export const PITCHER_POTION = [501, 502, 503, 504, 505];
export function pitcherHeal(roll: number, lv: number, research: number, vit: number, recovery: number) {
  let hp = Math.trunc((roll * (100 + lv * 10 + research * 5)) / 100);
  hp = Math.trunc((hp * (100 + vit * 2)) / 100);
  return Math.trunc((hp * (100 + recovery * 10)) / 100);
}

/** PR_SANCTUARY heal per wave (skill_calc_heal: lv > 6 ? 777 : lv x 100). */
export const sanctuaryHeal = (lv: number) => (lv > 6 ? 777 : lv * 100);

/** Spirit spheres (sd->spiritball): MO_CALLSPIRITS adds one up to its level (max 5); the skills that spend them (skill_db
 *  SpiritSphereCost): Throw Spirit Sphere up to its level, Occult Impaction 1, Fury 5, Asura Strike all (needs Fury). */
export const SPHERE_COST: Record<string, number> = { MO_FINGEROFFENSIVE: 1, MO_INVESTIGATE: 1, MO_EXPLOSIONSPIRITS: 5, MO_EXTREMITYFIST: 1 };
export const MAX_SPHERES = 5;
/** skill_check_condition_castbegin: a status that must be running (sightrasher.cpp: SC_SIGHT, ended by the cast). */
export const NEEDS_SC: Record<string, string> = { WZ_SIGHTRASHER: "Sight" };
/** Renewal Double Attack (battle.cpp:4311): with a dagger, 7 % x lv of normal attacks hit twice. Triple Attack (7267): 30 %. */
export const doubleRate = (lv: number) => 7 * lv;
export const TRIPLE_RATE = 30;
/** battle_calc_damage (battle.cpp:1291): Kyrie absorbs weapon damage until its HP (val2) or hits (val3) run out; Lex Aeterna (Aeterna)
 *  doubles the next damage and ends; Guard (SC_AUTOGUARD, 1521) blocks a weapon hit with val2 % chance. */
export function defend(dmg: number, weapon: boolean, sc: { kyrie?: { val2: number; val3: number }; aeterna?: boolean; guard?: number; assumptio?: boolean }, roll: number) {
  let out = dmg, ended: string[] = [], blocked = false;
  if (weapon && sc.guard && roll < sc.guard) return { dmg: 0, blocked: true, ended };
  if (sc.assumptio) out = Math.trunc(out / 2); // SC_ASSUMPTIO (RENEWAL, outside PvP): damage halved
  if (sc.aeterna && out > 0) { out *= 2; ended.push("Aeterna"); }
  if (sc.kyrie && out > 0) {
    sc.kyrie.val2 -= out;
    if (weapon) out = sc.kyrie.val2 >= 0 ? 0 : -sc.kyrie.val2;
    if (--sc.kyrie.val3 <= 0 || sc.kyrie.val2 <= 0) ended.push("Kyrie");
  }
  return { dmg: out, blocked, ended };
}
