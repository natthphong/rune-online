// Renewal status formulas, re-implemented from rAthena (src/map/status.cpp, RENEWAL branches) with default
// battle config (conf/battle/*.conf). Integer math mirrors the C++ (int division truncates, float casts floor).
import { JOBS, STAT_KEYS, type Element, type JobKey, type Mob, type MobClass, type Race, type Size, type Stats } from "./data.ts";
import { copyIndexed, noBonus, type EquipBonus, type HandWeapon, type IndexedBonus } from "./bonus.ts";
import { PC_MODE } from "./mode.ts";
import { DEX_WEAPONS } from "./weapons.ts";
import { masteryAtk2, passive2 } from "./skills2.ts";
export type { HandWeapon } from "./bonus.ts";

export const MAX_ASPD = 190; // conf/battle/player.conf max_aspd
export const PC_WALK_MS = 150; // DEFAULT_WALK_SPEED, ms per cell

/** Weapon a character fights with (see items.ts weaponOf): the item's own ATK / level / type (item_db SubType: what rAthena's
 *  `switch (sd->status.weapon)` lists test, see weapons.ts) / element / Range, plus what its refine adds (status.cpp:3955-3989):
 *  atk2 = refine ATK (wa->atk2), matk = item MagicAttack + refine MATK (wa->matk), overrefine = RandomBonus / 100
 *  (sd->right_weapon.overrefine), range = item Range (wa->range; bare hands 0). */
export type Weapon = { atk: number; atk2: number; matk: number; overrefine: number; level: number; type: string; element: Element; range: number };
export const FISTS: Weapon = { atk: 0, atk2: 0, matk: 0, overrefine: 0, level: 0, type: "Fist", element: "Neutral", range: 0 };
export const STARTER_WEAPON: Weapon = { atk: 17, atk2: 0, matk: 0, overrefine: 0, level: 1, type: "Dagger", element: "Neutral", range: 1 }; // = item 1201 (Knife) +0, used by tests

/** The equipped ammo's part of a player's attack (sd->bonus.arrow_*, written by status_calc_pc_sub's ammo pass, status.cpp:
 *  4042-4052): its item ATK and its script's arrow hit / crit (x10) / element (Neutral = none). Battle adds them to an attack that
 *  shoots the ammo (battle.ts playerAttack). */
export type ArrowBonus = { atk: number; hit: number; cri: number; ele: Element };

/** weapon = the right-hand weapon item (its type for ASPD / status ATK / battle, overrefine); shield = an armor piece sits in the
 *  Left_Hand slot (pc_equipitem sets status.shield only for a non-weapon there; adds the job's Shield ASPD penalty); equip =
 *  what the equipment loop wrote (items.ts gearOf): DEF, script bonuses and rhw, the right hand after its ATK / refine and every
 *  bAtk / bAtk2 / bAtkEle in equip_index order. Without equip.rhw, rhw is `weapon` alone (no scripts). Any field left out keeps
 *  its reset value. */
export type PlayerBase = { job: JobKey; level: number; jobLevel: number; stats: Stats; weapon?: Weapon; shield?: boolean; equip?: Partial<EquipBonus>; passives?: Passives;
  /** Status changes (status_change.ts): `stats` maps the summed STR..LUK through status_calc_str ... (Blessing, Increase AGI ...) before
   *  anything is derived from them; `aspd` = status_calc_aspd's percent bonus (Increase AGI), added to aspd_rate2. */
  sc?: { stats?: (s: Stats) => Stats; aspd?: number } };
/** Learned passive skill levels status_calc_pc reads (pc_checkskill, so 0 for a skill outside the character's current tree; shared/rules/
 *  skill.ts passivesOf builds it): AC_OWL +DEX (status.cpp:4283, before the stat sum), AC_VULTURE +attack range with a bow (4485) and,
 *  Renewal, +hit in is_attack_hitting (battle.cpp:3292; kept as vultureHit), TF_MISS +3 FLEE per level after the flee rate (4517; x4
 *  is for the 2nd thief classes). MC_INCCARRY's +2000 max weight per level is items.ts maxWeight's third argument (status.cpp:3678). */
export type Passives = {
  owl?: number; vulture?: number; miss?: number;
  sword?: number; twohand?: number; // SM_SWORD / SM_TWOHAND: battle_addmastery +4 ATK per level (battle.cpp:2338-2347)
  recovery?: number; srecovery?: number; // SM_RECOVERY / MG_SRECOVERY: skill regen (status.cpp:5304-5313) + item heal (pc.cpp:10700)
  dp?: number; demonbane?: number; // AL_DP (battle_calc_defense, battle.cpp:4817) / AL_DEMONBANE (battle_addmastery, battle.cpp:2291)
  extra?: Record<string, number>; // 2.5.0: the 2nd-job passives by skill key (shared/rules/skills2.ts masteryAtk2 / passive2)
};

export type Status = {
  stats: Stats; // base + job bonus + equipment bonus
  bonus: Stats; // the "+n" of the Status window: battle_status - status (job bonus + equipment)
  maxHp: number; maxSp: number;
  batk: number; // status ATK (doubled in battle)
  watk: number; // weapon ATK = rhw.atk + rhw.atk2 (status_weapon_atk)
  eatk: number; // equipment ATK (bBaseAtk)
  atkRate: number; // bAtkRate, percent of weapon + equipment ATK added in battle
  rhw: HandWeapon; // rhw.range = normal attack range in cells (status_get_range; unit_attack_timer_sub, unit.cpp:3250)
  arrow?: ArrowBonus; // players: the equipped ammo's sd->bonus.arrow_* (zeros without ammo)
  overrefine: number; // sd->right_weapon.overrefine: battle adds rnd() % overrefine + 1 to weapon damage (battle.ts)
  matkMin: number; matkMax: number;
  matkStatus: number; matkEquip: number; // Status window "a + b" (pc_leftside_matk / pc_rightside_matk)
  hit: number; flee: number; flee2: number; // flee2 = perfect dodge, tenths of %
  vultureHit: number; // Renewal: Far Sight's level, added to the hit rate of every player attack (is_attack_hitting, battle.cpp:3292), not shown
  cri: number; // tenths of %
  def: number; def2: number; mdef: number; mdef2: number; // hard / soft
  aspd: number; attackDelayMs: number; walkMs: number;
  element: Element; elementLevel: number; size: Size;
  race: Race; // status->race: monsters mob_db Race, players RC_PLAYER_HUMAN (status.cpp:3840; a Summoner's would be summoner_race)
  class_: MobClass; // status->class_ (CLASS_*): monsters mob_db Class, players Normal (status.cpp:3841); what bAddClass / bSubClass index
  mode: number; // status->mode, e_mode bits (mode.ts): monsters mob_db Ai + Modes, players PC_MODE (status.cpp:3827)
  // passive skills (shared/rules/skill.ts PASSIVE_IMPL), players only: weapon mastery ATK (battle_addmastery's weapon cases), Fiendbane /
  // Sacred Ward levels with the base level they scale by, and the skill regen of SM_RECOVERY / MG_SRECOVERY (regen_data_sub sregen hp / sp)
  masteryAtk?: number; demonBane?: number; dpLv?: number; baseLv?: number; sregenHp?: number; sregenSp?: number;
  noFlee?: boolean; // status_change.ts: a unit under Stone / Freeze / Stun / Sleep (sc->opt1, not the petrify wait) is hit by every attack (is_attack_hitting, battle.cpp:3250)
  beastBane?: number; // HT_BEASTBANE level (battle_addmastery: +4 x lv vs Brute / Insect)
  noSizeFix?: boolean; // SC_WEAPONPERFECTION: the size modifier is 100 % (battle_calc_base_damage)
  auraBlade?: number; // SC_AURABLADE: flat damage added to every weapon hit (20 x lv)
  atkPercent?: number; // status_change.ts scAtkPercent: battle_get_atkpercent (Curse -25, Provoke +), the base of the Renewal skill ratio; absent = 100
  hpRecovRate?: number; spRecovRate?: number; // players: sd->hprecov_rate / sprecov_rate, percent of natural regen (card bonuses; absent = 100)
} & BattleBonus;

/** The sd->bonus / sd->right_weapon / sd->indexed_bonus fields only the battle code reads (bonus.ts EquipBonus documents each one;
 *  the indexed tables are bonus.ts INDEXED_BONUS). Players: what the equipment loop wrote; monsters have no sd, so none (zeros). */
export type BattleBonus = Pick<EquipBonus, "critAtkRate" | "nonCritAtkRate" | "shortAtkRate" | "longAtkRate" | "nearAtkDef" | "longAtkDef" | "critRangeAtk" | "addEff" | "resEff"> & IndexedBonus;
const battleBonus = (e: EquipBonus): BattleBonus => ({
  critAtkRate: e.critAtkRate, nonCritAtkRate: e.nonCritAtkRate, shortAtkRate: e.shortAtkRate, longAtkRate: e.longAtkRate,
  nearAtkDef: e.nearAtkDef, longAtkDef: e.longAtkDef, critRangeAtk: e.critRangeAtk, addEff: { ...e.addEff }, resEff: { ...e.resEff }, ...copyIndexed(e),
});

const t = Math.trunc;
const SHRT_MIN = -32768, SHRT_MAX = 32767, USHRT_MAX = 65535;
const cap = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// src/map/status.hpp
const AMOTION_ZERO_ASPD = 2000, AMOTION_INTERVAL = 10, AMOTION_DIVIDER_PC = 2, MIN_ASPD = 8000;

/** Job bonus stats (job_stats.yml BonusStats) accumulated up to jobLevel. */
export function jobBonus(job: JobKey, jobLevel: number): Stats {
  const b: Stats = { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 };
  for (const row of JOBS[job].bonusStats) {
    if (row.level > jobLevel) continue;
    for (const k of STAT_KEYS) b[k] += row[k] ?? 0;
  }
  return b;
}

/** status_base_atk (RENEWAL, BL_PC): str + dex/5 + luk/3 + level/4, computed in tenths. A DEX weapon (weapons.ts DEX_WEAPONS:
 *  bows, instruments, whips, guns; status.cpp:2436-2446) swaps str<->dex. */
export function pcBaseAtk(s: Stats, level: number, dexWeapon: boolean) {
  const str = dexWeapon ? s.dex : s.str, dex = dexWeapon ? s.str : s.dex;
  return t((str * 10 + t((dex * 10) / 5) + t((s.luk * 10) / 3) + t((level * 10) / 4)) / 10);
}

/** job->aspd_base[column]: job_db fills every BaseASPD column a job doesn't list, the weapon types and the RENEWAL Shield column
 *  (index MAX_WEAPON_TYPE) alike, with AMOTION_ZERO_ASPD / AMOTION_INTERVAL = 200 (JobDatabase::parseBodyNode, pc.cpp:13945-13959). */
export const aspdBase = (job: JobKey, column: string) => JOBS[job].aspdBase[column] ?? AMOTION_ZERO_ASPD / AMOTION_INTERVAL;

/** status_base_amotion_pc (RENEWAL_ASPD) without skills: the base value on the ASPD scale (not yet capped). */
export function pcBaseAspd(job: JobKey, s: Stats, weapon: Weapon, shield = false) {
  // status.cpp:2366-2368 job->aspd_base[weapontype1] (+ aspd_base[MAX_WEAPON_TYPE], the Shield column, when status.shield);
  // status.cpp:2398 subtracts min(aspd, 200). A DEX weapon takes DEX² / 7 instead of / 5 (status.cpp:2372-2386).
  let penalty = aspdBase(job, weapon.type);
  if (shield) penalty += aspdBase(job, "Shield");
  const temp = Math.sqrt(DEX_WEAPONS.has(weapon.type) ? (s.dex * s.dex) / 7 + s.agi * s.agi * 0.5 : (s.dex * s.dex) / 5 + s.agi * s.agi * 0.5) * 0.25 + 196;
  return t(temp) - Math.min(penalty, 200);
}
/** Displayed ASPD without equipment bonuses (capped at max_aspd). */
export const pcAspd = (job: JobKey, s: Stats, weapon: Weapon, shield = false) => Math.min(MAX_ASPD, pcBaseAspd(job, s, weapon, shield));

/** status_calc_bl_main SCB_ASPD, BL_PC + RENEWAL_ASPD (status.cpp:6388-6415) without skills/SCs: base ASPD, + (195 - ASPD) *
 *  aspd_rate2 / 100 (bAspdRate), converted to amotion, + bonus.aspd_add (bAspd), capped to [max_aspd, MIN_ASPD] / 2. */
export function pcCalcAmotion(baseAspd: number, aspdRate2 = 0, aspdAdd = 0) {
  const aspd = baseAspd + t((Math.max(195 - baseAspd, 2) * aspdRate2) / 100);
  const amotion = AMOTION_ZERO_ASPD - aspd * AMOTION_INTERVAL + aspdAdd;
  // pc_maxaspd = battle_config.max_aspd stored as (2000 - max_aspd * 10) * AMOTION_DIVIDER_PC (battle.cpp:8965), / AMOTION_DIVIDER_PC
  return cap(amotion, AMOTION_ZERO_ASPD - MAX_ASPD * AMOTION_INTERVAL, MIN_ASPD / AMOTION_DIVIDER_PC);
}

/** Player attack interval: amotion = 2000 - aspd*10, adelay = 2*amotion (AMOTION_DIVIDER_PC). */
export const aspdToDelay = (aspd: number) => 2 * (2000 - aspd * 10);

/** status_calc_maxhp_pc / status_calc_maxsp_pc (status.cpp:3511-3600) for a plain (non-trans) job: base * (1 + stat%), + 1 per
 *  equipment VIT / INT (param_equip), + bMaxHP / bMaxSP, + bMaxHPrate / bMaxSPrate % of that; double math, truncated, min 1. */
export function pcMaxHpSp(base: number, stat: number, equipStat: number, flat: number, rate: number, trans = false) {
  let dmax = base;
  if (stat > 0) dmax *= 1.0 + stat * 0.01;
  if (trans) dmax *= 1.25; // (sd.class_ & JOBL_UPPER): transcendent jobs
  dmax += equipStat;
  dmax += flat;
  dmax += (dmax * (rate - 100)) / 100; // status_get_hpbonus_equip: hprate - 100 (usable-item and skill rates: none yet)
  return Math.max(1, t(dmax));
}

/** status_calc_pc_sub (RENEWAL) + status_calc_misc + status_calc_bl_main for a player without skills or status changes, in
 *  rAthena's order: equipment (item DEF, weapon ATK/MATK, scripts via pc_bonus) -> stats (base + job + equipment) -> max HP/SP
 *  -> misc (HIT/FLEE/DEF2/MDEF2/CRI/FLEE2 stack on the script bonuses) -> rate bonuses -> DEF/MDEF rates -> ASPD -> MATK. */
export function playerStatus(p: PlayerBase): Status {
  const weapon = p.weapon ?? FISTS;
  const e: EquipBonus = { ...noBonus(), ...p.equip, param: { ...noBonus().param, ...p.equip?.param }, paramEquip: { ...noBonus().paramEquip, ...p.equip?.paramEquip } };
  const jb = jobBonus(p.job, p.jobLevel);
  // status.cpp:4290-4302: base_status->str = job bonus + status.str + param_bonus + param_equip, capped to [0, USHRT_MAX]
  // status.cpp:4283 absolute modifiers from passive skills join base_status before the sum: AC_OWL +DEX
  const sk: Stats = { str: 0, agi: 0, vit: 0, int: 0, dex: p.passives?.owl ?? 0, luk: 0 };
  let s = Object.fromEntries(STAT_KEYS.map((k) => [k, cap(sk[k] + p.stats[k] + jb[k] + e.param[k], 0, USHRT_MAX)])) as Stats;
  if (p.sc?.stats) s = p.sc.stats(s); // status_calc_str / agi / int / dex / luk: status changes act on the summed stat
  const bonus = Object.fromEntries(STAT_KEYS.map((k) => [k, s[k] - p.stats[k]])) as Stats;
  const lv = Math.max(1, p.level), job = JOBS[p.job];

  // base_status->rhw as the equipment loop left it (items.ts gearOf: item ATK, refine ATK2, MATK, wlv, Range, then the scripts'
  // bAtk / bAtk2 / bAtkEle / bAtkRange in equip_index order, the ammo's last); status.cpp:4347 watk = rhw.atk + rhw.atk2
  // (status_weapon_atk). status.cpp:4216: an attack range below 1 (bare hands) is 1.
  const rhw: HandWeapon = p.equip?.rhw ? { ...p.equip.rhw }
    : { atk: weapon.atk, atk2: weapon.atk2, matk: weapon.matk, wlv: weapon.level, ele: weapon.element, range: weapon.range };
  if (rhw.range < 1) rhw.range = 1;
  if ((p.passives?.vulture ?? 0) > 0 && weapon.type === "Bow") rhw.range += p.passives!.vulture!; // status.cpp:4485 AC_VULTURE

  // status_calc_misc (RENEWAL, BL_PC): players stack these on the bonuses the scripts already wrote
  let hit = cap(e.hit + lv + s.dex + t(s.luk / 3) + 175, 1, SHRT_MAX);
  let flee = cap(e.flee + lv + s.agi + t(s.luk / 5) + 100, 1, SHRT_MAX);
  let def2 = cap(e.def2 + Math.floor((lv + s.vit) / 2 + s.agi / 5), 0, SHRT_MAX);
  let mdef2 = cap(e.mdef2 + Math.floor(s.int + lv / 4 + (s.dex + s.vit) / 5), 0, SHRT_MAX);
  let cri = cap(e.cri + t(lv / 10) + 10 + s.luk * 3, 1, SHRT_MAX);
  let flee2 = cap(e.flee2 + s.luk + 10, 0, SHRT_MAX);
  // status.cpp:4408-4446: rate bonuses (negative rates count as 0)
  const rate = (v: number, r: number) => (r === 100 ? v : t((v * Math.max(0, r)) / 100));
  hit = rate(hit, e.hitRate);
  flee = rate(flee, e.fleeRate);
  // status.cpp:4517 TF_MISS, after flee_rate: 3 per level, 4 for the Assassin line ((class_ & MAPID_UPPERMASK) == MAPID_ASSASSIN)
  flee += ((MAPID[p.job] & 0xfff) === 0x106 ? 4 : 3) * (p.passives?.miss ?? 0);
  const p2 = passive2((k) => p.passives?.extra?.[k] ?? 0); // 2.5.0: Dodge (flee), Weaponry Research (hit), Faith (max HP)
  flee += p2.flee;
  hit += p2.hit;
  def2 = rate(def2, e.def2Rate);
  mdef2 = rate(mdef2, e.mdef2Rate);
  cri = cap(rate(cri, e.criticalRate), SHRT_MIN, SHRT_MAX);
  flee2 = rate(flee2, e.flee2Rate);
  // status_calc_bl_main final pass (status.cpp:6004-6024, 6136-6157, 6047/6071) with no status changes: status_calc_hit / flee
  // cap_value(.., 1, SHRT_MAX) (7544-7546, 7612-7621); status_calc_critical / status_calc_flee2 cap_value(.., 10, SHRT_MAX) only
  // when the base value is non-zero (7504-7507, 7724-7727); def2 / mdef2 RENEWAL cap_value(.., SHRT_MIN, SHRT_MAX).
  hit = cap(hit, 1, SHRT_MAX);
  flee = cap(flee, 1, SHRT_MAX);
  if (cri !== 0) cri = cap(cri, 10, SHRT_MAX);
  if (flee2 !== 0) flee2 = cap(flee2, 10, SHRT_MAX);
  def2 = cap(def2, SHRT_MIN, SHRT_MAX);
  mdef2 = cap(mdef2, SHRT_MIN, SHRT_MAX);
  // e.def already holds item DEF + bDef + the refine DEF (refinedef + 50) / 100 (status.cpp:4096, items.ts gearOf);
  // 4576-4601 def_rate / mdef_rate, capped to DEFTYPE (short)
  const def = cap(rate(e.def, e.defRate), SHRT_MIN, SHRT_MAX);
  const mdef = cap(rate(e.mdef, e.mdefRate), SHRT_MIN, SHRT_MAX);

  const amotion = pcCalcAmotion(pcBaseAspd(p.job, s, weapon, p.shield ?? false), e.aspdRate2 + (p.sc?.aspd ?? 0), e.aspdAdd);

  // status_calc_bl_main SCB_MATK (RENEWAL, status.cpp:6283-6359): StatusMATK + WeaponMATK -/+ variance (matk * wlv / 10; the
  // refine MATK is part of rhw.matk), overrefine min +1 / max +(overrefine - 1) (6325-6328), + EquipMATK (bMatk), then
  // * matk_rate / 100, capped to [0, USHRT_MAX].
  const matkStatus = s.int + t(s.int / 2) + t(s.dex / 5) + t(s.luk / 3) + t(lv / 4); // status_base_matk_min/max, BL_PC
  const wMatk = rhw.matk > 0 ? rhw.matk : 0, variance = rhw.matk > 0 ? t((rhw.matk * rhw.wlv) / 10) : 0;
  let matkMin = matkStatus + wMatk - variance, matkMax = matkStatus + wMatk + variance;
  const overrefine = weapon.overrefine;
  if (overrefine > 0) { matkMin++; matkMax += overrefine - 1; }
  matkMin += e.ematk; matkMax += e.ematk;
  const matkRate = Math.max(0, e.matkRate);
  if (matkRate !== 100) { matkMin = t((matkMin * matkRate) / 100); matkMax = t((matkMax * matkRate) / 100); }

  const trans = isTrans(p.job); // status_calc_maxhp_pc / _maxsp_pc: JOBL_UPPER x 1.25 after the VIT / INT factor
  const maxHpV = pcMaxHpSp(job.baseHp[lv - 1], s.vit, e.paramEquip.vit, e.hp + p2.maxHp, e.hpRate, trans), maxSpV = pcMaxHpSp(job.baseSp[lv - 1], s.int, e.paramEquip.int, e.sp, e.spRate, trans);
  return {
    stats: s, bonus,
    maxHp: maxHpV,
    maxSp: maxSpV,
    batk: pcBaseAtk(s, lv, DEX_WEAPONS.has(weapon.type)),
    watk: rhw.atk + rhw.atk2, eatk: e.eatk, atkRate: e.atkRate, rhw, overrefine,
    arrow: { atk: e.arrowAtk, hit: e.arrowHit, cri: e.arrowCri, ele: e.arrowEle },
    matkMin: cap(matkMin, 0, USHRT_MAX), matkMax: cap(matkMax, 0, USHRT_MAX),
    matkStatus, matkEquip: rhw.matk + e.ematk,
    hit, flee, flee2, cri, vultureHit: p.passives?.vulture ?? 0,
    def, def2, mdef, mdef2,
    aspd: (AMOTION_ZERO_ASPD - amotion) / AMOTION_INTERVAL, attackDelayMs: AMOTION_DIVIDER_PC * amotion, walkMs: PC_WALK_MS,
    element: e.defEle, elementLevel: 1, size: "Medium", race: "Player_Human", class_: "Normal", mode: PC_MODE,
    masteryAtk: weaponMastery(weapon.type, p.passives), demonBane: p.passives?.demonbane ?? 0, beastBane: p.passives?.extra?.HT_BEASTBANE ?? 0, dpLv: p.passives?.dp ?? 0, baseLv: lv,
    sregenHp: skillRegen(p.passives?.recovery ?? 0, 5, maxHpV), sregenSp: skillRegen(p.passives?.srecovery ?? 0, 3, maxSpV),
    hpRecovRate: Math.max(0, e.hpRecovRate), spRecovRate: Math.max(0, e.spRecovRate), // status.cpp:4670-4673: never below 0
    ...battleBonus(e),
  };
}

export type MobStatus = Status & { atkMin: number; atkMax: number };

/** Monster status: mob_db values + status_calc_misc / status_base_atk_min/max (RENEWAL, BL_MOB). Monsters can't crit or perfect-dodge
 *  (conf/battle/battle.conf enable_critical / enable_perfect_flee). */
export function mobStatus(m: Mob): MobStatus {
  const s: Stats = { str: m.str, agi: m.agi, vit: m.vit, int: m.int, dex: m.dex, luk: m.luk };
  return {
    stats: s, bonus: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
    maxHp: m.hp, maxSp: m.sp,
    batk: m.str + m.level, // status_base_atk default branch: dstr + level
    watk: m.atk, eatk: 0, atkRate: 0,
    // mob_db Attack / Attack2 / AttackRange (status_calc_mob_). A monster's attack element stays ELE_NEUTRAL: mob_db's `Element` is its
    // defense element (mob.cpp:5341 sets def_ele) and nothing sets rhw.ele (battle_get_weapon_element reads it, status.cpp:6161)
    rhw: { atk: m.atk, atk2: 0, matk: m.matk, wlv: 0, ele: "Neutral", range: m.range }, overrefine: 0,
    atkMin: t((m.atk * 80) / 100), atkMax: t((m.atk * 120) / 100),
    matkMin: m.int + m.level + t((m.matk * 70) / 100), matkMax: m.int + m.level + t((m.matk * 130) / 100),
    matkStatus: m.int + m.level + t((m.matk * 70) / 100), matkEquip: 0,
    hit: m.level + m.dex + 150,
    flee: m.level + m.agi + 100,
    flee2: 0, cri: 0, vultureHit: 0,
    def: m.def, def2: Math.floor((m.level + m.vit) / 2),
    mdef: m.mdef, mdef2: Math.floor((m.int + m.level) / 4),
    aspd: 0, attackDelayMs: m.attackDelay, walkMs: m.walkSpeed,
    element: m.element as Element, elementLevel: m.elementLevel, size: m.size as Size,
    race: m.race as Race, class_: m.class as MobClass, mode: m.mode, // status_calc_mob_ copies md->db->status (status.cpp:2818): mob_db Race / Class, mode as imported
    ...battleBonus(noBonus()),
  };
}

// Natural regen (status_calc_regen) every natural_healhp_interval / natural_healsp_interval; sitting halves the interval.
/** battle_addmastery's weapon cases (battle.cpp:2336-2347): W_DAGGER / W_1HSWORD get SM_SWORD x 4, W_2HSWORD SM_TWOHAND x 4. */
export const weaponMastery = (type: string, p?: Passives) =>
  (type === "Dagger" || type === "1hSword" ? 4 * (p?.sword ?? 0) : type === "2hSword" ? 4 * (p?.twohand ?? 0) : 0)
  + masteryAtk2(type, (k) => p?.extra?.[k] ?? 0); // 2.5.0: spear / axe / mace / knuckle / instrument / whip / book / katar / Weaponry Research
/** status_calc_regen (status.cpp:5304-5313) sregen: SM_RECOVERY val = lv*5 + lv*max_hp/500, MG_SRECOVERY lv*3 + lv*max_sp/500 (0..SHRT_MAX). */
export const skillRegen = (lv: number, base: number, max: number) => (lv > 0 ? Math.min(32767, lv * base + t((lv * max) / 500)) : 0);
/** natural_heal_skill_interval (conf/battle/player.conf): ms of walking-free time per sregen tick. */
export const NATURAL_HEAL_SKILL_INTERVAL = 10000;
export const HP_REGEN_MS = 6000, SP_REGEN_MS = 8000;
/** status_natural_heal (status.cpp:15526-15530): while the unit's walktimer runs, SP never regenerates, and HP only does when
 *  regen->state.walk is set (SC_GT_REVITALIZE, status.cpp:5455; `walkRegen`). Otherwise the HP timer is restarted (else branch,
 *  status.cpp:15566-15568), so the first tick comes a full interval after the unit stops. SP walking is NOT blocked in our port
 *  (the critic found the existing behaviour correct), so only HP is gated here. */
export const hpRegenBlockedByWalk = (walking: boolean, walkRegen = false) => walking && !walkRegen;
// bHPrecovRate / bSPrecovRate scale the value like status_calc_regen (status.cpp:5278, 5289): val * rate / 100 when rate != 100
export const hpRegen = (s: Status) => { const v = t(s.stats.vit / 5) + Math.max(1, t(s.maxHp / 200)); return s.hpRecovRate !== undefined && s.hpRecovRate !== 100 ? t((v * s.hpRecovRate) / 100) : v; };
export const spRegen = (s: Status) => {
  const v = 1 + t(s.stats.int / 6) + t(s.maxSp / 100) + (s.stats.int >= 120 ? t((s.stats.int - 120) / 2) + 4 : 0);
  return s.spRecovRate !== undefined && s.spRecovRate !== 100 ? t((v * s.spRecovRate) / 100) : v;
};

/**
 * Status window values the way the server sends them (clif_initialstatus / clif_updatestatus, clif.cpp:4142-4155, 3725-3732;
 * RENEWAL macros pc_leftside_* / pc_rightside_* in pc.hpp:1239-1253). Each row is "left + right" except CRI (cri / 10, integer)
 * and HIT (single value). Soft DEF/MDEF come first (def2 / mdef2), hard (def / mdef) second.
 */
export type StatusDisplay = {
  atk: [number, number]; matk: [number, number]; def: [number, number]; mdef: [number, number];
  hit: number; flee: [number, number]; cri: number; aspd: number;
};
export function statusDisplay(s: Pick<Status, "batk" | "watk" | "eatk" | "matkStatus" | "matkEquip" | "def" | "def2" | "mdef" | "mdef2" | "hit" | "flee" | "flee2" | "cri" | "aspd">): StatusDisplay {
  return {
    atk: [s.batk, s.watk + s.eatk], // pc_leftside_atk = batk, pc_rightside_atk = watk + watk2 + eatk
    matk: [s.matkStatus, s.matkEquip], // status_base_matk_min / rhw.matk + lhw.matk + ematk
    def: [s.def2, s.def], mdef: [s.mdef2, s.mdef],
    hit: s.hit,
    flee: [s.flee, Math.trunc(s.flee2 / 10)], // flee + perfect dodge (flee2 / 10)
    cri: Math.trunc(s.cri / 10),
    aspd: s.aspd,
  };
}

/**
 * The Status window's "Details" ledger (the footer expander): parameters the server sends the client too (clif_updatestatus)
 * that the classic window has no row for, in the units a player reads. Percentages keep the tenth that the Flee / Critical rows
 * drop. range = SP_ATTACKRANGE, status->rhw.range in cells (clif.cpp:3777; bare hands count as 1, status.cpp:4216); perfectDodge
 * = SP_FLEE2, flee2 / 10 % (clif.cpp:3674; flee2 is in tenths of a percent); crit = SP_CRITICAL, cri / 10 % (3724); attackDelay =
 * adelay = AMOTION_DIVIDER_PC * amotion in seconds (status.cpp:6417); walkSpeed = SP_SPEED, battle_status.speed in ms per cell
 * (clif.cpp:3646) as cells per second; element / elementLevel = def_ele / ele_lv, the element an attack against the player is
 * matched with (the armor element, level 1).
 */
export type StatusDetail = { range: number; perfectDodge: number; crit: number; attackDelay: number; walkSpeed: number; element: Element; elementLevel: number };
export function statusDetail(s: Pick<Status, "rhw" | "flee2" | "cri" | "attackDelayMs" | "walkMs" | "element" | "elementLevel">): StatusDetail {
  return {
    range: s.rhw.range, perfectDodge: s.flee2 / 10, crit: s.cri / 10,
    attackDelay: s.attackDelayMs / 1000, walkSpeed: 1000 / s.walkMs,
    element: s.element, elementLevel: s.elementLevel,
  };
}

/** e_mapid (map.hpp:106-114, 127, 149, 171): the map server's class id of each job in shared/data/jobs.json. The low bits are the base class;
 *  JOBL_2_1 / JOBL_2_2 / JOBL_THIRD / JOBL_FOURTH mark the tier and JOBL_UPPER / JOBL_BABY the trans / baby versions
 *  (map.hpp:88-96), e.g. Super Novice = JOBL_2_1|MAPID_NOVICE = 0x100, Novice High = JOBL_UPPER|MAPID_NOVICE = 0x100000.
 *  An imported job needs its row here (a missing one is a type error). */
export const JOBL_2_1 = 0x100, JOBL_2_2 = 0x200, JOBL_2 = 0x300, JOBL_UPPER = 0x100000; // map.hpp:88-96
export const MAPID: Record<JobKey, number> = {
  Novice: 0x0, Swordman: 0x1, Mage: 0x2, Archer: 0x3, Acolyte: 0x4, Merchant: 0x5, Thief: 0x6,
  // 2-1 (JOBL_2_1 | first) and 2-2 (JOBL_2_2 | first); Bard and Dancer share MAPID_BARDDANCER
  Knight: 0x101, Wizard: 0x102, Hunter: 0x103, Priest: 0x104, Blacksmith: 0x105, Assassin: 0x106,
  Crusader: 0x201, Sage: 0x202, Bard: 0x203, Dancer: 0x203, Monk: 0x204, Alchemist: 0x205, Rogue: 0x206,
  // transcendent = JOBL_UPPER | the plain class
  Novice_High: 0x100000, Swordman_High: 0x100001, Mage_High: 0x100002, Archer_High: 0x100003, Acolyte_High: 0x100004, Merchant_High: 0x100005, Thief_High: 0x100006,
  Lord_Knight: 0x100101, High_Wizard: 0x100102, Sniper: 0x100103, High_Priest: 0x100104, Whitesmith: 0x100105, Assassin_Cross: 0x100106,
  Paladin: 0x100201, Professor: 0x100202, Clown: 0x100203, Gypsy: 0x100203, Champion: 0x100204, Creator: 0x100205, Stalker: 0x100206,
};
/** pc_mapid2jobid for the masks we use, per gender-free job: the imported job whose class id is `mapid` (Bard for MAPID_BARDDANCER
 *  unless `female`, then Dancer; Clown / Gypsy alike). */
export function jobOfMapid(mapid: number, female = false): JobKey | undefined {
  const all = (Object.keys(MAPID) as JobKey[]).filter((j) => MAPID[j] === mapid);
  return all.length > 1 ? all[female ? 1 : 0] : all[0];
}
/** sd->class_ & MAPID_FIRSTMASK (+ JOBL_UPPER kept off): the first job of a line (Knight / Lord Knight -> Swordman). */
export const firstJobOf = (job: JobKey): JobKey => jobOfMapid(MAPID[job] & 0xff)!;
/** The plain (non-trans) 2nd or 1st job of a transcendent one (MAPID & ~JOBL_UPPER). */
export const plainJobOf = (job: JobKey, female = false): JobKey => jobOfMapid(MAPID[job] & ~JOBL_UPPER & 0xfffff, female)!;
export const isTrans = (job: JobKey) => (MAPID[job] & JOBL_UPPER) !== 0;
export const isSecondJob = (job: JobKey) => (MAPID[job] & JOBL_2) !== 0;
export const MAPID_NOVICE = 0x0, MAPID_SECONDMASK = 0xfff; // map.hpp:108, 100
/** (class_ & MAPID_SECONDMASK) == MAPID_NOVICE: the Novice class (Novice, Novice High, Baby Novice). The Super Novice line
 *  (JOBL_2_1) is not part of it. */
export const isNoviceClass = (job: JobKey) => (MAPID[job] & MAPID_SECONDMASK) === MAPID_NOVICE;

/** clif_updatestatus SP_HP (clif.cpp:3683-3690): the HP a character's own client is sent never goes below 1 ("on officials the
 *  HP never go below 1, even if you die"), and a Novice-class character at 0 HP is sent max_hp / 2 (integer). pc_damage sends
 *  it right after the lethal hit (pc.cpp:9682-9686) and pc_dead sends no other HP, so a dead character shows it until it
 *  respawns. Display only: the server's real HP stays 0. */
export const ownerHp = (job: JobKey, hp: number, maxHp: number) => (hp > 0 ? hp : isNoviceClass(job) ? Math.trunc(maxHp / 2) : 1);
