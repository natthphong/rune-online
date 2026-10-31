// Pets (2.4.0): the pure rules of rAthena's pet.cpp (Renewal, conf/battle/pet.conf), re-implemented from the C++ functions
// cited on each piece. Data: shared/data/pets.json (db/re/pet_db.yml with our names, tools/rathena/import.ts), normalised by
// petRow() so a row may leave out the pet_db defaults. The server side (catching, eggs, the pet unit, timers) is
// server/src/pets.ts; the client draws the pet from the room state (MapRoom.ts Pet schema).
import type { PetInfo, PetKind } from "../protocol.ts";
import type { ItemBonus } from "./bonus.ts";

// ---------- constants (pet.hpp e_pet_intimate_level / e_pet_hungry, conf/battle/pet.conf) ----------
export const PET_INTIMATE = { NONE: 0, AWKWARD: 1, SHY: 100, NEUTRAL: 250, CORDIAL: 750, LOYAL: 910, MAX: 1000 } as const;
export const PET_HUNGER = { NONE: 0, VERY_HUNGRY: 10, HUNGRY: 25, NEUTRAL: 75, SATISFIED: 90, STUFFED: 100 } as const;
/** conf/battle/pet.conf (the values our server runs with). */
export const PET_CONF = {
  pet_catch_rate: 100,
  pet_distance_check: 5,
  pet_friendly_rate: 100,
  pet_hungry_delay_rate: 100,
  pet_support_min_friendly: 900,
  /** OUR DEVIATION from rAthena: a battle pet fights from NEUTRAL (250, where every pet starts) instead of 900, or a new pet would
   *  never help. See supportRate for the intimacy bands that replace rAthena's rate_fix. */
  our_support_min_friendly: 250,
  pet_master_dead: false,
  /** battle_config.feature_pet_autofeed_rate (conf/battle/feature.conf): autofeed when hunger <= this */
  feature_pet_autofeed_rate: 89,
  /** pet_hungry: "While starving, it's every 20 seconds" */
  starving_interval_ms: 20_000,
  /** pet_ai_sub_hard: the pet keeps within 3 cells of its master when it has nothing to do */
  follow_range: 3,
  /** MIN_PETTHINKTIME (pet.hpp) */
  think_ms: 100,
} as const;
/** The rename is allowed once (pet.renamed); 1-23 characters like NAME_LENGTH - 1. */
export const PET_NAME_MAX = 23;

// ---------- data ----------
/** petheal (script.cpp buildin_petheal): heal `amount` HP when the owner is at or below hp% AND sp% (pet_heal_timer), every `delay` s.
 *  petskillsupport (buildin_petskillsupport): cast skill `skill` (an AL_* buff we model) at level `lv` on the owner on the same terms. */
export type PetSupport =
  | { type: "heal"; amount: number; delay: number; hp: number; sp: number }
  | { type: "skill"; skill: number | string; lv: number; delay: number; hp: number; sp: number }
  /** petskillbonus (buildin_petskillbonus -> pet_skill_bonus_timer): `bonus` for `duration` s every `delay` s */
  | { type: "bonus"; bonus: ItemBonus; duration: number; delay: number; hp: 100; sp: 100 };
export type PetDb = {
  mobId: number; tameItem: number; eggItem: number; equipItem: number; foodItem: number;
  /** hunger lost every hungryDelay ms */
  fullness: number; hungryDelay: number; hungerIncrease: number;
  intimacyStart: number; intimacyFed: number; intimacyOverfed: number; intimacyHungry: number; intimacyOwnerDie: number;
  captureRate: number; attackRate: number; retaliateRate: number; changeTargetRate: number;
  allowAutoFeed: boolean; specialPerformance: boolean;
  /** the Script bonus per tier (pet_db Script: `if (.@i >= PET_INTIMATE_LOYAL) {...} else if (.@i >= PET_INTIMATE_CORDIAL) {...}`) */
  bonus: { cordial: ItemBonus[]; loyal: ItemBonus[] };
  support: PetSupport[];
  kind: PetKind;
  /** 2.4.0 legendary pets: "legendary" rows (pets.json rarity) fight with legendaryHitDamage and breathe fire (petskillattack) */
  rarity: PetRarity;
  /** reserved for mounts (a later release); nothing reads it in 2.4.0 */
  rideable: boolean;
  /** petskillattack "<skill>",lv,rate,bonusrate (buildin_petskillattack -> pd->a_skill), used by pet_attackskill */
  attacks: PetSkillAttack[];
};
export type PetRarity = "common" | "legendary";
export type PetSkillAttack = { skill: number; lv: number; rate: number; bonusRate: number };

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bonusList = (v: unknown): ItemBonus[] => (Array.isArray(v) ? v.filter((b) => b && typeof b.type === "string") : []);

/** A pets.json row with pet_db.yml's defaults filled in (pet.cpp PetDatabase::parseBodyNode). HungryDelay is in seconds in the
 *  yml (default 60); a value above 1000 is taken as already in ms. */
export function petRow(raw: Record<string, unknown>): PetDb {
  const hd = num(raw.hungryDelay, 60);
  const b = raw.bonus as unknown;
  let bonus: PetDb["bonus"] = { cordial: [], loyal: [] };
  // importer shape: `bonus` = the cordial block, `loyalBonus` = the loyal block
  if (Array.isArray(b)) bonus = { cordial: bonusList(b), loyal: bonusList(raw.loyalBonus ?? b) };
  else if (b && typeof b === "object") {
    const o = b as Record<string, unknown>;
    bonus = { cordial: bonusList(o.cordial), loyal: bonusList(o.loyal ?? o.cordial) };
  }
  const sup = raw.support as unknown;
  let support: PetSupport[];
  if (sup && typeof sup === "object" && !Array.isArray(sup) && ("skills" in sup || "bonuses" in sup)) { // importer shape (SupportScript parsed)
    const o = sup as { skills?: Record<string, unknown>[]; bonuses?: Record<string, unknown>[] };
    support = [
      ...(o.skills ?? []).map((k): PetSupport => ({ type: "skill", skill: k.skill as number, lv: num(k.level, 1), delay: num(k.delay, 60), hp: num(k.hpPercent, 100), sp: num(k.spPercent, 100) })),
      ...(o.bonuses ?? []).map((k): PetSupport => ({ type: "bonus", bonus: { type: String(k.type), value: k.value as number }, duration: num(k.duration, 10), delay: num(k.delay, 60), hp: 100, sp: 100 })),
    ];
  } else support = (Array.isArray(sup) ? sup : sup ? [sup] : []).map(supportRow).filter((s): s is PetSupport => !!s);
  const kind: PetKind = raw.kind === "battle" || raw.kind === "support" ? raw.kind : "companion";
  return {
    mobId: num(raw.mobId, 0), tameItem: num(raw.tameItem, 0), eggItem: num(raw.eggItem, 0), equipItem: num(raw.equipItem, 0), foodItem: num(raw.foodItem, 0),
    fullness: num(raw.fullness, 1), hungryDelay: hd > 1000 ? hd : hd * 1000, hungerIncrease: num(raw.hungerIncrease, 20),
    intimacyStart: num(raw.intimacyStart, 250), intimacyFed: num(raw.intimacyFed, 50), intimacyOverfed: num(raw.intimacyOverfed, -100),
    intimacyHungry: num(raw.intimacyHungry, -5), intimacyOwnerDie: num(raw.intimacyOwnerDie, -20),
    captureRate: num(raw.captureRate, 0), attackRate: num(raw.attackRate, 0), retaliateRate: num(raw.retaliateRate, 0),
    changeTargetRate: num(raw.changeTargetRate, 0), allowAutoFeed: raw.allowAutoFeed === true, specialPerformance: raw.specialPerformance !== false,
    bonus, support, kind,
    rarity: raw.rarity === "legendary" ? "legendary" : "common", rideable: raw.rideable === true,
    attacks: petAttacks(raw.support),
  };
}
function petAttacks(sup: unknown): PetSkillAttack[] {
  const a = sup && typeof sup === "object" && !Array.isArray(sup) ? (sup as { attacks?: Record<string, unknown>[] }).attacks : undefined;
  return (a ?? []).filter((k) => typeof k.skill === "number")
    .map((k) => ({ skill: k.skill as number, lv: num(k.level, 1), rate: num(k.rate, 0), bonusRate: num(k.bonusRate, 0) }));
}
function supportRow(s: unknown): PetSupport | undefined {
  if (!s || typeof s !== "object") return undefined;
  const o = s as Record<string, unknown>;
  const delay = num(o.delay, 60), hp = num(o.hp, 100), sp = num(o.sp, 100);
  if (o.type === "heal" || o.heal !== undefined) return { type: "heal", amount: num(o.amount ?? o.heal ?? o.lv, 100), delay, hp, sp };
  const skill = typeof o.skill === "string" ? o.skill : undefined;
  return skill ? { type: "skill", skill, lv: num(o.lv ?? o.level, 1), delay, hp, sp } : undefined;
}

// ---------- the pet row (struct s_pet) ----------
export type PetRow = {
  id: number; charId: number; mobId: number; name: string; renamed: boolean; level: number;
  hunger: number; intimacy: number; equip: number; autoFeed: boolean; incubate: boolean;
};

/** pet_create_egg / pet_catch_process_end -> intif_create_pet: a new pet starts with the db's IntimacyStart and hunger 100. */
export function newPet(db: PetDb, mobLevel: number, name: string): Omit<PetRow, "id" | "charId"> {
  return { mobId: db.mobId, name, renamed: false, level: mobLevel, hunger: PET_HUNGER.STUFFED, intimacy: db.intimacyStart, equip: 0, autoFeed: false, incubate: true };
}

export function petInfo(p: PetRow, db: PetDb): PetInfo {
  return { petId: p.id, mobId: p.mobId, name: p.name, renamed: p.renamed, level: p.level, hunger: p.hunger, intimacy: p.intimacy, accessory: p.equip, kind: db.kind, autoFeed: p.autoFeed };
}

/** pet_set_intimate: bounded to [PET_INTIMATE_NONE, PET_INTIMATE_MAX]. 0 = the pet is lost (the egg is deleted). */
export const capIntimacy = (v: number) => Math.max(PET_INTIMATE.NONE, Math.min(PET_INTIMATE.MAX, Math.trunc(v)));

// ---------- catching (pet_catch_process_end) ----------
/** The non-legacy capture rate (pet_legacy_formula: no), out of 10000: CaptureRate + (100 - hp%) * CaptureRate / 100, at least 1,
 *  then pet_catch_rate %. get_percentage = trunc(hp * 100 / maxHp). */
export function catchRate(capture: number, hp: number, maxHp: number, rate = PET_CONF.pet_catch_rate): number {
  const pct = maxHp > 0 ? Math.trunc((hp * 100) / maxHp) : 100;
  let r = capture + Math.trunc(((100 - pct) * capture) / 100);
  if (r < 1) r = 1;
  if (rate !== 100) r = Math.trunc((r * rate) / 100);
  return r;
}
/** Why pet_catch_process_end refuses before rolling (clif_pet_roulette false), or null to roll. */
export function catchBlock(o: { tameItem: number; db: PetDb | undefined; distance: number; bagFull: boolean }): string | null {
  if (!o.db) return "That monster can't be tamed.";
  if (o.db.tameItem !== o.tameItem) return "That taming item doesn't work on this monster.";
  if (o.distance > PET_CONF.pet_distance_check) return "The monster is too far away.";
  if (o.bagFull) return "Your bag is full.";
  return null;
}

// ---------- hunger (pet_hungry) ----------
export type HungerTick = { hunger: number; intimacy: number; interval: number; starving: boolean };
/** One pet_hungry timer: hunger -= Fullness; below 0 it stays 0, intimacy += IntimacyHungry and the next check is 20 s later;
 *  else the next one is HungryDelay * pet_hungry_delay_rate later. */
export function hungerTick(p: Pick<PetRow, "hunger" | "intimacy">, db: PetDb): HungerTick {
  let interval = Math.trunc((db.hungryDelay * PET_CONF.pet_hungry_delay_rate) / 100), hunger = p.hunger - db.fullness, intimacy = p.intimacy;
  let starving = false;
  if (hunger < PET_HUNGER.NONE) {
    hunger = PET_HUNGER.NONE;
    intimacy = capIntimacy(intimacy + db.intimacyHungry);
    interval = PET_CONF.starving_interval_ms;
    starving = true;
  }
  return { hunger, intimacy, interval: Math.max(interval, 1), starving };
}
/** pet_hungry: autofeed runs when it's on and hunger <= feature_pet_autofeed_rate. */
export const autoFeedDue = (p: Pick<PetRow, "hunger" | "autoFeed">, db: PetDb) => db.allowAutoFeed && p.autoFeed && p.hunger <= PET_CONF.feature_pet_autofeed_rate;

/** pet_food: an over-fed pet (hunger > SATISFIED) gets IntimacyOverfed; else IntimacyFed * pet_friendly_rate %, halved (at least 1)
 *  above NEUTRAL. Hunger += HungerIncrease, capped at STUFFED. */
export function feed(p: Pick<PetRow, "hunger" | "intimacy">, db: PetDb): { hunger: number; intimacy: number; overfed: boolean } {
  let intimacy: number;
  const overfed = p.hunger > PET_HUNGER.SATISFIED;
  if (overfed) intimacy = capIntimacy(p.intimacy + db.intimacyOverfed);
  else {
    let k = PET_CONF.pet_friendly_rate !== 100 ? Math.trunc((db.intimacyFed * PET_CONF.pet_friendly_rate) / 100) : db.intimacyFed;
    if (p.hunger > PET_HUNGER.NEUTRAL) k = Math.max(1, Math.trunc(k / 2));
    intimacy = capIntimacy(p.intimacy + k);
  }
  return { hunger: Math.min(p.hunger + db.hungerIncrease, PET_HUNGER.STUFFED), intimacy, overfed };
}
/** pc_dead: the owner's pet loses IntimacyOwnerDie. */
export const ownerDied = (intimacy: number, db: PetDb) => capIntimacy(intimacy + db.intimacyOwnerDie);

// ---------- bonus (status_calc_pc "Pet Bonus": the pet_db Script) ----------
/** The Script's bonuses for this intimacy: the loyal block at PET_INTIMATE_LOYAL, the cordial one at PET_INTIMATE_CORDIAL, none
 *  below, and none while starving (pet_hungry sets hunger 0: our tie-in of "hungry pets stop helping" from the draft). */
export function petBonuses(db: PetDb, intimacy: number, hunger: number): ItemBonus[] {
  if (hunger <= PET_HUNGER.NONE) return [];
  if (intimacy >= PET_INTIMATE.LOYAL) return db.bonus.loyal;
  if (intimacy >= PET_INTIMATE.CORDIAL) return db.bonus.cordial;
  return [];
}

// ---------- battle support (pet_target_check / status_calc_pet rate_fix) ----------
/** status_calc_pet: rate_fix = 1000 * (intimacy - pet_support_min_friendly) / (1000 - pet_support_min_friendly) + 500
 *  (rAthena's curve, 500..1500 over 900..1000; kept for reference, supportRate no longer uses it). */
export const rateFix = (intimacy: number) =>
  Math.trunc((1000 * (intimacy - PET_CONF.pet_support_min_friendly)) / (1000 - PET_CONF.pet_support_min_friendly)) + 500;
/** OUR DEVIATION from rAthena (which needs intimacy >= 900 and scales 0.5x..1.5x above it): the rate multiplier (per mille) of the
 *  intimacy band, so a more intimate pet still helps more: neutral 500, cordial 750, loyal 1000 of the pets.json rates; 0 below neutral. */
export const supportBand = (intimacy: number) =>
  intimacy >= PET_INTIMATE.LOYAL ? 1000 : intimacy >= PET_INTIMATE.CORDIAL ? 750 : intimacy >= PET_CONF.our_support_min_friendly ? 500 : 0;
/** pet_target_check: the chance (out of 10000) that the pet takes the target, or 0 when it can't help: intimacy below
 *  our_support_min_friendly (rAthena: 900; ours: neutral, see above), starving (hunger 0), the target of its own species, or a dead
 *  master (pet_master_dead: no). `retaliate` = type 1 (the master was attacked: RetaliateRate), else AttackRate (the master attacked). */
export function supportRate(db: PetDb, p: Pick<PetRow, "intimacy" | "hunger">, o: { retaliate: boolean; targetMobId: number; masterDead: boolean }): number {
  if (p.intimacy < PET_CONF.our_support_min_friendly || p.hunger <= PET_HUNGER.NONE || o.targetMobId === db.mobId) return 0;
  if (!PET_CONF.pet_master_dead && o.masterDead) return 0;
  const base = o.retaliate ? db.retaliateRate : db.attackRate;
  let rate = Math.trunc((base * supportBand(p.intimacy)) / 1000);
  if (base > 0 && rate <= 0) rate = 1;
  return rate;
}

/** A battle pet's hit when it connects (0 when its own attack missed/was 0). Our balance rule (PET_DRAFT.md: ~15-25% of a player's
 *  output): 15% of the owner's swing on the same target plus a tenth of the pet's own mob ATK as flavour, capped at 25% of the
 *  owner's swing, never below max(pet level, 2) so a weak owner's pet still shows a number. Lv5 owner (25): 6, Lv20 (80): 15,
 *  Lv40 (200): 33 with a 30-ATK pet. */
export function petHitDamage(petDmg: number, ownerDmg: number, petLevel = 1): number {
  if (petDmg <= 0) return 0;
  const o = Math.max(ownerDmg, 1), floor = Math.max(petLevel, 2);
  return Math.max(floor, Math.min(Math.trunc(o * 0.15 + petDmg / 10), Math.trunc(o / 4)));
}

// ---------- legendary pets (2.4.0, owner's request) ----------
/** Our balance numbers for a legendary battle pet: clearly above a common battle pet (petHitDamage: 15 % of the owner's swing,
 *  cap 25 %) but never the main damage source. Normal hit: 30 % of the owner's swing on the same target + a twentieth of the pet's
 *  own mob ATK, capped at 38 % of the owner's swing. Fire breath (petskillattack, replaces a swing when it fires): 55 % of the owner's
 *  swing on EACH target in the splash, through the Fire row of the element table (attr_fix: x1.5 on Earth, x0.25 on Fire 1 ...),
 *  capped at 80 % of that swing before the element. */
export const LEGENDARY_PET = { hitShare: 0.3, hitCap: 0.38, atkDiv: 20, breathShare: 0.55, breathCap: 0.8, breathElement: "Fire" } as const;
/** A legendary pet's normal hit (0 when its own attack missed). Floor 2 (a number is always shown); no pet-level floor, since the
 *  legendary species is a high-level monster (Lv86) and would otherwise out-hit a low-level owner. */
export function legendaryHitDamage(petDmg: number, ownerDmg: number): number {
  if (petDmg <= 0) return 0;
  const o = Math.max(ownerDmg, 1);
  return Math.max(2, Math.min(Math.trunc(o * LEGENDARY_PET.hitShare + petDmg / LEGENDARY_PET.atkDiv), Math.trunc(o * LEGENDARY_PET.hitCap)));
}
/** pet_attackskill (pet.cpp): rnd_chance(rate + intimacy * bonusrate / 1000, 100), only while the pet can act. Percent, 0..100. */
export const breathChance = (a: Pick<PetSkillAttack, "rate" | "bonusRate">, intimacy: number) =>
  Math.max(0, Math.min(100, a.rate + Math.trunc((intimacy * a.bonusRate) / 1000)));
/** The fire breath's damage on one target before the element: our share of the owner's swing on that target (see LEGENDARY_PET),
 *  plus the pet's MATK / 20, at least 1. The caller runs it through attrFix(dmg, "Fire", target element, level). */
export function breathDamage(ownerDmg: number, petMatk: number): number {
  const o = Math.max(ownerDmg, 1);
  return Math.max(1, Math.min(Math.trunc(o * LEGENDARY_PET.breathShare + petMatk / 20), Math.trunc(o * LEGENDARY_PET.breathCap)));
}

// ---------- support skills (pet_heal_timer / pet_skill_support_timer) ----------
/** Whether the owner's numbers allow the support now: alive and at or below both thresholds (get_percentage). Otherwise the
 *  timer waits (rate > 10 ? rate : 10) * 100 ms, rate = the percentage that blocked it. */
export function supportReady(s: Pick<PetSupport, "hp" | "sp">, o: { dead: boolean; hp: number; maxHp: number; sp: number; maxSp: number }): { ok: true } | { ok: false; waitMs: number } {
  if (o.dead) return { ok: false, waitMs: 1000 };
  const sp = o.maxSp > 0 ? Math.trunc((o.sp * 100) / o.maxSp) : 100, hp = o.maxHp > 0 ? Math.trunc((o.hp * 100) / o.maxHp) : 100;
  if (sp > s.sp) return { ok: false, waitMs: Math.max(sp, 10) * 100 };
  if (hp > s.hp) return { ok: false, waitMs: Math.max(hp, 10) * 100 };
  return { ok: true };
}

/** skill_calc_heal (skill.cpp) for AL_HEAL cast by the pet: (level + INT) / 8 * (4 + 8 * skill level). Our floor: at least twice
 *  (4 + 8 * skill level), so a level-1 support pet (0 by the formula) still mends its owner a little. */
export const petHealAmount = (level: number, int: number, lv: number) => Math.max(Math.trunc((level + int) / 8) * (4 + 8 * lv), 2 * (4 + 8 * lv));

// ---------- names ----------
/** pet_change_name: 1-23 characters, no control characters. */
export function validPetName(name: string): string | null {
  const n = String(name ?? "").trim();
  if (!n || n.length > PET_NAME_MAX || /[\u0000-\u001f]/.test(n)) return null;
  return n;
}

/** clif_send_petdata(CHANGESTATEPET_PERFORMANCE): the performance number, 1-3 by intimacy, 4 = the special one at loyal
 *  (pet.cpp pet_performance / clif.cpp: rnd_value(1, 1 + intimacy level) with SpecialPerformance). */
export function performance(intimacy: number, special: boolean, r: () => number = Math.random): number {
  const tier = intimacy >= PET_INTIMATE.LOYAL ? (special ? 4 : 3) : intimacy >= PET_INTIMATE.CORDIAL ? 3 : intimacy >= PET_INTIMATE.NEUTRAL ? 2 : 1;
  return 1 + Math.floor(r() * tier);
}
