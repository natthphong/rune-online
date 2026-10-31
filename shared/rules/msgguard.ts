// One table that says what each client request may do while the character is dead, and whether it ends the spawn
// protection. Every client -> server message MUST have a row (CLIENT_MSGS is exhaustive over the Msg keys that clients send;
// a missing row is a type error), and MapRoom registers handlers only through guarded(), so a new handler cannot skip either
// decision.
//
// rAthena (src/map/clif.cpp, packet parse functions; "dead" = pc_isdead(sd), pc_dead() also runs pc_close_npc(sd,2) which
// clears sd->npc_shopid, pc.cpp:9746/9875):
//   WalkToXY (clif_parse_WalkToXY)        unit_walktoxy refuses a dead unit (unit_can_move)   -> deny
//   ActionRequest attack/sit              clif_parse_ActionRequest_sub: pc_isdead -> return    -> deny
//   TakeItem (clif_parse_TakeItem)        pc_isdead -> return                                  -> deny
//   NpcClicked (clif_parse_NpcClicked)    pc_isdead -> clif_clearunit_area, return             -> deny
//   UseItem (clif_parse_UseItem)          pc_isdead -> return                                  -> deny
//   EquipItem / UnequipItem               pc_isdead -> clif_clearunit_area, return             -> deny
//   NpcBuyListSend / NpcSellListSend      need sd->npc_shopid (cleared on death)               -> deny (+ open shop)
//   GlobalMessage (clif_parse_GlobalMessage) no death check                                    -> allow
//   StatusUp (clif_parse_StatusUp)        pc_statusup has no death check                       -> allow
//   Hotkeys (clif_parse_HotkeyRequest)    pure storage                                         -> allow
//   Restart (clif_parse_Restart type 0)   pc_respawn only acts on a dead character (pc_isdead)  -> only
//
// Spawn protection (shared/rules/invincible.ts): the only requests that call pc_delinvincibletimer are
//   WalkToXY                              clif.cpp:11415, after the dead / pc_cant_act checks and BEFORE unit_walktoxy, which
//                                         may still refuse (sitting, no path): the request alone ends it           -> end
//   ActionRequest attack (DMG_NORMAL/REPEAT) clif.cpp:11731, after pc_cant_act and BEFORE unit_attack checks the target -> end
//   UseSkillToId / ToPos / Map            clif.cpp:12982 / 13077 / 13174 (an item skill only when it is not a self skill,
//                                         12965) -> end (row useSkill)
// Sit/stand (ActionRequest_sub's sit cases), items (pc_useitem), equipment, NPC clicks, shop deals, chat, stat points and
// hotkeys never touch it. A pickup is a TakeItem (no call); the real client walks to a far item with a WalkToXY first, so
// MapRoom ends the protection when the server starts that walk for the player (pursueGoal).
//
// NPC sessions lock the character (pc.hpp:1156-1167): pc_cant_act2(sd) includes sd->npc_shopid (a shop list is open,
// npc_buysellsel npc.cpp:2409) and pc_cant_act(sd) = sd->npc_id (a script dialog runs, script_attach_state) || chatID ||
// pc_cant_act2(sd). Each parse function applies its own subset, so every row names which one (`lock`):
//   cant_act  WalkToXY (clif.cpp:11393), ActionRequest attack (11721), TakeItem (12025): pc_cant_act -> silently refused
//   click     NpcClicked (12212-12216): pc_cant_act2 || npc_id -> MSI_BUSY (RENEWAL)
//   equip     EquipItem / UnequipItem (12132 / 12180): npc_id (no npc_item_flag) -> MSI_CAN_NOT_EQUIP_ITEM; otherwise
//             pc_cant_act2 (a shop list) -> silently refused
//   useitem   UseItem (12090) only checks pc_istrading (no npc_shopid); pc_useitem (pc.cpp:6464) refuses with MSI_BUSY while
//             npc_id is set (no npc_item_flag): a dialog blocks items, a shop list doesn't
//   reply     NpcNextClicked / NpcSelectMenu / NpcCloseClicked (13348 / 13319 / 13406): npc_scriptcont needs sd->npc_id
//             (the npc must match: the handler checks that)
//   free      no NPC check: chat, status points, hotkeys, sit / stand (ActionRequest_sub's sit cases skip pc_cant_act),
//             respawn, shop deals (they check npc_shopid themselves), CZ_NPC_TRADE_QUIT, CZ_ACTIVE_QUEST
// The shop session itself ends after every buy / sell list (clif.cpp:12324 / 12359), on CZ_NPC_TRADE_QUIT (2319-2323), on a
// warp (unit_remove_map, unit.cpp:3678) and on death; the dialog session on close / cancel / death / disconnect / timeout.
export type DeadRule = "deny" | "allow" | "only"; // only = accepted solely while dead
export type InvincibleRule = "end" | "keep"; // end = pc_delinvincibletimer when the request is accepted
export type NpcLockRule = "cant_act" | "click" | "equip" | "useitem" | "reply" | "free";

export type ClientMsgGuard = {
  dead: DeadRule;
  invincible: InvincibleRule;
  lock: NpcLockRule;
  shop?: true; // needs an open shop session (sd->npc_shopid)
};

export const CLIENT_MSGS = {
  move: { dead: "deny", invincible: "end", lock: "cant_act" },
  attack: { dead: "deny", invincible: "end", lock: "cant_act" },
  sit: { dead: "deny", invincible: "keep", lock: "free" },
  pickup: { dead: "deny", invincible: "keep", lock: "cant_act" },
  npc: { dead: "deny", invincible: "keep", lock: "click" },
  useItem: { dead: "deny", invincible: "keep", lock: "useitem" },
  equip: { dead: "deny", invincible: "keep", lock: "equip" },
  unequip: { dead: "deny", invincible: "keep", lock: "equip" },
  // clif_parse_UseCard / clif_parse_InsertCard (clif.cpp:13490 / 13525): only pc_istrading is checked, no death or NPC lock
  useCard: { dead: "allow", invincible: "keep", lock: "free" },
  insertCard: { dead: "allow", invincible: "keep", lock: "free" },
  shopBuy: { dead: "deny", invincible: "keep", lock: "free", shop: true },
  shopSell: { dead: "deny", invincible: "keep", lock: "free", shop: true },
  shopQuit: { dead: "allow", invincible: "keep", lock: "free" }, // CZ_NPC_TRADE_QUIT: npc_shopid = 0, no other check
  chat: { dead: "allow", invincible: "keep", lock: "free" },
  statUp: { dead: "allow", invincible: "keep", lock: "free" },
  hotkeys: { dead: "allow", invincible: "keep", lock: "free" },
  respawn: { dead: "only", invincible: "keep", lock: "free" }, // starts the protection instead (LoadEndAck after the respawn warp)
  // NPC dialog answers: the parse functions have no death check (death already ended the session, pc_close_npc)
  npcNext: { dead: "allow", invincible: "keep", lock: "reply" },
  npcMenu: { dead: "allow", invincible: "keep", lock: "reply" },
  npcClose: { dead: "allow", invincible: "keep", lock: "reply" },
  questActive: { dead: "allow", invincible: "keep", lock: "free" }, // CZ_ACTIVE_QUEST (clif_parse_questStateAck): no checks
  // clif_parse_SkillUp -> pc_skillup: no death / NPC check. clif_parse_UseSkillToId / ToPos (clif.cpp:12940-13080): pc_isdead and
  // pc_cant_act refuse; an accepted request calls pc_delinvincibletimer (12982 / 13077) before unit_skilluse_* checks the rest
  skillUp: { dead: "allow", invincible: "keep", lock: "free" },
  useSkill: { dead: "deny", invincible: "end", lock: "cant_act" },
  // party (2.3.0): clif_parse_CreateParty2 / PartyInvite2 / ReplyPartyInvite / LeaveParty / RemovePartyMember / PartyChangeLeader /
  // PartyChangeOption / PartyMessage (clif.cpp:13822-13985) have no pc_isdead and no NPC-session check
  partyCreate: { dead: "allow", invincible: "keep", lock: "free" },
  partyInvite: { dead: "allow", invincible: "keep", lock: "free" },
  partyReply: { dead: "allow", invincible: "keep", lock: "free" },
  partyLeave: { dead: "allow", invincible: "keep", lock: "free" },
  partyKick: { dead: "allow", invincible: "keep", lock: "free" },
  partyLeader: { dead: "allow", invincible: "keep", lock: "free" },
  partyOption: { dead: "allow", invincible: "keep", lock: "free" },
  partyChat: { dead: "allow", invincible: "keep", lock: "free" },
  // duel (2.4.0): @duel / @accept / @reject / @leave are atcommands (atcommand.cpp:9260-9380): no pc_isdead and no NPC-session check in
  // the command path itself (the server adds its own refusals for a dead or talking challenger); chat-like requests never end spawn protection
  duelInvite: { dead: "allow", invincible: "keep", lock: "free" },
  duelReply: { dead: "allow", invincible: "keep", lock: "free" },
  duelLeave: { dead: "allow", invincible: "keep", lock: "free" },
  // friends + whisper (2.3.0): clif_parse_FriendsListAdd / Reply / Remove and clif_parse_WisMessage have no death or NPC check
  friendAdd: { dead: "allow", invincible: "keep", lock: "free" },
  friendReply: { dead: "allow", invincible: "keep", lock: "free" },
  friendRemove: { dead: "allow", invincible: "keep", lock: "free" },
  whisper: { dead: "allow", invincible: "keep", lock: "free" },
  // pets (2.4.0): clif_parse_CatchPet / clif_parse_SelectEgg run after an item use (dead + dialog refuse it like pc_useitem);
  // clif_parse_PetMenu / ChangePetName / pet autofeed have no death or NPC check
  petCatch: { dead: "deny", invincible: "keep", lock: "useitem" },
  petHatch: { dead: "deny", invincible: "keep", lock: "useitem" },
  petCommand: { dead: "allow", invincible: "keep", lock: "free" },
  petRename: { dead: "allow", invincible: "keep", lock: "free" },
  petAutoFeed: { dead: "allow", invincible: "keep", lock: "free" },
} as const satisfies Record<string, ClientMsgGuard>;

export type ClientMsgKey = keyof typeof CLIENT_MSGS;

/** May a request with this guard run now? `dead` = pc_isdead, `shopOpen` = sd->npc_shopid is set for the target npc. */
export function msgAllowed(g: ClientMsgGuard, dead: boolean, shopOpen: boolean): boolean {
  if (g.dead === "deny" && dead) return false;
  if (g.dead === "only" && !dead) return false;
  if (g.shop && !shopOpen) return false;
  return true;
}

/** Does an accepted request of this kind call pc_delinvincibletimer? */
export const endsInvincible = (g: ClientMsgGuard): boolean => g.invincible === "end";

/** The character's NPC sessions: `talking` = sd->npc_id (a script dialog runs), `shopping` = sd->npc_shopid (a shop list). */
export type NpcLock = { talking: boolean; shopping: boolean };
/** ok, or how the request is refused: silently (deny), with MSI_BUSY (busy) or MSI_CAN_NOT_EQUIP_ITEM (cant_equip). */
export type LockVerdict = "ok" | "deny" | "busy" | "cant_equip";

/** The NPC-session part of a request's parse function (see the table above), checked after the dead rule. */
export function npcLockVerdict(g: Pick<ClientMsgGuard, "lock">, lock: NpcLock): LockVerdict {
  switch (g.lock) {
    case "cant_act": return lock.talking || lock.shopping ? "deny" : "ok";
    case "click": return lock.talking || lock.shopping ? "busy" : "ok";
    case "equip": return lock.talking ? "cant_equip" : lock.shopping ? "deny" : "ok";
    case "useitem": return lock.talking ? "busy" : "ok";
    case "reply": return lock.talking ? "ok" : "deny";
    case "free": return "ok";
  }
}

/** UseItem on a piece of gear (our hotkey toggle): rAthena's pc_isUseitem never equips through UseItem, gear only changes via
 *  EquipItem / UnequipItem, so the toggle must obey exactly their lock (clif.cpp:12132 / 12180), not the looser useitem one. */
export function gearUseVerdict(lock: NpcLock): LockVerdict {
  return npcLockVerdict(CLIENT_MSGS.equip, lock);
}

/** Why a request did not run: the dead rule, a missing shop session (both answered by the handler's `refuse`, e.g. a shop
 *  deal's fail result), or the NPC-session lock (silently, MSI_BUSY or MSI_CAN_NOT_EQUIP_ITEM). */
export type GuardOutcome = { run: true; endInvincible: boolean } | { run: false; why: "dead" | "shop" | Exclude<LockVerdict, "ok"> };

/** The whole guard decision in the order of the parse functions: pc_isdead first, then the shop session (npc_shopid), then
 *  the NPC-session lock (pc_cant_act ...), and only a request that passes all of them may end the spawn protection
 *  (pc_delinvincibletimer runs after pc_cant_act: clif.cpp:11393 -> 11415 for a walk, 11721 -> 11731 for an attack). So a
 *  protected player with a dialog or a shop list open who clicks to walk or attack keeps both the protection and the lock. */
export function guardRequest(g: ClientMsgGuard, dead: boolean, shopOpen: boolean, lock: NpcLock): GuardOutcome {
  if (!msgAllowed(g, dead, shopOpen)) return { run: false, why: dead && g.dead === "deny" || !dead && g.dead === "only" ? "dead" : "shop" };
  const v = npcLockVerdict(g, lock);
  if (v !== "ok") return { run: false, why: v };
  return { run: true, endInvincible: endsInvincible(g) };
}
