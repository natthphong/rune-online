// Status changes (sc_data): the abnormal statuses and buffs a unit carries, re-implemented from rAthena (Renewal) src/map/status.cpp
// (status_get_sc_def, status_change_start / _post_delay, status_change_end, status_change_timer, status_calc_* of the statuses
// below), db/re/status.yml (the per-status flags / Fail / EndOnStart / EndReturn lists) and db/re/skill_db.yml (the default durations,
// DurationLookup). Pure: this file has no clock, no randomness of its own (an Rng is passed) and no knowledge of the room. The room
// side is server/src/status.ts (timers on the 20 Hz tick, stopping walks / attacks / casts, the owner's list, the visible options).
//
// What is modelled (the statuses our first-job skills, cards and monster skills use):
//   abnormal  Stone (+ StoneWait, the 2-phase petrify), Freeze, Stun, Sleep, Poison, Curse, Silence, Blind, Bleeding
//   buffs     Provoke, Endure, Concentrate (Improve Concentration), Angelus, Blessing, IncreaseAgi, DecreaseAgi
// Everything else status.yml lists is simply absent from ScKey: a Fail / EndOnStart name that is not one of ours can never be active.
import { STAT_KEYS, type Element, type Stats } from "./data.ts";
import { MD } from "./mode.ts";
import type { Status } from "./status.ts";

export const SC_KEYS = [
  "Stone", "StoneWait", "Freeze", "Stun", "Sleep", "Poison", "Curse", "Silence", "Blind", "Bleeding",
  "Provoke", "Endure", "Concentrate", "Angelus", "Blessing", "IncreaseAgi", "DecreaseAgi",
  // 2.5.0: the 2nd-job and transcendent buffs / debuffs (status.yml names)
  "TwoHandQuicken", "SpearQuicken", "Adrenaline", "Overthrust", "WeaponPerfection", "Gloria", "Impositio", "Magnificat",
  "FireWeapon", "WaterWeapon", "WindWeapon", "EarthWeapon", "Aspersio", "EncPoison", "ExplosionSpirits", "AssnCros", "Humming",
  "WindWalk", "Concentration", "AuraBlade", "StripWeapon", "StripArmor", "Ankle", "Kyrie", "Aeterna", "AutoGuard", "Sight",
  "Whistle", "Fortune", "AppleIdun", "MagicPower", "Assumptio",
] as const;
export type ScKey = (typeof SC_KEYS)[number];
export const isScKey = (k: string): k is ScKey => (SC_KEYS as readonly string[]).includes(k);

/** e_status_change_start_flags (status.hpp), the ones used here. */
export const SCSTART = { NONE: 0, NOAVOID: 1, NOICON: 2, NOTICKDEF: 4, NORATEDEF: 8 } as const;

/** One row of status.yml. `lookup` = DurationLookup's skill Duration2 (skill_get_time2 of level 7, what a card's bAddEff uses, pc_bonus_addeff). */
type ScDef = {
  lookup: number; // ms (0 = a buff: its skill gives the duration)
  opt1?: true; // Opt1 (Stone / StoneWait / Freeze / Stun / Sleep): only one at a time, shown on the unit
  noMove?: true; noCast?: true; noAttack?: true; // States: NoMove / NoCast / NoAttack (sc->cant)
  bossResist?: true; // Flags: BossResist (MD_STATUSIMMUNE units ignore it unless NOAVOID)
  removeOnDamaged?: true; stopAttacking?: true; stopCasting?: true;
  debuff?: true; // Flags: Debuff
  fail?: readonly ScKey[]; endOnStart?: readonly ScKey[]; endReturn?: readonly ScKey[];
};
export const SC_DB: Readonly<Record<ScKey, ScDef>> = {
  Stone: { lookup: 17000, opt1: true, noMove: true, noCast: true, noAttack: true, bossResist: true, removeOnDamaged: true, stopAttacking: true, stopCasting: true,
    fail: ["Freeze", "Stun", "Sleep"], endReturn: ["StoneWait", "Stone"] },
  StoneWait: { lookup: 17000, opt1: true, noCast: true, noAttack: true, bossResist: true, stopAttacking: true,
    fail: ["Freeze", "Stun", "Sleep"], endReturn: ["StoneWait", "Stone"] },
  Freeze: { lookup: 27000, opt1: true, noMove: true, noCast: true, noAttack: true, bossResist: true, removeOnDamaged: true, stopAttacking: true, stopCasting: true,
    fail: ["Stone", "StoneWait", "Freeze", "Stun", "Sleep"] },
  Stun: { lookup: 4500, opt1: true, noMove: true, noCast: true, noAttack: true, bossResist: true, stopAttacking: true, stopCasting: true, fail: ["Stun"] },
  Sleep: { lookup: 18000, opt1: true, noMove: true, noCast: true, noAttack: true, bossResist: true, removeOnDamaged: true, stopAttacking: true, stopCasting: true, fail: ["Sleep"] },
  Poison: { lookup: 18000, bossResist: true, stopAttacking: true, fail: ["Poison"] },
  Curse: { lookup: 18000, bossResist: true, fail: ["Curse"] },
  Silence: { lookup: 18000, noCast: true, bossResist: true, stopCasting: true, fail: ["Silence"] },
  Blind: { lookup: 18000, bossResist: true, fail: ["Blind"] },
  Bleeding: { lookup: 108000, bossResist: true, fail: [] },
  Provoke: { lookup: 0, bossResist: true, debuff: true, endOnStart: ["Freeze", "Stone", "Sleep"] },
  Endure: { lookup: 0 },
  Concentrate: { lookup: 0 },
  Angelus: { lookup: 0 },
  Blessing: { lookup: 0, bossResist: true },
  IncreaseAgi: { lookup: 0, endOnStart: ["DecreaseAgi"] },
  DecreaseAgi: { lookup: 0, bossResist: true, debuff: true, endOnStart: ["IncreaseAgi"] },
  // 2.5.0 (db/re/status.yml): the endows end each other (EndOnStart), the quickens are plain buffs
  TwoHandQuicken: { lookup: 0, endOnStart: ["DecreaseAgi"] }, SpearQuicken: { lookup: 0, endOnStart: ["DecreaseAgi"] },
  Adrenaline: { lookup: 0, endOnStart: ["DecreaseAgi"] }, Overthrust: { lookup: 0 }, WeaponPerfection: { lookup: 0 },
  Gloria: { lookup: 0 }, Impositio: { lookup: 0 }, Magnificat: { lookup: 0 },
  FireWeapon: { lookup: 0, endOnStart: ["WaterWeapon", "WindWeapon", "EarthWeapon", "Aspersio", "EncPoison"] },
  WaterWeapon: { lookup: 0, endOnStart: ["FireWeapon", "WindWeapon", "EarthWeapon", "Aspersio", "EncPoison"] },
  WindWeapon: { lookup: 0, endOnStart: ["FireWeapon", "WaterWeapon", "EarthWeapon", "Aspersio", "EncPoison"] },
  EarthWeapon: { lookup: 0, endOnStart: ["FireWeapon", "WaterWeapon", "WindWeapon", "Aspersio", "EncPoison"] },
  Aspersio: { lookup: 0, endOnStart: ["FireWeapon", "WaterWeapon", "WindWeapon", "EarthWeapon", "EncPoison"] },
  EncPoison: { lookup: 0, endOnStart: ["FireWeapon", "WaterWeapon", "WindWeapon", "EarthWeapon", "Aspersio"] },
  ExplosionSpirits: { lookup: 0 }, AssnCros: { lookup: 0 }, Humming: { lookup: 0 }, WindWalk: { lookup: 0 },
  Concentration: { lookup: 0 }, AuraBlade: { lookup: 0 },
  StripWeapon: { lookup: 0, debuff: true }, StripArmor: { lookup: 0, debuff: true },
  Ankle: { lookup: 0, noMove: true, debuff: true },
  Kyrie: { lookup: 0 }, Aeterna: { lookup: 0, debuff: true }, AutoGuard: { lookup: 0 }, Sight: { lookup: 0 },
  Whistle: { lookup: 0 }, Fortune: { lookup: 0 }, AppleIdun: { lookup: 0 }, MagicPower: { lookup: 0 }, Assumptio: { lookup: 0 },
};
/** The endow statuses -> the weapon element they give (status_calc_attack_element: SC_FIREWEAPON .. SC_ENCPOISON, status.cpp). */
export const ENDOW_ELEMENT: Partial<Record<ScKey, Element>> = {
  FireWeapon: "Fire", WaterWeapon: "Water", WindWeapon: "Wind", EarthWeapon: "Earth", Aspersio: "Holy", EncPoison: "Poison",
};
const OPT1: readonly ScKey[] = SC_KEYS.filter((k) => SC_DB[k].opt1);
/** status_get_sc_interval (status.cpp:9585): statuses that act every N ms for their whole duration. */
export const SC_INTERVAL: Partial<Record<ScKey, number>> = { Poison: 1000, Stone: 5000, Bleeding: 10000 };
/** Statuses that are bad for their carrier (the client draws them red). */
export const isDebuff = (k: ScKey) => !!SC_DB[k].opt1 || !!SC_DB[k].debuff || ["Poison", "Curse", "Silence", "Blind", "Bleeding", "Provoke", "DecreaseAgi"].includes(k);

/** struct status_change_entry: val1 is the skill level (or 7 for an item / card), val2..val4 per status; `due` = when its timer fires
 *  (the end for a plain status, the next interval step for Poison / Stone / Bleeding), Infinity = no timer. */
export type ScEntry = { type: ScKey; val1: number; val2: number; val3: number; val4: number; due: number; src?: string };

/** struct status_change: the statuses a unit carries. */
export class ScData {
  readonly map = new Map<ScKey, ScEntry>();
  get(t: ScKey) { return this.map.get(t); }
  has(t: ScKey) { return this.map.has(t); }
  get size() { return this.map.size; }
  /** sc->opt1: the Opt1 status in effect (only one can be). */
  opt1(): ScKey | undefined { return OPT1.find((k) => this.map.has(k)); }
  /** sc->cant (status_calc_state): what the active statuses forbid. */
  cant() {
    const c = { move: false, cast: false, attack: false };
    for (const k of this.map.keys()) { const d = SC_DB[k]; if (d.noMove) c.move = true; if (d.noCast) c.cast = true; if (d.noAttack) c.attack = true; }
    return c;
  }
}

// ---------- resistance (status_get_sc_def) ----------
/** What the resistance and start code read of a unit (status_data + the unit's kind / level / item resistances). */
export type ScUnit = Pick<Status, "stats" | "mdef" | "mode" | "race" | "element"> & {
  isPlayer: boolean; level: number; sc: ScData; resEff?: Partial<Record<ScKey, number>>; // bResEff: 10000 = immune
};
export type Rng = () => number;
const t = Math.trunc;
/** rnd() % 10000 < rate */
const roll = (r: Rng, rate: number) => Math.floor(r() * 10000) < rate;
/** conf/battle/status.conf: pc_status_def_rate / mob_status_def_rate 100, pc_max_status_def / mob_max_status_def 100 (%). */
export const SC_CONF = { pc_sc_def_rate: 100, mob_sc_def_rate: 100, pc_max_sc_def: 100, mob_max_sc_def: 100 };

/** battle_check_undead (undead_detect_type 0, battle.cpp): the Undead element. */
export const undeadFlag = (u: Pick<ScUnit, "element">) => u.element === "Undead";

/**
 * status_get_sc_def (status.cpp:9620), RENEWAL: the rate a status lands with after the target's resistance and the duration left, as
 * `rate` (0..10000) and `tick` in, or 0 when it failed (the 0..10000 roll is made here). srcLevel = the source's base level
 * (levelAdv = floor(max(0, srcLv - tgtLv)^2 / 5) * 100 lowers the resistance of a weak target). Only the types listed in the switch
 * resist; any other status is a plain `rnd() % 10000 < rate`.
 */
export function scGetDef(type: ScKey, tgt: ScUnit, srcLevel: number, rate: number, tick: number, flag: number, r: Rng, c = SC_CONF): number {
  const s = tgt.stats;
  const levelAdv = t(Math.max(0, srcLevel - tgt.level) ** 2 / 5) * 100;
  let scDef = 0, tickDef = -1, tickDef2 = 0, scDef2 = 0;
  switch (type) {
    case "Poison": scDef = s.vit * 100 - levelAdv; tickDef2 = -2000; break;
    case "Stun": scDef = s.vit * 100 - levelAdv; tickDef2 = -500; break;
    case "Silence": scDef = s.int * 100 - levelAdv; tickDef2 = -2000; break;
    case "Bleeding": scDef = s.agi * 100 - levelAdv; tickDef2 = -12000; break;
    case "Sleep": scDef = s.agi * 100 - levelAdv; tickDef2 = -2000; break;
    case "StoneWait": scDef = tgt.mdef * 100 - levelAdv; tickDef2 = -3000; break;
    case "Freeze": scDef = tgt.mdef * 100 - levelAdv; tickDef2 = -3000; break;
    case "Curse":
      if (s.luk === 0) return 0; // special property: immunity when luk is zero
      scDef = s.luk * 100 - levelAdv; tickDef2 = -2000; break;
    case "Blind": scDef = s.int * 100 - levelAdv; tickDef2 = -2000; break;
    case "DecreaseAgi":
      if (tgt.isPlayer) tick = t(tick / 2); // half duration for players
      scDef2 = tgt.mdef * 100; break;
    default: // an effect that cannot be reduced (a buff, Stone itself)
      return roll(r, rate) ? (tick || 1) : 0;
  }
  const rateMul = tgt.isPlayer ? c.pc_sc_def_rate : c.mob_sc_def_rate, maxDef = (tgt.isPlayer ? c.pc_max_sc_def : c.mob_max_sc_def) * 100;
  if (rateMul !== 100) { scDef = t((scDef * rateMul) / 100); scDef2 = t((scDef2 * rateMul) / 100); }
  scDef = Math.min(maxDef, Math.max(0, scDef)); scDef2 = Math.min(maxDef, Math.max(0, scDef2));
  if (rateMul !== 100) { tickDef = t((tickDef * rateMul) / 100); tickDef2 = t((tickDef2 * rateMul) / 100); }
  if (tickDef === -1) tickDef = scDef; // when tick_def is not set the reduction is the same for both
  const res = tgt.resEff?.[type] ?? 0;
  if (!(flag & SCSTART.NORATEDEF)) {
    rate -= t((rate * scDef) / 10000);
    rate -= scDef2;
    if (res) rate -= t((rate * res) / 10000); // item resistance (bResEff): only the rate...
    if (rate > 0 && rate % 10 !== 0) rate += 10 - (rate % 10); // Aegis accuracy
  }
  if (rate < 10000 && (rate <= 0 || !roll(r, rate))) return 0;
  const minDuration = 1;
  if (flag & SCSTART.NOTICKDEF) return Math.max(tick, minDuration);
  tick -= t((tick * tickDef) / 10000);
  if (res) tick -= t((tick * res) / 10000); // ...and, in Renewal, the duration too
  tick -= tickDef2;
  return Math.max(tick, minDuration);
}

// ---------- start ----------
export type StartOpts = {
  type: ScKey;
  tgt: ScUnit;
  srcLevel: number; // the source's base level (status_get_lv(src))
  rate: number; // 0..10000 (sc_start's 1..100 x 100)
  val1: number; val2?: number; val3?: number; val4?: number;
  duration: number; // ms
  flag?: number; delay?: number; // SCSTART_*; delay = StoneWait's time before the petrify (status_change_start's `delay`)
  now: number; r: Rng;
  src?: string; // the unit that applied it (val2 of Poison / Stone Curse in rAthena is the source's id: kept on the entry)
  paramBonus?: Stats; // Concentrate: the equipment / card stat bonus that must not count in the percentage (sd->indexed_bonus.param_bonus)
};
/** "started": the status is (now) active, "nochange": rAthena returned true without giving it (a stronger one runs, an EndReturn /
 *  Blessing cure took the place), "failed": immune / resisted / a Fail status runs. `ended` = the statuses it removed. */
export type StartResult = { kind: "started" | "nochange" | "failed"; ended: ScKey[]; entry?: ScEntry; tick?: number };

/**
 * status_change_start (status.cpp:10152) + status_change_start_post_delay (10303) for the statuses above, with the val setup of the
 * big switch (10845-11700). Mutates `tgt.sc`. The Stone wait, the Blessing cures and the Opt1 replacement are handled here; stopping
 * the unit, the calc and the option update are the caller's.
 */
export function startSc(o: StartOpts): StartResult {
  const { type, tgt } = o, sc = tgt.sc, db = SC_DB[type], flag = o.flag ?? 0, ended: ScKey[] = [];
  const fail = (): StartResult => ({ kind: "failed", ended });
  const same = (): StartResult => ({ kind: "nochange", ended });
  // boss resistance: MD_STATUSIMMUNE units ignore a BossResist status unless it is forced (SCSTART_NOAVOID)
  if ((tgt.mode & MD.STATUSIMMUNE) && !(flag & SCSTART.NOAVOID) && db.bossResist) return fail();
  const end = (k: ScKey) => { if (sc.map.delete(k)) ended.push(k); };
  // EndReturn: ending any of them takes the place of giving the status
  if (db.endReturn) {
    let removed = false;
    for (const k of db.endReturn) if (sc.has(k)) { end(k); removed = true; }
    if (removed) return { kind: "nochange", ended };
  }
  for (const k of db.fail ?? []) if (sc.has(k)) return fail();
  let tick = o.duration, val3 = o.val3 ?? 0, val4 = o.val4 ?? 0;
  const val1 = o.val1, delay = o.delay ?? 0;
  if (!(flag & (SCSTART.NOAVOID))) {
    tick = scGetDef(type, tgt, o.srcLevel, o.rate, tick, flag, o.r);
    if (!tick) return fail();
  }
  // type-specific checks before the delay (10238-10260)
  if (type === "Stone" || type === "StoneWait" || type === "Freeze") {
    if (!(flag & SCSTART.NOAVOID) && undeadFlag(tgt)) return fail(); // Undead are immune to Freeze / Stone (also race Undead with undead_detect_type 0: the element covers ours)
    if (type === "StoneWait") { val3 = Math.max(1, tick - delay); tick = delay; } // the delay is the time until Stone kicks in; val3 the petrify time
  }
  // post_delay: hardcoded Opt1 stacking, EndOnStart, Blessing's cures
  if (tgt.sc.opt1() && db.opt1) for (const k of OPT1) end(k);
  for (const k of db.endOnStart ?? []) end(k);
  if (type === "Blessing" && tgt.isPlayer) {
    if (sc.has("Curse")) { end("Curse"); return { kind: "nochange", ended }; } // end Curse and give no stat boost
    if (sc.has("Stone")) { end("Stone"); return { kind: "nochange", ended }; }
  }
  const old = sc.get(type);
  if (old) {
    if (type === "Endure") { if (old.val4 && !val4) return same(); if (old.val1 > val1) return same(); } // infinite Endure is not overridden
    else if (old.val1 > val1) return same(); // a stronger level of the same status keeps running ("return true")
  }
  // val setup (status_change_start_post_delay's big switch)
  let val2 = o.val2 ?? 0;
  switch (type) {
    case "IncreaseAgi": case "DecreaseAgi": val2 = 2 + val1; break; // agi change
    case "Endure": val2 = 7; break; // hit count
    case "Blessing": val2 = tgt.isPlayer || (!undeadFlag(tgt) && tgt.race !== "Demon") ? val1 : 0; break; // 0 -> half stat
    case "Concentrate": val2 = 2 + val1; val3 = o.paramBonus?.agi ?? 0; val4 = o.paramBonus?.dex ?? 0; break;
    case "Angelus": val2 = 5 * val1; break; // def increase
    case "Provoke": val2 = 2 + 3 * val1; val3 = 5 + 5 * val1; break; // atk increase, def reduction
    // 2.5.0 (status_change_start_post_delay, status.cpp:11048-11630, RENEWAL)
    case "TwoHandQuicken": val2 = 300; break; // aspd rate (pre-Renewal); RENEWAL_ASPD reads the fixed +7 % below
    case "Adrenaline": val3 = val2 ? 300 : 200; break; // val2 = cast on self
    case "Overthrust": val3 = val2 ? 5 * val1 : val1 > 4 ? 15 : val1 > 2 ? 10 : 5; break; // power increase (party members get less)
    case "Impositio": val2 = 5 * val1; break; // WATK / MATK increase
    case "ExplosionSpirits": val2 = 75 + 25 * val1; break; // crit bonus (tenths)
    case "AssnCros": val2 = val1 < 10 ? val1 * 2 - 1 : 20; break; // ASPD increase
    case "Humming": val2 = 4 * val1; break; // hit increase
    case "WindWalk": val2 = t((val1 + 1) / 2); break; // flee bonus 1/1/2/2/3...
    case "Concentration": val2 = 5 + val1 * 2; val3 = 10 * val1; val4 = 5 + val1 * 2; break; // atk %, hit, def reduction %
    case "AuraBlade": val2 = 20 * val1; break; // flat damage (battle.cpp: SC_AURABLADE skill_lv * 20 in Renewal ATK)
    case "StripWeapon": val2 = tgt.isPlayer ? 0 : 25; break; // monsters: WATK -25 %
    case "Whistle": val2 = 18 + 2 * val1; val3 = t((val1 + 1) / 2) * 10; break; // flee, perfect dodge (tenths)
    case "Fortune": val2 = val1 * 10; break; // critical (tenths)
    case "AppleIdun": val2 = val1 < 10 ? 9 + val1 : 20; break; // max HP %
    case "MagicPower": val3 = 5 * val1; break; // MATK % (Renewal)
    case "Kyrie": val3 = t(val1 / 2) + 5; break; // hits it blocks; val2 (the HP it absorbs, MaxHP x (lv x 2 + 10) %) comes from the caller
    case "AutoGuard": { val2 = 0; for (let i = 0; i < val1; i++) { const q = 5 - t(i / 2); val2 += q < 0 ? 1 : q; } break; } // block chance %
    case "StripArmor": val2 = tgt.isPlayer ? 0 : 40; break; // monsters: VIT -40 %
  }
  // timers: an interval status first fires after its interval, with the remaining time in val4 (tick_time / val4 = tick - tick_time)
  const interval = SC_INTERVAL[type];
  let due = tick >= 0 ? o.now + tick : Infinity;
  if (interval) { due = o.now + interval; val4 = tick - interval; }
  const entry: ScEntry = { type, val1, val2, val3, val4, due, src: o.src };
  sc.map.set(type, entry);
  return { kind: "started", ended, entry, tick };
}

/** status_change_timer's tail (status.cpp:15218): after an interval status acted, `due` moves to the next step while at least 100 ms
 *  remain (val4), else it is over. True = the status ends now. */
export function intervalNext(e: ScEntry, now: number): boolean {
  const interval = SC_INTERVAL[e.type]!;
  if (e.val4 >= 100) { e.due = now + Math.min(e.val4, interval); e.val4 -= interval; return false; }
  return true;
}
/** Milliseconds left on a status (an interval one: the time to its next step plus the remainder in val4). */
export function scRemaining(e: ScEntry, now: number): number {
  if (e.due === Infinity) return Infinity;
  return Math.max(0, e.due - now) + (SC_INTERVAL[e.type] ? Math.max(0, e.val4) : 0);
}

// ---------- the interval effects (status_change_timer) ----------
/** SC_POISON (status.cpp:14246): players lose 2 + MaxHP * 3 / 200, monsters 2 + MaxHP / 200 per second, never below 25 % HP. 0 = none. */
export function poisonDamage(isPlayer: boolean, hp: number, maxHp: number): number {
  const dmg = isPlayer ? 2 + t((maxHp * 3) / 200) : 2 + t(maxHp / 200);
  return hp > Math.max(t(maxHp / 4), dmg) ? dmg : 0;
}
/** SC_STONE (14237): while above 25 % HP, 1 % of MaxHP (status_percent_damage(.., -1, 0, false): never kills). */
export function stoneDamage(hp: number, maxHp: number): number {
  if (hp <= t(maxHp / 4)) return 0;
  return Math.min(hp - 1, Math.max(1, t(maxHp / 100)));
}
/** SC_BLEEDING (14255): rnd() % 600 + 200 per 10 s; a monster never dies of it. */
export function bleedingDamage(isPlayer: boolean, hp: number, r: Rng): number {
  const dmg = Math.floor(r() * 600) + 200;
  return !isPlayer && dmg >= hp ? hp - 1 : dmg;
}

// ---------- calc (status_calc_*) ----------
/** status_calc_str / agi / int / dex / luk for the statuses above: Blessing (+val2, or half when val2 is 0), Concentrate
 *  (agi += (agi - val3) * val2 / 100, dex with val4), IncreaseAgi (+val2), DecreaseAgi (-val2), Curse (luk 0). Capped to [0, USHRT_MAX]. */
export function scStats(s: Stats, sc: ScData | undefined): Stats {
  if (!sc || sc.size === 0) return s;
  const o = { ...s }, bl = sc.get("Blessing"), co = sc.get("Concentrate");
  if (bl) for (const k of ["str", "int", "dex"] as const) o[k] += bl.val2 ? bl.val2 : -t(o[k] / 2);
  if (co) { o.agi += t(((o.agi - co.val3) * co.val2) / 100); o.dex += t(((o.dex - co.val4) * co.val2) / 100); }
  const inc = sc.get("IncreaseAgi"), dec = sc.get("DecreaseAgi");
  if (inc) o.agi += inc.val2;
  if (dec) o.agi -= dec.val2;
  if (sc.has("Curse")) o.luk = 0;
  if (sc.has("Gloria")) o.luk += 30; // status_calc_luk
  const sa = sc.get("StripArmor");
  if (sa?.val2) o.vit -= t((o.vit * sa.val2) / 100); // status_calc_vit (non-players)
  for (const k of STAT_KEYS) o[k] = Math.min(65535, Math.max(0, o[k]));
  return o;
}
/** status_calc_aspd (RENEWAL_ASPD, status.cpp:8236-8346) for players: IncreaseAgi adds val1 to the ASPD percent (aspd_rate2 + bonus). */
export function scAspdBonus(sc: ScData | undefined) {
  if (!sc) return 0;
  // status_calc_aspd(fixed): Two-Hand Quicken / Spear Quicken / Adrenaline Rush give the fixed +7 (status.cpp:8249), Impressive Riff
  // its val2 when larger (8257); the non-fixed part (Increase AGI val1) adds on top
  let fixed = 0;
  if (sc.has("TwoHandQuicken") || sc.has("SpearQuicken") || sc.has("Adrenaline")) fixed = 7;
  const ac = sc.get("AssnCros");
  if (ac && fixed < ac.val2) fixed = ac.val2;
  return (sc.get("IncreaseAgi")?.val1 ?? 0) + fixed;
}
/** The attack percent of battle_get_atkpercent (battle.cpp:4355): 100, Curse -25, Provoke + val2. Renewal: the base of the skill ratio. */
export function scAtkPercent(sc: ScData | undefined): number {
  if (!sc) return 100;
  let p = 100;
  if (sc.has("Curse")) p -= 25;
  const pr = sc.get("Provoke");
  if (pr) p += pr.val2;
  const ot = sc.get("Overthrust");
  if (ot) p += ot.val3; // battle_get_atkpercent: SC_OVERTHRUST val3
  const lc = sc.get("Concentration");
  if (lc) p += lc.val2; // SC_CONCENTRATION val2 (Renewal: 5 + 2 x lv)
  return Math.min(65535, Math.max(0, p));
}
const SHRT_MAX = 32767, MIN_WALK_SPEED = 20, MAX_WALK_SPEED = 1000;
/**
 * The non-stat part of status_calc_bl_main for the statuses above, applied to a status whose stats (and so HIT / FLEE / DEF2 ...) were
 * already computed from scStats: Hit (Blind -25 %, then Blessing +2 per level, 7544-7620), Flee (Blind -25 %, 7681), DEF (Stone /
 * Freeze halve it, poisoned monsters 75 %, Provoke -val3 % on monsters; 7792-7805), DEF2 (Angelus + VIT / 2 * val2 %, Poison 75 %,
 * Provoke -val3 %; 7879-7892), MDEF (Endure + its level, Stone / Freeze + 25 %; 7946-7953), the defense element (Freeze Water 1,
 * Stone Earth 1; 8774-8823), max HP (Angelus + 50 per level, 3187), walk speed (slow: Decrease AGI 25, Curse 300; haste: Increase AGI
 * 25; 8070-8213) and the attack percent. Returns a copy.
 */
export function scApply<S extends Status>(s: S, sc: ScData | undefined, isPlayer: boolean): S {
  if (!sc || sc.size === 0) return s;
  const o: S = { ...s };
  const cap1 = (v: number) => Math.min(SHRT_MAX, Math.max(1, v));
  if (sc.has("Blind")) { o.hit = cap1(o.hit - t((o.hit * 25) / 100)); o.flee = cap1(o.flee - t((o.flee * 25) / 100)); }
  const bl = sc.get("Blessing");
  if (bl) o.hit = cap1(o.hit + bl.val1 * 2);
  if (sc.has("Stone") || sc.has("Freeze")) o.def = t(o.def / 2);
  const poison = sc.has("Poison");
  if (poison && !isPlayer) o.def = t((o.def * 75) / 100);
  const pr = sc.get("Provoke");
  if (pr && !isPlayer) o.def -= t((o.def * pr.val3) / 100); // Provoke doesn't alter player hard defense
  const an = sc.get("Angelus");
  if (an) o.def2 += t((t(s.stats.vit / 2) * an.val2) / 100);
  if (poison) o.def2 = t((o.def2 * 75) / 100);
  if (pr) o.def2 -= t((o.def2 * pr.val3) / 100);
  const en = sc.get("Endure");
  if (en && !en.val3) o.mdef += en.val4 === 0 ? en.val1 : 1;
  if (sc.has("Stone")) o.mdef += t((25 * o.mdef) / 100);
  if (sc.has("Freeze")) o.mdef += t((25 * o.mdef) / 100);
  if (sc.has("Freeze")) { o.element = "Water" as Element; o.elementLevel = 1; } else if (sc.has("Stone")) { o.element = "Earth" as Element; o.elementLevel = 1; }
  if (an) o.maxHp += an.val1 * 50;
  let slow = 0, haste = 0;
  if (sc.has("DecreaseAgi")) slow = Math.max(slow, 25);
  if (sc.has("Curse")) slow = Math.max(slow, 300);
  if (sc.has("IncreaseAgi")) haste = Math.max(haste, 25);
  if (slow || haste) { const rate = Math.max(40, 100 + slow - haste); o.walkMs = Math.min(MAX_WALK_SPEED, Math.max(MIN_WALK_SPEED, t((o.walkMs * rate) / 100))); }
  o.atkPercent = scAtkPercent(sc);
  // 2.5.0: the 2nd-job buffs (status_calc_critical 7509-7521, status_calc_hit 7553-7589, status_calc_flee 7635-7667, status_calc_watk
  // 7348, status_calc_def 7820 (Concentration), status_calc_attack_element (the endows), status_calc_regen_rate (Magnificat))
  const thq = sc.get("TwoHandQuicken"), sq = sc.get("SpearQuicken"), ad = sc.get("Adrenaline"), ex = sc.get("ExplosionSpirits");
  if (ex) o.cri += ex.val2;
  if (sq) o.cri += 3 * sq.val1 * 10;
  if (thq) o.cri += (2 + thq.val1) * 10;
  const hu = sc.get("Humming"), lc = sc.get("Concentration");
  if (hu) o.hit = cap1(o.hit + hu.val2);
  if (thq) o.hit = cap1(o.hit + thq.val1 * 2);
  if (ad) o.hit = cap1(o.hit + ad.val1 * 3 + 5);
  if (lc) { o.hit = cap1(o.hit + lc.val3); o.def -= t((o.def * lc.val4) / 100); o.def2 -= t((o.def2 * lc.val4) / 100); }
  const ww = sc.get("WindWalk");
  if (ww) o.flee = cap1(o.flee + ww.val2);
  if (sq) o.flee = cap1(o.flee + 2 * sq.val1);
  const im = sc.get("Impositio");
  if (im) o.eatk += im.val2; // Renewal: + WATK (kept with the equipment ATK, element-free of the status ATK)
  const sw = sc.get("StripWeapon");
  if (sw?.val2) { o.watk -= t((o.watk * sw.val2) / 100); const m = o as unknown as { atkMin?: number; atkMax?: number }; if (m.atkMin !== undefined) { m.atkMin -= t((m.atkMin * sw.val2) / 100); m.atkMax! -= t((m.atkMax! * sw.val2) / 100); } }
  for (const [k, ele] of Object.entries(ENDOW_ELEMENT)) if (sc.has(k as ScKey)) { o.rhw = { ...o.rhw, ele: ele! }; break; }
  const wh = sc.get("Whistle"), fo = sc.get("Fortune"), ai = sc.get("AppleIdun"), mp = sc.get("MagicPower");
  if (wh) { o.flee = cap1(o.flee + wh.val2); o.flee2 += wh.val3; } // status_calc_flee / flee2 (SC_WHISTLE)
  if (fo) o.cri += fo.val2; // status_calc_critical (SC_FORTUNE)
  if (ai) o.maxHp += t((o.maxHp * ai.val2) / 100); // status_calc_maxhp rate (SC_APPLEIDUN)
  if (mp) { o.matkMin += t((o.matkMin * mp.val3) / 100); o.matkMax += t((o.matkMax * mp.val3) / 100); } // status_calc_matk (SC_MAGICPOWER)
  if (sc.has("Magnificat")) o.spRecovRate = (o.spRecovRate ?? 100) + 100; // SP regen x2 (status_calc_regen_rate: sregen->rate.sp += 100)
  if (sc.has("WeaponPerfection")) o.noSizeFix = true; // battle_calc_base_damage: no size modifier
  const ab = sc.get("AuraBlade");
  if (ab) o.auraBlade = ab.val2;
  if (sc.has("WindWalk")) { const rate = 100 - 2 * ww!.val1; o.walkMs = Math.max(MIN_WALK_SPEED, t((o.walkMs * rate) / 100)); } // status_calc_speed haste
  const o1 = sc.opt1();
  if (o1 && o1 !== "StoneWait") o.noFlee = true;
  return o;
}

/** The unit's visible options (opt1 / opt2 in the unit's view data): space-separated, lower case; the client draws one effect per word. */
export function scOption(sc: ScData | undefined): string {
  if (!sc || sc.size === 0) return "";
  const out: string[] = [];
  const o1 = sc.opt1();
  if (o1) out.push(o1.toLowerCase());
  for (const k of ["Poison", "Curse", "Silence", "Blind", "Bleeding", "Angelus", "Ankle"] as const) if (sc.has(k)) out.push(k.toLowerCase());
  return out.join(" ");
}

/** status_isendure (status.cpp:9311), the part a status gives: a running Endure (and, for a monster, Class Boss) keeps the unit from
 *  being stopped by a hit. */
export const isEndure = (sc: ScData | undefined) => !!sc?.has("Endure");

/** Hit count of Endure (status_damage, status.cpp:1583): a monster's hit uses one of val2 (7); at 0 the status ends. True = ended. */
export function endureHit(sc: ScData): boolean {
  const e = sc.get("Endure");
  if (!e || e.val4) return false;
  return --e.val2 <= 0;
}

// ---------- skills that apply statuses ----------
/** What a first-job skill does with the statuses above (skill_castend_nodamage_id / applyAdditionalEffects of the skill classes, src/map/skills/). */
export type SkillSc = {
  sc: ScKey;
  /** the percent chance (1..100, sc_start's rate) from the skill level and the two units' levels / the caster's INT. */
  rate: (lv: number, a: { srcLv: number; tgtLv: number; srcInt: number; srcDex?: number; tgtDex?: number }) => number;
  /** the duration source: skill_get_time (Duration1) or skill_get_time2 (Duration2); `delay` = Duration1 as StoneWait's delay. */
  time: "dur1" | "dur2"; delay?: "dur1";
};
export const SKILL_SC: Readonly<Record<string, SkillSc>> = {
  SM_PROVOKE: { sc: "Provoke", time: "dur1", rate: (lv, a) => 70 + 3 * lv + a.srcLv - a.tgtLv }, // provoke.cpp: 70% + 3% x lv + src level - target level
  SM_ENDURE: { sc: "Endure", time: "dur1", rate: () => 100 },
  AC_CONCENTRATION: { sc: "Concentrate", time: "dur1", rate: () => 100 }, // concentration.cpp
  AL_INCAGI: { sc: "IncreaseAgi", time: "dur1", rate: () => 100 }, // incagi.cpp
  AL_BLESSING: { sc: "Blessing", time: "dur1", rate: () => 100 }, // blessing.cpp
  AL_ANGELUS: { sc: "Angelus", time: "dur1", rate: () => 100 }, // angelus.cpp
  AL_DECAGI: { sc: "DecreaseAgi", time: "dur1", rate: (lv, a) => 50 + lv * 3 + t((a.srcLv + a.srcInt) / 5) }, // decagi.cpp
  MG_STONECURSE: { sc: "StoneWait", time: "dur2", delay: "dur1", rate: (lv) => lv * 4 + 20 }, // stonecurse.cpp (brate 0)
  MG_FROSTDIVER: { sc: "Freeze", time: "dur2", rate: (lv) => Math.min(lv * 3 + 35, lv + 60) }, // frostdiver.cpp applyAdditionalEffects
  TF_POISON: { sc: "Poison", time: "dur2", rate: (lv) => 4 * lv + 10 }, // envenom.cpp
  // 2.5.0: the 2nd-job / transcendent buffs (castendNoDamageId: sc_start(.., 100, lv, skill_get_time)) ...
  KN_TWOHANDQUICKEN: { sc: "TwoHandQuicken", time: "dur1", rate: () => 100 }, CR_SPEARQUICKEN: { sc: "SpearQuicken", time: "dur1", rate: () => 100 },
  BS_ADRENALINE: { sc: "Adrenaline", time: "dur1", rate: () => 100 }, BS_OVERTHRUST: { sc: "Overthrust", time: "dur1", rate: () => 100 },
  BS_WEAPONPERFECT: { sc: "WeaponPerfection", time: "dur1", rate: () => 100 }, PR_GLORIA: { sc: "Gloria", time: "dur1", rate: () => 100 },
  PR_IMPOSITIO: { sc: "Impositio", time: "dur1", rate: () => 100 }, PR_MAGNIFICAT: { sc: "Magnificat", time: "dur1", rate: () => 100 },
  SA_FLAMELAUNCHER: { sc: "FireWeapon", time: "dur1", rate: () => 100 }, SA_FROSTWEAPON: { sc: "WaterWeapon", time: "dur1", rate: () => 100 },
  SA_LIGHTNINGLOADER: { sc: "WindWeapon", time: "dur1", rate: () => 100 }, SA_SEISMICWEAPON: { sc: "EarthWeapon", time: "dur1", rate: () => 100 },
  PR_ASPERSIO: { sc: "Aspersio", time: "dur1", rate: () => 100 }, AS_ENCHANTPOISON: { sc: "EncPoison", time: "dur1", rate: () => 100 },
  MO_EXPLOSIONSPIRITS: { sc: "ExplosionSpirits", time: "dur1", rate: () => 100 }, BA_ASSASSINCROSS: { sc: "AssnCros", time: "dur2", rate: () => 100 },
  DC_HUMMING: { sc: "Humming", time: "dur2", rate: () => 100 }, SN_WINDWALK: { sc: "WindWalk", time: "dur1", rate: () => 100 },
  LK_CONCENTRATION: { sc: "Concentration", time: "dur1", rate: () => 100 }, LK_AURABLADE: { sc: "AuraBlade", time: "dur1", rate: () => 100 },
  // ... the debuffs: stripweapon.cpp / striparmor.cpp rate 5 x (lv + 1) % + (DEX - target DEX) / 5 (50 x (lv + 1) + 2 x dex diff, /1000),
  // lexdivina.cpp Silence 100 %
  RG_STRIPWEAPON: { sc: "StripWeapon", time: "dur1", rate: (lv, a) => 5 * (lv + 1) + t(((a.srcDex ?? 0) - (a.tgtDex ?? 0)) / 5) },
  RG_STRIPARMOR: { sc: "StripArmor", time: "dur1", rate: (lv, a) => 5 * (lv + 1) + t(((a.srcDex ?? 0) - (a.tgtDex ?? 0)) / 5) },
  PR_LEXDIVINA: { sc: "Silence", time: "dur2", rate: () => 100 },
  PR_KYRIE: { sc: "Kyrie", time: "dur1", rate: () => 100 }, PR_LEXAETERNA: { sc: "Aeterna", time: "dur1", rate: () => 100 },
  CR_AUTOGUARD: { sc: "AutoGuard", time: "dur1", rate: () => 100 },
  BA_WHISTLE: { sc: "Whistle", time: "dur2", rate: () => 100 }, DC_FORTUNEKISS: { sc: "Fortune", time: "dur2", rate: () => 100 },
  BA_APPLEIDUN: { sc: "AppleIdun", time: "dur2", rate: () => 100 }, HW_MAGICPOWER: { sc: "MagicPower", time: "dur1", rate: () => 100 },
  HP_ASSUMPTIO: { sc: "Assumptio", time: "dur1", rate: () => 100 }, MG_SIGHT: { sc: "Sight", time: "dur1", rate: () => 100 },
  // ... and the statuses a damage skill gives on hit (applyAdditionalEffects; SKILL_ON_HIT): smite.cpp Stun 15 + 5 x lv, holycross.cpp Blind
  // 3 x lv, sonicblow.cpp Stun 2 x lv + 10, sightlessmind.cpp Stun 10 + 3 x lv, frostnova.cpp Freeze 5 x lv + 33 (player), meteorstorm.cpp
  // Stun 3 x lv, hammerfall.cpp Stun 20 + 10 x lv, stormgust.cpp Freeze 65 - 5 x lv (every hit, RENEWAL)
  CR_SHIELDCHARGE: { sc: "Stun", time: "dur2", rate: (lv) => 15 + 5 * lv }, CR_HOLYCROSS: { sc: "Blind", time: "dur2", rate: (lv) => 3 * lv },
  AS_SONICBLOW: { sc: "Stun", time: "dur2", rate: (lv) => 2 * lv + 10 }, RG_RAID: { sc: "Stun", time: "dur2", rate: (lv) => 10 + 3 * lv },
  WZ_FROSTNOVA: { sc: "Freeze", time: "dur2", rate: (lv) => 5 * lv + 33 }, WZ_METEOR: { sc: "Stun", time: "dur2", rate: (lv) => 3 * lv },
  BS_HAMMERFALL: { sc: "Stun", time: "dur2", rate: (lv) => 20 + 10 * lv }, WZ_STORMGUST: { sc: "Freeze", time: "dur2", rate: (lv) => 65 - 5 * lv },
};
/** The damage skills whose SKILL_SC row is rolled when the hit connects (skill_additional_effect), not cast as a status. */
export const SKILL_ON_HIT: ReadonlySet<string> = new Set(["TF_POISON", "MG_FROSTDIVER", "CR_SHIELDCHARGE", "CR_HOLYCROSS", "AS_SONICBLOW", "RG_RAID",
  "WZ_FROSTNOVA", "WZ_METEOR", "BS_HAMMERFALL", "WZ_STORMGUST"]);
/** Skills that take statuses away (skill_castend_nodamage_id): AL_CURE (cure.cpp), TF_DETOXIFY (detoxify.cpp). */
export const SKILL_CURE: Readonly<Record<string, readonly ScKey[]>> = {
  AL_CURE: ["Silence", "Blind"], TF_DETOXIFY: ["Poison"],
  PR_STRECOVERY: ["Freeze", "Stone", "StoneWait", "Stun"], // statusrecovery.cpp (Renewal: + Sleep handled elsewhere)
  // dispell.cpp: every status not flagged NoDispell; ours = the buffs
  SA_DISPELL: SC_KEYS.filter((k) => !SC_DB[k].opt1 && !SC_DB[k].debuff && !["Poison", "Curse", "Silence", "Blind", "Bleeding"].includes(k)),
};

/** mob_skill_db skills that apply a status through a weapon attack (src/map/skills/npc/*.cpp): the status, the rate per skill level
 *  (sc_start's 20 x lv %) and +20 % to the hit rate (modifyHitRate). Duration: skill Duration2 = SC_DB.lookup. */
export const NPC_SC_SKILLS: Readonly<Record<number, { name: string; sc: ScKey }>> = {
  176: { name: "NPC_POISON", sc: "Poison" }, 177: { name: "NPC_BLINDATTACK", sc: "Blind" }, 178: { name: "NPC_SILENCEATTACK", sc: "Silence" },
  179: { name: "NPC_STUNATTACK", sc: "Stun" }, 180: { name: "NPC_PETRIFYATTACK", sc: "StoneWait" }, 181: { name: "NPC_CURSEATTACK", sc: "Curse" },
  182: { name: "NPC_SLEEPATTACK", sc: "Sleep" },
};
export const npcSkillRate = (lv: number) => 20 * lv;

/** bAddEff on a normal attack / skill hit (skill_additional_effect, skill.cpp:1269-1300 with pc_bonus_addeff's defaults: weapon attacks
 *  of either range, target = the enemy): for each effect the percent is rate / 100 (10000 = always); duration = the status' default
 *  (skill Duration2 at level 7). Returns the effects that proc. */
export function addEffProcs(addEff: Readonly<Partial<Record<ScKey, number>>> | undefined, r: Rng): ScKey[] {
  const out: ScKey[] = [];
  if (!addEff) return out;
  for (const [k, rate] of Object.entries(addEff)) if (rate && roll(r, rate)) out.push(k as ScKey);
  return out;
}

/** The status constants a bAddEff / bResEff names (Eff_Stun ...) -> ScKey; undefined = not modelled. */
export const EFF_SC: Readonly<Record<string, ScKey>> = {
  eff_stone: "StoneWait", eff_freeze: "Freeze", eff_stun: "Stun", eff_sleep: "Sleep", eff_poison: "Poison", eff_curse: "Curse",
  eff_silence: "Silence", eff_blind: "Blind", eff_bleeding: "Bleeding",
};
