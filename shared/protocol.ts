// Shared between client and server. Plain TS only (no enums / namespaces / parameter
// properties) so Node can run it with type stripping and Vite can bundle it as-is.

export const ROOM_NAME = "map";
export const MAP_TITLE = "Verdant Plains"; // shown in the minimap + entry banner
export const TICK_MS = 50; // server simulation + patch rate (20 Hz)

// client -> server
export type MoveMsg = { x: number; y: number }; // target tile
export type ChatMsg = { text: string };
export type AttackMsg = { id: string }; // monster id; player walks into range and auto-attacks
export type PickupMsg = { id: string }; // floor item id
export type UseItemMsg = { uid: number };
export type EquipMsg = { uid: number };
// Cards (shared/rules/cards.ts): double-clicking a card asks for the list of pieces it can go into (CZ_REQ_ITEMCOMPOSITION_LIST), the
// answer picks one (CZ_REQ_ITEMCOMPOSITION: card index + equip index; clif_parse_InsertCard).
export type UseCardMsg = { uid: number };
export type InsertCardMsg = { card: number; equip: number };
export type NpcMsg = { id: string };
export type ShopBuyMsg = { npc: string; items: { itemId: number; amount: number }[] };
export type ShopSellMsg = { npc: string; items: { uid: number; amount: number }[] };
// The shortcut window (shared/rules/hotkey.ts): item ids for 4 bars of 9 + 2 quickslots (MAX_HOTKEYS), and the bar rotation
// its up/down arrows pick (CZ_SHORTCUT_KEY_CHANGE + CZ_SHORTCUTKEYBAR_ROTATE; rowShift alone = only the rotation changed).
export type HotkeysMsg = { keys?: (number | null)[]; rowShift?: number };
export type StatUpMsg = { stat: "str" | "agi" | "vit" | "int" | "dex" | "luk"; amount?: number }; // amount default 1 (CZ_STATUS_CHANGE)
export type StatUpAck = { stat: StatUpMsg["stat"]; ok: boolean; amount: number; value: number }; // clif_statusupack; amount = applied
export type JoinOptions = { token: string; charId: number }; // token from POST /api/login
/** ZC_NPCACK_MAPMOVE (clif_changemap): the character now stands on `map` (shared/maps.ts); join that map's room (roomOf). */
export type ChangeMapEvent = { map: string; x: number; y: number };
// NPC dialog answers (CZ_REQ_NEXT_SCRIPT / CZ_CHOOSE_MENU / CZ_CLOSE_DIALOG): npc = the NPC whose dialog is open.
// choice: 1..n = the n-th option shown, 255 = cancel (clif_parse_NpcSelectMenu).
export type NpcReplyMsg = { npc: string };
export type NpcMenuMsg = { npc: string; choice: number };
export type QuestActiveMsg = { id: number; active: boolean }; // CZ_ACTIVE_QUEST: show / hide a quest (Q_ACTIVE / Q_INACTIVE)
// Skills (shared/rules/skill.ts): CZ_UPGRADE_SKILLLEVEL (one point into skill `id`), CZ_USE_SKILL (on unit `target`; a self skill
// with no target = the caster) and CZ_USE_SKILL_TOGROUND (on cell x, y). lv = the level to use (1..learned), default the learned one.
export type SkillUpMsg = { id: number };
export type UseSkillMsg = { id: number; lv?: number; target?: string; x?: number; y?: number };

// server -> client
// Per-event messages reach only the clients rAthena's clif_send target reaches (server/src/area.ts): "area" = players within
// area_size (14) cells of the unit the event is about, "owner" = that player alone. The synced room state goes to everyone.
// Public chat (clif_parse_GlobalMessage): players within area_size - 5 cells (AREA_CHAT_WOC) + the speaker (SELF).
export type ChatEvent = { id: string; name: string; text: string };
// Sent when the swing starts (clif_damage, area of the TARGET): the attacker animates now, the client shows the number / flinch
// `amotion` ms later (sdelay), while the server applies HP, death and EXP when the damage lands (battle_delay_damage).
// dmotion = the target's damage motion (ddelay). lucky = perfect dodge.
export type HitEvent = { from: string; to: string; dmg: number; crit: boolean; miss: boolean; lucky: boolean; amotion: number; dmotion: number; skill?: number; div?: number };
// A skill hit is a HitEvent with `skill` (clif_skill_damage: the skill id) and `div` (hits; the client splits the number).
export type DieEvent = { id: string; killer?: string }; // area of the dead unit (clif_clearunit_area CLR_DEAD)
// The level-up effect (clif_misceffect NOTIFYEFFECT_BASE/JOB_LEVEL_UP, area of the player). The new level itself is the
// owner's own number (SP_BASELEVEL / SP_JOBLEVEL, SELF): Msg.status, sent to the owner just before this.
export type LevelUpEvent = { id: string; kind: "base" | "job" };
export type ExpEvent = { base: number; job: number; quest?: boolean; lost?: boolean }; // sent only to the earner; quest = from a script (getexp); lost = the death penalty (pc_lostexp -> clif_displayexp(lost): base and job in two events, amounts shown as losses)
// Owner only (clif_updatestatus / clif_couplestatus / clif_par_change, all SELF): the character's own numbers, sent at login
// and whenever one changes. Other clients never get them: rAthena's unit packets (clif_set_unit_idle / _walking) show others
// only the look, name, class and base level, and another player's HP only to party / battleground members (none yet).
// hp is the value clif_updatestatus SP_HP sends (shared/rules/status.ts ownerHp: never 0, max/2 for a dead Novice).
export type StatusEvent = {
  level: number; jobLevel: number; exp: number; jobExp: number; statPoints: number; skillPoints: number;
  hp: number; maxHp: number; sp: number; maxSp: number;
  str: number; agi: number; vit: number; int: number; dex: number; luk: number;
  // SP_WEIGHT / SP_MAXWEIGHT (clif_updatestatus SELF; status_calc_pc status.cpp:3693-3697 sends the max whenever it changes,
  // pc_updateweightstatus the weight): in 0.1 units like the item db. Msg.inv carries the same pair with every snapshot.
  weight: number; maxWeight: number;
};
export type TakeItemEvent = { id: string }; // clif_takeitem (area of the picker): the pickup motion of player `id`
export type InvEvent = { items: { uid: number; itemId: number; amount: number; equip: string | null; refine: number; cards: number[] }[]; zeny: number; weight: number; maxWeight: number };
export type ItemGetEvent = { itemId: number; amount: number; quest?: boolean }; // quest = NPC script / quest drop, not a pickup
export type NoticeEvent = { text: string };
// clif_mvp_effect (AREA of the winner): the MVP effect over `id` (a session id). Name = the boss that fell.
export type MvpEvent = { id: string; boss: string };
/** A boss's ranged glob (shared/rules/bossmoves.ts): from the boss to a player, landing after `ms` (the hit comes as Msg.hit then). */
export type BossSpitEvent = { from: string; to: string; ms: number };
/** A boss splitting at an HP threshold: the cue over the boss (its slaves arrive as ordinary monsters). */
export type BossSplitEvent = { id: string; text: string; /** a client locale key for `text` */ key?: string; /** the cue drawn (default "jelly") */ kind?: "jelly" | "stomp" | "roar" };
/** A boss's charge / headbutt telegraph (Msg.bossCharge): `kind` "charge" = the lane from the boss to cell (ex, ey) is shown for `windMs`, then
 *  the boss dashes it in `dashMs`; "head" = a rear-back before a headbutt (ex, ey = the boss's own cell). */
export type BossChargeEvent = { id: string; kind: "charge" | "head"; ex: number; ey: number; windMs: number; dashMs: number };
/** What a charge / headbutt did to `to` (Msg.bossSlam; the damage comes as an ordinary Msg.hit): the impact over the victim, who is
 *  thrown to cell (kx, ky) (the state patch moves them there too) and stunned for `stunMs`. */
export type BossSlamEvent = { from: string; to: string; kind: "charge" | "head"; kx: number; ky: number; stunMs: number };
// clif_mvp_exp / clif_mvp_item (SELF): the MVP's reward. exp = base EXP paid (0 = none), itemId = the prize (0 = none), floor = it did
// not fit and lies on the ground under the MVP (pc_additem failed -> map_addflooritem).
export type MvpRewardEvent = { boss: string; exp: number; itemId: number; floor: boolean };
// intif_broadcast (BC_DEFAULT): a server-wide yellow line.
export type AnnounceEvent = { text: string };
// DEV ONLY: "hurt" = the sender deals `dmg` (default: all HP but 1) to monster `id`; "kill" = a killing blow from the sender;
// "spawn" = a boss_monster line of `mobId` at (x, y) (respawn 15-20 s, id is ignored); "remove" = that test line and its slaves / tomb.
export type DevBossMsg = { op: "hurt" | "kill" | "spawn" | "remove"; id: string; dmg?: number; mobId?: number; x?: number; y?: number };
// ZC_ITEMCOMPOSITION_LIST (clif_use_card): the inventory uids the card `card` can be compounded into (only sent when there is one).
export type CardListEvent = { card: number; targets: number[] };
// ZC_ACK_ITEMCOMPOSITION (clif_insert_card): the result of a compound (result 0 = success, 1 = failure); the inv snapshot follows on success.
export type CardAckEvent = { card: number; equip: number; ok: boolean; text?: string };
// type = callshop's option (shared/rules/script.ts CALLSHOP): 0 = buy and sell (clif_npcbuysell, also a plain shop NPC click),
// 1 = the buy list only, 2 = the sell list only (npc_buysellsel type 0 / 1).
export type ShopEvent = { npc: string; name: string; stock: { itemId: number; price: number }[]; type?: 0 | 1 | 2 };
export type HotkeysEvent = { keys: (number | null)[]; rowShift: number }; // ZC_SHORTCUT_KEY_LIST (+ rotate) at login
// clif_useitemack(ok) goes to the area of the user: who used which item. hp / sp = what it healed, in the owner's copy only
// (pc_itemheal -> status_heal -> clif_updatestatus SP_HP / SP_SP, SELF).
// A script's `heal` (status_heal flag 1 -> pc_heal -> clif_heal) shows its numbers to the owner alone: itemId 0, no area copy.
export type HealEvent = { id: string; itemId: number; hp?: number; sp?: number };
// NPC dialog (server -> the talking player only): one npcMes per line (ZC_SAY_DIALOG), then a button or a menu.
export type NpcMesEvent = { npc: string; text: string };
export type NpcButtonEvent = { npc: string }; // npcNextBtn (ZC_WAIT_DIALOG) / npcCloseBtn (ZC_CLOSE_DIALOG) / npcClear / npcEnd
export type NpcMenuEvent = { npc: string; options: string[] }; // ZC_MENU_LIST, the options actually shown (empty ones left out)
export type CutinEvent = { image: string; type: number }; // ZC_SHOW_IMAGE: 0-2 bottom left/middle/right, 3-4 centre, 255 clear
// Quest log (owner only): every held quest that is not completed, like the client's quest list (ZC_ALL_QUEST_LIST).
export type QuestLogEvent = {
  quests: { id: number; state: number; time: number; count: number[] }[];
  /** W01 r2: the ids of the completed quests (rAthena's log keeps them after avail_quests; the window lists only the others).
   *  The client reads it for world cues that follow a finished quest (the sealed stair's glow). */
  done?: number[];
};
export type QuestMarkEvent = { npc: string; icon: number; color: number }; // ZC_QUEST_NOTIFY_EFFECT over an NPC (QTYPE_*, QMARK_*)
export type ZenyEvent = { amount: number }; // zeny received from an NPC script (reward feed)
// NPC scripts in the world: an emotion bubble over a unit (clif_emotion, AREA of the unit; id = player session id or NPC id, type =
// ET_*), and an NPC's line over its head + in the chat log (npctalk -> ZC_NPC_CHAT; color 0xRRGGBB).
export type EmotionEvent = { id: string; type: number };
export type NpcTalkEvent = { npc: string; text: string; color: number };
// Skills. Owner only: the skill list (clif_skillinfoblock: every row of the tree with learned level, max and whether it can rise
// now, + the points left) and a failed use (clif_skill_fail: the USESKILL_FAIL_* key and its text). Area of the caster: a cast
// starting (clif_skillcasting: castMs = the cast bar, 0 = instant), a cast interrupted (clif_skillcastcancel), and the skill going
// off (clif_skill_nodamage / clif_skill_poseffect / the start of clif_skill_damage: target unit or cell, heal = HP restored).
export type SkillsEvent = { list: { id: number; lv: number; maxLevel: number; upgradable: boolean; later?: boolean }[]; points: number };
export type SkillFailEvent = { id: number; why: string; text: string };
export type SkillCastEvent = { src: string; id: number; lv: number; target?: string; x?: number; y?: number; castMs: number };
export type SkillCancelEvent = { src: string };
export type SkillUseEvent = { src: string; id: number; lv: number; target?: string; x?: number; y?: number; heal?: number };
// Owner only: canact / cooldown timers after a skill (EFST_POSTDELAY + clif_skill_cooldown): no skill before `delayUntil` ms from
// now, skill `id` blocked for `cooldownMs`.
export type SkillDelayEvent = { id: number; delayMs: number; cooldownMs: number };

// Status changes (shared/rules/status_change.ts, server/src/status.ts). Owner only (clif_status_change on SELF: the status icons): every
// status the character carries, with its skill level (val1) and the time left in ms (-1 = no end), sent whenever the list changes.
// What other players see (opt1 / opt2: stone, freeze, stun, poison ...) is the unit's synced `opt` word, not an event.
export type ScListEvent = { list: { sc: string; lv: number; ms: number }[] };
// DEV ONLY (NODE_ENV != production), the status bot's GM shortcut: "start" gives the sender (or monster `target`) status `sc`, `force`
// skips the resistance roll (SCSTART_NOAVOID), "end" removes it, "clear" removes all; ms = duration (default: the status' own).
// "dump" = the unit's numbers (walk ms, hit, flee, DEF ... as a Msg.notice line "[dev-status] {json}"); "mobskill" = monster `target` casts its
// first status skill on the sender now (rate roll, delay and state skipped; the range and the resistance roll still apply).
export type DevStatusMsg = { op: "start" | "end" | "clear" | "dump" | "mobskill"; sc?: string; lv?: number; ms?: number; force?: boolean; target?: string };

// ---- Party (2.3.0; rAthena party.cpp / clif party packets). One server process: parties live in server/src/party.ts across rooms.
// Client -> server
export type PartyCreateMsg = { name: string }; // CZ_MAKE_GROUP2 (party name 1-23 chars, unique)
export type PartyInviteMsg = { name: string }; // CZ_PARTY_JOIN_REQ: invite an online character by name (leader only)
export type PartyReplyMsg = { partyId: number; accept: boolean }; // CZ_PARTY_JOIN_REQ_ACK
export type PartyKickMsg = { charId: number }; // CZ_REQ_EXPEL_GROUP_MEMBER (leader only)
export type PartyLeaderMsg = { charId: number }; // CZ_CHANGE_GROUP_MASTER (leader only, target online on the same map)
export type PartyShare = "each" | "even"; // exp: each take what they kill / even share (party_exp_share); item: each picks up / random member
export type PartyOptionMsg = { exp?: PartyShare; item?: PartyShare }; // CZ_CHANGE_GROUPEXPOPTION (leader only)
// Server -> client
export type PartyInvitedEvent = { partyId: number; partyName: string; from: string }; // ZC_PARTY_JOIN_REQ (invitee)
export type PartyMember = { charId: number; name: string; online: boolean; map: string; x: number; y: number; hp: number; maxHp: number;
  level: number; job: string; leader: boolean };
export type PartyEvent = { party: null | { id: number; name: string; exp: PartyShare; item: PartyShare; members: PartyMember[] } }; // ZC_GROUP_LIST
export type PartyUpdateEvent = { charId: number; x?: number; y?: number; hp?: number; maxHp?: number; map?: string; online?: boolean }; // clif_party_hp/xy
export type PartyNoticeEvent = { text: string }; // join refused / left / kicked / leader changed ... as a system line

// ---- Friends + whisper (2.3.0; rAthena friend list in char_friends via clif_friendslist_*, whisper clif_wis_message)
export type FriendAddMsg = { name: string }; // CZ_ADD_FRIENDS
export type FriendReplyMsg = { charId: number; accept: boolean }; // CZ_ACK_REQ_ADD_FRIENDS
export type FriendRemoveMsg = { charId: number }; // CZ_DELETE_FRIENDS
export type FriendReqEvent = { charId: number; name: string }; // ZC_REQ_ADD_FRIENDS (to the asked character)
export type FriendsEvent = { list: { charId: number; name: string; online: boolean }[] }; // ZC_FRIENDS_LIST (owner, whole list on change)
export type WhisperMsg = { to: string; text: string }; // CZ_WHISPER
// chat lines from other channels reuse Msg.chat with a channel: party chat and whispers (WhisperEvent `from` / `to` = names)
export type ChannelChatEvent = { channel: "party" | "whisper"; from: string; to?: string; text: string };

// ---- Pets (2.4.0; rAthena pet.cpp / clif pet packets, data shared/data/pets.json imported from db/re/pet_db.yml with our names).
// A hatched pet is a unit in the room state (MapState.pets, key "pet<petId>"; schema Pet in MapRoom.ts: mobId, owner = the owner's
// session id, name, x/y/sx/sy/dir/moving like Monster, hungry: boolean (hunger <= PET_HUNGRY), accessory: item id 0 = none).
// The client draws it with the monster's sprite (mobId) at PET_SCALE and follows the same motion code as monsters.
// Kinds (our extension, derived from pet_db by tools/rathena/import.ts): "companion" (Script bonus + loyal bonus only), "battle"
// (AttackRate / RetaliateRate: hits its owner's target, petskillattack), "support" (SupportScript petheal / petskillsupport).
// Hunger 0 -> intimacy keeps dropping (IntimacyHungry); intimacy 0 -> the pet runs away for good (pet_return_egg is NOT
// done: the egg is deleted, like rAthena's pet_hungry -> pet_remove_map + intimacy 0). Owner's decision 2026-10-24.
export const PET_SCALE = 0.8;
export const PET_HUNGRY = 25; // rAthena PET_HUNGRY_HUNGRY..: 0-10 very hungry, 11-25 hungry, 26-75 neutral, 76-90 satisfied, 91-100 stuffed
export type PetKind = "companion" | "battle" | "support";
// Client -> server
export type PetCatchMsg = { id: string }; // CZ_TRYCAPTURE_MONSTER: the monster picked after a taming item was used (Msg.petCatchStart)
export type PetHatchMsg = { uid: number }; // CZ_SELECT_PETEGG: the egg (inventory uid) to hatch (only when no pet is out)
export type PetCommandMsg = { op: "info" | "feed" | "perform" | "return" | "unequip" }; // CZ_COMMAND_PET 0..4
export type PetRenameMsg = { name: string }; // CZ_RENAME_PET (once, 1-23 chars)
export type PetAutoFeedMsg = { on: boolean }; // CZ_PET_AUTOFEED (only when pets.json allowAutoFeed)
// Server -> client
export type PetCatchStartEvent = { itemId: number }; // ZC_START_CAPTURE (owner): pick a monster with the target cursor
export type PetCatchResultEvent = { ok: boolean; mobId: number }; // ZC_TRYCAPTURE_MONSTER (area of the catcher)
export type PetEggsEvent = { uids: number[] }; // ZC_PETEGG_LIST (owner): the eggs that can hatch now
// ZC_PROPERTY_PET (owner, on hatch / any change; pet null = no pet out). intimacy 0-1000, hunger 0-100 (rAthena units).
export type PetInfo = { petId: number; mobId: number; name: string; renamed: boolean; level: number; hunger: number; intimacy: number;
  accessory: number; kind: PetKind; autoFeed: boolean };
export type PetInfoEvent = { pet: PetInfo | null };
export type PetEmoteEvent = { id: string; emote: number }; // ZC_PET_ACT / clif_pet_emotion (area of the pet): performance, hungry ...
export type PetNoticeEvent = { text: string }; // "Your pet ran away", "Taming failed" ...: a system line (owner)

// ---- Duel (2.4.0; rAthena duel.cpp, @duel / @invite / @accept / @reject / @leave). 1-vs-1 challenge on any map (rAthena only
// refuses maps with mapflag noduel; we have none). Damage between the two follows the normal player-vs-player battle path.
export type DuelInviteMsg = { name: string }; // @duel <name> / right-click "Duel": challenge an online character on the same map
export type DuelReplyMsg = { accept: boolean }; // @accept / @reject (the pending invitation)
// Msg.duelLeave: @leave (the duel ends; the other side wins)
export type DuelInvitedEvent = { from: string; fromId: string }; // the challenged player (fromId = challenger's session id)
export type DuelEvent = { duel: null | { with: string; withId: string; since: number } }; // owner: the current duel (null = none)
// AttackMsg.id / UseSkillMsg.target may be a player session id while both are in the same duel; otherwise the server refuses.

export const Msg = {
  changeMap: "changeMap", // C08: pc_setpos to another map -> clif_changemap: the client leaves this room and joins the map's room
  move: "move",
  chat: "chat",
  attack: "attack",
  hit: "hit",
  die: "die",
  levelUp: "levelUp",
  respawn: "respawn", // dead player asks to return to the save point
  statUp: "statUp",
  statUpAck: "statUpAck", // server -> requester: result of a statUp
  sit: "sit", // toggle sit/stand (Insert)
  exp: "exp",
  pickup: "pickup",
  useItem: "useItem",
  equip: "equip",
  unequip: "unequip",
  useCard: "useCard", // client -> server: CZ_REQ_ITEMCOMPOSITION_LIST
  insertCard: "insertCard", // client -> server: CZ_REQ_ITEMCOMPOSITION
  cardList: "cardList", // server -> owner: CardListEvent
  cardAck: "cardAck", // server -> owner: CardAckEvent
  npc: "npc", // talk to / open an NPC
  shopBuy: "shopBuy",
  shopSell: "shopSell",
  hotkeys: "hotkeys",
  inv: "inv", // server -> owner: full inventory snapshot
  itemGet: "itemGet",
  notice: "notice", // server -> one client: short system message
  shop: "shop",
  shopClose: "shopClose", // server -> client: the NPC/shop session ended (pc_close_npc on death)
  heal: "heal", // area: someone used a healing item (the amounts only in the owner's copy)
  status: "status", // server -> owner: own stats / points / EXP / HP / SP (StatusEvent)
  takeItem: "takeItem", // area: pickup motion
  shopQuit: "shopQuit", // client -> server: the shop list window was closed (CZ_NPC_TRADE_QUIT)
  // NPC dialog (shared/content scripts run on the server, server/src/script.ts)
  npcNext: "npcNext",
  npcMenu: "npcMenu",
  npcClose: "npcClose",
  npcMes: "npcMes",
  npcNextBtn: "npcNextBtn",
  npcCloseBtn: "npcCloseBtn",
  npcMenuList: "npcMenuList",
  npcClear: "npcClear",
  npcEnd: "npcEnd", // server -> client: the dialog session ended without a close click (death, timeout, script end)
  cutin: "cutin",
  // quests (shared/rules/quest.ts, shared/content/quest_db.ts)
  quests: "quests",
  questMark: "questMark",
  questActive: "questActive",
  zenyGet: "zenyGet",
  emotion: "emotion", // server -> area: EmotionEvent
  npcTalk: "npcTalk", // server -> area / owner: NpcTalkEvent
  // skills (shared/rules/skill.ts, server: MapRoom skill section)
  skillUp: "skillUp", // client -> server: SkillUpMsg
  useSkill: "useSkill", // client -> server: UseSkillMsg
  skills: "skills", // server -> owner: SkillsEvent
  skillFail: "skillFail", // server -> owner: SkillFailEvent
  skillCast: "skillCast", // server -> area: SkillCastEvent
  skillCancel: "skillCancel", // server -> area: SkillCancelEvent
  skillUse: "skillUse", // server -> area: SkillUseEvent
  skillDelay: "skillDelay", // server -> owner: SkillDelayEvent
  // bosses (shared/rules/mvp.ts, server/src/boss.ts)
  mvp: "mvp", // server -> area: MvpEvent (clif_mvp_effect: the MVP effect over the winner)
  mvpReward: "mvpReward", // server -> the MVP only: MvpRewardEvent (clif_mvp_exp / clif_mvp_item)
  bossSpit: "bossSpit", // server -> area: BossSpitEvent (our floor-boss ranged glob, shared/rules/bossmoves.ts)
  bossSplit: "bossSplit", // server -> area: BossSplitEvent (a boss splits into slaves at an HP threshold)
  bossCharge: "bossCharge", // server -> area: BossChargeEvent (Devo's charge telegraph / headbutt wind-up)
  bossSlam: "bossSlam", // server -> area: BossSlamEvent (the impact of a charge / headbutt on a player)
  announce: "announce", // server -> every player online: AnnounceEvent (intif_broadcast, e.g. a rare MVP prize)
  devBoss: "devBoss", // client -> server, DEV ONLY (NODE_ENV != production): DevBossMsg, the boss bot's GM shortcut
  // status changes (shared/rules/status_change.ts, server/src/status.ts)
  scList: "scList", // server -> owner: ScListEvent (the status icons)
  devStatus: "devStatus", // client -> server, DEV ONLY: DevStatusMsg, the status bot's GM shortcut
  // party (server/src/party.ts)
  partyCreate: "partyCreate", partyInvite: "partyInvite", partyReply: "partyReply", partyLeave: "partyLeave", partyKick: "partyKick",
  partyLeader: "partyLeader", partyOption: "partyOption", partyChat: "partyChat", // client -> server (partyChat: ChatMsg)
  partyInvited: "partyInvited", party: "party", partyUpdate: "partyUpdate", partyNotice: "partyNotice", // server -> client
  // friends + whisper (server/src/friends.ts)
  friendAdd: "friendAdd", friendReply: "friendReply", friendRemove: "friendRemove", whisper: "whisper", // client -> server
  friendReq: "friendReq", friends: "friends", channelChat: "channelChat", // server -> client (channelChat: ChannelChatEvent)
  // pets (server/src/pets.ts)
  petCatch: "petCatch", petHatch: "petHatch", petCommand: "petCommand", petRename: "petRename", petAutoFeed: "petAutoFeed", // client -> server
  petCatchStart: "petCatchStart", petCatchResult: "petCatchResult", petEggs: "petEggs", petInfo: "petInfo", petEmote: "petEmote",
  petNotice: "petNotice", // server -> client
  devPet: "devPet", // DEV ONLY (pets bot, never in production): { op: "hunger" | "intimacy", value } | { op: "starve" | "catch" } | { op: "give", itemId, amount } | { op: "floor", itemId, value: 0 free | 1 held by another character } | { op: "ownerHp", value: % }
  // duel (server/src/duel.ts)
  duelInvite: "duelInvite", duelReply: "duelReply", duelLeave: "duelLeave", // client -> server
  duelInvited: "duelInvited", duel: "duel", // server -> client
} as const;

// 8 facing directions, RO order: 0 = south (toward camera), clockwise.
export function dirFromDelta(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const a = Math.atan2(dx, dy); // 0 when moving +y (south)
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}
