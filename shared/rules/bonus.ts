// Equipment script bonuses: a data-driven subset of rAthena pc_bonus (src/map/pc.cpp:3725) and pc_bonus2 (pc.cpp:4498) for the
// `bonus bX,n;` / `bonus2 bX,t,n;` statements that tools/rathena/import.ts turns into data (item_db Script -> items.json
// `bonuses`; anything the importer can't express as a plain bonus lands in the item's `unsupported` list and has no effect).
// Each script constant (bStr, bMdef, ... from src/map/script_constants.hpp) is one SP_* case of pc_bonus / pc_bonus2, written as
// a PC_BONUS / PC_BONUS2 row below: the field(s) of the equipment state it moves, how, and under which sd->state.lr_flag.
// items.ts gearOf runs the worn items' scripts the way status_calc_pc_sub does (equip_index order, lr_flag per hand). Teaching a
// bonus = one row (+ its field) and a re-import.
import { ELEMENTS, MOB_CLASSES, RACES, SIZES, STAT_KEYS, type ClassKey, type EleKey, type Element, type RaceKey, type SizeKey, type StatKey, type Stats } from "./data.ts";
import { shootsAmmo } from "./weapons.ts";
import { EFF_SC, type ScKey } from "./status_change.ts";

/** One `bonus bX,n;` statement, or `bonus2 bX,type2,n;` with type2 = its first argument as the importer resolved it (bonus2Type2:
 *  a race / element / size / monster class in mob_db spelling, "All" = RC_ALL / ELE_ALL / SZ_ALL / CLASS_ALL). value is a number, or an element name (without the `Ele_` prefix) for bAtkEle /
 *  bDefEle. */
export type ItemBonus = { type: string; value: number | string; type2?: string };

/** sd->state.lr_flag (pc.hpp:124 enum e_lr_flag) while an equipment script runs: "none" (LR_FLAG_NONE) for the right-hand
 *  weapon and every armor piece outside the left hand, "shield" (LR_FLAG_SHIELD) for the armor in EQI_HAND_L
 *  (status.cpp:4025-4029), "arrow" (LR_FLAG_ARROW) for the equipped ammo, run after the loop (status.cpp:4042-4052).
 *  LR_FLAG_WEAPON (a left-hand weapon: dual wield, lhw) arrives with dual wield. */
export type LrFlag = "none" | "shield" | "arrow";

/** struct weapon_atk (status.hpp:3361) of the right hand: base_status->rhw. range = attack range in cells: the weapon item's
 *  Range (status.cpp:3989) + bAtkRange, floored at 1 by status_calc_pc_sub (status.cpp:4216; see status.ts playerStatus). */
export type HandWeapon = { atk: number; atk2: number; matk: number; wlv: number; ele: Element; range: number };

/** The kinds of index a pc_bonus2 `type2` can have, with the script constant prefix that names a member (constants are case-insensitive:
 *  RC_DemiHuman, Ele_Fire, Size_Large, Class_Boss) and every member, "All" being the kind's RC_ALL / ELE_ALL / SZ_ALL / CLASS_ALL slot.
 *  A case validates its type2 with PC_BONUS_CHK_RACE / _ELEMENT / _SIZE / _CLASS (pc.cpp:3101-3109; map.hpp:1279-1282, mob.hpp:585). */
const INDEX_KINDS = {
  race: { prefix: "rc_", names: [...RACES, "All"] },
  ele: { prefix: "ele_", names: [...ELEMENTS, "All"] },
  size: { prefix: "size_", names: [...SIZES, "All"] },
  class: { prefix: "class_", names: [...MOB_CLASSES, "All"] },
} as const;
type IndexKind = keyof typeof INDEX_KINDS;
type IndexKey = { race: RaceKey; ele: EleKey; size: SizeKey; class: ClassKey };

/** Every indexed table of the equipment state the battle code reads (an `int32 x[RC_MAX]` / `[ELE_MAX]` / `[SZ_MAX]` / `[CLASS_MAX]` array
 *  of sd->right_weapon or sd->indexed_bonus), with the kind of index it has. A PC_BONUS2 row names the table it adds to; a new
 *  indexed bonus = one entry here (+ its row, + the battle step that reads it) and a re-import. Skill passives and status changes
 *  write the same tables (status.cpp:4677-4844: Faith, Skin Tempering, Dragonology, Eucharistica, Providence ...), so when they
 *  arrive they add into the arrays status.ts hands to battle.ts and cardfix needs no change. */
export const INDEXED_BONUS = {
  critAddRace: "race", // indexed_bonus.critaddrace (bCriticalAddRace, x10): + crit rate vs a race
  // the attacker's bonuses on weapon / equipment ATK (battle_calc_cardfix, battle.ts cardfix): right_weapon.add* from the weapon and
  // every armor piece, indexed_bonus.arrow_add* from the equipped ammo, both read by an attack that shoots it
  addRace: "race", addEle: "ele", addSize: "size", addClass: "class",
  arrowAddRace: "race", arrowAddEle: "ele", arrowAddSize: "size", arrowAddClass: "class",
  // the defender's: indexed_bonus.subrace / subele_script / subsize / subclass / subdefele (the attacker's own armor element) / weapon_subsize
  subRace: "race", subEle: "ele", subSize: "size", subClass: "class", subDefEle: "ele", weaponSubSize: "size",
} as const satisfies Record<string, IndexKind>;
export type IndexedName = keyof typeof INDEXED_BONUS;
/** The tables of one unit: only the slots a bonus wrote exist, an absent one is 0. */
export type IndexedBonus = { [N in IndexedName]: Partial<Record<IndexKey[(typeof INDEXED_BONUS)[N]], number>> };
export const INDEXED_NAMES = Object.keys(INDEXED_BONUS) as IndexedName[];
export const emptyIndexed = (): IndexedBonus => Object.fromEntries(INDEXED_NAMES.map((n) => [n, {}])) as IndexedBonus;
export const copyIndexed = (b: IndexedBonus): IndexedBonus => Object.fromEntries(INDEXED_NAMES.map((n) => [n, { ...b[n] }])) as IndexedBonus;

/** What status_calc_pc_sub's equipment loop writes on base_status / map_session_data. Starts at the resets of
 *  status.cpp:3784-3800 (rates 100) and the base_status memset (everything else 0, elements ELE_NEUTRAL). */
export type EquipBonus = {
  rhw: HandWeapon; // base_status->rhw: the weapon's ATK / refine ATK2 / MATK / level (status.cpp:3955-3977) + bAtk / bAtk2 / bAtkEle
  param: Stats; // indexed_bonus.param_bonus -> param_equip after the equipment loop (status.cpp:4092-4094)
  paramEquip: Stats; // sd->indexed_bonus.param_equip: param_bonus as the equipment loop left it, BEFORE the card loop (status.cpp:4093); only it feeds MaxHP/MaxSP's +1 per point (3534, 3585)
  def: number; // base_status->def: item DEF (status.cpp:3917) + bDef (SP_DEF1)
  def2: number; mdef: number; mdef2: number; // SP_DEF2 / SP_MDEF1 / SP_MDEF2
  hit: number; flee: number; // SP_HIT / SP_FLEE1
  flee2: number; cri: number; // SP_FLEE2 / SP_CRITICAL, already x10 (tenths of %)
  eatk: number; // bonus.eatk (SP_BASE_ATK, RENEWAL): equipment ATK
  ematk: number; // bonus.ematk (SP_EMATK = bMatk): equipment MATK
  atkRate: number; // bonus.atk_rate (SP_ATK_RATE, RENEWAL), percent added to weapon + equipment ATK
  hp: number; sp: number; // bonus.hp / bonus.sp (SP_MAXHP / SP_MAXSP)
  hpRate: number; spRate: number; // sd->hprate / sprate (SP_MAXHPRATE / SP_MAXSPRATE), 100 = unchanged
  hpRecovRate: number; spRecovRate: number; // sd->hprecov_rate / sprecov_rate (SP_HP_RECOV_RATE / SP_SP_RECOV_RATE), 100 = unchanged: natural regen %
  matkRate: number; hitRate: number; fleeRate: number; flee2Rate: number; criticalRate: number; // sd->*_rate, 100 = unchanged
  defRate: number; def2Rate: number; mdefRate: number; mdef2Rate: number;
  aspdAdd: number; // bonus.aspd_add (SP_ASPD: -10 * val, amotion units)
  aspdRate2: number; // base_status->aspd_rate2 (SP_ASPD_RATE under RENEWAL_ASPD), percent
  defEle: Element; // base_status->def_ele (SP_DEFELE): the armor element
  // the equipped ammo (status.cpp:4042-4052): sd->bonus.arrow_atk = its item ATK, and what its script writes under LR_FLAG_ARROW
  arrowAtk: number; // sd->bonus.arrow_atk: joins equipment ATK on an arrow attack (battle_calc_equip_attack, battle.cpp:3439-3444)
  arrowHit: number; // sd->bonus.arrow_hit (SP_HIT under LR_FLAG_ARROW): + hit rate of an arrow attack (battle.cpp:3284-3285)
  arrowCri: number; // sd->bonus.arrow_cri (SP_CRITICAL under LR_FLAG_ARROW, x10): + crit of an arrow attack (battle.cpp:3050-3053)
  arrowEle: Element; // sd->bonus.arrow_ele (SP_ATKELE under LR_FLAG_ARROW without a shooting weapon); Neutral = none
  // what only the battle code reads (battle.ts playerAttack / mobAttack / battleCalcCardfix), all percent unless noted
  critAtkRate: number; // sd->bonus.crit_atk_rate (SP_CRIT_ATK_RATE): + damage of a critical normal attack, before DEF (battle.cpp:5549-5553)
  nonCritAtkRate: number; // sd->bonus.non_crit_atk_rate (SP_NON_CRIT_ATK_RATE): + damage of a non-critical one (5555-5557)
  shortAtkRate: number; longAtkRate: number; // sd->bonus.short_attack_atk_rate / long_attack_atk_rate: + damage of a BF_SHORT / BF_LONG attack (5560-5563)
  nearAtkDef: number; longAtkDef: number; // sd->bonus.near_attack_def_rate / long_attack_def_rate: - damage taken from BF_SHORT / BF_LONG attacks (battle_calc_cardfix)
  critRangeAtk: number; // sd->bonus.critical_rangeatk (SP_CRITICAL_RANGEATK = bCriticalLong, x10): + crit of an arrow attack (battle.cpp:3051-3052)
  addEff: Partial<Record<ScKey, number>>; // sd->addeff (bonus2 bAddEff, pc_bonus_addeff): status -> chance in 1/10000 that an attack of ours inflicts it
  resEff: Partial<Record<ScKey, number>>; // sd->reseff (bonus2 bResEff, pc_bonus_itembonus): status -> resistance in 1/10000 (capped +-10000)
} & IndexedBonus; // + the indexed tables (INDEXED_BONUS): crit / ATK / damage-taken modifiers by race, element, size and class

export function noBonus(): EquipBonus {
  return {
    rhw: { atk: 0, atk2: 0, matk: 0, wlv: 0, ele: "Neutral", range: 0 },
    param: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
    paramEquip: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
    def: 0, def2: 0, mdef: 0, mdef2: 0, hit: 0, flee: 0, flee2: 0, cri: 0,
    eatk: 0, ematk: 0, atkRate: 0, hp: 0, sp: 0, hpRate: 100, spRate: 100, hpRecovRate: 100, spRecovRate: 100,
    matkRate: 100, hitRate: 100, fleeRate: 100, flee2Rate: 100, criticalRate: 100,
    defRate: 100, def2Rate: 100, mdefRate: 100, mdef2Rate: 100, aspdAdd: 0, aspdRate2: 0, defEle: "Neutral",
    arrowAtk: 0, arrowHit: 0, arrowCri: 0, arrowEle: "Neutral",
    critAtkRate: 0, nonCritAtkRate: 0, shortAtkRate: 0, longAtkRate: 0, nearAtkDef: 0, longAtkDef: 0, critRangeAtk: 0,
    addEff: {}, resEff: {},
    ...emptyIndexed(),
  };
}

const ELEMENT_NAMES: ReadonlySet<string> = new Set(ELEMENTS);
const SHORT = [-32768, 32767] as const, USHORT = [0, 65535] as const; // cap_value(.., SHRT_MIN, SHRT_MAX) / (.., 0, USHRT_MAX)

/** A numeric field of the equipment state: a top-level number, `param.<stat>` (param_bonus) or `rhw.atk` / `rhw.atk2` / `rhw.range`. */
type NumField = { [K in keyof EquipBonus]: EquipBonus[K] extends number ? K : never }[keyof EquipBonus] | `param.${StatKey}` | "rhw.atk" | "rhw.atk2" | "rhw.range";
/** An element field: base_status->rhw.ele, base_status->def_ele, sd->bonus.arrow_ele. */
type EleField = "rhw.ele" | "defEle" | "arrowEle";
/** Where a case writes under LR_FLAG_ARROW: one field (sd->bonus.arrow_hit / arrow_cri), or split by the worn weapon type —
 *  `shooter` while it shoots its ammo (weapons.ts SHOOTING_WEAPONS: W_BOW, W_REVOLVER..W_GRENADE), `other` otherwise; a missing
 *  side writes nothing. */
type ArrowRoute<F> = F | { shooter?: F; other?: F };

/** One pc_bonus case as data.
 *  - `add`: every listed field += val * mul (default 1), then cap_value(field, cap) where the C++ caps the running value
 *    (status_data fields; sd->bonus / sd->*_rate fields are a plain +=). `lr`: the non-arrow lr_flag values the case writes
 *    under; omitted = all of them.
 *  - `set`: an element bonus, PC_BONUS_CHK_ELEMENT then field = val, so of several such scripts the one run last wins.
 *  - `arrow`: what the case does under LR_FLAG_ARROW (an ammo item's script): a plain += (or the element set) on that field.
 *    Omitted = nothing, the C++ `if (sd->state.lr_flag != LR_FLAG_ARROW)` gate that almost every case has. */
export type BonusRule =
  | { add: readonly NumField[]; mul?: number; cap?: readonly [number, number]; lr?: readonly Exclude<LrFlag, "arrow">[]; arrow?: ArrowRoute<NumField> }
  | { set: EleField; arrow?: ArrowRoute<EleField> };

type AddRule = Extract<BonusRule, { add: unknown }>;
const stat = (...keys: readonly StatKey[]): AddRule => ({ add: keys.map((k) => `param.${k}` as const) });
const short = (f: NumField, mul = 1): AddRule => ({ add: [f], mul, cap: SHORT });
const plus = (f: NumField): AddRule => ({ add: [f] });

/** pc_bonus (pc.cpp:3725-4410, RENEWAL branches) by script constant; numbers are the pc.cpp case lines. */
export const PC_BONUS: Readonly<Record<string, BonusRule>> = {
  bStr: stat("str"), bAgi: stat("agi"), bVit: stat("vit"), bInt: stat("int"), bDex: stat("dex"), bLuk: stat("luk"), // SP_STR..SP_LUK 3734
  bAllStats: stat(...STAT_KEYS), bAgiVit: stat("agi", "vit"), bAgiDexStr: stat("agi", "dex", "str"), // SP_ALL_STATS 4219, SP_AGI_VIT 4239, SP_AGI_DEX_STR 4245
  // SP_ATK1 3752 / SP_ATK2 3762: rhw.atk(2) = cap_value(rhw.atk(2) + val, 0, USHRT_MAX) under LR_FLAG_NONE only. The cap is on
  // the running value, the weapon's own ATK / refine ATK2 included once it has been processed; LR_FLAG_WEAPON writes lhw instead
  // and LR_FLAG_SHIELD / LR_FLAG_ARROW write nothing.
  bAtk: { add: ["rhw.atk"], cap: USHORT, lr: ["none"] }, bAtk2: { add: ["rhw.atk2"], cap: USHORT, lr: ["none"] },
  bBaseAtk: short("eatk"), // SP_BASE_ATK 3772 (RENEWAL): bonus.eatk
  bDef: short("def"), bDef2: short("def2"), bMdef: short("mdef"), bMdef2: short("mdef2"), // SP_DEF1 3782, SP_DEF2 3792, SP_MDEF1 3798, SP_MDEF2 3811
  bFlee: short("flee"), bFlee2: short("flee2", 10), // SP_FLEE1 3824, SP_FLEE2 3830: val*10
  // SP_HIT 3817 / SP_CRITICAL 3836 (val*10): an ammo script's goes to sd->bonus.arrow_hit / arrow_cri instead (3822, 3841)
  bHit: { ...short("hit"), arrow: "arrowHit" }, bCritical: { ...short("cri", 10), arrow: "arrowCri" },
  // SP_ATTACKRANGE 3943: rhw.range += val under LR_FLAG_NONE / LR_FLAG_SHIELD (the switch's default); an ammo script's only with
  // a shooting weapon (3945-3953)
  bAtkRange: { add: ["rhw.range"], arrow: { shooter: "rhw.range" } },
  bMaxHP: plus("hp"), bMaxSP: plus("sp"), bMaxHPrate: plus("hpRate"), bMaxSPrate: plus("spRate"), // SP_MAXHP 3912, SP_MAXSP 3917, SP_MAXHPRATE 3927, SP_MAXSPRATE 3931
  bHPrecovRate: plus("hpRecovRate"), bSPrecovRate: plus("spRecovRate"), // SP_HP_RECOV_RATE 3986 / SP_SP_RECOV_RATE 3990 (status_calc_regen reads them)
  bMatk: plus("ematk"), // bMatk = SP_EMATK 4403: bonus.ematk
  bAtkRate: plus("atkRate"), // SP_ATK_RATE 4037 (RENEWAL): bonus.atk_rate
  bMatkRate: plus("matkRate"), bCriticalRate: plus("criticalRate"), bHitRate: plus("hitRate"), bFleeRate: plus("fleeRate"), // 4012, 4071, 4096, 4100
  bFlee2Rate: plus("flee2Rate"), bDefRate: plus("defRate"), bDef2Rate: plus("def2Rate"), bMdefRate: plus("mdefRate"), bMdef2Rate: plus("mdef2Rate"), // 4104-4120
  bAspd: { add: ["aspdAdd"], mul: -10 }, // SP_ASPD 3972: bonus.aspd_add -= 10*val
  bAspdRate: plus("aspdRate2"), // SP_ASPD_RATE 3976, RENEWAL_ASPD branch: aspd_rate2 += val
  // SP_ATKELE 3879: rhw.ele = val under LR_FLAG_NONE and LR_FLAG_SHIELD alike (the switch's default); an ammo script's becomes the
  // weapon element with a shooting weapon, else the arrow element (3883-3896)
  bAtkEle: { set: "rhw.ele", arrow: { shooter: "rhw.ele", other: "arrowEle" } },
  bDefEle: { set: "defEle" }, // SP_DEFELE 3907: def_ele = val (not under LR_FLAG_ARROW)
  // sd->bonus rates only battle reads, a plain += under every lr_flag but LR_FLAG_ARROW: SP_CRIT_ATK_RATE 4320,
  // SP_NON_CRIT_ATK_RATE 4300, SP_SHORT_ATK_RATE 4292, SP_LONG_ATK_RATE 4296, SP_NEAR_ATK_DEF 3996, SP_LONG_ATK_DEF 4000
  bCritAtkRate: plus("critAtkRate"), bNonCritAtkRate: plus("nonCritAtkRate"),
  bShortAtkRate: plus("shortAtkRate"), bLongAtkRate: plus("longAtkRate"), bNearAtkDef: plus("nearAtkDef"), bLongAtkDef: plus("longAtkDef"),
  // SP_CRITICAL_RANGEATK 4450 (bCriticalLong): critical_rangeatk += val*10; an ammo script's goes to arrow_cri instead
  bCriticalLong: { add: ["critRangeAtk"], mul: 10, arrow: "arrowCri" },
};

/** True when pc_bonus below knows this script constant (the importer and the tests use it to flag the rest). */
export const isSupportedBonus = (type: string) => Object.hasOwn(PC_BONUS, type);

/** One pc_bonus2 case as data: it adds val * mul (default 1) to `table[type2]`, type2 being a member of the table's index kind (the case's
 *  PC_BONUS_CHK_*), under LR_FLAG_NONE and LR_FLAG_SHIELD. Under LR_FLAG_ARROW (an ammo item's script) it adds to the `arrow` table
 *  instead (the weapon-side bonuses keep a separate copy for the ammo, sd->indexed_bonus.arrow_add*), or to `table` itself with
 *  `arrow: true` (a case without an lr_flag test), and writes nothing without `arrow` (the usual `lr_flag != LR_FLAG_ARROW`). */
export type Bonus2Rule = { table: IndexedName; mul?: number; arrow?: IndexedName | true };

/** pc_bonus2 (pc.cpp:4498-) by script constant; numbers are the pc.cpp case lines. */
export const PC_BONUS2: Readonly<Record<string, Bonus2Rule>> = {
  bCriticalAddRace: { table: "critAddRace", mul: 10 }, // SP_CRITICAL_ADDRACE 4709: critaddrace[type2] += val*10
  // the attacker's: right_weapon.add* under LR_FLAG_NONE / LR_FLAG_SHIELD (a shield's goes to the right hand too), arrow_add* from the
  // ammo (a left-hand weapon's, LR_FLAG_WEAPON, goes to left_weapon with dual wield)
  bAddEle: { table: "addEle", arrow: "arrowAddEle" }, // SP_ADDELE 4503
  bAddRace: { table: "addRace", arrow: "arrowAddRace" }, // SP_ADDRACE 4512
  bAddClass: { table: "addClass", arrow: "arrowAddClass" }, // SP_ADDCLASS 4521
  bAddSize: { table: "addSize", arrow: "arrowAddSize" }, // SP_ADDSIZE 4530
  // the defender's: indexed_bonus.*, not under LR_FLAG_ARROW (bSubDefEle has no lr_flag test at all)
  bSubEle: { table: "subEle" }, // SP_SUBELE 4539: subele_script (subele itself is written by skills, status.cpp:4677-4844)
  bSubRace: { table: "subRace" }, // SP_SUBRACE 4544
  bSubClass: { table: "subClass" }, // SP_SUBCLASS 4549
  bSubSize: { table: "subSize" }, // SP_SUBSIZE 4806
  bWeaponSubSize: { table: "weaponSubSize" }, // SP_WEAPON_SUBSIZE 4811
  bSubDefEle: { table: "subDefEle", arrow: true }, // SP_SUBDEF_ELE 5070
};

/** True when pc_bonus2 below knows this script constant. */
export const isSupportedBonus2 = (type: string) => Object.hasOwn(PC_BONUS2, type) || Object.hasOwn(EFF_BONUS2, type);

/** The two bonus2 cases whose type2 is a status constant (PC_BONUS_CHK_SC, Eff_Stun ...): bAddEff (SP_ADDEFF, pc.cpp:4554: a plain
 *  weapon-attack effect on the enemy, `val` in 1/10000; an ammo's goes to arrow_rate, not modelled) and bResEff (SP_RESEFF, 4562:
 *  not under LR_FLAG_ARROW, pc_bonus_itembonus with the +-10000 cap). Only the statuses status_change.ts models. */
const EFF_BONUS2: Readonly<Record<string, "addEff" | "resEff">> = { bAddEff: "addEff", bResEff: "resEff" };

/** The script constant (lower case) -> member name of one index kind, e.g. "rc_demihuman" -> "Demihuman", "size_large" -> "Large". */
const constantsOf = (kind: IndexKind): ReadonlyMap<string, string> =>
  new Map((INDEX_KINDS[kind].names as readonly string[]).map((n) => [`${INDEX_KINDS[kind].prefix}${n}`.toLowerCase(), n]));
const CONSTANTS: Readonly<Record<IndexKind, ReadonlyMap<string, string>>> = { race: constantsOf("race"), ele: constantsOf("ele"), size: constantsOf("size"), class: constantsOf("class") };
/** The type2 a `bonus2 bX,<constant>,n;` statement indexes, as stored in items.json: a constant of the kind bX takes (RC_DemiHuman and
 *  RC_All for bAddRace, Ele_Fire for bAddEle, Size_Large for bAddSize, Class_Boss for bAddClass: script constants are
 *  case-insensitive) becomes its mob_db spelling ("Demihuman", "All", "Fire", "Large", "Boss"). undefined = pc_bonus2 doesn't model bX,
 *  or the constant isn't of the kind bX takes (PC_BONUS_CHK_*). tools/rathena/import.ts resolves with it. */
export function bonus2Type2(type: string, constant: string): string | undefined {
  if (Object.hasOwn(EFF_BONUS2, type)) return EFF_SC[constant.toLowerCase()];
  if (!isSupportedBonus2(type)) return undefined;
  return CONSTANTS[INDEXED_BONUS[PC_BONUS2[type].table]].get(constant.toLowerCase());
}

/** [object, key] of a field path ("def", "param.str", "rhw.atk"). */
function fieldOf(b: EquipBonus, path: string): [Record<string, number | string>, string] {
  const dot = path.indexOf(".");
  const obj = dot < 0 ? b : b[path.slice(0, dot) as "rhw" | "param"];
  return [obj as unknown as Record<string, number | string>, dot < 0 ? path : path.slice(dot + 1)];
}

/** The field an LR_FLAG_ARROW route picks for the worn weapon type, or undefined (writes nothing). */
function arrowField<F>(route: ArrowRoute<F> | undefined, weapon: string): F | undefined {
  if (route === undefined || typeof route === "string") return route;
  const split = route as { shooter?: F; other?: F };
  return shootsAmmo(weapon) ? split.shooter : split.other;
}

/** pc_bonus(sd, type, val) with sd->state.lr_flag = lr; weapon = sd->status.weapon (the worn weapon's item_db SubType, "Fist"
 *  bare-handed), which only the LR_FLAG_ARROW routes read. Returns false (and changes nothing) for a bonus this port doesn't
 *  model or a value pc_bonus rejects; a modelled bonus that writes nothing under this lr_flag (a shield's bAtk) returns true. */
export function pcBonus(b: EquipBonus, type: string, value: number | string, lr: LrFlag = "none", weapon = "Fist"): boolean {
  if (!isSupportedBonus(type)) return false;
  const rule = PC_BONUS[type];
  if ("set" in rule) {
    if (typeof value !== "string" || !ELEMENT_NAMES.has(value)) return false; // PC_BONUS_CHK_ELEMENT: outside ELE_NEUTRAL..ELE_UNDEAD
    const field = lr === "arrow" ? arrowField(rule.arrow, weapon) : rule.set;
    if (field === undefined) return true;
    const [obj, key] = fieldOf(b, field);
    obj[key] = value;
    return true;
  }
  if (typeof value !== "number") return false;
  const v = Math.trunc(value) * (rule.mul ?? 1);
  if (lr === "arrow") { // the sd->bonus.arrow_* / weapon fields an ammo script reaches are a plain +=
    const field = arrowField(rule.arrow, weapon);
    if (field === undefined) return true;
    const [obj, key] = fieldOf(b, field);
    obj[key] = (obj[key] as number) + v;
    return true;
  }
  if (rule.lr && !rule.lr.includes(lr)) return true;
  for (const f of rule.add) {
    const [obj, key] = fieldOf(b, f);
    const sum = (obj[key] as number) + v;
    obj[key] = rule.cap ? Math.min(rule.cap[1], Math.max(rule.cap[0], sum)) : sum;
  }
  return true;
}

/** pc_bonus2(sd, type, type2, val) with sd->state.lr_flag = lr (type2 as bonus2Type2 resolved it). Returns false (and changes
 *  nothing) for a bonus this port doesn't model or a type2 outside the case's index (PC_BONUS_CHK_RACE / _ELEMENT / _SIZE / _CLASS);
 *  a modelled bonus that writes nothing under this lr_flag (an ammo's bSubRace) returns true. */
export function pcBonus2(b: EquipBonus, type: string, type2: string, value: number, lr: LrFlag = "none"): boolean {
  if (!isSupportedBonus2(type)) return false;
  if (Object.hasOwn(EFF_BONUS2, type)) {
    if (!Object.values(EFF_SC).includes(type2 as ScKey)) return false; // PC_BONUS_CHK_SC
    if (lr === "arrow") return true;
    const table = b[EFF_BONUS2[type]], v = Math.trunc(value), key = type2 as ScKey;
    table[key] = EFF_BONUS2[type] === "resEff" ? Math.min(10000, Math.max(-10000, (table[key] ?? 0) + v)) : (table[key] ?? 0) + v;
    return true;
  }
  const rule = PC_BONUS2[type];
  if (!(INDEX_KINDS[INDEXED_BONUS[rule.table]].names as readonly string[]).includes(type2)) return false;
  const name = lr !== "arrow" ? rule.table : rule.arrow === true ? rule.table : rule.arrow;
  if (name === undefined) return true; // `if (sd->state.lr_flag != LR_FLAG_ARROW)`
  const table: Record<string, number | undefined> = b[name];
  table[type2] = (table[type2] ?? 0) + Math.trunc(value) * (rule.mul ?? 1);
  return true;
}

/** buildin_bonus (script.cpp) for one stored statement: `bonus` -> pc_bonus, `bonus2` (type2 set) -> pc_bonus2. */
export function scriptBonus(b: EquipBonus, s: ItemBonus, lr: LrFlag = "none", weapon = "Fist"): boolean {
  if (s.type2 === undefined) return pcBonus(b, s.type, s.value, lr, weapon);
  return typeof s.value === "number" && pcBonus2(b, s.type, s.type2, s.value, lr);
}
