// Golden tests for script.ts, worked out by hand from rAthena src/map/script.cpp (menu_countoptions, buildin_menu /
// buildin_select index mapping, buildin_showevent, buildin_emotion / npctalk / heal / percentheal / isequipped / callshop),
// npc.cpp npc_scriptcont / npc_touch_areanpc / npc_touch_area_allnpc, pc.cpp pc_percentheal, status.cpp status_percent_change /
// status_heal (with common/utils.hpp apply_rate), clif.cpp clif_parse_NpcSelectMenu and the examples in doc/script_commands.txt
// ("menu" section: "A::B",L_Wrong,"",L_Impossible,"C",L_Right -> @menu 1 / 3 / 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BC, CALLSHOP, ET, ET_MAX, MAX_EVENTQUEUE, MENU_CANCEL, QMARK, QTYPE, callshopOption, cutinNameValid, emotionValid, inTouchArea, isequippedIds,
  menuBuild, menuChoiceValid, menuCountOptions, menuSelect, npctalkTarget, percentHeal, scriptCont, scriptHeal, showeventArgs, touchAreas, varScope,
} from "./script.ts";

test("menu_countoptions: groups with ':' and numbered empty options", () => {
  assert.deepEqual(menuCountOptions("A::B"), { count: 2, total: 3 });
  assert.deepEqual(menuCountOptions(""), { count: 0, total: 1 });
  assert.deepEqual(menuCountOptions("::A"), { count: 1, total: 3 });
  assert.deepEqual(menuCountOptions("A:"), { count: 1, total: 2 });
  assert.deepEqual(menuCountOptions("Yes:No"), { count: 2, total: 2 });
  // stopping at the 2nd option of "A::B": B is index 3 within the argument
  assert.deepEqual(menuCountOptions("A::B", 2), { count: 2, total: 3 });
  assert.deepEqual(menuCountOptions("A::B", 1), { count: 1, total: 1 });
});

test("select builds the ZC_MENU_LIST text and npc_menu; the client shows the non-empty parts", () => {
  assert.deepEqual(menuBuild(["A::B", "", "C"]), { text: "A::B::C", npcMenu: 3, shown: ["A", "B", "C"] });
  assert.deepEqual(menuBuild(["", "B"]), { text: "B", npcMenu: 1, shown: ["B"] }); // no ':' before the first option
  assert.deepEqual(menuBuild(["Yes:No"]), { text: "Yes:No", npcMenu: 2, shown: ["Yes", "No"] });
  assert.deepEqual(menuBuild(["Where am I?", "Any work for me?", "Goodbye."]).npcMenu, 3);
});

test("@menu is consistent with grouped and empty options (doc example: A 1, B 3, C 5)", () => {
  const args = ["A::B", "", "C"];
  assert.deepEqual([1, 2, 3].map((c) => menuSelect(args, c)), [1, 3, 5]);
  assert.equal(menuSelect(["", "B"], 1), 2);
  assert.equal(menuSelect(["Yes:No"], 2), 2);
  assert.deepEqual([1, 2, 3].map((c) => menuSelect(["Where am I?", "Any work for me?", "Goodbye."], c)), [1, 2, 3]);
});

test("clif_parse_NpcSelectMenu: a choice is 1..npc_menu or 255 (cancel); 0 and anything above is forged", () => {
  assert.equal(MENU_CANCEL, 255);
  assert.deepEqual([0, 1, 3, 4, 254, 255, 256, 1.5, -1].map((c) => menuChoiceValid(c, 3)), [false, true, true, false, false, true, false, false, false]);
  assert.equal(menuChoiceValid("1", 3), false);
  assert.equal(menuChoiceValid(255, 0), true); // cancel is always accepted
});

test("npc_scriptcont state machine", () => {
  // Next / menu answer
  assert.equal(scriptCont("STOP", false), "RUN"); // next
  assert.equal(scriptCont("RERUNLINE", false), "RERUNLINE"); // menu / select: the line re-runs with the choice
  assert.equal(scriptCont("CLOSE", false), "END"); // unexpected: ends
  // Close click
  assert.equal(scriptCont("CLOSE", true), "END"); // close / close3
  assert.equal(scriptCont("STOP", true), "RUN"); // close2 continues
  assert.equal(scriptCont("RERUNLINE", true), "END");
});

test("showevent icon / colour validation (PACKETVER >= 20120410)", () => {
  assert.deepEqual(showeventArgs(QTYPE.QUEST, QMARK.YELLOW), { icon: 0, color: 1 });
  assert.deepEqual(showeventArgs(QTYPE.QUEST2), { icon: 1, color: 0 });
  assert.deepEqual([-1, 7, 9, 9999].map((i) => showeventArgs(i).icon), [9999, 9999, 9999, 9999]);
  assert.equal(showeventArgs(QTYPE.EVENT3).icon, 8);
  assert.equal(showeventArgs(0, 4).color, QMARK.NONE);
});

test("variable scopes and cutin names", () => {
  assert.equal(varScope("f1_guide"), "char");
  assert.equal(varScope("@menu"), "temp");
  assert.equal(varScope(".@x"), null);
  assert.equal(varScope("$global"), null);
  assert.equal(varScope("9lives"), null);
  assert.equal(cutinNameValid("guide_lio"), true);
  assert.equal(cutinNameValid(""), true);
  assert.equal(cutinNameValid("../secret"), false);
});

test("emotion numbers (e_emotion_type) and npctalk targets (e_broadcast_flags)", () => {
  assert.deepEqual([ET.SURPRISE, ET.QUESTION, ET.THANKS, ET.SMILE, ET.BEST, ET.OK, ET.SPARK, ET.OHNO, ET.PANIC], [0, 1, 15, 18, 21, 33, 52, 54, 79]);
  assert.equal(ET_MAX, 88);
  assert.deepEqual([0, 87, 88, -1, 1.5, "1"].map(emotionValid), [true, true, false, false, false, false]);
  // buildin_npctalk: bc_all -> ALL_CLIENT, bc_map -> ALL_SAMEMAP, bc_self -> SELF, bc_area and anything else -> AREA
  assert.deepEqual([BC.ALL, BC.MAP, BC.AREA, BC.SELF].map((f) => npctalkTarget(f)), ["all", "map", "area", "self"]);
  assert.equal(npctalkTarget(), "area");
  assert.equal(npctalkTarget(7), "area");
});

test("percentheal: % of MaxHP / MaxSP, damage never below 1 HP except -100, the C integer maths of apply_rate", () => {
  const c = { hp: 70, maxHp: 70, sp: 2, maxSp: 11 };
  // the lookout bramble: status_percent_damage(-40): apply_rate(70, 40) = 28
  assert.deepEqual(percentHeal(c, -40, 0), { hp: -28, sp: 0, kill: false });
  // -99: apply_rate(70, 99) = 69 (69.3 truncated); 69 < 70 so it stands
  assert.deepEqual(percentHeal(c, -99, 0), { hp: -69, sp: 0, kill: false });
  // flag 2 (not -100): an amount reaching the current HP leaves 1 (hp = status->hp - 1)
  assert.deepEqual(percentHeal({ ...c, hp: 10 }, -50, 0), { hp: -9, sp: 0, kill: false });
  // -100 kills: amount = max_hp, flag 1
  assert.deepEqual(percentHeal({ ...c, hp: 30 }, -100, 0), { hp: -30, sp: 0, kill: true });
  // heal: status_percent_heal(50) -> status_percent_change(-50): apply_rate(MAX, 50) = 35, capped at max - hp by status_heal
  assert.deepEqual(percentHeal({ ...c, hp: 10 }, 50, 0), { hp: 35, sp: 0, kill: false });
  assert.deepEqual(percentHeal({ ...c, hp: 50 }, 50, 0), { hp: 20, sp: 0, kill: false });
  assert.deepEqual(percentHeal({ ...c, hp: 1 }, 100, 100), { hp: 69, sp: 9, kill: false });
  // a rate that rounds to 0 still moves 1: apply_rate(40, 1) = 0 -> 1
  assert.deepEqual(percentHeal({ hp: 20, maxHp: 40, sp: 0, maxSp: 0 }, 1, 0), { hp: 1, sp: 0, kill: false });
  // crossed signs: each part on its own; SP damage is capped at the current SP (apply_rate(11, 50) = 5, but 2 left)
  assert.deepEqual(percentHeal(c, -10, 50), { hp: -7, sp: 5, kill: false });
  assert.deepEqual(percentHeal(c, 10, -50), { hp: 0, sp: -2, kill: false });
  // rates are capped to +-100 (pc_percentheal); nothing for the dead
  assert.deepEqual(percentHeal({ ...c, hp: 10 }, 150, 0), percentHeal({ ...c, hp: 10 }, 100, 0));
  assert.deepEqual(percentHeal({ ...c, hp: 0 }, 100, 100), { hp: 0, sp: 0, kill: false });
  // apply_rate above 100000: val / 100 * rate (integer division first)
  assert.deepEqual(percentHeal({ hp: 1, maxHp: 200_050, sp: 0, maxSp: 0 }, 30, 0), { hp: 60_000, sp: 0, kill: false });
});

test("heal: amounts capped at the max (status_heal), a negative HP amount is damage that can kill", () => {
  const c = { hp: 50, maxHp: 70, sp: 10, maxSp: 11 };
  assert.deepEqual(scriptHeal(c, 30, 0), { hp: 20, sp: 0, kill: false });
  assert.deepEqual(scriptHeal(c, 0, 5), { hp: 0, sp: 1, kill: false });
  assert.deepEqual(scriptHeal(c, -20, -20), { hp: -20, sp: -10, kill: false });
  assert.deepEqual(scriptHeal(c, -100, 0), { hp: -50, sp: 0, kill: true });
  assert.deepEqual(scriptHeal({ ...c, hp: 0 }, 9999, 0), { hp: 0, sp: 0, kill: false });
});

test("isequipped: every listed item worn, ids <= 0 skipped; callshop options", () => {
  const worn = [2220, 1201, 2301];
  assert.equal(isequippedIds(worn, [2220]), true);
  assert.equal(isequippedIds(worn, [2220, 1201]), true);
  assert.equal(isequippedIds(worn, [2220, 2101]), false);
  assert.equal(isequippedIds(worn, [0, 2220]), true);
  assert.equal(isequippedIds(worn, []), false);
  assert.deepEqual([CALLSHOP.MENU, CALLSHOP.BUY, CALLSHOP.SELL], [0, 1, 2]);
  assert.deepEqual([0, 1, 2, 3, -1, "1", undefined].map(callshopOption), [0, 1, 2, 0, 0, 0, 0]);
});

test("OnTouch areas: TriggerX/Y cells around the NPC; each entry fires once, leaving resets it, overlapping areas both fire", () => {
  const lookout = { id: "lookout", x: 24, y: 10, xs: 2, ys: 2 };
  assert.equal(inTouchArea(lookout, 22, 8), true);
  assert.equal(inTouchArea(lookout, 26, 12), true);
  assert.equal(inTouchArea(lookout, 21, 10), false);
  assert.equal(inTouchArea(lookout, 24, 13), false);
  assert.equal(inTouchArea({ ...lookout, xs: -1 }, 24, 10), false); // no area
  const a = { id: "a", x: 10, y: 10, xs: 3, ys: 3 }, b = { id: "b", x: 14, y: 10, xs: 3, ys: 3 };
  const inside = new Set<string>();
  assert.deepEqual(touchAreas([a, b], inside, 5, 10), []);
  assert.deepEqual(touchAreas([a, b], inside, 7, 10), ["a"]); // walked into a
  assert.deepEqual(touchAreas([a, b], inside, 8, 10), []); // still inside: nothing (sd->areanpc)
  assert.deepEqual(touchAreas([a, b], inside, 12, 10), ["b"]); // the overlap: a stays, b fires
  assert.deepEqual([...inside].sort(), ["a", "b"]);
  assert.deepEqual(touchAreas([a, b], inside, 17, 10), []); // left a (removed), still in b
  assert.deepEqual([...inside], ["b"]);
  assert.deepEqual(touchAreas([a, b], inside, 12, 10), ["a"]); // back into a: fires again
  assert.equal(MAX_EVENTQUEUE, 2);
});
