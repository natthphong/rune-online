import { test } from "node:test";
import assert from "node:assert/strict";
import { gearUseVerdict, CLIENT_MSGS, endsInvincible, guardRequest, msgAllowed, npcLockVerdict, type ClientMsgKey, type NpcLock } from "./msgguard.ts";
import { Msg } from "../protocol.ts";

const SENT: ClientMsgKey[] = ["move", "attack", "sit", "pickup", "npc", "useItem", "equip", "unequip", "shopBuy", "shopSell", "shopQuit",
  "chat", "statUp", "hotkeys", "respawn", "npcNext", "npcMenu", "npcClose", "questActive", "useCard", "insertCard", "skillUp", "useSkill",
  "partyCreate", "partyInvite", "partyReply", "partyLeave", "partyKick", "partyLeader", "partyOption", "partyChat",
  "friendAdd", "friendReply", "friendRemove", "whisper", "duelInvite", "duelReply", "duelLeave",
  "petCatch", "petHatch", "petCommand", "petRename", "petAutoFeed"];

test("every client request has a guard row", () => {
  assert.deepEqual(Object.keys(CLIENT_MSGS).sort(), [...SENT].sort());
  for (const k of SENT) assert.ok(Msg[k], k);
});

test("dead rules follow clif.cpp parse functions", () => {
  const dead = (k: ClientMsgKey) => msgAllowed(CLIENT_MSGS[k], true, true);
  for (const k of ["move", "attack", "sit", "pickup", "npc", "useItem", "equip", "unequip", "shopBuy", "shopSell", "useSkill"] as const) assert.equal(dead(k), false, k);
  // NpcNextClicked / NpcSelectMenu / NpcCloseClicked / NPCShopClosed / questStateAck have no pc_isdead check
  for (const k of ["chat", "statUp", "hotkeys", "respawn", "npcNext", "npcMenu", "npcClose", "shopQuit", "questActive", "useCard", "insertCard", "skillUp", "friendAdd", "friendReply", "friendRemove", "whisper", "duelInvite", "duelReply", "duelLeave"] as const) assert.equal(dead(k), true, k); // + clif_parse_UseCard / InsertCard: no death check
});

test("respawn only while dead; shop needs an open session", () => {
  assert.equal(msgAllowed(CLIENT_MSGS.respawn, false, false), false);
  assert.equal(msgAllowed(CLIENT_MSGS.shopBuy, false, false), false);
  assert.equal(msgAllowed(CLIENT_MSGS.shopBuy, false, true), true);
  assert.equal(msgAllowed(CLIENT_MSGS.unequip, false, false), true);
});

test("spawn protection ends only on walking and attacking (pc_delinvincibletimer callers in clif.cpp)", () => {
  // clif_parse_WalkToXY:11415, clif_parse_ActionRequest_sub:11731 and the skill requests (clif_parse_UseSkillToId 12982 /
  // ToPos 13077) call it. Sitting, items, equipment, NPC clicks, chat, stat points, skill points do not.
  const ending = (Object.keys(CLIENT_MSGS) as ClientMsgKey[]).filter((k) => endsInvincible(CLIENT_MSGS[k])).sort();
  assert.deepEqual(ending, ["attack", "move", "useSkill"]);
});

// pc.hpp:1156-1167: pc_cant_act2 includes sd->npc_shopid, pc_cant_act = sd->npc_id || chatID || pc_cant_act2.
const NONE: NpcLock = { talking: false, shopping: false };
const TALK: NpcLock = { talking: true, shopping: false }; // a script dialog runs (sd->npc_id)
const SHOP: NpcLock = { talking: false, shopping: true }; // a shop list is open (sd->npc_shopid)
const verdicts = (k: ClientMsgKey) => [NONE, TALK, SHOP].map((l) => npcLockVerdict(CLIENT_MSGS[k], l));

test("no NPC session: nothing is locked except the dialog answers", () => {
  for (const k of SENT) assert.equal(npcLockVerdict(CLIENT_MSGS[k], NONE), ["npcNext", "npcMenu", "npcClose"].includes(k) ? "deny" : "ok", k);
});

test("walk / attack / pickup: pc_cant_act refuses silently while a dialog or a shop list is open", () => {
  // clif_parse_WalkToXY:11393, clif_parse_ActionRequest_sub:11721 (attack), clif_parse_TakeItem:12025
  for (const k of ["move", "attack", "pickup"] as const) assert.deepEqual(verdicts(k), ["ok", "deny", "deny"], k);
});

test("NPC click answers MSI_BUSY during a dialog or a shop list (clif_parse_NpcClicked:12212, RENEWAL)", () => {
  assert.deepEqual(verdicts("npc"), ["ok", "busy", "busy"]);
});

test("equip / unequip: MSI_CAN_NOT_EQUIP_ITEM during a dialog, silent refusal with a shop list (clif.cpp:12132 / 12180)", () => {
  assert.deepEqual(verdicts("equip"), ["ok", "cant_equip", "deny"]);
  assert.deepEqual(verdicts("unequip"), ["ok", "cant_equip", "deny"]);
});

test("item use: busy during a dialog (pc_useitem pc.cpp:6464), allowed with a shop list (UseItem only checks pc_istrading)", () => {
  assert.deepEqual(verdicts("useItem"), ["ok", "busy", "ok"]);
});

test("gear through useItem obeys the equip lock, a shop list included (pc_isUseitem never equips)", () => {
  assert.equal(gearUseVerdict({ talking: false, shopping: false }), "ok");
  assert.equal(gearUseVerdict({ talking: true, shopping: false }), "cant_equip");
  assert.equal(gearUseVerdict({ talking: false, shopping: true }), "deny");
});

test("dialog answers need sd->npc_id; chat, stats, hotkeys, sit, shop deals, shop quit and quest toggle are never locked", () => {
  for (const k of ["npcNext", "npcMenu", "npcClose"] as const) assert.deepEqual(verdicts(k), ["deny", "ok", "deny"], k);
  for (const k of ["chat", "statUp", "hotkeys", "sit", "respawn", "shopBuy", "shopSell", "shopQuit", "questActive"] as const) {
    assert.deepEqual(verdicts(k), ["ok", "ok", "ok"], k);
  }
  // both sessions at once (a shop opened by a script, callshop): still locked
  assert.equal(npcLockVerdict(CLIENT_MSGS.move, { talking: true, shopping: true }), "deny");
  assert.equal(npcLockVerdict(CLIENT_MSGS.equip, { talking: true, shopping: true }), "cant_equip");
});

test("order: a locked walk / attack is refused before pc_delinvincibletimer, so the protection stays (clif.cpp:11393/11415, 11721/11731)", () => {
  for (const k of ["move", "attack"] as const) {
    for (const lock of [TALK, SHOP]) assert.deepEqual(guardRequest(CLIENT_MSGS[k], false, false, lock), { run: false, why: "deny" }, k);
    assert.deepEqual(guardRequest(CLIENT_MSGS[k], false, false, NONE), { run: true, endInvincible: true }, k);
    assert.deepEqual(guardRequest(CLIENT_MSGS[k], true, false, NONE), { run: false, why: "dead" }, k); // dead before the lock
  }
  // the other answers keep their order too: dead, then shop session, then lock
  assert.deepEqual(guardRequest(CLIENT_MSGS.npc, false, false, SHOP), { run: false, why: "busy" });
  assert.deepEqual(guardRequest(CLIENT_MSGS.equip, false, false, TALK), { run: false, why: "cant_equip" });
  assert.deepEqual(guardRequest(CLIENT_MSGS.shopBuy, false, false, TALK), { run: false, why: "shop" });
  assert.deepEqual(guardRequest(CLIENT_MSGS.respawn, false, false, NONE), { run: false, why: "dead" }); // only while dead
  assert.deepEqual(guardRequest(CLIENT_MSGS.npcNext, false, false, TALK), { run: true, endInvincible: false });
});
