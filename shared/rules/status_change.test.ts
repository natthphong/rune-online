// Golden tests for shared/rules/status_change.ts (+ its paths in bonus.ts, battle.ts and skill.ts), numbers worked out by hand from the
// rAthena functions each rule cites (status_get_sc_def, status_change_start, status_change_timer, status_calc_*).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFF_SC, NPC_SC_SKILLS, SC_DB, SC_INTERVAL, SC_KEYS, SKILL_CURE, SKILL_SC, SCSTART, ScData, bleedingDamage, endureHit, intervalNext, npcSkillRate, poisonDamage,
  scApply, scAspdBonus, scAtkPercent, scGetDef, scOption, scRemaining, scStats, startSc, stoneDamage, type ScKey, type ScUnit,
} from "./status_change.ts";
import { MD } from "./mode.ts";
import { MOB_BY_ID, MOBS, type Stats } from "./data.ts";
import { STARTER_WEAPON, mobStatus, playerStatus } from "./status.ts";
import { mobAttack } from "./battle.ts";
import { bonus2Type2, noBonus, pcBonus2, scriptBonus } from "./bonus.ts";
import { ITEMS } from "./items.ts";
import { SKILLS, SKILL_ID, skillReady } from "./skill.ts";
import { skillStateMatches } from "./mvp.ts";

const stats = (o: Partial<Stats> = {}): Stats => ({ str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1, ...o });
const unit = (o: Omit<Partial<ScUnit>, "stats"> & { stats?: Partial<Stats> } = {}): ScUnit => ({
  isPlayer: true, level: 50, mdef: 0, mode: 0, race: "Player_Human", element: "Neutral", sc: new ScData(), ...o, stats: stats(o.stats),
});
const always = () => 0; // the roll that always passes (rnd() % 10000 = 0)
const never = () => 0.9999;
const start = (type: ScKey, u: ScUnit, o: Partial<Parameters<typeof startSc>[0]> = {}) =>
  startSc({ type, tgt: u, srcLevel: u.level, rate: 10000, val1: 1, duration: 10000, now: 0, r: always, ...o });

test("status_get_sc_def (Renewal): Poison — VIT lowers the rate and the duration by VIT %, +2 s; level difference lowers the resistance", () => {
  // vit 30 -> sc_def 3000: rate 10000 -> 7000; tick 18000 - 18000 * 3000 / 10000 = 12600, tick_def2 -2000 adds 2 s
  const u = unit({ stats: { vit: 30 } });
  assert.equal(scGetDef("Poison", u, 50, 10000, 18000, 0, () => 0), 14600);
  assert.equal(scGetDef("Poison", u, 50, 10000, 18000, 0, () => 0.6999), 14600); // 6999 < 7000
  assert.equal(scGetDef("Poison", u, 50, 10000, 18000, 0, () => 0.7), 0); // 7000 is not < 7000
  // levelAdv = floor(10^2 / 5) * 100 = 2000 (source 10 levels above the target): sc_def 3000 - 2000 = 1000
  assert.equal(scGetDef("Poison", u, 60, 10000, 18000, 0, () => 0.8999), 18000 - 1800 + 2000);
  assert.equal(scGetDef("Poison", u, 60, 10000, 18000, 0, () => 0.9), 0);
  // a target above the source gets no bonus (max(0, ..)); the resistance is capped to pc_max_status_def 100 %
  assert.equal(scGetDef("Poison", unit({ stats: { vit: 200 } }), 50, 10000, 18000, 0, never), 0);
});

test("status_get_sc_def: Stun +500 ms, Sleep / Freeze / Stone wait / Silence / Blind durations, Curse is immune at LUK 0, Aegis rate rounding", () => {
  assert.equal(scGetDef("Stun", unit(), 50, 10000, 4500, 0, always), 4500 - 45 + 500); // vit 1 -> sc_def 100 (1 %): tick 4500 - 45 + 500
  assert.equal(scGetDef("Stun", unit({ stats: { vit: 0 } }), 50, 10000, 4500, 0, always), 5000);
  assert.equal(scGetDef("Sleep", unit({ stats: { agi: 0 } }), 50, 10000, 18000, 0, always), 20000);
  assert.equal(scGetDef("Silence", unit({ stats: { int: 0 } }), 50, 10000, 18000, 0, always), 20000);
  assert.equal(scGetDef("Blind", unit({ stats: { int: 0 } }), 50, 10000, 18000, 0, always), 20000);
  assert.equal(scGetDef("Freeze", unit({ mdef: 0 }), 50, 10000, 12000, 0, always), 15000); // +3 s
  assert.equal(scGetDef("StoneWait", unit({ mdef: 0 }), 50, 10000, 17000, 0, always), 20000);
  assert.equal(scGetDef("Bleeding", unit({ stats: { agi: 0 } }), 50, 10000, 108000, 0, always), 120000); // +12 s
  assert.equal(scGetDef("Curse", unit({ stats: { luk: 0 } }), 50, 10000, 18000, 0, always), 0); // "immunity when luk is zero"
  assert.ok(scGetDef("Curse", unit({ stats: { luk: 1 } }), 50, 10000, 18000, 0, always) > 0);
  // rate 1500 (15 %), vit 7 -> sc_def 700: 1500 - 105 = 1395 -> Aegis accuracy rounds up to 1400
  const u = unit({ stats: { vit: 7 } });
  assert.ok(scGetDef("Stun", u, 50, 1500, 4500, 0, () => 0.1399) > 0);
  assert.equal(scGetDef("Stun", u, 50, 1500, 4500, 0, () => 0.14), 0);
});

test("status_get_sc_def: Decrease AGI (MDEF lowers the rate 1 % each, half duration for players), unreducable statuses are a plain roll, item resistance", () => {
  assert.equal(scGetDef("DecreaseAgi", unit({ mdef: 10 }), 50, 5000, 40000, 0, () => 0.3999), 20000); // 5000 - 10 * 100 = 4000
  assert.equal(scGetDef("DecreaseAgi", unit({ mdef: 10 }), 50, 5000, 40000, 0, () => 0.4), 0);
  assert.equal(scGetDef("DecreaseAgi", unit({ mdef: 10, isPlayer: false }), 50, 5000, 40000, 0, () => 0.3999), 40000);
  assert.equal(scGetDef("Provoke", unit(), 50, 7000, 30000, 0, () => 0.6999), 30000);
  assert.equal(scGetDef("Provoke", unit(), 50, 7000, 30000, 0, () => 0.7), 0);
  // bResEff 2000 (20 %): rate 10000 - 2000 = 8000; Renewal also shortens the duration by 20 % (Silence, int 0: 18000 - 3600 + 2000)
  const r = unit({ stats: { int: 0 }, resEff: { Silence: 2000 } });
  assert.equal(scGetDef("Silence", r, 50, 10000, 18000, 0, () => 0.7999), 18000 - 3600 + 2000);
  assert.equal(scGetDef("Silence", r, 50, 10000, 18000, 0, () => 0.8), 0);
  // SCSTART_NOTICKDEF keeps the duration, SCSTART_NORATEDEF keeps the rate
  assert.equal(scGetDef("Poison", unit({ stats: { vit: 30 } }), 50, 10000, 18000, SCSTART.NOTICKDEF, always), 18000);
  assert.equal(scGetDef("Poison", unit({ stats: { vit: 99 } }), 50, 10000, 18000, SCSTART.NORATEDEF, always) > 0, true);
});

test("status_change_start: boss immunity (MD_STATUSIMMUNE + BossResist), Fail lists, EndOnStart, Opt1 replacement, EndReturn", () => {
  const boss = unit({ isPlayer: false, mode: MD.STATUSIMMUNE });
  assert.equal(start("Stun", boss).kind, "failed");
  assert.equal(start("Stun", boss, { flag: SCSTART.NOAVOID }).kind, "started"); // forced
  assert.equal(start("Endure", unit({ isPlayer: false, mode: MD.STATUSIMMUNE })).kind, "started"); // Endure has no BossResist
  // Freeze fails on Stone / Stun / Sleep / Freeze; Stun and Sleep do not fail on a frozen unit but replace it (only one Opt1)
  const u = unit({ stats: { vit: 0 } });
  assert.equal(start("Freeze", u).kind, "started");
  assert.equal(start("Freeze", u).kind, "failed");
  assert.equal(start("Sleep", u).kind, "started"); // Sleep's Fail list is only Sleep
  assert.equal(u.sc.has("Freeze"), false); // replaced
  assert.equal(start("Sleep", u).kind, "failed");
  assert.equal(start("Stone", u).kind, "failed"); // Stone fails while asleep
  // Provoke wakes (EndOnStart: Freeze, Stone, Sleep)
  const r = start("Provoke", u);
  assert.deepEqual(r.ended, ["Sleep"]);
  // Increase AGI ends Decrease AGI and the other way round
  const v = unit();
  assert.equal(start("DecreaseAgi", v).kind, "started");
  assert.deepEqual(start("IncreaseAgi", v).ended, ["DecreaseAgi"]);
  assert.deepEqual(start("DecreaseAgi", v).ended, ["IncreaseAgi"]);
  // a poisoned unit cannot be poisoned again
  assert.equal(start("Poison", v).kind, "started");
  assert.equal(start("Poison", v).kind, "failed");
});

test("status_change_start: the petrify has two phases (Stone Curse: StoneWait, then Stone for the rest), Undead are immune, EndReturn", () => {
  const u = unit();
  // Stone Curse: duration 17000, delay 5000; scdef: mdef 0 -> +3 s => 20000; StoneWait lasts the delay, val3 = petrify time
  const w = start("StoneWait", u, { duration: 17000, delay: 5000 });
  assert.equal(w.kind, "started");
  assert.equal(w.entry!.due, 5000);
  assert.equal(w.entry!.val3, 20000 - 5000);
  assert.equal(scOption(u.sc), "stonewait");
  assert.deepEqual(u.sc.cant(), { move: false, cast: true, attack: true }); // the wait stops attacks and skills but not walking
  // the timer runs out: StoneWait is deleted first, then Stone is forced for val3 (SCSTART_NOAVOID)
  u.sc.map.delete("StoneWait");
  const s = start("Stone", u, { duration: 15000, flag: SCSTART.NOAVOID, now: 5000 });
  assert.equal(s.kind, "started");
  assert.equal(s.entry!.due, 5000 + 5000); // an interval status: first step after 5 s, the rest in val4
  assert.equal(s.entry!.val4, 10000);
  assert.deepEqual(u.sc.cant(), { move: true, cast: true, attack: true });
  assert.equal(scRemaining(s.entry!, 5000), 15000);
  assert.equal(scOption(u.sc), "stone");
  // EndReturn: casting it again on a petrified unit takes the status off instead
  const again = start("StoneWait", u, { duration: 17000, delay: 5000 });
  assert.equal(again.kind, "nochange");
  assert.deepEqual(again.ended, ["Stone"]);
  // Undead are immune to Freeze and Stone unless forced
  assert.equal(start("Freeze", unit({ element: "Undead" })).kind, "failed");
  assert.equal(start("StoneWait", unit({ element: "Undead" }), { duration: 17000, delay: 5000 }).kind, "failed");
});

test("Blessing: val2 = level (player, or a non-undead non-demon), 0 = halves the stats; it cures Curse / Stone on a player instead of buffing", () => {
  const p = unit();
  assert.equal(start("Blessing", p, { val1: 5 }).entry!.val2, 5);
  assert.equal(start("Blessing", unit({ isPlayer: false, race: "Demon" }), { val1: 5 }).entry!.val2, 0);
  assert.equal(start("Blessing", unit({ isPlayer: false, element: "Undead" }), { val1: 5 }).entry!.val2, 0);
  assert.equal(start("Blessing", unit({ isPlayer: false, race: "Brute" }), { val1: 5 }).entry!.val2, 5);
  const c = unit();
  start("Curse", c);
  const r = start("Blessing", c, { val1: 5 });
  assert.equal(r.kind, "nochange");
  assert.deepEqual(r.ended, ["Curse"]);
  assert.equal(c.sc.has("Blessing"), false);
  const s = unit();
  start("Stone", s, { flag: SCSTART.NOAVOID });
  assert.deepEqual(start("Blessing", s, { val1: 5 }).ended, ["Stone"]);
});

test("a stronger level of a status keeps running; Endure's hit count (7) ends it", () => {
  const u = unit();
  assert.equal(start("Provoke", u, { val1: 5 }).kind, "started");
  assert.equal(start("Provoke", u, { val1: 3 }).kind, "nochange"); // sce->val1 > val1: "return true"
  assert.equal(u.sc.get("Provoke")!.val1, 5);
  assert.equal(start("Provoke", u, { val1: 7 }).kind, "started");
  assert.equal(u.sc.get("Provoke")!.val2, 2 + 3 * 7); // atk increase
  assert.equal(u.sc.get("Provoke")!.val3, 5 + 5 * 7); // def reduction
  const e = start("Endure", u, { val1: 4 }).entry!;
  assert.equal(e.val2, 7);
  for (let i = 0; i < 6; i++) assert.equal(endureHit(u.sc), false);
  assert.equal(endureHit(u.sc), true); // the 7th hit
});

test("status_change_timer: Poison steps every second for its whole duration, val4 counts the rest (status.cpp:15218)", () => {
  const u = unit();
  const e = start("Poison", u, { duration: 18000, flag: SCSTART.NOAVOID }).entry!;
  assert.equal(e.due, 1000);
  assert.equal(e.val4, 17000);
  let fires = 0, now = e.due;
  for (;;) {
    fires++; // the effect runs while val4 >= 0
    assert.ok(e.val4 >= 0);
    if (intervalNext(e, now)) break;
    now = e.due;
  }
  assert.equal(fires, 18);
  assert.equal(now, 18000);
  assert.deepEqual(SC_INTERVAL, { Poison: 1000, Stone: 5000, Bleeding: 10000 });
});

test("interval effects: Poison (2 + 3/200 MaxHP for players, 2 + 1/200 for monsters, never below 25 % HP), Stone (1 % above 25 %), Bleeding", () => {
  assert.equal(poisonDamage(true, 1000, 1000), 17);
  assert.equal(poisonDamage(false, 1000, 1000), 7);
  assert.equal(poisonDamage(true, 250, 1000), 0); // hp must be above max(25 %, damage)
  assert.equal(poisonDamage(true, 251, 1000), 17);
  assert.equal(poisonDamage(true, 20, 40), 2); // 2 + 120 / 200 = 2; hp 20 is above max(10, 2)
  assert.equal(poisonDamage(true, 10, 40), 0);
  assert.equal(stoneDamage(1000, 1000), 10);
  assert.equal(stoneDamage(250, 1000), 0);
  assert.equal(stoneDamage(251, 1000), 10);
  assert.equal(bleedingDamage(true, 5000, () => 0), 200);
  assert.equal(bleedingDamage(true, 5000, () => 0.9999), 799);
  assert.equal(bleedingDamage(false, 100, () => 0.5), 99); // a monster never dies of it
  assert.equal(bleedingDamage(true, 100, () => 0.5), 500);
});

test("status_calc_str / agi / int / dex / luk: Blessing, Improve Concentration, Increase / Decrease AGI, Curse", () => {
  const s = stats({ str: 20, agi: 40, int: 30, dex: 50, luk: 25 });
  const sc = new ScData();
  sc.map.set("Blessing", { type: "Blessing", val1: 5, val2: 5, val3: 0, val4: 0, due: 1 });
  assert.deepEqual(scStats(s, sc), { ...s, str: 25, int: 35, dex: 55 });
  sc.map.set("Blessing", { type: "Blessing", val1: 5, val2: 0, val3: 0, val4: 0, due: 1 }); // undead / demon: half
  assert.deepEqual(scStats(s, sc), { ...s, str: 10, int: 15, dex: 25 });
  const c = new ScData();
  c.map.set("Concentrate", { type: "Concentrate", val1: 5, val2: 7, val3: 0, val4: 10, due: 1 });
  // agi += (40 - 0) * 7 / 100 = 2; dex += (50 - 10) * 7 / 100 = 2 (the equipment part does not count)
  assert.deepEqual(scStats(s, c), { ...s, agi: 42, dex: 52 });
  const a = new ScData();
  a.map.set("IncreaseAgi", { type: "IncreaseAgi", val1: 3, val2: 5, val3: 0, val4: 0, due: 1 });
  assert.equal(scStats(s, a).agi, 45);
  a.map.delete("IncreaseAgi");
  a.map.set("DecreaseAgi", { type: "DecreaseAgi", val1: 3, val2: 5, val3: 0, val4: 0, due: 1 });
  assert.equal(scStats(s, a).agi, 35);
  assert.equal(scStats(stats({ agi: 2 }), a).agi, 0); // floored at 0
  const k = new ScData();
  start("Curse", unit({ sc: k }));
  assert.equal(scStats(s, k).luk, 0);
  assert.equal(scStats(s, undefined), s);
  assert.equal(scAspdBonus(a), 0);
  a.map.set("IncreaseAgi", { type: "IncreaseAgi", val1: 7, val2: 9, val3: 0, val4: 0, due: 1 });
  assert.equal(scAspdBonus(a), 7);
});

test("status_calc_* of the other flags: hit / flee / DEF / DEF2 / MDEF / element / max HP / speed / attack percent", () => {
  const base = playerStatus({ job: "Swordman", level: 50, jobLevel: 10, stats: stats({ str: 30, agi: 30, vit: 30, int: 10, dex: 30, luk: 10 }), weapon: STARTER_WEAPON });
  const sc = (...es: [ScKey, number, number?, number?, number?][]) => { const d = new ScData(); for (const [t, v1, v2 = 0, v3 = 0, v4 = 0] of es) d.map.set(t, { type: t, val1: v1, val2: v2, val3: v3, val4: v4, due: 1 }); return d; };
  // Blind: hit and flee -25 %
  const bl = scApply(base, sc(["Blind", 1]), true);
  assert.equal(bl.hit, base.hit - Math.trunc((base.hit * 25) / 100));
  assert.equal(bl.flee, base.flee - Math.trunc((base.flee * 25) / 100));
  // Blessing: +2 hit per level (after Blind's cut)
  assert.equal(scApply(base, sc(["Blind", 1], ["Blessing", 5, 5]), true).hit, bl.hit + 10);
  // Stone / Freeze halve hard DEF, +25 % MDEF; Freeze = Water 1, Stone = Earth 1
  const gear = { ...base, def: 20, mdef: 20 };
  assert.equal(scApply(gear, sc(["Stone", 1]), true).def, 10);
  assert.equal(scApply(gear, sc(["Stone", 1]), true).mdef, 25);
  assert.deepEqual([scApply(gear, sc(["Freeze", 1]), true).element, scApply(gear, sc(["Freeze", 1]), true).elementLevel], ["Water", 1]);
  assert.equal(scApply(gear, sc(["Stone", 1]), true).element, "Earth");
  assert.equal(scApply(gear, sc(["Freeze", 1]), true).def2, base.def2); // DEF2 untouched
  // Poison: DEF2 x 75 %, hard DEF x 75 % for monsters only; Provoke: DEF2 -val3 %, hard DEF only on monsters
  const po = scApply(gear, sc(["Poison", 1]), true);
  assert.equal(po.def, 20);
  assert.equal(po.def2, Math.trunc((base.def2 * 75) / 100));
  assert.equal(scApply(gear, sc(["Poison", 1]), false).def, 15);
  const pv = sc(["Provoke", 5, 17, 30]);
  assert.equal(scApply(gear, pv, true).def, 20);
  assert.equal(scApply(gear, pv, false).def, 14); // 20 - 20 * 30 / 100
  assert.equal(scApply(gear, pv, true).def2, base.def2 - Math.trunc((base.def2 * 30) / 100));
  // Angelus: max HP + 50 per level, DEF2 + VIT / 2 * val2 %
  const an = scApply(base, sc(["Angelus", 3, 15]), true);
  assert.equal(an.maxHp, base.maxHp + 150);
  assert.equal(an.def2, base.def2 + Math.trunc((15 * 15) / 100));
  // Endure: MDEF + its level
  assert.equal(scApply(gear, sc(["Endure", 4, 7]), true).mdef, 24);
  // speed: Increase AGI 25 % faster, Decrease AGI 25 % slower, Curse 300 % slower (rate 400), Curse's 300 beats Decrease AGI's 25 (max of the slows)
  assert.equal(scApply(base, sc(["IncreaseAgi", 3, 5]), true).walkMs, 112);
  assert.equal(scApply(base, sc(["DecreaseAgi", 3, 5]), true).walkMs, 187);
  assert.equal(scApply(base, sc(["Curse", 1]), true).walkMs, 600);
  // attack percent (battle_get_atkpercent): Curse -25, Provoke + val2
  assert.equal(scAtkPercent(sc(["Curse", 1])), 75);
  assert.equal(scAtkPercent(sc(["Provoke", 5, 17, 30])), 117);
  assert.equal(scAtkPercent(sc(["Provoke", 5, 17, 30], ["Curse", 1])), 92);
  assert.equal(scAtkPercent(undefined), 100);
  assert.equal(scApply(base, sc(["Provoke", 5, 17, 30]), true).atkPercent, 117);
  assert.equal(scApply(base, undefined, true), base);
});

test("the attack percent scales a monster's normal attack before DEF (Renewal skill ratio base)", () => {
  const def = MOB_BY_ID.get(1001)!;
  const att = mobStatus({ ...def, level: 30, str: 30, dex: 99 });
  const target = playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: stats(), weapon: STARTER_WEAPON });
  const zero = { ...target, def: 0, def2: 0, flee: 1, flee2: 0 };
  const t = { type: 1, targeted: 0 };
  const plain = mobAttack(att, zero, t, () => 0).dmg, cursed = mobAttack({ ...att, atkPercent: 75 }, zero, t, () => 0).dmg, provoked = mobAttack({ ...att, atkPercent: 150 }, zero, t, () => 0).dmg;
  const raw = att.atkMin + att.batk; // DEF 0, DEF2 floored at 1 (vit_penalty_type: Math.max(1, def2))
  assert.equal(plain, raw - 1);
  assert.equal(cursed, Math.trunc((raw * 75) / 100) - 1);
  assert.equal(provoked, Math.trunc((raw * 150) / 100) - 1);
  // hitRate modifier of an NPC attack skill (+20 %): flee-heavy target, deterministic roll
  const dodger = { ...zero, flee: att.hit - 10 + 1 };
  const hitChance = (mod?: (h: number) => number) => (mobAttack(att, dodger, t, () => 0.2, mod).dmg > 0);
  assert.equal(hitChance(), false); // hit rate (att.hit - flee) = 9 %: 20 is not < 9
  assert.equal(hitChance((h) => h + Math.trunc((h * 20) / 100) + 20), true);
});

test("skills: rates and durations of the status skills (provoke.cpp, decagi.cpp, stonecurse.cpp, frostdiver.cpp, envenom.cpp)", () => {
  const a = { srcLv: 50, tgtLv: 30, srcInt: 40 };
  assert.equal(SKILL_SC.SM_PROVOKE.rate(5, a), 70 + 15 + 50 - 30);
  assert.equal(SKILL_SC.AL_DECAGI.rate(5, a), 50 + 15 + Math.trunc((50 + 40) / 5));
  assert.equal(SKILL_SC.MG_STONECURSE.rate(5, a), 40);
  assert.equal(SKILL_SC.MG_FROSTDIVER.rate(1, a), 38);
  assert.equal(SKILL_SC.MG_FROSTDIVER.rate(10, a), 65); // min(10 * 3 + 35, 10 + 60)
  assert.equal(SKILL_SC.MG_FROSTDIVER.rate(10, a) < 70, true);
  assert.equal(SKILL_SC.TF_POISON.rate(4, a), 26);
  for (const k of ["SM_ENDURE", "AC_CONCENTRATION", "AL_INCAGI", "AL_BLESSING", "AL_ANGELUS"]) assert.equal(SKILL_SC[k].rate(1, a), 100);
  assert.deepEqual([SKILL_CURE.AL_CURE, SKILL_CURE.TF_DETOXIFY, SKILL_CURE.PR_STRECOVERY], [["Silence", "Blind"], ["Poison"], ["Freeze", "Stone", "StoneWait", "Stun"]]);
  assert.ok(SKILL_CURE.SA_DISPELL.includes("Blessing") && SKILL_CURE.SA_DISPELL.includes("TwoHandQuicken") && !SKILL_CURE.SA_DISPELL.includes("Poison")); // dispell.cpp: buffs only
  // every skill the table names exists, is ready (unlocked) and gets the duration it names
  for (const [key, d] of Object.entries(SKILL_SC)) {
    const sk = SKILLS.get(SKILL_ID[key])!;
    assert.ok(sk, key);
    assert.ok(skillReady(sk.id), `${key} is unlocked`);
    assert.ok((d.time === "dur1" ? sk.duration1 : sk.duration2).every((ms) => ms > 0), `${key} has a duration`);
    if (key !== "RG_RAID") assert.equal(sk.status, d.sc === "StoneWait" ? "StoneWait" : d.sc, `${key} applies ${d.sc}`); // sightlessmind.cpp: Stun on hit, its own SC_RAID not modelled
  }
  for (const key of Object.keys(SKILL_CURE)) assert.ok(skillReady(SKILL_ID[key]), `${key} is unlocked`);
  // Stone Curse's delay is Duration1 (5 s), its total Duration2 (17 s)
  const sc = SKILLS.get(SKILL_ID.MG_STONECURSE)!;
  assert.equal(sc.duration1[0], 5000);
  assert.equal(sc.duration2[0], 17000);
  // Increase AGI 60 s at level 1; Angelus 30 s; Provoke 30 s
  assert.equal(SKILLS.get(SKILL_ID.AL_INCAGI)!.duration1[0], 60000);
  assert.equal(SKILLS.get(SKILL_ID.AL_ANGELUS)!.duration1[0], 30000);
});

test("cards: bAddEff / bResEff are modelled (pc_bonus2 SP_ADDEFF / SP_RESEFF), bResEff is capped to +-10000", () => {
  assert.equal(bonus2Type2("bAddEff", "Eff_Stun"), "Stun");
  assert.equal(bonus2Type2("bResEff", "eff_silence"), "Silence");
  assert.equal(bonus2Type2("bAddEff", "Eff_Poison"), "Poison");
  assert.equal(bonus2Type2("bAddEff", "Eff_Teleport"), undefined);
  const b = noBonus();
  assert.equal(pcBonus2(b, "bAddEff", "Stun", 500), true);
  assert.equal(pcBonus2(b, "bAddEff", "Stun", 200), true);
  assert.deepEqual(b.addEff, { Stun: 700 });
  pcBonus2(b, "bResEff", "Silence", 8000); pcBonus2(b, "bResEff", "Silence", 8000);
  assert.deepEqual(b.resEff, { Silence: 10000 });
  assert.equal(pcBonus2(b, "bAddEff", "Stun", 500, "arrow"), true);
  assert.deepEqual(b.addEff, { Stun: 700 }); // an ammo's goes to arrow_rate: not modelled
  assert.equal(pcBonus2(b, "bAddEff", "Bogus", 500), false);
  // the five cards of our roster carry them
  const want: Record<number, [string, string, number]> = {
    4017: ["bAddEff", "Stun", 500], 4037: ["bAddEff", "Poison", 500], 4039: ["bResEff", "Silence", 2000], 4020: ["bAddEff", "Blind", 500], 4025: ["bAddEff", "Stun", 200],
  };
  for (const [id, [type, type2, value]] of Object.entries(want)) {
    const it = ITEMS.get(Number(id))!;
    assert.deepEqual(it.unsupported, [], `${it.name} has nothing unsupported`);
    const e = noBonus();
    for (const s of it.bonuses as { type: string; value: number | string; type2?: string }[]) scriptBonus(e, s);
    const table = type === "bAddEff" ? e.addEff : e.resEff;
    assert.equal(table[type2 as ScKey], value, it.name);
  }
  // a Status carries them to the battle code (monsters: none)
  const e = noBonus();
  pcBonus2(e, "bAddEff", "Stun", 500);
  assert.deepEqual(playerStatus({ job: "Novice", level: 1, jobLevel: 1, stats: stats(), weapon: STARTER_WEAPON, equip: e }).addEff, { Stun: 500 });
  assert.deepEqual(mobStatus(MOB_BY_ID.get(1001)!).addEff, {});
  assert.deepEqual(Object.values(EFF_SC).filter((k) => !SC_KEYS.includes(k)), []);
});

test("items: Green Herb cures Poison (sc_end SC_POISON), others keep their heal", () => {
  assert.deepEqual(ITEMS.get(511)!.effect, { cure: ["Poison"] });
  assert.ok(ITEMS.get(501)!.effect && "heal" in (ITEMS.get(501)!.effect as object));
});

test("monster skills: mob_skill_db NPC_POISON / BLINDATTACK / SILENCEATTACK / SLEEPATTACK rows of our species (20 % x level per hit, 5 s delay)", () => {
  const rows = MOBS.flatMap((m) => m.statusSkills.map((r) => ({ mob: m.name, ...r })));
  assert.ok(rows.length >= 8);
  for (const r of rows) {
    assert.ok(NPC_SC_SKILLS[r.skill], `${r.mob}: skill ${r.skill} is one we run`);
    assert.ok(r.lv >= 1 && r.lv <= 5);
    assert.equal(r.cond, "always");
    assert.equal(r.delay, 5000);
    assert.equal(r.rate, 500); // 5 % per check
    assert.ok(skillStateMatches("attack", "berserk", true));
  }
  assert.equal(npcSkillRate(3), 60);
  assert.deepEqual(MOB_BY_ID.get(1001)!.statusSkills.map((r) => [r.skill, r.lv, r.castTime]), [[176, 3, 800]]); // Scorchtail: poison attack lv 3, 800 ms cast
  assert.deepEqual(MOB_BY_ID.get(1014)!.statusSkills.map((r) => [r.skill, r.castTime]), [[182, 0]]); // Bogcap: sleep attack, no cast
  assert.equal(SC_DB.Poison.lookup, 18000);
  assert.equal(SC_DB.Stun.lookup, 4500);
  assert.equal(SC_DB.Freeze.lookup, 27000);
});

test("the owner's list time and the visible option word", () => {
  const u = unit();
  start("Poison", u, { duration: 18000, flag: SCSTART.NOAVOID });
  start("Silence", u, { duration: 20000, flag: SCSTART.NOAVOID });
  start("Angelus", u, { val1: 3, duration: 90000 });
  assert.equal(scOption(u.sc), "poison silence angelus");
  assert.equal(scRemaining(u.sc.get("Silence")!, 5000), 15000);
  assert.equal(scRemaining(u.sc.get("Poison")!, 0), 1000 + 17000); // next step + the remainder
  assert.equal(scRemaining(u.sc.get("Angelus")!, 10000), 80000);
  assert.equal(scOption(undefined), "");
});
