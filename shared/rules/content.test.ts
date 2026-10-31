// Content checks (shared/content): quest rows parse without the warnings rAthena would print, every name / NPC / cell / cutin
// they point at exists, NPCs stand on walkable cells with a sprite, and the whole of Chapter 1 plays through the real NPC
// scripts (a Script double over an in-memory character) with the "!" / "?" marks pointing at the next NPC at every step.
// The chapter's pacing is checked on the Renewal exp tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { walkable } from "../map.ts";
import { itemNamed, mobNamed } from "./quest.ts";
import { MOBS, TABLES } from "./data.ts";
import { gainExp, type Progress } from "./exp.ts";
import { applyExpPenalty, levelPenaltyMod } from "./penalty.ts";
import { QUESTS, QUEST_DB, QUEST_DB_WARNINGS, QUEST_INFO, F1_GATE_LEVEL } from "../content/quest_db.ts";
import { CALLING, MASTERS } from "../content/f1/jobs.ts";
import { HEAL_FEE, TOWN_NPC, TQ } from "../content/f1/town.ts";
import { NPC_HOMES, buildMap, isMapName } from "../maps.ts";
import { NPCS, NPC_BY_ID, npcClassless } from "../content/npcs.ts";
import { GUIDE_QUESTINFO, Q_BEADS, Q_PATROL, guideLio } from "../content/f1/guide.ts";
import { CHAPTER1, NPC, Q, chapter1Step } from "../content/f1/chapter1.ts";
import { taskProgress } from "../content/tasks.ts";
import { SEAL, SEAL_LEVEL, SEAL_VAR } from "../content/f1/stair.ts";
import { DUNGEON_ENTRY, TOWN_SAVE } from "../maps.ts";
import { ART_STANDIN } from "../mobart.ts";
import { CALLSHOP, QTYPE, inTouchArea } from "./script.ts";
import { ITEMS, type EquipSlot } from "./items.ts";
import { refineCost, refinePercent } from "./refine.ts";
import { itemDisplayName } from "./cards.ts";
import type { ItemRef, NpcDef, QuestInfoView, Script } from "../content/api.ts";

/** The cells of the map a row names (at MAP_SEED 1337). */
const mapNamed = (name: string) => { assert.ok(isMapName(name), `map ${name}`); return buildMap(name, 1337); };
const PUBLIC = new URL("../../client/public/", import.meta.url);
const SPRITES: string[] = JSON.parse(readFileSync(new URL("sprites/index.json", PUBLIC), "utf8"));
const ICONS: Record<string, number> = JSON.parse(readFileSync(new URL("icons/items.json", PUBLIC), "utf8")).names;

test("quest_db content parses cleanly and every reference resolves", () => {
  assert.deepEqual(QUEST_DB_WARNINGS, []);
  assert.equal(QUEST_DB.size, QUESTS.length);
  for (const q of QUESTS) {
    if (q.Info.Report) assert.ok(NPC_BY_ID.has(q.Info.Report), `${q.Id} reports to a real NPC`);
    for (const it of [...(q.Info.Items ?? []), ...(q.Info.RewardItems ?? [])]) assert.ok(itemNamed(it.Item), `${q.Id}: item ${it.Item}`);
    if (q.Info.Navi) assert.ok(walkable(mapNamed(q.Info.Navi.map), q.Info.Navi.x, q.Info.Navi.y), `${q.Id}: Navi cell walkable`);
    assert.ok((q.Id >= 1001 && q.Id <= 1999) || (q.Id >= 2001 && q.Id <= 2999), "floor 1 quests use 1001-1999, floor 2 2001-2999");
    for (const t of q.Info.Tasks ?? []) {
      if ("Equip" in t) assert.ok(itemNamed(t.Equip), `${q.Id}: task item ${t.Equip}`);
      if ("Use" in t) assert.ok(itemNamed(t.Use), `${q.Id}: task item ${t.Use}`);
      if ("Visit" in t) { // the place must be an OnTouch area of that map that the auto-walk can reach
        assert.ok(walkable(mapNamed(t.Visit.Map), t.Visit.X, t.Visit.Y), `${q.Id}: Visit cell walkable`);
        const area = NPCS.find((n) => n.map === t.Visit.Map && n.trigger && inTouchArea({ x: n.x, y: n.y, xs: n.trigger.x, ys: n.trigger.y }, t.Visit.X, t.Visit.Y));
        assert.ok(area, `${q.Id}: Visit cell inside an NPC trigger area`);
      }
    }
  }
  // every item a chapter quest names has an icon in the atlas (quest window, reward feed, bag)
  for (const q of QUESTS) for (const it of [...(q.Info.Items ?? []), ...(q.Info.RewardItems ?? [])]) assert.ok(itemNamed(it.Item)!.name in ICONS, `icon for ${it.Item}`);
  for (const name of ["Supply Crate", "Ember Coal", "Herb Tea"]) assert.ok(name in ICONS, `icon for ${name}`);
});

test("Chapter 1 is one Main chain 1001-1014 whose kill / drop targets exist on the field", () => {
  // the Main quests: Chapter 1, C04's "A Calling" (the job change, f1/jobs.ts), C08's Hearthmoor steps that lead to it, W03's seal
  assert.deepEqual([...CHAPTER1, CALLING, TQ.HEARTH, TQ.LESSON, SEAL], QUESTS.filter((q) => q.Info.Type === "Main" && q.Id < 2000).map((q) => q.Id)); // floor 2's chain: floor2 tests below
  assert.deepEqual([...CHAPTER1], Array.from({ length: 14 }, (_, i) => 1001 + i));
  const spawns = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  for (const q of QUEST_DB.values()) {
    for (const o of q.objectives) {
      const mobs = o.mobId ? [o.mobId] : MOBS.filter((m) => (o.element === "All" || m.element === o.element) && (o.race === "All" || m.race === o.race)).map((m) => m.id);
      // a named target must spawn; a filter target (any Fire monster...) needs at least one spawning species (new species may
      // match the filter before the world builder places them)
      const spawning = (id: number) => spawns.includes(`\t${id},`) || spawns.includes(`${mobNamed(id)!.name}\t${id},`);
      assert.ok(mobs.length && (o.mobId ? mobs.every(spawning) : mobs.filter(spawning).length >= 2), `${q.id}: targets spawn on a field`);
    }
    for (const d of q.drops) assert.ok(d.mobId === 0 || spawns.includes(`${mobNamed(d.mobId)!.name}\t`), `${q.id}: drop monster spawns`);
  }
  // the fire hunt is an Id target with an Element filter (quest.cpp:184), the pest hunt has two objectives
  assert.equal(QUEST_DB.get(Q.EMBERS)!.objectives[0].element, "Fire");
  assert.equal(QUEST_DB.get(Q.EMBERS)!.objectives[0].mobId, 0);
  assert.equal(QUEST_DB.get(Q.PESTS)!.objectives.length, 2);
});

test("NPCs: unique ids, walkable cells, a sprite sheet, a script for script NPCs, shop stock, trigger areas", () => {
  assert.equal(new Set(NPCS.map((n) => n.id)).size, NPCS.length);
  for (const n of NPCS) {
    assert.equal(n.kind === "script", !!n.script, n.id);
    if (n.kind === "shop") for (const r of n.shop ?? []) assert.ok(itemNamed(r), `${n.id} sells ${r}`);
    if (n.map === "-") { assert.ok(!n.trigger && !n.questinfo, `${n.id}: a floating NPC has no area and no icon`); continue; }
    const m = mapNamed(n.map);
    assert.ok(walkable(m, n.x, n.y), `${n.id} on a walkable cell of ${n.map}`);
    if (n.sprite) assert.ok(SPRITES.includes(n.sprite), `${n.id} sprite ${n.sprite} in sprites/index.json`);
    else assert.ok(!n.questinfo, `${n.id}: an invisible NPC can't show an icon`);
    if (n.trigger) {
      let cells = 0;
      for (let y = n.y - n.trigger.y; y <= n.y + n.trigger.y; y++) for (let x = n.x - n.trigger.x; x <= n.x + n.trigger.x; x++) if (walkable(m, x, y)) cells++;
      assert.ok(cells > 0, `${n.id}: trigger area has walkable cells`);
    }
  }
  // W01: the client's table of where NPCs live (navigation to an NPC on another map) matches the rows, and covers every visible
  // NPC and every quest's Report NPC
  for (const [id, home] of Object.entries(NPC_HOMES)) assert.deepEqual({ map: NPC_BY_ID.get(id)?.map, name: NPC_BY_ID.get(id)?.name }, home, `NPC_HOMES ${id}`);
  for (const n of NPCS) if (n.sprite && n.map !== "-") assert.ok(NPC_HOMES[n.id], `NPC_HOMES has ${n.id}`);
  for (const q of QUESTS) if (q.Info.Report) assert.ok(NPC_HOMES[q.Info.Report], `NPC_HOMES has ${q.Info.Report} (quest ${q.Id})`);
  assert.ok(npcClassless(NPC_BY_ID.get(NPC.miraShop)!) && npcClassless(NPC_BY_ID.get(NPC.lookout)!) && !npcClassless(NPC_BY_ID.get(NPC.guide)!));
});

// ---------- a Script double over an in-memory character ----------
type World = {
  vars: Record<string, number>; quests: Record<number, number>; hunt: Record<number, number>;
  items: Record<string, number>; worn: Set<string>; params: Record<string, number>;
  log: string[]; skills?: Record<string, number>; job?: string;
  gear?: Partial<Record<EquipSlot, { id: number; refine: number }>>; // worn pieces (the refiner's getequip* reads)
};
const newWorld = (): World => ({
  vars: {}, quests: {}, hunt: {}, items: {}, worn: new Set(), log: [],
  params: { Zeny: 0, BaseLevel: 1, StatusPoint: 48, Hp: 40, MaxHp: 40, Sp: 11, MaxSp: 11 },
});
const nameOf = (i: ItemRef) => itemNamed(i)!.name;
class End extends Error {}
/** The questinfo / script reads, like the engine's: HUNTING = 2 once `hunt` says so (or no objectives), quests 0/1/2. */
function reader(w: World): QuestInfoView {
  return {
    isbegin_quest: (id) => w.quests[id] ?? 0,
    checkquest: (id, type) => {
      if (!(id in w.quests)) return -1;
      if (type === "HUNTING") return w.quests[id] === 2 ? 0 : (w.hunt[id] ?? (QUEST_DB.get(id)!.objectives.length ? 0 : 2));
      return w.quests[id];
    },
    countitem: (i) => w.items[nameOf(i)] ?? 0,
    get: (k) => (k in w.params ? w.params[k] : w.vars[k] ?? 0),
    strcharinfo: () => "Tester",
    isequipped: (...items) => items.every((i) => w.worn.has(nameOf(i))),
    getskilllv: (k) => w.skills?.[k] ?? 0,
  };
}
function mock(w: World, npcId: string, choices: number[]): Script {
  const r = reader(w), log = w.log;
  return {
    npc: { id: npcId, name: NPC_BY_ID.get(npcId)!.name },
    mes: (...l) => { log.push(`mes ${l.join(" | ")}`); },
    next: async () => { log.push("next"); },
    close: async () => { log.push("close"); throw new End(); },
    close2: async () => { log.push("close2"); },
    close3: async () => { log.push("close3"); throw new End(); },
    clear: () => { log.push("clear"); },
    end: () => { throw new End(); },
    select: async (...o) => { const c = choices.shift(); log.push(`select ${o.join("/")} -> ${c}`); if (c === undefined) throw new End(); return c; },
    prompt: async () => 255,
    cutin: (img, t) => { log.push(`cutin ${img} ${t}`); },
    emotion: (e, target) => { log.push(`emotion ${e}${target ? ` ${target}` : ""}`); },
    npctalk: (m, npc, flag) => { log.push(`npctalk ${m} ${npc ?? ""} ${flag ?? ""}`); },
    playerattached: () => "me",
    strcharinfo: r.strcharinfo,
    get: r.get,
    set: (k, v) => { if (k === "Zeny") w.params.Zeny = v; else w.vars[k] = v; log.push(`set ${k} ${v}`); },
    countitem: r.countitem,
    checkweight: () => true,
    getitem: (i, n) => { w.items[nameOf(i)] = (w.items[nameOf(i)] ?? 0) + n; log.push(`getitem ${nameOf(i)} ${n}`); return true; },
    delitem: (i, n) => { if ((w.items[nameOf(i)] ?? 0) < n) throw new End(); w.items[nameOf(i)] -= n; log.push(`delitem ${nameOf(i)} ${n}`); },
    getexp: (b, j) => { log.push(`getexp ${b} ${j}`); },
    heal: (hp) => { w.params.Hp = Math.min(w.params.MaxHp, w.params.Hp + hp); log.push(`heal ${hp}`); },
    percentheal: (hp) => { w.params.Hp = Math.max(1, Math.min(w.params.MaxHp, w.params.Hp + Math.trunc((w.params.MaxHp * hp) / 100))); log.push(`percentheal ${hp}`); },
    isequipped: r.isequipped,
    callshop: (name, option) => { log.push(`callshop ${name} ${option}`); return NPC_BY_ID.get(name)?.kind === "shop"; },
    setquest: (id) => { w.quests[id] = 1; log.push(`setquest ${id}`); },
    completequest: (id) => { w.quests[id] = 2; delete w.hunt[id]; log.push(`completequest ${id}`); },
    erasequest: (id) => { delete w.quests[id]; },
    changequest: () => {},
    checkquest: r.checkquest,
    isbegin_quest: r.isbegin_quest,
    showevent: () => {},
    getskilllv: r.getskilllv,
    basicskillcheck: () => true,
    jobchange: (job) => { if (w.job === job) return false; w.job = job; w.params.JobLevel = 1; log.push(`jobchange ${job}`); return true; },
    resetlvl: () => { w.params.BaseLevel = 1; w.params.JobLevel = 1; log.push("resetlvl 1"); },
    warp: (map, x, y) => { log.push(`warp ${map} ${x} ${y}`); throw new End(); },
    savepoint: (map, x, y) => { log.push(`savepoint ${map} ${x} ${y}`); },
    getequipisequiped: (p) => !!w.gear?.[p],
    getequipisenableref: (p) => !!w.gear?.[p] && ITEMS.get(w.gear[p]!.id)!.refineable,
    getequiprefinerycnt: (p) => w.gear?.[p]?.refine ?? 0,
    getequipweaponlv: (p) => (w.gear?.[p] && ITEMS.get(w.gear[p]!.id)!.type === "Weapon" ? ITEMS.get(w.gear[p]!.id)!.weaponLevel : 0),
    getequiparmorlv: (p) => (w.gear?.[p] && ITEMS.get(w.gear[p]!.id)!.type === "Armor" ? ITEMS.get(w.gear[p]!.id)!.armorLevel : 0),
    getequipid: (p) => w.gear?.[p]?.id ?? 0,
    getequipname: (p) => (w.gear?.[p] ? itemDisplayName(ITEMS.get(w.gear[p]!.id)!, [], w.gear[p]!.refine) : ""),
    getequippercentrefinery: (p) => (w.gear?.[p] ? refinePercent(ITEMS.get(w.gear[p]!.id)!, w.gear[p]!.refine) : 0),
    getequiprefinecost: (p, info) => { const c = w.gear?.[p] && refineCost(ITEMS.get(w.gear[p]!.id)!, w.gear[p]!.refine); return !c ? 0 : info ? c.material : c.price; },
    successrefitem: (p) => { log.push(`successrefitem ${p}`); return ++w.gear![p]!.refine; },
    failedrefitem: (p) => { log.push(`failedrefitem ${p}`); delete w.gear![p]; },
  };
}
/** Click an NPC (or walk into its area: `touch`) and play its script with these menu answers. Returns this talk's log. */
async function talk(w: World, npcId: string, choices: number[] = [], touch = false) {
  const n = NPC_BY_ID.get(npcId)!, from = w.log.length;
  const entry = touch ? n.onTouch ?? n.script! : n.script!;
  await entry(mock(w, npcId, choices)).catch((e) => { if (!(e instanceof End)) throw e; });
  assert.deepEqual(choices, [], `${npcId}: menu answers left over`);
  return w.log.slice(from);
}
/** The icon each NPC shows the character now (first questinfo entry whose condition holds), QTYPE.NONE when none. */
function marks(w: World) {
  const v = reader(w), out: Record<string, number> = {};
  for (const n of NPCS) if (n.questinfo) out[n.id] = n.questinfo.find((q) => !q.condition || q.condition(v))?.icon ?? QTYPE.NONE;
  return out;
}
/** Exactly these NPCs show these icons, every other one shows none. */
function expectMarks(w: World, want: Record<string, number>, when: string) {
  const got = Object.fromEntries(Object.entries(marks(w)).filter(([, i]) => i !== QTYPE.NONE));
  assert.deepEqual(got, want, `marks ${when}`);
}
const paid = (log: string[]) => log.filter((l) => /^(getexp|getitem|set Zeny|completequest|setquest|delitem)/.test(l));

const icon = (v: QuestInfoView) => GUIDE_QUESTINFO.find((q) => !q.condition || q.condition(v))?.icon ?? QTYPE.NONE;
test("Guide Lio's questinfo: ! new work, nothing while busy, ? ready to report", () => {
  const view = (have: Record<number, number>, hunt: Record<number, number> = {}, items: Record<string, number> = {}) =>
    reader({ ...newWorld(), quests: have, hunt, items });
  assert.equal(icon(view({})), QTYPE.QUEST);
  assert.equal(icon(view({ [Q_PATROL]: 1 })), QTYPE.NONE);
  assert.equal(icon(view({ [Q_PATROL]: 1 }, { [Q_PATROL]: 2 })), QTYPE.QUEST2);
  assert.equal(icon(view({ [Q_PATROL]: 2 })), QTYPE.QUEST);
  assert.equal(icon(view({ [Q_PATROL]: 2, [Q_BEADS]: 1 }, {}, { "Gel Bead": 9 })), QTYPE.NONE);
  assert.equal(icon(view({ [Q_PATROL]: 2, [Q_BEADS]: 1 }, {}, { "Gel Bead": 10 })), QTYPE.QUEST2);
  assert.equal(icon(view({ [Q_PATROL]: 2, [Q_BEADS]: 2, [Q.THANKS]: 1 })), QTYPE.NONE);
  assert.equal(icon(view({ [Q_PATROL]: 2, [Q_BEADS]: 2 })), QTYPE.QUEST); // the hand-over to Mira never happened
});

test("Guide Lio: intro pages, menu, Bloom Patrol accepted; report pays the listed rewards and offers the beads", async () => {
  const w = newWorld();
  let log = await talk(w, NPC.guide, [1, 2, 1]); // Where am I? -> (pages) -> Any work? -> accept
  assert.equal(log[0], "cutin guide_lio 2");
  assert.ok(log.includes("set f1_guide 1"));
  assert.equal(log.filter((l) => l === "next").length >= 5, true);
  assert.ok(log.includes(`setquest ${Q_PATROL}`));
  assert.equal(log.at(-1), "close3");
  log = await talk(w, NPC.guide, [2]); // second talk while hunting: no intro, the menu, a reminder
  assert.ok(!log.includes("set f1_guide 1"));
  assert.ok(log.some((l) => l.includes("still out there")));
  w.hunt[Q_PATROL] = 2; // targets done: report first, rewards from quest_db Info, then the bead quest is offered and taken
  log = await talk(w, NPC.guide, [1]);
  assert.deepEqual(paid(log), [`completequest ${Q_PATROL}`, "getexp 600 30", "set Zeny 150", "getitem Red Tonic 3", `setquest ${Q_BEADS}`]);
  assert.ok(log.includes("cutin guide_lio_cheer 2"), "a report gets the cheering face");
  w.items["Gel Bead"] = 9;
  log = await talk(w, NPC.guide, [2]);
  assert.ok(log.some((l) => l.includes("^4d4dff9^000000 of 10")));
  w.items["Gel Bead"] = 10;
  log = await talk(w, NPC.guide);
  assert.deepEqual(paid(log), ["delitem Gel Bead 10", `completequest ${Q_BEADS}`, "getexp 1200 50", "set Zeny 450",
    "getitem Orange Tonic 2", "getitem Blink Feather 1", `setquest ${Q.THANKS}`]);
  assert.equal(w.items["Gel Bead"], 0);
});

test("Chapter 1 plays through every NPC script; the marks always point at the next NPC", async () => {
  const w = newWorld();
  const done = (id: number) => assert.equal(w.quests[id], 2, `quest ${id} completed`);
  const held = (id: number) => assert.equal(w.quests[id], 1, `quest ${id} held`);
  // a new character: Lio calls out when it walks into his area (OnTouch) and shows "!"
  expectMarks(w, { [NPC.guide]: QTYPE.QUEST }, "at login");
  let log = await talk(w, NPC.guide, [], true);
  assert.deepEqual(log.filter((l) => l.startsWith("npctalk") || l.startsWith("emotion")).length, 2);
  // 1001 / 1002 with Lio
  await talk(w, NPC.guide, [2, 1]);
  expectMarks(w, {}, "while patrolling");
  w.hunt[Q.PATROL] = 2;
  expectMarks(w, { [NPC.guide]: QTYPE.QUEST2 }, "patrol done");
  await talk(w, NPC.guide, [1]);
  w.items["Gel Bead"] = 10;
  await talk(w, NPC.guide);
  done(Q.BEADS); held(Q.THANKS);
  // 1003 Mira thanks you with a Hat; 1004 wear it (a tutorial page with a centre illustration)
  expectMarks(w, { [NPC.merchant]: QTYPE.QUEST2 }, "talk to Mira");
  log = await talk(w, NPC.merchant);
  assert.deepEqual(paid(log), [`completequest ${Q.THANKS}`, "getitem Hat 1", `setquest ${Q.DRESSED}`]);
  assert.ok(log.includes(`cutin tut_equip 3`) && log.includes("cutin mira 2"));
  expectMarks(w, {}, "Hat not worn yet");
  log = await talk(w, NPC.merchant, [3]); // not worn: her greeting reminds you, Buy / Sell / Cancel
  assert.ok(log.some((l) => l.includes("put on that ^4d4dffHat")) && log.some((l) => l.startsWith("select Buy/Sell/Cancel")));
  w.worn.add("Hat");
  assert.equal(taskProgress(QUEST_INFO.get(Q.DRESSED)!.Tasks![0], { statusPoint: 0, baseLevel: 1, hp: 1, maxHp: 1, countitem: () => 0, isequipped: () => true }).done, true);
  expectMarks(w, { [NPC.merchant]: QTYPE.QUEST2 }, "Hat worn");
  log = await talk(w, NPC.merchant, [1]); // report, then she asks for the delivery: accept
  assert.deepEqual(paid(log), [`completequest ${Q.DRESSED}`, "getexp 400 10", "set Zeny 550", "getitem Red Tonic 5", "getitem Supply Crate 1", `setquest ${Q.CRATE}`]);
  // 1005 deliver the crate to Vessa (her OnTouch spots it), 1006 spend status points
  expectMarks(w, { [NPC.ranger]: QTYPE.QUEST2 }, "deliver the crate");
  log = await talk(w, NPC.ranger, [], true);
  assert.ok(log.some((l) => l.startsWith("npctalk Ranger Vessa : Is that Mira's crate?")));
  w.params.StatusPoint = 9;
  log = await talk(w, NPC.ranger);
  assert.deepEqual(paid(log), ["delitem Supply Crate 1", `completequest ${Q.CRATE}`, "getexp 800 20", "set Zeny 750", `setquest ${Q.STATS}`]);
  assert.ok(log.includes("cutin tut_status 3"));
  expectMarks(w, {}, "points unspent");
  log = await talk(w, NPC.ranger);
  assert.ok(log.some((l) => l.includes("still have ^4d4dff9^000000 status points")));
  w.params.StatusPoint = 1;
  expectMarks(w, { [NPC.ranger]: QTYPE.QUEST2 }, "points spent");
  log = await talk(w, NPC.ranger, [1]); // done, then the fire hunt is offered: accept
  assert.deepEqual(paid(log), [`completequest ${Q.STATS}`, "getexp 400 10", "getitem Orange Tonic 1", `setquest ${Q.EMBERS}`]);
  // 1007 six Fire monsters + four Ember Coals
  expectMarks(w, {}, "hunting embers");
  w.hunt[Q.EMBERS] = 2; w.items["Ember Coal"] = 3;
  expectMarks(w, {}, "kills done, 3 coals");
  w.items["Ember Coal"] = 4;
  expectMarks(w, { [NPC.ranger]: QTYPE.QUEST2 }, "embers ready");
  log = await talk(w, NPC.ranger);
  assert.deepEqual(paid(log), ["delitem Ember Coal 4", `completequest ${Q.EMBERS}`, "getexp 2200 40", "set Zeny 1150", "getitem Guard 1", `setquest ${Q.LOOKOUT}`]);
  // 1008 the old lookout: an OnTouch area (no label: its script runs); a bramble takes 40% HP
  expectMarks(w, {}, "scouting");
  w.params.Hp = 70; w.params.MaxHp = 70;
  log = await talk(w, NPC.lookout, [], true);
  assert.deepEqual(paid(log), [`completequest ${Q.LOOKOUT}`, "getexp 600 0", `setquest ${Q.TRAIL}`]);
  assert.ok(log.includes("percentheal -40") && log.includes("emotion 0 me"));
  assert.equal(w.params.Hp, 42);
  assert.equal(log.at(-1), "close");
  log = await talk(w, NPC.lookout, [], true); // walking in again does nothing
  assert.deepEqual(log, []);
  // 1009 Tamsin; 1010 tea from the shortcut bar + sit until HP is full
  expectMarks(w, { [NPC.herbalist]: QTYPE.QUEST2 }, "find Tamsin");
  log = await talk(w, NPC.herbalist);
  assert.deepEqual(paid(log), [`completequest ${Q.TRAIL}`, "getitem Herb Tea 1", `setquest ${Q.REST}`]);
  assert.ok(log.includes("cutin tut_hotkey 3") && log.includes("cutin tut_sit 3"));
  expectMarks(w, {}, "tea and rest");
  log = await talk(w, NPC.herbalist);
  assert.ok(log.some((l) => l.includes("Drink your tea first")));
  w.items["Herb Tea"] = 0; w.params.Hp = 60;
  log = await talk(w, NPC.herbalist);
  assert.ok(log.some((l) => l.includes("Basic Training Lv 3")), "sitting needs Basic Training 3 (basic_skill_check)");
  w.skills = { NV_BASIC: 3 };
  log = await talk(w, NPC.herbalist);
  assert.ok(log.some((l) => l.includes("(HP 60 / 70)")));
  w.params.Hp = 70;
  expectMarks(w, { [NPC.herbalist]: QTYPE.QUEST2 }, "rested");
  log = await talk(w, NPC.herbalist, [1]);
  assert.deepEqual(paid(log), [`completequest ${Q.REST}`, "getexp 700 10", "getitem Red Herb 5", `setquest ${Q.PESTS}`]);
  // 1011 Tumhogs + Loamblooms; 1012 news for Lio; 1013 the warden's gate
  expectMarks(w, {}, "hunting pests");
  w.hunt[Q.PESTS] = 2;
  expectMarks(w, { [NPC.herbalist]: QTYPE.QUEST2 }, "pests done");
  log = await talk(w, NPC.herbalist);
  assert.deepEqual(paid(log), [`completequest ${Q.PESTS}`, "getexp 2800 40", "set Zeny 1650", "getitem Yellow Tonic 2", `setquest ${Q.NEWS}`]);
  expectMarks(w, { [NPC.guide]: QTYPE.QUEST2 }, "news for Lio");
  log = await talk(w, NPC.guide);
  assert.deepEqual(paid(log), [`completequest ${Q.NEWS}`, "getexp 800 0", "set Zeny 1850", "getitem Homing Feather 1", `setquest ${Q.GATE}`]);
  assert.ok(log.includes("cutin guide_lio_think 2") && log.includes("cutin guide_lio_cheer 2"));
  expectMarks(w, { [NPC.warden]: QTYPE.QUEST2 }, "meet Orrin");
  // 1014: below the gate level he sends you hunting; at it, the chapter ends
  w.params.BaseLevel = F1_GATE_LEVEL - 1;
  log = await talk(w, NPC.warden);
  assert.deepEqual(paid(log), [`completequest ${Q.GATE}`, `setquest ${Q.PROVEN}`]);
  assert.ok(log.some((l) => l.includes(`Come back at ^4d4dffBase Lv ${F1_GATE_LEVEL}`)));
  expectMarks(w, {}, "below the gate level");
  w.params.BaseLevel = F1_GATE_LEVEL;
  expectMarks(w, { [NPC.warden]: QTYPE.QUEST2 }, "gate level reached");
  log = await talk(w, NPC.warden);
  assert.deepEqual(paid(log), [`completequest ${Q.PROVEN}`, "getexp 3000 0", "set Zeny 2850", "getitem Cutter 1", `setquest ${TQ.HEARTH}`]);
  assert.ok(log.some((l) => l.startsWith("mes -! Chapter 1 complete !-")));
  // the whole chapter is done; the next Main step (C08) is Hearthmoor: a "?" over Hearthkeeper Bren
  for (const id of CHAPTER1) done(id);
  assert.equal(chapter1Step(reader(w)), undefined);
  expectMarks(w, { [TOWN_NPC.hearthkeeper]: QTYPE.QUEST2, [TOWN_NPC.pella]: QTYPE.QUEST }, "after the chapter");
  log = await talk(w, NPC.warden); // W01: the south gate is an ordinary warp; Orrin only warns about the road
  assert.deepEqual(log.filter((l) => l.startsWith("warp")), []);
  assert.ok(log.some((l) => l.includes("stays sealed")));
  // Bren: welcome gift, then the Drillmaster's lesson; her menu (save point) follows
  log = await talk(w, TOWN_NPC.hearthkeeper, [1]);
  assert.deepEqual(paid(log), [`completequest ${TQ.HEARTH}`, "set Zeny 3150", "getitem Red Tonic 5", `setquest ${TQ.LESSON}`]);
  assert.ok(log.includes(`savepoint f1_town01 ${TOWN_SAVE.x} ${TOWN_SAVE.y}`));
  // the lesson: Kessa explains the skill points until Job Lv 10 + Basic Training 9, then hands over "A Calling"
  w.params.JobLevel = 10; w.skills = { NV_BASIC: 3 };
  expectMarks(w, { [TOWN_NPC.pella]: QTYPE.QUEST }, "lesson held");
  log = await talk(w, TOWN_NPC.drillmaster);
  assert.ok(log.some((l) => l.includes("Basic Training Lv ^4d4dff3")) && !paid(log).length);
  w.skills = { NV_BASIC: 9 };
  expectMarks(w, { [TOWN_NPC.drillmaster]: QTYPE.QUEST2, [TOWN_NPC.pella]: QTYPE.QUEST }, "lesson done");
  log = await talk(w, TOWN_NPC.drillmaster);
  assert.deepEqual(paid(log), [`completequest ${TQ.LESSON}`, "getexp 1500 0", "set Zeny 3650", "getitem Orange Tonic 3", `setquest ${CALLING}`]);
  // Job Lv 10 + Basic Training 9 + "A Calling": a green "!" over every master; a wrong answer changes nothing, the right one changes the job
  expectMarks(w, { ...Object.fromEntries(MASTERS.map((m) => [m.npc, QTYPE.JOB])), [TOWN_NPC.pella]: QTYPE.QUEST }, "training done");
  const brannoc = MASTERS.find((m) => m.job === "Swordman")!;
  log = await talk(w, brannoc.npc, [2, 1]);
  assert.ok(!log.some((l) => l.startsWith("jobchange")), "wrong answer: no job change");
  log = await talk(w, brannoc.npc, [2, brannoc.answer, 1]);
  assert.ok(log.includes("jobchange Swordman"));
  assert.deepEqual(paid(log), ["getitem Sword 1", `completequest ${CALLING}`]);
  w.params.BaseJob = 1; // Job_Swordman
  expectMarks(w, { [TOWN_NPC.pella]: QTYPE.QUEST }, "after the job change");
  // Hearthmoor's side work: Pella's errand ("!" Pella -> "?" Garr), then Garr's Sootcap hunt
  log = await talk(w, TOWN_NPC.pella, [1]);
  assert.deepEqual(paid(log), [`setquest ${TQ.DINNER}`]);
  expectMarks(w, { [TOWN_NPC.garr]: QTYPE.QUEST2 }, "dinner bell");
  log = await talk(w, TOWN_NPC.garr, [1]);
  assert.deepEqual(paid(log), [`completequest ${TQ.DINNER}`, "getexp 200 0", "set Zeny 3750", `setquest ${TQ.SOOT}`]);
  expectMarks(w, {}, "sootcaps held");
  w.hunt[TQ.SOOT] = 2;
  expectMarks(w, { [TOWN_NPC.garr]: QTYPE.QUEST2 }, "sootcaps done");
  log = await talk(w, TOWN_NPC.garr);
  assert.deepEqual(paid(log), [`completequest ${TQ.SOOT}`, "getexp 900 20", "set Zeny 4050", "getitem Blink Feather 2"]);
  expectMarks(w, {}, "town work done");
  // Bren's fire: free for a Novice, HEAL_FEE zeny for a guild climber (BaseJob 1 now)
  w.params.Hp = 1;
  log = await talk(w, TOWN_NPC.hearthkeeper, [2]);
  assert.deepEqual(log.filter((l) => /^(set Zeny|percentheal)/.test(l)), [`set Zeny ${4050 - HEAL_FEE}`, "percentheal 100"]);
  assert.equal(w.params.Hp, w.params.MaxHp);
  for (const n of NPCS) if (n.script && n.sprite) assert.ok((await talk(w, n.id, n.id === NPC.merchant ? [3] : n.id === NPC.guide ? [3] : n.id === TOWN_NPC.hearthkeeper ? [3] : n.id === TOWN_NPC.garr ? [] : [])).some((l) => l.startsWith("mes")), `${n.id} still talks`);
});

test("W03: Warden Orrin's seal: offered at Base Lv 15 after the chapter, 8 Dustcoils, then the stair takes the climber down", async () => {
  const w = newWorld();
  for (const id of [...CHAPTER1, TQ.HEARTH]) w.quests[id] = 2;
  w.params.BaseLevel = SEAL_LEVEL - 1;
  // the stair: sealed for everyone Orrin has not let through; it says so and points at him
  let log = await talk(w, "f1_stair", [], true);
  assert.ok(log.some((l) => l.includes("not open yet")) && !log.some((l) => l.startsWith("warp")));
  expectMarks(w, { [TOWN_NPC.pella]: QTYPE.QUEST }, "below the seal level");
  log = await talk(w, NPC.warden);
  assert.ok(log.some((l) => l.includes("stays sealed")) && !paid(log).length);
  w.params.BaseLevel = SEAL_LEVEL;
  expectMarks(w, { [NPC.warden]: QTYPE.QUEST, [TOWN_NPC.pella]: QTYPE.QUEST }, "seal level reached");
  log = await talk(w, NPC.warden);
  assert.deepEqual(paid(log), [`setquest ${SEAL}`]);
  expectMarks(w, { [TOWN_NPC.pella]: QTYPE.QUEST }, "seal errand held");
  log = await talk(w, NPC.warden);
  assert.ok(log.some((l) => l.includes("still on")) && !paid(log).length);
  w.hunt[SEAL] = 2;
  expectMarks(w, { [NPC.warden]: QTYPE.QUEST2, [TOWN_NPC.pella]: QTYPE.QUEST }, "dustcoils done");
  log = await talk(w, NPC.warden);
  assert.deepEqual(paid(log), [`completequest ${SEAL}`, "getexp 9000 4000", "set Zeny 2000", "getitem Yellow Tonic 5"]);
  assert.equal(w.vars[SEAL_VAR], 1);
  assert.ok(log.some((l) => l.includes("<NAVI>")), "Orrin links the stair");
  log = await talk(w, "f1_stair", [], true);
  assert.deepEqual(log, [`warp ${DUNGEON_ENTRY.map} ${DUNGEON_ENTRY.x} ${DUNGEON_ENTRY.y}`], "the open stair goes straight down, no dialog");
  log = await talk(w, NPC.warden);
  assert.ok(log.some((l) => l.includes("is open to you")) && !paid(log).length);
});

test("Mira converses, then opens her floating shop with callshop (Buy = buy list, Sell = sell list)", async () => {
  const w = newWorld();
  for (const id of [Q.PATROL, Q.BEADS, Q.THANKS, Q.DRESSED, Q.CRATE]) w.quests[id] = 2;
  let log = await talk(w, NPC.merchant, [1]);
  // Johanna's order (npc/re/merchants/eden_market.txt): mes, close2, then callshop; the cutin goes with the dialog
  assert.deepEqual(log.slice(-3), ["close2", "cutin  255", `callshop ${NPC.miraShop} ${CALLSHOP.BUY}`]);
  assert.ok(log.some((l) => l.startsWith("select Buy/Sell/Cancel")));
  log = await talk(w, NPC.merchant, [2]);
  assert.ok(log.includes(`callshop ${NPC.miraShop} ${CALLSHOP.SELL}`));
  log = await talk(w, NPC.merchant, [3]);
  assert.ok(!log.some((l) => l.startsWith("callshop")) && log.at(-1) === "close3");
  // the crate went missing during the delivery: she packs another one
  w.quests[Q.CRATE] = 1;
  log = await talk(w, NPC.merchant);
  assert.ok(log.includes("getitem Supply Crate 1"));
  const shop = NPC_BY_ID.get(NPC.miraShop) as NpcDef;
  assert.equal(shop.kind, "shop");
  assert.equal(shop.map, "-");
});

test("every cutin the scripts show exists in client/public/art/cutin", async () => {
  const shown = new Set<string>();
  const w = newWorld();
  const collect = (log: string[]) => { for (const l of log) { const m = /^cutin (\S+) (\d+)$/.exec(l); if (m && m[2] !== "255") shown.add(m[1]); } };
  // the chain of the test above, plus every NPC in every state the chain passes through
  const states: Partial<Record<number, number>>[] = CHAPTER1.map((_, i) => Object.fromEntries(CHAPTER1.slice(0, i).map((id) => [id, 2])));
  for (const st of states) {
    Object.assign(w, newWorld());
    w.quests = { ...st } as Record<number, number>;
    const next = chapter1Step(reader(w));
    if (next) w.quests[next.id] = 1;
    for (const n of NPCS) if (n.script) collect(await talk(w, n.id, [], false).catch(() => []));
  }
  for (const n of ["guide_lio", "guide_lio_cheer", "guide_lio_think", "mira", "ranger_vessa", "herbalist_tamsin", "warden_orrin", "tut_equip", "tut_status", "tut_hotkey", "tut_sit"]) shown.add(n);
  for (const img of shown) assert.ok(existsSync(new URL(`art/cutin/${img}.png`, PUBLIC)), `cutin ${img}.png`);
});

/** One kill's EXP for a character of this base level (mob db EXP with the Renewal level penalty, rules/penalty.ts). */
function killExp(name: string, level: number) {
  const m = MOBS.find((x) => x.name === name)!;
  return applyExpPenalty(m.baseExp, m.jobExp, levelPenaltyMod("Exp", { baseLevel: level }, m, {}));
}

test("pacing on the Renewal exp tables: Job Lv 10 during the last hunt, the gate level within a few kills, Base Lv 8 at the end", () => {
  // the fewest kills the chain needs (Gel Bead 70% + the quest's 50% -> 9 kills for 10, Ember Coal 50% -> 8 fire kills for 4)
  const kills: Record<number, [string, number][]> = {
    [Q.PATROL]: [["Puddlebloom", 5]], [Q.BEADS]: [["Puddlebloom", 9]], [Q.EMBERS]: [["Sootcap", 8]], [Q.PESTS]: [["Tumhog", 5], ["Loambloom", 2]],
  };
  const p: Progress = { job: "Novice", level: 1, exp: 0, jobLevel: 1, jobExp: 0, statPoints: 48, skillPoints: 0 };
  const at: Record<number, { level: number; jobLevel: number }> = {};
  for (const id of CHAPTER1) {
    if (id === Q.PROVEN) while (p.level < F1_GATE_LEVEL) { const g = killExp("Tumhog", p.level); gainExp(p, g.base, g.job); }
    for (const [name, n] of kills[id] ?? []) for (let i = 0; i < n; i++) { const g = killExp(name, p.level); gainExp(p, g.base, g.job); }
    const r = QUEST_INFO.get(id)!;
    gainExp(p, r.RewardEXP ?? 0, r.RewardJEXP ?? 0);
    at[id] = { level: p.level, jobLevel: p.jobLevel };
  }
  assert.ok(at[Q.EMBERS].jobLevel < 10, `still below Job Lv 10 after the fire hunt (${at[Q.EMBERS].jobLevel})`);
  assert.equal(at[Q.PESTS].jobLevel, 10, "Job Lv 10 (the Fledgling's last) by the end of the last hunt");
  assert.ok(at[Q.GATE].level >= F1_GATE_LEVEL - 1, `at most one level short at the gate (Base ${at[Q.GATE].level})`);
  assert.ok(at[Q.PROVEN].level >= 8, `Base Lv 8+ when the chapter ends (${at[Q.PROVEN].level})`);
});

// ---------- C11: the field's roster, weapons and cards ----------
test("C11 roster: every species has sprite sheets, a spawn line on walkable cells; every item has an icon; cards and weapons are complete", async () => {
  const { ITEMS } = await import("./items.ts");
  const spawns = readFileSync(new URL("../data/spawns.txt", import.meta.url), "utf8");
  const anim = JSON.parse(readFileSync(new URL("sprites/anim/index.json", PUBLIC), "utf8")) as string[];
  assert.ok(MOBS.length >= 10 && MOBS.length <= 45, `${MOBS.length} species`);
  // C14 species the world builder (W01) has not placed yet: data + art are done, spawns.txt follows (see .cache/loop/c14_progress.md);
  // drop an id from this list once its spawn line exists (it is then checked like the rest)
  // C14 loot icons still being drawn (.cache/art/c14_icon_jobs.json -> icons_c14_*); empty this set once tools/art/build_ro.py icons has them
  const C14_ICONS_PENDING = new Set<string>([]);
  const C14_ART_PENDING = new Set<number>([]); // all shipped (2.5.0 floor 2 art landed; 2.5.4 Devo's own sheets landed)
  const unplaced = new Set<number>([]); // W01 r2 placed the last four (1047, 1014, 1094, 1024)
  const petOnly = (m: object) => (m as { petOnly?: boolean }).petOnly === true;
  const hasArt = (id: number) => anim.includes(`mob_${id}_move`) && anim.includes(`mob_${id}_act`);
  for (const m of MOBS) {
    const placed = spawns.includes(`${m.name}\t${m.id},`);
    assert.ok(unplaced.has(m.id) || placed || petOnly(m), `${m.name} has a spawn line`); // 2.4.0: a legendary pet's species never spawns
    assert.ok(C14_ART_PENDING.has(m.id) || hasArt(m.id), `${m.name} has move + act sheets`);
    // W03: a placed species whose art is still pending is drawn with a look-alike's sheets (shared/mobart.ts), never invisible
    if (placed && !hasArt(m.id) && !SPRITES.includes(`mob_${m.id}`)) assert.ok(m.id in ART_STANDIN && hasArt(ART_STANDIN[m.id]), `${m.name}: a stand-in with art while its own is pending`);
    for (const d of m.drops) assert.ok(ITEMS.has(d.item), `${m.name} drops a known item`);
  }
  for (const id of Object.keys(ART_STANDIN).map(Number)) assert.ok(C14_ART_PENDING.has(id), `stand-in for ${id}: only while its art is pending`);
  // spread: passive + aggressive, immobile + mobile, every size class used, level 1..25
  const has = (f: (m: (typeof MOBS)[number]) => boolean) => MOBS.some(f);
  assert.ok(has((m) => (m.mode & 4) !== 0) && has((m) => (m.mode & 4) === 0 && (m.mode & 1) !== 0) && has((m) => (m.mode & 1) === 0));
  assert.deepEqual([...new Set(MOBS.map((m) => m.size))].sort(), ["Large", "Medium", "Small"]);
  assert.ok(Math.min(...MOBS.map((m) => m.level)) === 1 && Math.max(...MOBS.filter((m) => m.bossType === "None" && !petOnly(m)).map((m) => m.level)) <= 45); // 2.5.0: floor 2 goes to Lv 45
  for (const it of ITEMS.values()) {
    assert.ok(it.name in ICONS || C14_ICONS_PENDING.has(it.name), `icon for ${it.name}`);
    if (it.type === "Card") { assert.ok(it.affix && (it.mobId === null || MOBS.some((m) => m.id === it.mobId)), `${it.name}: affix + monster (mobId null = a card of a monster we do not ship, 2.4.0 CARDS)`); assert.ok(it.locations.length, it.name); }
    if (it.type === "Weapon") assert.ok(it.jobs.length > 0 && it.atk + it.matk > 0, `${it.name}: a job wields it`);
  }
  // the full low-level weapon spread is on sale (types our seven jobs wield)
  const sold = new Set([...ITEMS.values()].filter((i) => i.shop && i.type === "Weapon").map((i) => i.subType));
  for (const t of ["Dagger", "1hSword", "2hSword", "1hSpear", "2hSpear", "1hAxe", "2hAxe", "Mace", "Staff", "Bow"]) assert.ok(sold.has(t), `${t} sold`);
});

// ---------- Forgemaster Brann (the refiner) ----------
test("Brann refines the worn weapon: ore + zeny paid, +1 on success, safe levels never warn", async () => {
  const knife = itemNamed("Knife")!.id, ore = refineCost(ITEMS.get(knife)!, 0)!, oreName = ITEMS.get(ore.material)!.name;
  const w: World = { ...newWorld(), gear: { weapon: { id: knife, refine: 0 } }, items: { [oreName]: 3 }, params: { ...newWorld().params, Zeny: 1000 } };
  // menu: Refine -> the weapon is entry 4 (head top, armor, shield, weapon) -> Yes
  const log = await talk(w, TOWN_NPC.refiner, [1, 4, 1]);
  assert.ok(log.includes(`set Zeny ${1000 - ore.price}`) && log.includes(`delitem ${oreName} 1`) && log.includes("successrefitem weapon"), log.join("\n"));
  assert.ok(!log.some((l) => /destroyed/.test(l)), "no warning at a safe level");
  assert.equal(w.gear!.weapon!.refine, 1);
});

test("Brann warns past the safe limit, and a failed roll destroys the piece", async () => {
  const knife = itemNamed("Knife")!.id, ore = ITEMS.get(refineCost(ITEMS.get(knife)!, 7)!.material)!.name;
  const w: World = { ...newWorld(), gear: { weapon: { id: knife, refine: 7 } }, items: { [ore]: 1 }, params: { ...newWorld().params, Zeny: 100 } };
  const rnd = Math.random;
  Math.random = () => 0.99; // rand(100) = 99 -> the 60 % roll fails
  try { var log = await talk(w, TOWN_NPC.refiner, [1, 4, 1, 1]); } finally { Math.random = rnd; }
  assert.ok(log.some((l) => /lose the weapon/.test(l)), "risk warning");
  assert.ok(log.includes("failedrefitem weapon") && !w.gear!.weapon);
  assert.equal(w.items[ore], 0);
});

test("Brann refuses without the ore or at +10, and purifies five chunks", async () => {
  const knife = itemNamed("Knife")!.id;
  let w: World = { ...newWorld(), gear: { weapon: { id: knife, refine: 0 } }, params: { ...newWorld().params, Zeny: 1000 } };
  let log = await talk(w, TOWN_NPC.refiner, [1, 4, 1]);
  assert.ok(log.some((l) => /enough zeny or/.test(l)) && !log.some((l) => /successrefitem/.test(l)));
  w = { ...newWorld(), gear: { weapon: { id: knife, refine: 10 } } };
  log = await talk(w, TOWN_NPC.refiner, [1, 4]);
  assert.ok(log.some((l) => /as refined as it gets/.test(l)));
  w = { ...newWorld(), items: { "Starsteel Chunk": 5 } };
  log = await talk(w, TOWN_NPC.refiner, [3, 2]);
  assert.ok(log.includes("delitem Starsteel Chunk 5") && log.includes("getitem Starsteel 1"));
});

test("Brann's ore shop sells every ore a refine level asks for", () => {
  const shop = NPC_BY_ID.get("town_ore_shop")!.shop!.map((i) => ITEMS.get(i as number)!.name);
  for (const g of ["Weapon", "Armor"]) for (const lv of Object.values(TABLES.refineChances[g]).slice(0, 4)) for (const [r, c] of Object.entries(lv)) {
    if (Number(r) <= 10 && c.material) assert.ok(shop.includes(ITEMS.get(c.material)!.name), `${g} +${r}: ${ITEMS.get(c.material)!.name}`);
  }
});

// ---------- 2.5.0 Floor 2: the Ascent Stair, Lanternrest, Sentinel Corwin's chain, the warp crystals ----------
test("2.5.0 Ascent Stair: sealed without f1_seal, short of Base Lv 25 it says so, otherwise it sets f2_visit, starts 2001 and warps to Lanternrest", async () => {
  const { F2_ARRIVAL } = await import("../maps.ts");
  const { F2_GATE_LEVEL, F2_VAR, NPC2, Q2 } = await import("../content/f2/chapter2.ts");
  const w = newWorld();
  w.params.BaseLevel = 40;
  let log = await talk(w, NPC2.ascent, [], true);
  assert.ok(log.some((l) => l.includes("not open yet")) && !log.some((l) => l.startsWith("warp")), "no seal: sealed");
  w.vars[SEAL_VAR] = 1;
  w.params.BaseLevel = F2_GATE_LEVEL - 1;
  log = await talk(w, NPC2.ascent, [], true);
  assert.ok(log.some((l) => l.includes(`Base Lv ${F2_GATE_LEVEL}`)) && !log.some((l) => l.startsWith("warp") || l.startsWith("setquest")), "seal but too low");
  w.params.BaseLevel = F2_GATE_LEVEL;
  log = await talk(w, NPC2.ascent, [], true);
  assert.deepEqual(log, [`set f2_visit 1`, `setquest ${Q2.ARRIVE}`, `warp ${F2_ARRIVAL.map} ${F2_ARRIVAL.x} ${F2_ARRIVAL.y}`]);
  assert.equal(w.vars[F2_VAR], 1);
  // up again after 2001 is done: no second quest row
  w.quests[Q2.ARRIVE] = 2;
  log = await talk(w, NPC2.ascent, [], true);
  assert.deepEqual(log, [`set f2_visit 1`, `warp ${F2_ARRIVAL.map} ${F2_ARRIVAL.x} ${F2_ARRIVAL.y}`]);
});

test("2.5.0 Sentinel Corwin: arrival report, Ashbeetle hunt, vault boss; marks follow; rewards are the listed ones", async () => {
  const { NPC2, Q2, F2_VAULT_VAR } = await import("../content/f2/chapter2.ts");
  const w = newWorld();
  w.params.BaseLevel = 25;
  w.quests[Q2.ARRIVE] = 1;
  assert.equal(marks(w)[NPC2.sentinel], QTYPE.QUEST2, "arrived");
  let log = await talk(w, NPC2.sentinel, [], true); // OnTouch: only a greeting
  assert.ok(log.some((l) => l.startsWith("npctalk Sentinel Corwin")));
  // report + offer in one talk: 2001 paid, then "I'll do it" takes the hunt
  log = await talk(w, NPC2.sentinel, [1]);
  assert.deepEqual(paid(log), [`completequest ${Q2.ARRIVE}`, "getexp 4000 1200", "set Zeny 1500", "getitem Yellow Tonic 3", `setquest ${Q2.TERRACES}`]);
  assert.equal(marks(w)[NPC2.sentinel], QTYPE.NONE, "hunting the terraces");
  log = await talk(w, NPC2.sentinel);
  assert.ok(log.some((l) => l.includes("Six Ashbeetles")) && !paid(log).length);
  w.hunt[Q2.TERRACES] = 2;
  assert.equal(marks(w)[NPC2.sentinel], QTYPE.QUEST2, "terraces done");
  log = await talk(w, NPC2.sentinel, [1]);
  assert.deepEqual(paid(log), [`completequest ${Q2.TERRACES}`, "getexp 24000 7000", "set Zeny 4500", "getitem Orange Tonic 5", `setquest ${Q2.VAULT}`]);
  w.hunt[Q2.VAULT] = 0;
  log = await talk(w, NPC2.sentinel);
  assert.ok(log.some((l) => l.includes("still alive")) && !paid(log).length);
  w.hunt[Q2.VAULT] = 2;
  log = await talk(w, NPC2.sentinel);
  assert.deepEqual(paid(log), [`completequest ${Q2.VAULT}`, "getexp 60000 20000", "set Zeny 12500", "getitem Yellow Tonic 10"]);
  assert.equal(w.vars[F2_VAULT_VAR], 1);
  assert.equal(marks(w)[NPC2.sentinel], QTYPE.NONE, "chain done");
  log = await talk(w, NPC2.sentinel);
  assert.ok(!paid(log).length);
  // a "no thanks" at the offer leaves the quest unstarted and the "!" up
  const v = newWorld();
  v.quests[Q2.ARRIVE] = 2;
  assert.equal(marks(v)[NPC2.sentinel], QTYPE.QUEST, "offer waiting");
  log = await talk(v, NPC2.sentinel, [2]);
  assert.ok(!paid(log).length && v.quests[Q2.TERRACES] === undefined);
});

test("2.5.0 Lamplighter Isolde saves at Lanternrest and heals for a fee; the warp crystals are dark until f2_visit, then go between the towns", async () => {
  const { F2_SAVE, TOWN } = await import("../maps.ts");
  const { CRYSTAL_LANDING, F2_VAR, NPC2 } = await import("../content/f2/chapter2.ts");
  const { F2_TOWN } = await import("../floor2.ts");
  const w = newWorld();
  w.params.Zeny = 500; w.params.Hp = 1; w.params.MaxHp = 100;
  let log = await talk(w, NPC2.keeper, [1]);
  assert.ok(log.includes(`savepoint ${F2_SAVE.map} ${F2_SAVE.x} ${F2_SAVE.y}`));
  log = await talk(w, NPC2.keeper, [2]);
  assert.deepEqual(log.filter((l) => /^(set Zeny|percentheal)/.test(l)), [`set Zeny ${500 - HEAL_FEE}`, "percentheal 100"]);
  for (const id of [NPC2.crystal, NPC2.crystal1]) {
    log = await talk(w, id);
    assert.ok(log.some((l) => l.includes("none of them are lit")) && !log.some((l) => l.startsWith("warp")), `${id} dark before floor 2`);
  }
  w.vars[F2_VAR] = 1;
  log = await talk(w, NPC2.crystal1, [1]); // Hearthmoor's crystal -> Lanternrest
  assert.equal(log.at(-1), `warp ${F2_TOWN} ${CRYSTAL_LANDING[F2_TOWN].x} ${CRYSTAL_LANDING[F2_TOWN].y}`);
  log = await talk(w, NPC2.crystal, [1]); // Lanternrest's -> Hearthmoor
  assert.equal(log.at(-1), `warp ${TOWN} ${CRYSTAL_LANDING[TOWN].x} ${CRYSTAL_LANDING[TOWN].y}`);
  log = await talk(w, NPC2.crystal, [2]);
  assert.ok(!log.some((l) => l.startsWith("warp")), "Cancel stays");
  // the landing cells are walkable and clear of every other NPC
  for (const c of Object.values(CRYSTAL_LANDING)) {
    assert.ok(walkable(mapNamed(c.map), c.x, c.y), `landing ${c.map} ${c.x},${c.y}`);
    assert.ok(!NPCS.some((n) => n.map === c.map && n.x === c.x && n.y === c.y), "landing is not an NPC's cell");
  }
});
