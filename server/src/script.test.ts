// The NPC script engine (server/src/script.ts) with a fake host and no database: OnTouch areas and the event queue of a busy
// player (npc.cpp npc_touch_area_allnpc / npc_touch_areanpc / npc_event_sub / npc_event_dequeue, script.cpp
// script_detach_state), and the commands the floor 1 content added (emotion, npctalk, playerattached, heal, percentheal,
// isequipped, callshop) as they reach the room.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GAME_NAME ??= "ro";
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.REDIS_URL ??= "redis://unused";
const { ScriptEngine } = await import("./script.ts");
const { QuestStore } = await import("./quests.ts");
const { BC, CALLSHOP, ET, EVENTQUEUE_DELAY } = await import("../../shared/rules/script.ts");
const { Msg } = await import("../../shared/protocol.ts");
import type { NpcDef, NpcScript } from "../../shared/content/api.ts";
import type { ScriptHost, PcView } from "./script.ts";
import type { Inventory } from "./inventory.ts";

type Call = [string, ...unknown[]];
/** A host that records what the engine asks of the room; timers run when the test advances the clock. */
function host() {
  const calls: Call[] = [];
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const pcs = new Map<string, PcView>();
  const invs = new Map<string, Inventory>();
  const h: ScriptHost = {
    mapName: "f1_field01",
    now: () => now,
    send: (sid, type, msg) => calls.push(["send", sid, type, msg]),
    near: () => true,
    pc: (sid) => pcs.get(sid),
    inv: (sid) => invs.get(sid),
    gainExp: (sid, b, j) => calls.push(["gainExp", sid, b, j]),
    invChanged: () => {},
    gearChanged: () => {},
    notice: (sid, text) => calls.push(["notice", sid, text]),
    setInterval: () => {},
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); },
    emotion: (unit, type) => calls.push(["emotion", unit, type]),
    npcTalk: (npc, text, color, target, sid) => calls.push(["npcTalk", npc, text, color, target, sid]),
    changeHpSp: (sid, change, show) => {
      calls.push(["changeHpSp", sid, change, show]);
      const p = pcs.get(sid)!;
      p.hp += change.hp; p.sp += change.sp;
    },
    openShop: (sid, shop, option) => calls.push(["openShop", sid, shop.id, option]),
    skillLv: () => 0,
    jobChange: (sid, job) => { calls.push(["jobChange", sid, job]); return true; },
    resetLevel: (sid) => { calls.push(["resetLevel", sid]); },
    warp: (sid, map, x, y) => { calls.push(["warp", sid, map, x, y]); },
    savepoint: (sid, map, x, y) => { calls.push(["savepoint", sid, map, x, y]); },
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    await new Promise((ok) => setTimeout(ok, 0));
  };
  return { h, calls, pcs, invs, advance };
}
const pcView = (over: Partial<PcView> = {}): PcView => ({
  name: "Tester", job: "Novice", level: 5, jobLevel: 5, exp: 0, jobExp: 0, statPoints: 0, skillPoints: 0, hp: 70, maxHp: 70, sp: 11, maxSp: 11,
  str: 1, dead: false, ...over,
});
/** An inventory with only what the engine reads in these tests: the item rows (countitem / isequipped) and a write chain. */
const inventory = (items: { itemId: number; amount: number; equip: string | null }[]) => ({
  charId: 1, items: new Map(items.map((s, i) => [i + 1, { uid: i + 1, refine: 0, ...s }])), persist: async () => {},
}) as unknown as Inventory;
const tick = () => new Promise((ok) => setTimeout(ok, 0));

/** Two NPCs with trigger areas next to each other, an invisible one without an OnTouch label, and a floating shop. */
function npcs(log: string[]) {
  const dialog: NpcScript = async (s) => { log.push("dialog"); s.mes("[Dialog]", "Hello"); await s.next(); await s.close(); };
  const touchA: NpcScript = async (s) => { log.push("touchA"); s.emotion(ET.SURPRISE); s.npctalk("A : hi", "", BC.SELF); };
  const touchB: NpcScript = async () => { log.push("touchB"); };
  const touchC: NpcScript = async () => { log.push("touchC"); };
  const hidden: NpcScript = async (s) => { log.push("hidden"); s.emotion(ET.HUK, s.playerattached()); s.percentheal(-40, 0); };
  const list: NpcDef[] = [
    { id: "a", map: "f1_field01", name: "A", sprite: "npc_guide", x: 10, y: 10, kind: "script", script: dialog, trigger: { x: 3, y: 3 }, onTouch: touchA },
    { id: "b", map: "f1_field01", name: "B", sprite: "npc_guide", x: 14, y: 10, kind: "script", script: dialog, trigger: { x: 3, y: 3 }, onTouch: touchB },
    { id: "c", map: "f1_field01", name: "C", sprite: "npc_guide", x: 12, y: 13, kind: "script", script: dialog, trigger: { x: 0, y: 0 }, onTouch: touchC },
    { id: "h", map: "f1_field01", name: "H", sprite: "", x: 30, y: 30, kind: "script", script: hidden, trigger: { x: 1, y: 1 } },
  ];
  const shop: NpcDef = { id: "shop_x", map: "-", name: "Wares", sprite: "", x: 0, y: 0, kind: "shop", shop: ["Red Tonic"] };
  return { list, byId: new Map([...list, shop].map((n) => [n.id, n])) };
}
async function setup(items: { itemId: number; amount: number; equip: string | null }[] = []) {
  const t = host(), log: string[] = [];
  const { list, byId } = npcs(log);
  const engine = new ScriptEngine(t.h, list, byId);
  const inv = inventory(items);
  t.pcs.set("p1", pcView());
  t.invs.set("p1", inv);
  await engine.load("p1", inv, QuestStore.fromRows(inv, []));
  return { ...t, engine, log, list };
}

test("OnTouch: an area fires once per entry, overlapping areas each fire, leaving and coming back fires again", async () => {
  const { engine, log, calls } = await setup();
  engine.touch("p1", 5, 10);
  engine.touch("p1", 7, 10); // into a
  await tick();
  engine.touch("p1", 8, 10); // still in a
  engine.touch("p1", 12, 10); // the overlap: b fires, a doesn't again
  await tick();
  assert.deepEqual(log, ["touchA", "touchB"]);
  // the OnTouch commands reach the room: an emotion over the NPC (AREA) and npctalk bc_self to the touching player
  assert.deepEqual(calls.filter((c) => c[0] === "emotion"), [["emotion", "a", ET.SURPRISE]]);
  assert.deepEqual(calls.filter((c) => c[0] === "npcTalk"), [["npcTalk", "a", "A : hi", 0xffffff, "self", "p1"]]);
  engine.touch("p1", 20, 10); // out of both
  engine.touch("p1", 9, 10); // back into a
  await tick();
  assert.deepEqual(log, ["touchA", "touchB", "touchA"]);
});

test("a busy player's OnTouch events wait in the queue (2 at most) and run after the script, if still inside", async () => {
  const { engine, log, calls, advance, list } = await setup();
  engine.click("p1", list[0]); // a dialog with A
  await tick();
  assert.equal(engine.talking("p1"), true);
  const warn = console.warn, warned: string[] = [];
  console.warn = (m: string) => { warned.push(m); };
  try { engine.touch("p1", 12, 13); } finally { console.warn = warn; } // a, b and c at once while talking: a and b queued, c dropped
  await tick();
  assert.deepEqual(log, ["dialog"]);
  assert.equal(warned.length, 1);
  engine.reply("p1", "a", { kind: "next" });
  await tick();
  engine.reply("p1", "a", { kind: "close" }); // the dialog ends: the first queued event runs EVENTQUEUE_DELAY later
  await tick();
  assert.equal(engine.talking("p1"), false);
  await advance(EVENTQUEUE_DELAY - 1);
  assert.deepEqual(log, ["dialog"]);
  await advance(1);
  assert.deepEqual(log, ["dialog", "touchA"]);
  await advance(EVENTQUEUE_DELAY); // and when that one ends, the next
  assert.deepEqual(log, ["dialog", "touchA", "touchB"]);
  await advance(EVENTQUEUE_DELAY * 3); // the third never made it into the queue (MAX_EVENTQUEUE)
  assert.deepEqual(log, ["dialog", "touchA", "touchB"]);
  assert.ok(calls.some((c) => c[0] === "send" && c[2] === Msg.npcCloseBtn));
});

test("a queued OnTouch event is dropped when the player has left the area by then (npc_event_sub re-check)", async () => {
  const { engine, log, advance, list } = await setup();
  engine.click("p1", list[1]); // talking to B
  await tick();
  engine.touch("p1", 8, 10); // into a: queued
  engine.touch("p1", 30, 20); // walked away (the dialog doesn't stop a walk already under way)
  engine.reply("p1", "b", { kind: "next" });
  await tick();
  engine.reply("p1", "b", { kind: "close" });
  await tick();
  await advance(EVENTQUEUE_DELAY * 3);
  assert.deepEqual(log, ["dialog"]);
});

test("an area NPC without an OnTouch label is clicked (its script runs) when the player is free; percentheal / emotion reach the room", async () => {
  const { engine, log, calls, pcs } = await setup();
  engine.touch("p1", 31, 31);
  await tick();
  assert.deepEqual(log, ["hidden"]);
  assert.deepEqual(calls.filter((c) => c[0] === "emotion"), [["emotion", "p1", ET.HUK]]); // playerattached() as the target
  assert.deepEqual(calls.filter((c) => c[0] === "changeHpSp"), [["changeHpSp", "p1", { hp: -28, sp: 0, kill: false }, false]]);
  assert.equal(pcs.get("p1")!.hp, 42);
});

test("heal shows its numbers, isequipped reads the worn rows, callshop opens a floating shop, bad arguments only warn", async () => {
  const t = host(), log: string[] = [];
  const { list, byId } = npcs(log);
  const probe: string[] = [];
  const script: NpcScript = async (s) => {
    s.heal(10, 100);
    probe.push(`hat ${s.isequipped("Hat")}`, `hat+guard ${s.isequipped("Hat", "Guard")}`);
    probe.push(`shop ${s.callshop("shop_x", CALLSHOP.SELL)}`, `not a shop ${s.callshop("a", CALLSHOP.BUY)}`);
    s.emotion(9999);
    s.emotion(ET.QUESTION, "nobody");
    s.npctalk("x", "nowhere");
    probe.push("went on");
  };
  const npc: NpcDef = { ...list[0], id: "probe", trigger: undefined, onTouch: undefined, script };
  const engine = new ScriptEngine(t.h, [...list, npc], new Map([...byId, ["probe", npc]]));
  const inv = inventory([{ itemId: 2220, amount: 1, equip: "head_top" }, { itemId: 2101, amount: 1, equip: null }]); // Hat worn, Guard in the bag
  t.pcs.set("p1", pcView({ hp: 60, sp: 5 }));
  t.invs.set("p1", inv);
  await engine.load("p1", inv, QuestStore.fromRows(inv, []));
  const warn = console.warn;
  console.warn = () => {};
  try { engine.click("p1", npc); await tick(); } finally { console.warn = warn; }
  assert.deepEqual(probe, ["hat true", "hat+guard false", "shop true", "not a shop false", "went on"]);
  assert.deepEqual(t.calls.filter((c) => c[0] === "changeHpSp"), [["changeHpSp", "p1", { hp: 10, sp: 6, kill: false }, true]]);
  assert.deepEqual(t.calls.filter((c) => c[0] === "openShop"), [["openShop", "p1", "shop_x", CALLSHOP.SELL]]);
  assert.deepEqual(t.calls.filter((c) => c[0] === "emotion" || c[0] === "npcTalk"), []);
});
