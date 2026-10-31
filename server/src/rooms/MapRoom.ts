import { Room, type Client } from "@colyseus/core";
import { delayConsumeBlockedWhileSitting, itemUseReady, nextItemUse } from "../../../shared/rules/itemuse.ts";
import { schema, t, type SchemaType } from "@colyseus/schema";
import {
  Msg, TICK_MS, dirFromDelta,
  type AttackMsg, type ChatEvent, type ChatMsg, type DieEvent, type EquipMsg, type ExpEvent, type HealEvent, type HitEvent, type HotkeysMsg,
  type EmotionEvent, type ItemGetEvent, type JoinOptions, type LevelUpEvent, type MoveMsg, type NoticeEvent, type NpcMsg, type NpcTalkEvent,
  type PickupMsg, type ShopBuyMsg, type ShopEvent, type ShopSellMsg, type StatUpAck, type StatUpMsg, type StatusEvent, type TakeItemEvent,
  type AnnounceEvent, type UseItemMsg, type CardAckEvent, type CardListEvent, type InsertCardMsg, type UseCardMsg, type ChangeMapEvent,
} from "../../../shared/protocol.ts";
import type { FriendAddMsg, FriendRemoveMsg, FriendReplyMsg, WhisperMsg } from "../../../shared/protocol.ts";
import * as friends from "../friends.ts";
import * as duel from "../duel.ts";
import type { DuelInviteMsg, DuelReplyMsg } from "../../../shared/protocol.ts";
import { cardTargets, isCard } from "../../../shared/rules/cards.ts";
import { pickAlbumCard } from "../../../shared/rules/album.ts";
import { areaReceivers, type SendTarget } from "../area.ts";
import { distance, walkable, type GameMap } from "../../../shared/map.ts";
import { FIELD, TOWN_SAVE, buildMap, isMapName, nearestWalkable, warpAt, type MapName, type MapPos } from "../../../shared/maps.ts";
import { JOBS, MOB_BY_ID, STAT_KEYS, type JobKey, type Mob, type Stats } from "../../../shared/rules/data.ts";
import { FISTS, HP_REGEN_MS, NATURAL_HEAL_SKILL_INTERVAL, SP_REGEN_MS, hpRegen, hpRegenBlockedByWalk, mobStatus, ownerHp, playerStatus, spRegen, type MobStatus, type Status, type Weapon } from "../../../shared/rules/status.ts";
import {
  ITEMS, SHOP_ITEMS, STARTER_KIT,
  equipBlock, isEquip, isUsable, itemHealAmount, maxWeight, rollHeal,
} from "../../../shared/rules/items.ts";
import { blocksNaturalRegen } from "../../../shared/rules/weight.ts";
import { hotkeyList, isRowShift, seedHotkeys } from "../../../shared/rules/hotkey.ts";
import { Inventory, writesSettled } from "../inventory.ts";
import { buyList, sellList, type BuyResult } from "../../../shared/rules/shop.ts";
import { buyGate, npcCheckNear, sellGate } from "../../../shared/rules/npc.ts";
import { HAIR_COLORS, HAIR_STYLES, outfitOf, visualsOf } from "../../../shared/look.ts";
import {
  ATK, BL, consumedAmmo, damageDelay, delayedDamageReach, mobAttack, pcAmotion, pcDmotion, playerAttack, walkDelay, weaponAttackAmmo, type AttackResult,
  type DamageLv,
} from "../../../shared/rules/battle.ts";
import { shootsAmmo, type AmmoFail } from "../../../shared/rules/weapons.ts";
import { inPcReach, pcAttackReach, pcAttackStep, pcDefersAttack, stepActionDelay } from "../../../shared/rules/unit.ts";
import {
  USW, attackWalkDelay, delayedWalkAt, exactCell, pastHalfStep, searchPath, skillWalkDelay, stepProgress, stepTime, stopSoonRemain,
  walkRequestPath, walkSubPath, type Cell, cellStackExceeded, nearbyFreecell, westClickBlocked,
} from "../../../shared/rules/walk.ts";
import { capExpGain, displayedGain, gainExp, planStatUp } from "../../../shared/rules/exp.ts";
import {
  PICKUP_RANGE, dropDirections, floorItemCell, floorLoot, mapCellFree, mobDeadLootOwners, mobDropModifier, rollMobDrops, takeItemTick, withItemRate,
  type BossType, type DropDir, type FloorLoot,
} from "../../../shared/rules/drops.ts";
import { loggedDamage, lootOwners, mobDeadShares, mobLogDamage, penalized, type DmgLog, type Receiver } from "../../../shared/rules/dmglog.ts";
import { partyExpAggregate, partyExpSplit } from "../../../shared/rules/party.ts";
import * as party from "../party.ts";
import type { ChatMsg as PartyChatMsg, PartyCreateMsg, PartyInviteMsg, PartyKickMsg, PartyLeaderMsg, PartyOptionMsg, PartyReplyMsg } from "../../../shared/protocol.ts";
import { deathPenalty, restartBase, restartValues } from "../../../shared/rules/death.ts";
import {
  MD, MIN_MOBLINKTIME, MONSTER_CONF, addLoot, battleCheckRange, canChangeTarget, canReach, hasMode, isChasing, mobCanSee, nextWalkTime,
  pickAggroTarget, pickLoot, randomWalkOffsets, walkpathTime, type MobState,
} from "../../../shared/rules/mobai.ts";
import { SPAWN_CONF, mobSpawnCell, parseSpawns, respawnDelay, spawnCenter, type SpawnData } from "../../../shared/rules/spawn.ts";
import { readFileSync } from "node:fs";
import { CLIENT_MSGS, gearUseVerdict, guardRequest, type ClientMsgGuard, type ClientMsgKey } from "../../../shared/rules/msgguard.ts";
import type { NpcMenuMsg, NpcReplyMsg, QuestActiveMsg } from "../../../shared/protocol.ts";
import { NPC_BY_ID, npcClassless, npcsOn } from "../../../shared/content/npcs.ts";
import type { NpcDef } from "../../../shared/content/api.ts";
import { itemNamed } from "../../../shared/rules/quest.ts";
import type { CallshopOption } from "../../../shared/rules/script.ts";
import { ScriptEngine, type ScriptHost } from "../script.ts";
import { SkillSystem } from "../skills.ts";
import { BASIC_SKILL_NEED } from "../../../shared/rules/skill.ts";
import type { SkillUpMsg, UseSkillMsg } from "../../../shared/protocol.ts";
import { isInvincible, pcTargetable, setInvincibleTimer } from "../../../shared/rules/invincible.ts";
import { config } from "../config.ts";
import { getSession } from "../auth.ts";
import { db } from "../db.ts";
import { redis } from "../redis.ts";
import { Timeline } from "../timeline.ts";
import { BossSystem } from "../boss.ts";
import { StatusSystem } from "../status.ts";
import { isScKey } from "../../../shared/rules/status_change.ts";
import { PetSystem } from "../pets.ts";

export const Player = schema({
  name: t.string(),
  // sprite look (shared/look.ts): creation choices + job outfit + layers of worn gear, so everyone sees your equipment
  gender: t.string(), hair: t.uint8(), style: t.uint8().default(0), outfit: t.string(),
  weapon: t.string(), shield: t.string(), headgear: t.string(), garment: t.string(),
  // bl->x / bl->y: the cell the character stands on, changed only when a step's timer fires (movement core below); sx / sy =
  // how far it has come into the cell it is stepping into (16ths of a cell, 0 while standing), so clients draw it between cells
  x: t.float32(),
  y: t.float32(),
  sx: t.float32().default(0), sy: t.float32().default(0),
  dir: t.uint8(),
  moving: t.boolean(),
  sitting: t.boolean(),
  dead: t.boolean(),
  job: t.string(), // rAthena job key (display name comes from shared/data/jobs.json)
  level: t.uint16(), // base level: public like clevel in clif_set_unit_idle / clif_set_unit_walking
  opt: t.string().default(""), // B14: the unit's visible status options (opt1 / opt2: "stone", "freeze", "stun", "poison" ... status_change.ts scOption)
  // Owner-only numbers: .noSync() keeps them on the server's Player (typed, read by the rules and the save) but never in the
  // synced state. rAthena sends them only to the owner (clif_updatestatus / clif_couplestatus / clif_par_change, all SELF;
  // another player's HP only to party / battleground members); the owner gets them as Msg.status (ownerStatus / flushStatus).
  hp: t.int32().noSync(), maxHp: t.int32().noSync(),
  sp: t.int32().noSync(), maxSp: t.int32().noSync(),
  exp: t.int32().noSync(),
  jobLevel: t.uint16().noSync(), jobExp: t.int32().noSync(),
  statPoints: t.uint16().noSync(), skillPoints: t.uint16().noSync(),
  str: t.uint8().noSync(), agi: t.uint8().noSync(), vit: t.uint8().noSync(), int: t.uint8().noSync(), dex: t.uint8().noSync(), luk: t.uint8().noSync(),
}, "Player");
export type Player = SchemaType<typeof Player>;

export const Monster = schema({
  mobId: t.uint16(), // shared/data/mobs.json id; clients look up name/level/element there
  x: t.float32(), // bl->x / bl->y and the drawn offset sx / sy, as for Player
  y: t.float32(),
  sx: t.float32().default(0), sy: t.float32().default(0),
  dir: t.uint8(),
  moving: t.boolean(),
  hp: t.int32(),
  maxHp: t.int32(),
  dead: t.boolean(),
  boss: t.uint8().default(0), // C07: 0 ordinary, 1 boss (Class Boss), 2 MVP (server/src/boss.ts BOSS_KIND): the client colours the name by it
  opt: t.string().default(""), // B14: visible status options, as Player.opt
}, "Monster");
export type Monster = SchemaType<typeof Monster>;

export const FloorItem = schema({
  itemId: t.uint16(),
  amount: t.uint16(),
  x: t.float32(),
  y: t.float32(),
}, "FloorItem");
export type FloorItem = SchemaType<typeof FloorItem>;

export const Npc = schema({
  name: t.string(),
  sprite: t.string(), // client sprite key (public/sprites/<sprite>.png)
  x: t.float32(),
  y: t.float32(),
  kind: t.string(), // "shop"
}, "Npc");
export type Npc = SchemaType<typeof Npc>;

// ---- Pets (2.4.0, server/src/pets.ts): a hatched pet, key "pet<petId>". Moves like a Monster (x / y = its cell, sx / sy the drawn
// offset); owner = the owner's session id; hungry = hunger <= PET_HUNGRY; accessory = the worn accessory item id (0 = none).
export const Pet = schema({
  mobId: t.uint16(), owner: t.string(), name: t.string(),
  x: t.float32(), y: t.float32(), sx: t.float32().default(0), sy: t.float32().default(0),
  dir: t.uint8(), moving: t.boolean(), hungry: t.boolean(), accessory: t.uint16().default(0),
}, "Pet");
export type Pet = SchemaType<typeof Pet>;

export const MapState = schema({
  seed: t.uint32(),
  map: t.string(), // C08: the map this room runs (shared/maps.ts); the client builds it from map + seed
  players: t.map(Player),
  monsters: t.map(Monster),
  floor: t.map(FloorItem),
  npcs: t.map(Npc),
  pets: t.map(Pet), // 2.4.0
}, "MapState");
export type MapState = SchemaType<typeof MapState>;

/** Permanent spawn lines of every map (npc/re/mobs format, our names); each room keeps the lines of its own map. */
const SPAWN_FILE = new URL("../../../shared/data/spawns.txt", import.meta.url);
/** area_size (conf/battle/client.conf): the attacked event ignores attackers farther than this (mob.cpp:1959). */
const MOB_AREA_SIZE = 14;
/** rnd() (common/random.cpp): a non-negative 31-bit random integer; AI code takes `% n` of it like the C++. */
const rnd = () => Math.floor(Math.random() * 0x80000000);
/** rnd_value(min, max) (common/random.hpp): uniform integer in [min, max] (bounds swapped if reversed). */
const rndValue = (min: number, max: number) => {
  if (min > max) [min, max] = [max, min];
  return min + Math.floor(Math.random() * (max - min + 1));
};
/** drops.conf; DROP_RATE (env, 1 = official) sets every item_rate_* to DROP_RATE * 100 like a rate-changed server. */
const DROPS = withItemRate(Math.trunc(100 * Number(process.env.DROP_RATE ?? 1)));
/** clif_npc_buy_result messages per e_purchase_result. */
const BUY_FAIL: Record<Exclude<BuyResult, "ok">, string> = {
  money: "You don't have enough zeny.",
  weight: "You can't carry that much.",
  count: "You can't carry any more items.",
};
/** clif_npc_sell_result 1 ("The deal has failed."). */
const SELL_FAIL = "You can't sell that.";
/** A shop NPC's list (rAthena "<item>:-1" = the item's own Buy price); a shop row without its own `shop` sells SHOP_ITEMS. */
function shopStock(def: NpcDef | undefined): ShopEvent["stock"] {
  return (def?.shop ?? SHOP_ITEMS).map((r) => itemNamed(r)).filter((it) => !!it).map((it) => ({ itemId: it!.id, price: it!.buy }));
}
/** MSI_BUSY: an NPC click (or an item use during a dialog) refused while an NPC dialog or a shop list is open. */
const NPC_BUSY = "You are busy right now. Close the NPC window first.";
/** MSI_CAN_NOT_EQUIP_ITEM: equipment can't change while an NPC dialog runs. */
const CANT_EQUIP_NOW = "You can't change equipment while talking to an NPC.";
/** clif_arrow_fail(ARROWFAIL_NO_AMMO) / clif_skill_fail(USESKILL_FAIL_NEED_MORE_BULLET): a bow / gun attack without its ammo. */
const AMMO_FAIL: Record<AmmoFail, string> = {
  noArrow: "You have no arrows equipped.",
  needBullet: "You have no bullets loaded.",
};

type Pos = { x: number; y: number; sx: number; sy: number; dir: number; moving: boolean };
type Actor = Pos & { hp: number; dead: boolean };
/** A unit's walk: the unit_data fields of rAthena's walk (server-only, in its Brain; see the movement core). */
type WalkState = {
  path: Cell[]; // ud->walkpath: the cells to enter, in order (path_len = path.length)
  pos: number; // ud->walkpath.path_pos: the cell being entered while a step runs
  stepAt?: number; // ud->walktimer: when the running step's timer fires; undefined = INVALID_TIMER (not walking)
  stepMs: number; // that timer's data: the step's duration (stepTime)
  token: number; // id of the running step timer: the timeline event of a stopped or replaced step is ignored (the tid check)
  to: Cell; // ud->to_x / to_y: where the walk goes
  changeTarget: boolean; // ud->state.change_walk_target: a request accepted during a step, searched again when it ends
  canmoveTick: number; // ud->canmove_tick: no walking before this (attack_walk_delay)
};
/** A normal attack between swing and landing (rAthena struct delay_damage). Units are kept by id + object, so a unit that
 *  left (or a respawn reusing the id) no longer matches when the timer fires — like map_id2bl returning nothing. */
type DelayedDamage = { src: string; srcUnit: Actor; target: string; targetUnit: Actor; res: AttackResult; reach: number };
// server-only per-actor data (never synced)
type Brain = {
  walk?: WalkState; // players and monsters: their walk (walkOf)
  target?: string; // id of the actor we are fighting
  engaged?: string; // monsters: target they reached and swung at (ud->target via unit_attack); see targetedCount
  nextAttack: number;
  repathAt: number;
  status: Status | MobStatus;
  // players
  nextHp?: number; nextSp?: number; sregenAt?: number; sregenHpMs?: number; sregenSpMs?: number;
  inv?: Inventory;
  weapon?: Weapon;
  hotkeys?: (number | null)[]; // the shortcut window: MAX_HOTKEYS item slots (rules/hotkey.ts)
  hotkeyRowShift?: number; // char.hotkey_rowshift: the bar rotation the window shows
  goal?: { kind: "pickup"; id: string }; // walk there, then act (NPCs are never walked to: npc_click only checks range)
  shopNpc?: string; // sd->npc_shopid: the NPC whose shop window is open (buy/sell need it; pc_close_npc clears it)
  canUseItemAt?: number; // sd->canuseitem_tick (rules/itemuse.ts)
  invincibleUntil?: number; // sd->invincible_timer: spawn protection ends at this room-clock time (rules/invincible.ts); undefined = none
  // floor items
  floorLoot?: FloorLoot; // flooritem_data first/second/third_get_charid + _tick (rules/drops.ts)
  expires?: number; // flooritem_lifetime clear timer
  // monsters: the mob_data / unit_data fields the AI uses (shared/rules/mobai.ts, mobAi below)
  mobState?: MobState; // md->state.skillstate
  walkAt?: number; // md->next_walktime: earliest next random walk
  thinkAt?: number; // md->next_thinktime: AI paused until then (mob_set_delay: attack motion after a swing)
  attacked?: { id: string; norm: boolean }; // md->attacked_id (+ norm_attacked_id): handled on the next think
  lootTarget?: string; // md->target_id when it is a floor item
  chaseTo?: string; // ud->target_to: what the current walk is chasing (checked cell by cell, unit_update_chase)
  chaseRange?: number; // ud->chaserange of that chase: the attack range, 0 for an item (unit_walktobl)
  moveToAttack?: boolean; // players: clif_movetoattack sent, the client walks in and asks to attack again once within reach
  stepTarget?: string; // players: ud->stepaction + ud->target_to, an attack asked during a step and not yet within range - 1
  stepToken?: number; // players: ud->steptimer, the pending retry of that step action (unit_step_timer)
  savePoint?: MapPos; // players: sd->status.save_point (pc_setsavepoint); undefined = Hearthmoor's hearth (start_point)
  nextMap?: MapPos; // players: pc_setpos to another map is under way (the client is changing rooms); the save writes this
  stepAttack?: boolean; // players: ud->state.step_attack, the attack came from a step action: reach + 1 (unit.cpp:3256-3258)
  loot?: { itemId: number; amount: number }[]; // md->lootitems, dropped again on death
  lastLink?: number; // md->last_linktime (MD_ASSIST)
  lastCanMove?: number; // md->last_canmove
  mode?: number; // monsters: a mode that replaces mob_db's (a slave's CANMOVE|NORANDOMWALK|CANATTACK, status_calc_slave_mode); undefined = def.mode
  dmglog?: DmgLog; // mob_log_damage: who hit it / was hit by it, keyed by character id (rules/dmglog.ts); new brain = fresh log
  statusSent?: string; // players: the last Msg.status sent to the owner (flushStatus sends again only when it changed)
  hpFull?: boolean; // players: HP was at max on the last tick (questinfo conditions on Hp are re-checked when it flips)
};

/** Who is in game, per account, across every map room: one character per account, the newest login wins. */
const online = new Map<number, { room: MapRoom; client: Client }>();
/** Logins of one account run one after another, so a second login waits until the first is in the world (or failed)
 *  and then evicts it properly instead of racing its load. */
const logins = new Map<number, Promise<unknown>>();
function serialLogin<T>(accountId: number, run: () => Promise<T>): Promise<T> {
  const p = (logins.get(accountId) ?? Promise.resolve()).then(run);
  const tail = p.catch(() => {});
  logins.set(accountId, tail);
  void tail.then(() => { if (logins.get(accountId) === tail) logins.delete(accountId); });
  return p;
}

const statsOf = (p: Player): Stats => ({ str: p.str, agi: p.agi, vit: p.vit, int: p.int, dex: p.dex, luk: p.luk });

/** DEV ONLY (RO_TICK_STATS=1): logs p50/p95/max of the simulation tick duration every 10 s. */
function tickStats(map: string, f: (dt: number) => void) {
  let xs: number[] = [], last = Date.now();
  return (dt: number) => {
    const t = performance.now();
    f(dt);
    xs.push(performance.now() - t);
    if (Date.now() - last >= 10_000) {
      xs.sort((a, b) => a - b);
      console.log(`[tickstats] ${map} n=${xs.length} p50=${xs[xs.length >> 1].toFixed(2)} p95=${xs[Math.floor(xs.length * 0.95)].toFixed(2)} max=${xs[xs.length - 1].toFixed(2)} ms`);
      xs = []; last = Date.now();
    }
  };
}

export class MapRoom extends Room<{ state: MapState }> {
  maxClients = 200;
  map!: GameMap;
  /** The map this room runs (one room per map, server/src/index.ts). */
  mapName: MapName = FIELD;
  brains = new Map<string, Brain>();
  accountOf = new Map<string, number>();
  timeline = new Timeline(); // delayed events (walk steps, attack damage, retaliation, later skills); drained every tick
  private walkSeq = 0; // ids of step timers (a stopped or replaced step's event is recognised and ignored)
  nextMonsterId = 1;
  private nextFloorId = 1;
  /** md->spawn + md->centerX/Y per monster id: its spawn line and its own centre cell (server-only, survives respawns). */
  mobSpawns = new Map<string, { sd: SpawnData; center: { x: number; y: number } }>();
  /** NPC scripts + quests of the players in this room (server/src/script.ts): sd->st / sd->npc_id, quest logs. */
  npcEngine!: ScriptEngine;
  /** Skills: learning, casting, delays, the job change (server/src/skills.ts). */
  skills: SkillSystem = new SkillSystem(this);
  /** Bosses: MVP rewards, tombs, slaves (server/src/boss.ts). */
  boss: BossSystem = new BossSystem(this);
  /** Status changes: sc_data of every unit, timers, effects, skills / cards / monster skills that apply them (server/src/status.ts). */
  status: StatusSystem = new StatusSystem(this);
  /** Pets: catching, eggs, the pet units, hunger, battle / support pets (server/src/pets.ts). */
  pets: PetSystem = new PetSystem(this);

  onCreate(options?: { map?: string }) {
    this.state = new MapState();
    this.mapName = isMapName(options?.map) ? options.map : isMapName(config.mapName) ? config.mapName : FIELD;
    this.state.seed = config.mapSeed;
    this.state.map = this.mapName;
    this.map = buildMap(this.mapName, config.mapSeed);
    this.spawnMobs();
    // the patch goes out at the end of every simulation tick, not on its own 50 ms timer: that timer ran just before the tick, so
    // every patch carried the previous tick's positions (a walk showed ~50 ms late; patch 2.2.1)
    this.setPatchRate(null);
    const tick = process.env.RO_TICK_STATS ? tickStats(this.mapName, (dt) => this.tick(dt / 1000)) : (dt: number) => this.tick(dt / 1000);
    this.setSimulationInterval((dt) => { tick(dt); this.broadcastPatch(); }, TICK_MS);
    // autosave: a redeploy/crash loses at most 30 s of progress
    this.clock.setInterval(() => {
      for (const p of this.state.players.values()) this.save(p).catch((e) => console.error("[autosave]", e));
    }, 30_000);

    // clif_parse_WalkToXY -> unit_walktoxy(flag 4), timed from the moment the request arrived: a sitting player can't walk
    // (unit_can_move), a refused path leaves the current walk alone, an accepted one replaces whatever the player was doing
    // (unit_unattackable + unit_stop_attack). Within the attack motion the walk itself starts at canmove_tick + 1.
    this.onGuarded("move", (client, m: MoveMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.dead || p.sitting || !Number.isInteger(m?.x) || !Number.isInteger(m?.y)) return;
      const b = this.brains.get(client.sessionId)!;
      if (westClickBlocked(this.cell(p), m, this.standingOn(m.x, m.y))) return; // clif_parse_WalkToXY (clif.cpp:11402-11405)
      if (this.walkToXY(client.sessionId, p, b, m.x, m.y, 4, this.exactNow())) { this.newIntent(b); this.skills.dropGoal(client.sessionId); }
    });

    this.onGuarded("attack", (client, m: AttackMsg) => {
      const p = this.state.players.get(client.sessionId);
      // duel (2.4.0): a duelist hits only its duel mate (battle_check_target), nobody else can hit a duelist
      const foeId = duel.foe(this, client.sessionId), want = String(m?.id);
      const mon = foeId !== undefined ? (want === foeId ? this.state.players.get(foeId) : undefined) : this.state.monsters.get(want);
      if (!p || p.dead || !mon || mon.dead || this.skills.casting(client.sessionId)) return; // unit_attack: refused during a cast
      const b = this.brains.get(client.sessionId)!;
      p.sitting = false;
      this.newIntent(b); // also unit_stop_stepaction: the latest request is what counts
      this.skills.dropGoal(client.sessionId);
      b.target = String(m.id);
      b.repathAt = 0;
      this.unitAttack(client.sessionId, p, b, mon, this.exactNow()); // decided when the request arrives (unit_attack)
    });

    this.onGuarded("sit", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.dead) return;
      const b = this.brains.get(client.sessionId)!;
      // clif_parse_ActionRequest_sub DMG_SIT_DOWN (clif.cpp:11741): basic_skill_check -> Basic Skill 3 to sit (USESKILL_FAIL_LEVEL)
      if (!p.sitting && !this.skills.basicOk(client.sessionId, BASIC_SKILL_NEED.sit)) return this.skills.fail(client.sessionId, 1, "basic");
      if (!p.sitting && this.skills.casting(client.sessionId)) return;
      p.sitting = !p.sitting;
      // clif_parse_ActionRequest_sub: sit/stand runs unit_stop_walking(USW_FIXPOS) + unit_stop_attack; FIXPOS stops on the
      // cell the player stands on (bl->x / bl->y), not the one it was stepping into
      if (p.sitting) { this.stopWalking(client.sessionId, p, b, USW.FIXPOS, this.exactNow()); this.newIntent(b); }
    });

    this.onGuarded("statUp", (client, m: StatUpMsg) => {
      const p = this.state.players.get(client.sessionId);
      const k = m?.stat;
      if (!p) return;
      // pc_statusup (pc.cpp:8879): a type outside SP_STR..SP_LUK is answered clif_statusupack(type, false) too, never dropped
      if (!STAT_KEYS.includes(k)) return void client.send(Msg.statUpAck, { stat: k, ok: false, amount: 0, value: 0 } satisfies StatUpAck);
      // pc_statusup: amount is lowered to what points and the job cap allow; 0 = refused (clif_statusupack false)
      const plan = planStatUp(p.job as JobKey, k, p[k], p.statPoints, m.amount ?? 1);
      if (plan.amount > 0) {
        p.statPoints -= plan.cost;
        p[k] += plan.amount;
        this.refreshStatus(client.sessionId, p);
        // our addition to pc_show_questinfo's triggers: a questinfo condition may read StatusPoint (a quest task, tasks.ts)
        this.npcEngine.questinfo(client.sessionId);
      }
      this.flushStatus(client.sessionId); // pc_statusup: clif_updatestatus(SP_<stat>, SP_STATUSPOINT ...) before clif_statusupack
      client.send(Msg.statUpAck, { stat: k, ok: plan.amount > 0, amount: plan.amount, value: p[k] } satisfies StatUpAck);
    });

    this.onGuarded("respawn", (client) => {
      const { p, b } = this.me(client);
      if (!p?.dead || !b) return;
      p.dead = false;
      ({ hp: p.hp, sp: p.sp } = restartValues(p.job as JobKey, p.maxHp, p.maxSp, p.sp)); // pc_setrestartvalue(sd,3)
      // pc_respawn -> pc_setpos(save point) -> client map load -> LoadEndAck -> pc_setinvincibletimer + the arrival cell's OnTouch
      // areas; a save point on another map is a map change (C08)
      this.setPos(client.sessionId, p, b, this.savePointOf(b));
    });

    this.onGuarded("chat", async (client, m: ChatMsg) => {
      const p = this.state.players.get(client.sessionId);
      const text = String(m?.text ?? "").trim().slice(0, 120);
      if (!p || !text) return;
      const k = `chat-rate:${p.name}`;
      if ((await redis.incr(k)) === 1) await redis.expire(k, 5);
      else if (Number(await redis.get(k)) > 5) return; // 5 lines / 5 s
      // clif_parse_GlobalMessage (clif.cpp:11526-11535): the others within AREA_SIZE - 5 cells hear it (AREA_CHAT_WOC), and the
      // speaker gets its own line back (SELF)
      const ev = { id: client.sessionId, name: p.name, text } satisfies ChatEvent;
      this.sendArea("AREA_CHAT_WOC", client.sessionId, Msg.chat, ev);
      client.send(Msg.chat, ev);
    });

    // ---------- items ----------
    // NPCs of this map (shared/content/npcs.ts); script NPCs run through the engine (one script per player at a time). Invisible
    // ones (FAKE_NPC: no sprite, e.g. a trigger area) stay server-side, like rAthena never sends a class -1 NPC to the client.
    for (const n of npcsOn(this.mapName)) if (n.sprite) this.state.npcs.set(n.id, new Npc({ name: n.name, sprite: n.sprite, x: n.x, y: n.y, kind: n.kind }));
    this.npcEngine = new ScriptEngine(this.scriptHost(), npcsOn(this.mapName));
    this.boss.register(); // dev-only GM shortcuts of the boss bot (never in production)
    this.status.register(); // dev-only GM shortcut of the status bot (never in production)
    this.pets.register(); // pet requests (+ the pets bot's dev-only shortcuts)
    // skills: CZ_UPGRADE_SKILLLEVEL (pc_skillup), CZ_USE_SKILL / CZ_USE_SKILL_TOGROUND (unit_skilluse_id / _pos)
    this.onGuarded("skillUp", (client, m: SkillUpMsg) => this.skills.skillUp(client, Number(m?.id)));
    this.onGuarded("useSkill", (client, m: UseSkillMsg) => this.skills.use(client, m));

    this.onGuarded("pickup", (client, m: PickupMsg) => this.setGoal(client.sessionId, "pickup", String(m?.id)));
    this.onGuarded("npc", (client, m: NpcMsg) => this.clickNpc(client, String(m?.id)));
    this.onGuarded("useItem", (client, m: UseItemMsg) => this.useItem(client, Number(m?.uid)));
    this.onGuarded("useCard", (client, m: UseCardMsg) => this.cardList(client, Number(m?.uid)));
    this.onGuarded("insertCard", (client, m: InsertCardMsg) => this.insertCard(client, Number(m?.card), Number(m?.equip)));
    this.onGuarded("equip", (client, m: EquipMsg) => {
      const { p, b } = this.me(client);
      const st = b?.inv?.items.get(Number(m?.uid));
      if (!p || !b || !st || p.dead) return;
      const why = equipBlock(ITEMS.get(st.itemId)!, p.job as JobKey, p.level, (b.weapon ?? FISTS).type);
      if (why) return this.notice(client, `Can't equip: ${why}.`);
      b.inv!.equip(st.uid);
      this.afterGearChange(client, p);
    });
    this.onGuarded("unequip", (client, m: EquipMsg) => {
      const { p, b } = this.me(client);
      if (p && b?.inv?.unequip(Number(m?.uid))) this.afterGearChange(client, p);
    });
    // npc_buylist / npc_selllist: the whole list is validated against the live inventory, then applied synchronously
    // (no await between check and change), so back-to-back requests see each other's result. Every refusal is answered
    // (clif_npc_buy_result / clif_npc_sell_result), including no open shop (guard refusal) and shop out of npc_checknear.
    this.onGuarded("shopBuy", (client, m: ShopBuyMsg) => {
      const { p, b } = this.me(client);
      if (!p || !b?.inv) return;
      try {
        const gate = buyGate(true, this.nearNpc(p, b.shopNpc));
        if (gate !== "ok") return this.notice(client, BUY_FAIL[gate]);
        const stock = shopStock(NPC_BY_ID.get(b.shopNpc!)).map((s) => s.itemId); // nd->u.shop.shop_item of the open shop
        const r = buyList(Array.isArray(m?.items) ? m.items : [], stock, b.inv.rows(), b.inv.zeny, b.inv.weight(), maxWeight(p.job as JobKey, p.str));
        if (r.result !== "ok") return this.notice(client, BUY_FAIL[r.result]);
        if (!b.inv.payZeny(r.cost)) return this.notice(client, BUY_FAIL.money);
        for (const l of r.lines) b.inv.add(l.itemId, l.amount);
        this.notice(client, `Bought ${r.lines.length} item type(s) for ${r.cost.toLocaleString()} z.`);
        this.sendInv(client, p);
      } finally {
        this.endShop(client, b); // clif_parse_NpcBuyListSend: sd->npc_shopid = 0 after every list, whatever the result (clif.cpp:12324)
      }
    }, (client) => {
      const gate = buyGate(false, false);
      if (gate !== "ok") this.notice(client, BUY_FAIL[gate]);
      const b = this.brains.get(client.sessionId);
      if (b) this.endShop(client, b);
    });
    this.onGuarded("shopSell", (client, m: ShopSellMsg) => {
      const { p, b } = this.me(client);
      if (!p || !b?.inv) return;
      try {
        if (!sellGate(true, this.nearNpc(p, b.shopNpc))) { this.notice(client, SELL_FAIL); return this.sendInv(client, p); }
        const r = sellList(Array.isArray(m?.items) ? m.items : [], b.inv.items);
        if (!r.ok) { this.notice(client, SELL_FAIL); return this.sendInv(client, p); }
        for (const l of r.lines) b.inv.remove(l.row, l.amount);
        b.inv.gainZeny(r.gain);
        this.notice(client, `Sold for ${r.gain.toLocaleString()} z.`);
        this.sendInv(client, p);
      } finally {
        this.endShop(client, b); // clif_parse_NpcSellListSend: sd->npc_shopid = 0 after every list (clif.cpp:12359)
      }
    }, (client) => {
      this.notice(client, SELL_FAIL);
      const b = this.brains.get(client.sessionId);
      if (b) this.endShop(client, b);
    });
    this.onGuarded("hotkeys", (client, m: HotkeysMsg) => {
      const { b } = this.me(client);
      if (!b) return;
      if (Array.isArray(m?.keys)) b.hotkeys = hotkeyList(m.keys); // clif_parse_Hotkey (idx < MAX_HOTKEYS_DB, known items only)
      if (isRowShift(m?.rowShift)) b.hotkeyRowShift = m.rowShift; // clif_parse_HotkeyRowShift
    });
    // NPC dialog answers -> npc_scriptcont (the engine checks the npc, range and choice), quest show/hide (CZ_ACTIVE_QUEST),
    // and the shop list window closing (CZ_NPC_TRADE_QUIT, clif_parse_NPCShopClosed: npc_shopid = 0)
    this.onGuarded("npcNext", (client, m: NpcReplyMsg) => this.npcEngine.reply(client.sessionId, String(m?.npc), { kind: "next" }));
    this.onGuarded("npcMenu", (client, m: NpcMenuMsg) => this.npcEngine.reply(client.sessionId, String(m?.npc), { kind: "menu", choice: m?.choice }));
    this.onGuarded("npcClose", (client, m: NpcReplyMsg) => this.npcEngine.reply(client.sessionId, String(m?.npc), { kind: "close" }));
    this.onGuarded("questActive", (client, m: QuestActiveMsg) => this.npcEngine.setActive(client.sessionId, Number(m?.id), !!m?.active));
    this.onGuarded("shopQuit", (client) => { const { b } = this.me(client); if (b) b.shopNpc = undefined; });
    // party (server/src/party.ts; rAthena party.cpp)
    this.onGuarded("partyCreate", (client, m: PartyCreateMsg) => party.create(this, client, m));
    this.onGuarded("partyInvite", (client, m: PartyInviteMsg) => party.invite(this, client, m));
    this.onGuarded("partyReply", (client, m: PartyReplyMsg) => party.reply(this, client, m));
    this.onGuarded("partyLeave", (client) => party.leaveParty(this, client));
    this.onGuarded("partyKick", (client, m: PartyKickMsg) => party.kick(this, client, m));
    this.onGuarded("partyLeader", (client, m: PartyLeaderMsg) => party.changeLeader(this, client, m));
    this.onGuarded("partyOption", (client, m: PartyOptionMsg) => party.option(this, client, m));
    this.onGuarded("partyChat", (client, m: PartyChatMsg) => party.chat(this, client, m));
    // duel (server/src/duel.ts; rAthena duel.cpp)
    this.onGuarded("duelInvite", (client, m: DuelInviteMsg) => duel.invite(this, client, m));
    this.onGuarded("duelReply", (client, m: DuelReplyMsg) => duel.reply(this, client, m));
    this.onGuarded("duelLeave", (client) => duel.leave(this, client));
    // friends + whisper (server/src/friends.ts)
    this.onGuarded("friendAdd", (client, m: FriendAddMsg) => friends.friendAdd(client, this.charIdOf(client.sessionId)!, m));
    this.onGuarded("friendReply", (client, m: FriendReplyMsg) => friends.friendReply(client, this.charIdOf(client.sessionId)!, m));
    this.onGuarded("friendRemove", (client, m: FriendRemoveMsg) => friends.friendRemove(client, this.charIdOf(client.sessionId)!, m));
    this.onGuarded("whisper", (client, m: WhisperMsg) => friends.whisper(client, this.charIdOf(client.sessionId)!, m));
  }

  // ---------- item helpers ----------
  /** Register a client request through the CLIENT_MSGS guard table (shared/rules/msgguard.ts): dead / open-shop checks run
   *  before the handler, so a handler can't forget them. A new Msg must get a row there before it can be handled.
   *  `refuse` answers a denied request (shop deals reply with a fail result, like clif_parse_NpcBuyListSend). */
  onGuarded<K extends ClientMsgKey, M>(key: K, fn: (client: Client, m: M) => void | Promise<void>, refuse?: (client: Client) => void) {
    this.onMessage(Msg[key], (client: Client, m: M) => {
      // rAthena's timers fire on time, not on a 50 ms grid: every step / landing hit due before this request arrived has
      // happened by now, so the request sees the cells and HP of the moment it arrives (between two simulation ticks)
      this.timeline.run(this.exactNow());
      const { p, b } = this.me(client);
      if (!p || !b) return;
      const g: ClientMsgGuard = CLIENT_MSGS[key];
      // sd->npc_shopid is set and names the shop this request is for; the range (npc_checknear) is the handler's check
      const shopOpen = !!g.shop && !!b.shopNpc && b.shopNpc === String((m as { npc?: unknown } | undefined)?.npc);
      // dead rule, shop session, then the NPC-session lock (sd->npc_id / sd->npc_shopid: pc_cant_act ...); only a request that
      // passes all of them may end the spawn protection (shared/rules/msgguard.ts guardRequest, clif.cpp:11393 -> 11415)
      const o = guardRequest(g, p.dead, shopOpen, { talking: this.npcEngine.talking(client.sessionId), shopping: b.shopNpc !== undefined });
      if (!o.run) {
        if (o.why === "dead" || o.why === "shop") return refuse?.(client);
        if (o.why === "busy") this.notice(client, NPC_BUSY);
        else if (o.why === "cant_equip") this.notice(client, CANT_EQUIP_NOW);
        return;
      }
      if (o.endInvincible) this.endInvincible(b); // pc_delinvincibletimer runs before the walk / attack itself can be refused
      return fn(client, m);
    });
  }
  /** clif_parse_NpcClicked -> npc_click (npc.cpp:2212): an NPC within npc_checknear range opens at once; farther away
   *  nothing happens and nothing is sent. No walking, and the current walk / attack is left alone (npc_click never calls
   *  unit_walktoxy or unit_stop_*). A shop sets sd->npc_shopid like npc_buysellsel (npc.cpp:2409). */
  clickNpc(client: Client, id: string) {
    const { p, b } = this.me(client);
    if (this.boss.clickTomb(client, id)) return; // an MVP tomb (npc_click NPCTYPE_TOMB -> run_tomb)
    const n = this.state.npcs.get(id), def = NPC_BY_ID.get(id);
    if (!p || !b || !n || !def || !this.nearNpc(p, id)) return; // only NPCs the client can see can be clicked
    if (def.kind === "script") return this.npcEngine.click(client.sessionId, def); // run_script
    this.openShop(client, b, def, 0); // a shop NPC: clif_npcbuysell (the buy / sell choice)
  }
  /** npc_buysellsel / clif_npcbuysell: sd->npc_shopid = the shop, and its window (npc.cpp:2387-2416; callshop option 0 / 1 / 2). */
  openShop(client: Client, b: Brain, def: NpcDef, type: CallshopOption) {
    b.shopNpc = def.id;
    client.send(Msg.shop, { npc: def.id, name: def.name, stock: shopStock(def), type } satisfies ShopEvent);
  }
  /** pc_close_npc (pc.cpp:9746): end the NPC/shop session and tell the client to close its window. */
  closeNpc(client: Client | undefined, b: Brain) {
    b.goal = undefined;
    if (client) this.npcEngine.end(client.sessionId, "death"); // the script dialog (sd->npc_id) ends as well (flag 2)
    this.endShop(client, b);
  }
  /** sd->npc_shopid = 0 and the client's list window closes: after every buy / sell list (clif.cpp:12324 / 12359), on a warp
   *  (unit_remove_map, unit.cpp:3678) and on death (pc_close_npc). */
  endShop(client: Client | undefined, b: Brain) {
    if (b.shopNpc === undefined) return;
    b.shopNpc = undefined;
    client?.send(Msg.shopClose, {});
  }
  /** What the NPC script engine (server/src/script.ts) may use in this room. */
  private scriptHost(): ScriptHost {
    const client = (sid: string) => this.clients.getById(sid);
    return {
      mapName: this.mapName,
      now: () => this.clock.currentTime,
      send: (sid, type, msg) => client(sid)?.send(type, msg),
      near: (sid, npcId) => { const p = this.state.players.get(sid); return !!p && this.nearNpc(p, npcId); },
      pc: (sid) => this.state.players.get(sid),
      inv: (sid) => this.brains.get(sid)?.inv,
      gainExp: (sid, base, job) => { const p = this.state.players.get(sid); if (p) this.reward(sid, p, base, job, true); },
      invChanged: (sid) => { const c = client(sid), p = this.state.players.get(sid); if (c && p) this.sendInv(c, p); },
      gearChanged: (sid) => { const c = client(sid), p = this.state.players.get(sid); if (c && p) this.afterGearChange(c, p); },
      notice: (sid, text) => { const c = client(sid); if (c) this.notice(c, text); },
      setInterval: (fn, ms) => { this.clock.setInterval(fn, ms); },
      setTimeout: (fn, ms) => { this.clock.setTimeout(fn, ms); },
      // clif_emotion (clif.cpp): AREA around the unit (a player or an NPC of this map)
      emotion: (unitId, type) => this.sendArea("AREA", unitId, Msg.emotion, { id: unitId, type } satisfies EmotionEvent),
      // buildin_npctalk -> clif_messagecolor(_target): bc_self to the attached player only, bc_area around the NPC, bc_map / bc_all
      // to everyone in this room (one room = one map; ALL_CLIENT would cross rooms once there are several)
      npcTalk: (npcId, text, color, target, sid) => {
        const ev = { npc: npcId, text, color } satisfies NpcTalkEvent;
        if (target === "self") client(sid)?.send(Msg.npcTalk, ev);
        else if (target === "area") this.sendArea("AREA", npcId, Msg.npcTalk, ev);
        else this.broadcast(Msg.npcTalk, ev);
      },
      changeHpSp: (sid, change, show) => this.scriptHpSp(sid, change, show),
      openShop: (sid, shop, option) => { const c = client(sid), b = this.brains.get(sid); if (c && b) this.openShop(c, b, shop, option); },
      skillLv: (sid, key) => this.skills.level(sid, key),
      jobChange: (sid, job) => this.skills.jobChange(sid, job),
      resetLevel: (sid) => this.skills.resetLevel(sid), // 2.5.0 rebirth (skills.ts)
      warp: (sid, map, x, y) => {
        const p = this.state.players.get(sid), b = this.brains.get(sid);
        // buildin_warp (script.cpp:5628): "SavePoint" / "Save" = pc_setpos(save point)
        if (p && b && (map === "SavePoint" || map === "Save")) this.setPos(sid, p, b, this.savePointOf(b));
        else if (p && b && isMapName(map)) this.setPos(sid, p, b, { map, x, y });
        else console.warn(`[script] warp: unknown map ${map}`);
      },
      makeEgg: (sid, itemId) => this.pets.makeEgg(sid, itemId), // buildin_getitem on an egg -> pet_create_egg
      savepoint: (sid, map, x, y) => { const b = this.brains.get(sid); if (b && isMapName(map)) b.savePoint = { map, x, y }; },
    };
  }
  /** A script's heal / percentheal on a player (status_heal / status_damage with no attacker): HP / SP move by the given amounts;
   *  `show` (buildin_heal: pc_heal -> clif_heal) shows the healed amounts to the owner. Losing HP this way neither stands the
   *  player up nor delays its walk (pc_damage returns before that without a src); a change that kills is a death like any other
   *  (pc_dead), with no killer. */
  scriptHpSp(sid: string, change: { hp: number; sp: number; kill: boolean }, show: boolean) {
    const p = this.state.players.get(sid), b = this.brains.get(sid), c = this.clients.getById(sid);
    if (!p || !b || p.dead) return;
    p.hp = Math.max(0, Math.min(p.maxHp, p.hp + change.hp));
    p.sp = Math.max(0, Math.min(p.maxSp, p.sp + change.sp));
    if (show && c && (change.hp > 0 || change.sp > 0)) {
      c.send(Msg.heal, { id: sid, itemId: 0, ...(change.hp > 0 ? { hp: change.hp } : {}), ...(change.sp > 0 ? { sp: change.sp } : {}) } satisfies HealEvent);
    }
    if (change.kill && p.hp <= 0) this.unitDied(sid, p, b, undefined);
    this.flushStatus(sid);
  }
  me(client: Client) {
    return { p: this.state.players.get(client.sessionId), b: this.brains.get(client.sessionId) };
  }
  /** clif_send for a per-event message: the players `type` reaches around unit `src` (a player or a monster on this map; rules
   *  in server/src/area.ts). Only events are area-limited; the synced state still reaches everyone. */
  sendArea(type: SendTarget, src: string, msgType: string, msg: unknown) {
    const u = this.actor(src) ?? this.state.npcs.get(src); // an NPC is a unit too (clif_emotion / ZC_NPC_CHAT around it)
    if (!u) return;
    const cells = [...this.state.players].map(([id, p]) => [id, this.cell(p)] as const);
    const to = new Set(areaReceivers(type, { id: src, ...this.cell(u) }, cells));
    for (const c of this.clients) if (to.has(c.sessionId)) c.send(msgType, msg); // one pass, no getById per receiver
  }
  /** intif_broadcast (BC_DEFAULT): a line for everyone playing, in every map room (the account registry `online` spans them). */
  announce(text: string) {
    for (const { client } of online.values()) client.send(Msg.announce, { text } satisfies AnnounceEvent);
  }
  /** The character's own numbers as its client is sent them (clif_updatestatus / clif_couplestatus, SELF). */
  ownerStatus(p: Player, inv?: Inventory): StatusEvent {
    return {
      level: p.level, jobLevel: p.jobLevel, exp: p.exp, jobExp: p.jobExp, statPoints: p.statPoints, skillPoints: p.skillPoints,
      hp: ownerHp(p.job as JobKey, p.hp, p.maxHp), maxHp: p.maxHp, sp: p.sp, maxSp: p.maxSp, // SP_HP never sends 0 (ownerHp)
      str: p.str, agi: p.agi, vit: p.vit, int: p.int, dex: p.dex, luk: p.luk,
      // SP_WEIGHT / SP_MAXWEIGHT: max weight follows job + STR (status.cpp:3663), so a stat raise / job change / any refreshStatus
      // that changes it reaches the owner through the same change-detecting flush as every other number.
      weight: inv?.weight() ?? 0, maxWeight: maxWeight(p.job as JobKey, p.str),
    };
  }
  /** Send the owner its Msg.status when any of its numbers changed since the last one (rAthena sends clif_updatestatus to the
   *  owner on every change). Runs every tick, and at once where the order matters: before a stat-raise ack (pc_statusup) and
   *  before a level-up effect (pc_checkbaselevelup sends SP_BASELEVEL etc. before clif_misceffect). */
  flushStatus(id: string, c: Client | undefined = this.clients.getById(id)) {
    const p = this.state.players.get(id), b = this.brains.get(id);
    if (!p || !b || !c) return;
    const s = this.ownerStatus(p, b.inv), key = JSON.stringify(s);
    if (key === b.statusSent) return;
    b.statusSent = key;
    c.send(Msg.status, s);
  }
  notice(client: Client, text: string) { client.send(Msg.notice, { text } satisfies NoticeEvent); }
  sendInv(client: Client, p: Player) {
    const b = this.brains.get(client.sessionId);
    if (b?.inv) client.send(Msg.inv, b.inv.message(p.job as JobKey, p.str));
    this.npcEngine?.questinfo(client.sessionId); // pc_additem / pc_delitem -> pc_show_questinfo
  }
  afterGearChange(client: Client, p: Player) {
    this.refreshStatus(client.sessionId, p);
    this.applyLook(p, this.brains.get(client.sessionId)?.inv);
    this.sendInv(client, p);
  }
  /** Public avatar look from worn equipment (empty string = nothing shown). */
  applyLook(p: Player, inv?: Inventory) {
    const worn = inv ? [...inv.items.values()].filter((s) => s.equip).map((s) => ITEMS.get(s.itemId)!) : [];
    const v = visualsOf(worn.map((i) => ({ id: i.id, type: i.type, subType: i.subType })));
    p.weapon = v.weapon ?? ""; p.shield = v.shield ?? ""; p.headgear = v.headgear ?? ""; p.garment = v.garment ?? "";
    p.outfit = outfitOf(p.job);
  }

  /** npc_checknear (rules/npc.ts) from the player's cell; a class-less NPC (invisible FAKE_NPC or floating, npcClassless) is near
   *  from anywhere ("Class-less npc, enable click from anywhere", npc.cpp:2153). */
  nearNpc(p: Player, id: string | undefined) {
    const def = id === undefined ? undefined : NPC_BY_ID.get(id);
    if (def && npcClassless(def)) return true;
    const n = id === undefined ? undefined : this.state.npcs.get(id);
    return !!n && npcCheckNear(this.cell(p), n);
  }
  setGoal(sessionId: string, kind: "pickup", id: string) {
    const p = this.state.players.get(sessionId), b = this.brains.get(sessionId);
    if (!p || !b || p.dead) return;
    if (!this.state.floor.has(id)) return;
    p.sitting = false;
    this.newIntent(b);
    b.goal = { kind, id };
    b.repathAt = 0;
  }

  /** Every new player request replaces the previous one (rAthena: unit_walktoxy / unit_attack call unit_stop_attack, and
   *  the client walks to items itself, so a later click always wins; an NPC click is not an intent, see clickNpc). Callers set the new target/goal after this. */
  newIntent(b: Brain) {
    b.target = undefined;
    b.goal = undefined;
    b.moveToAttack = false;
    b.stepTarget = undefined; b.stepAttack = false; // unit_stop_stepaction
  }

  useItem(client: Client, uid: number) {
    const { p, b } = this.me(client);
    const st = b?.inv?.items.get(uid);
    if (!p || !b?.inv || !st || p.dead) return;
    const it = ITEMS.get(st.itemId)!;
    if (this.pets.useItem(client.sessionId, uid, it.id)) return; // taming item / egg / pet accessory (server/src/pets.ts)
    if (isCard(it)) return this.cardList(client, uid); // a hotkeyed / double-clicked card opens the compound list
    if (isEquip(it)) { // hotkeyed equipment toggles: gear only changes through the equip / unequip request, so it obeys their lock
      const lv = gearUseVerdict({ talking: this.npcEngine.talking(client.sessionId), shopping: b.shopNpc !== undefined });
      if (lv !== "ok") { if (lv === "cant_equip") this.notice(client, CANT_EQUIP_NOW); return; }
      if (st.equip) { b.inv.unequip(uid); this.afterGearChange(client, p); return; }
      const why = equipBlock(it, p.job as JobKey, p.level, (b.weapon ?? FISTS).type);
      if (why) return this.notice(client, `Can't equip: ${why}.`);
      b.inv.equip(uid); this.afterGearChange(client, p); return;
    }
    if ((it.effect as { album?: boolean } | null)?.album) { // the card album (rules/album.ts): one random card, like getgroupitem(IG_CardAlbum)
      const now = this.exactNow();
      if (!itemUseReady(now, b.canUseItemAt ?? 0)) return;
      const card = ITEMS.get(pickAlbumCard(Math.random()))!;
      const why = b.inv.canAdd(card, 1, p.job as JobKey, p.str);
      if (why) return this.notice(client, `Can't open ${it.name}: ${why}.`);
      b.canUseItemAt = nextItemUse(now);
      b.inv.remove(uid, 1);
      b.inv.add(card.id, 1);
      client.send(Msg.itemGet, { itemId: card.id, amount: 1 } satisfies ItemGetEvent);
      this.notice(client, `The ${it.name} held a ${card.name}!`);
      this.sendInv(client, p);
      return;
    }
    const heal = rollHeal(it);
    const tele = (it.effect as { teleport?: string } | null)?.teleport;
    const cure = (it.effect as { cure?: string[] } | null)?.cure; // `sc_end SC_POISON;` (Green Herb)
    if (!heal && !tele && !cure) return this.notice(client, `${it.name} can't be used yet.`);
    const now = this.exactNow();
    if (!itemUseReady(now, b.canUseItemAt ?? 0)) return; // pc_isUseitem: canuseitem_tick (item_use_interval)
    if (delayConsumeBlockedWhileSitting(it, p.sitting)) return; // pc_useitem: DelayConsume + pc_issit -> not used, not consumed
    b.canUseItemAt = nextItemUse(now);
    b.inv.remove(uid, 1);
    if (heal) {
      const stats = b.status.stats;
      const hp = Math.min(p.maxHp - p.hp, itemHealAmount(heal.hp, stats.vit, 10 * this.skills.level(client.sessionId, "SM_RECOVERY"))), sp = Math.min(p.maxSp - p.sp, itemHealAmount(heal.sp, stats.int, 10 * this.skills.level(client.sessionId, "MG_SRECOVERY"))); // status_heal clamps to max-cur
      p.hp += hp; p.sp += sp;
      // clif_useitemack(ok) goes to the area (clif.cpp:4492-4496); what it healed is the owner's own HP / SP (pc_itemheal ->
      // status_heal flag 1 -> pc_heal -> clif_updatestatus SP_HP / SP_SP, SELF)
      this.sendArea("AREA_WOS", client.sessionId, Msg.heal, { id: client.sessionId, itemId: it.id } satisfies HealEvent);
      client.send(Msg.heal, { id: client.sessionId, itemId: it.id, hp, sp } satisfies HealEvent);
    } else if (cure) {
      for (const k of cure) if (isScKey(k)) this.status.end(client.sessionId, k); // status_change_end
      this.sendArea("AREA_WOS", client.sessionId, Msg.heal, { id: client.sessionId, itemId: it.id } satisfies HealEvent);
    } else {
      // AL_TELEPORT lv 2 / Homing Feather: pc_setpos(save point), maybe on another map (C08); level 1 = a random cell here
      this.setPos(client.sessionId, p, b, tele === "save" ? this.savePointOf(b) : { map: this.mapName, ...this.randomTile(3) });
    }
    this.sendInv(client, p);
  }

  /** clif_parse_UseCard -> clif_use_card (clif.cpp:7074): the pieces of the bag this card can be compounded into
   *  (shared/rules/cards.ts cardTargets), sent to the owner only when there is at least one (the original sends nothing otherwise;
   *  we say so). */
  cardList(client: Client, uid: number) {
    const { b } = this.me(client);
    const st = b?.inv?.items.get(uid), card = st && ITEMS.get(st.itemId);
    if (!b?.inv || !st || !card || !isCard(card)) return;
    const targets = cardTargets(card, b.inv.rows()).map((r) => r.uid);
    if (!targets.length) return this.notice(client, `Nothing you carry can take the ${card.name} (it needs unequipped gear with a free slot).`);
    client.send(Msg.cardList, { card: uid, targets } satisfies CardListEvent);
  }
  /** clif_parse_InsertCard -> pc_insert_card (pc.cpp:5596) -> clif_insert_card: compound, answer with the result, then the new bag. */
  insertCard(client: Client, cardUid: number, equipUid: number) {
    const { p, b } = this.me(client);
    if (!p || !b?.inv) return;
    const why = b.inv.insertCard(cardUid, equipUid);
    client.send(Msg.cardAck, { card: cardUid, equip: equipUid, ok: why === null, text: why ?? undefined } satisfies CardAckEvent);
    if (why === null) this.sendInv(client, p);
  }

  /** floor item pickup (pc_takeitem): within PICKUP_RANGE cells, after this character's loot-priority wait
   *  (rules/drops.ts takeItemTick), then the weight/slot check. */
  pickup(id: string, p: Player, b: Brain, client: Client, range = PICKUP_RANGE, quiet = false) { // range/quiet: a companion pet's petloot (pets.ts)
    const f = this.state.floor.get(id), fb = this.brains.get(id);
    if (!f || !fb || !b.inv) return;
    const now = this.clock.currentTime, c = this.cell(p);
    if (distance(f.x - c.x, f.y - c.y) > range) return;
    if (fb.floorLoot && now < takeItemTick(fb.floorLoot, b.inv.charId)) return quiet ? undefined : this.notice(client, "That item belongs to someone else for now.");
    // party_share_loot (item share "even"): a random party member on this map who can carry it gets it; nobody -> the picker
    const item = ITEMS.get(f.itemId)!;
    const shared = party.lootReceiver(this, client.sessionId, (sid) => {
      const tp = this.state.players.get(sid), ti = this.brains.get(sid)?.inv;
      return !!tp && !!ti && !ti.canAdd(item, f.amount, tp.job as JobKey, tp.str);
    });
    const to = shared ?? client.sessionId, tp = this.state.players.get(to)!, ti = this.brains.get(to)!.inv!, tc = this.clients.getById(to);
    const why = ti.canAdd(item, f.amount, tp.job as JobKey, tp.str);
    if (why) return quiet ? undefined : this.notice(client, `Can't pick up: ${why}.`);
    this.state.floor.delete(id);
    this.brains.delete(id);
    ti.add(f.itemId, f.amount);
    tc?.send(Msg.itemGet, { itemId: f.itemId, amount: f.amount } satisfies ItemGetEvent);
    this.sendArea("AREA", client.sessionId, Msg.takeItem, { id: client.sessionId } satisfies TakeItemEvent); // pc_takeitem -> clif_takeitem (area)
    if (tc) this.sendInv(tc, tp);
  }

  /** mob_dead item drops (mob.cpp:3233-3430): loot owners from the damage log (rules/dmglog.ts lootOwners; first_sd falls
   *  back to a player killer), the RENEWAL_DROP penalty of first_sd ?: second_sd ?: third_sd, the killer as
   *  mob_getdroprate's src; then mob_delay_item_drop puts the regular drops and the items the monster had looted around the
   *  corpse cell (md->x/y), each list on its own mob_process_drop_list direction cycle. Looted items keep no origin monster
   *  here, so they get the normal protection. */
  dropMobItems(monsterId: string, mon: Monster, killerId: string, looted: readonly { itemId: number; amount: number }[]) {
    const def = MOB_BY_ID.get(mon.mobId)!, now = this.clock.currentTime;
    const owners = mobDeadLootOwners(lootOwners(this.dmgLogOf(monsterId), this.receiver), this.charIdOf(killerId));
    const modifier = mobDropModifier(owners.map(this.receiver), def);
    // mob_getdroprate's src = the killer (a monster killer only brings its LUK, no player bonuses)
    const ks = this.actor(killerId) ? this.brains.get(killerId)?.status : undefined;
    const src = ks ? { luk: ks.stats.luk, pc: this.state.players.has(killerId) ? {} : undefined } : undefined;
    // 2.4.0 pets (mob_dead: first_sd + IT_PETEGG -> pet_create_egg): an egg drop (the legendary egg) is first_sd's egg at once, never a floor item
    const firstSid = owners.length ? this.sessionOfChar(owners[0]) : undefined;
    const drops = rollMobDrops(def, { modifier, src, conf: DROPS }).filter((id) => !(firstSid && ITEMS.get(id)?.type === "Petegg" && (this.pets.makeEgg(firstSid, id), true)));
    const at = this.cell(mon), keep = looted.filter((l) => ITEMS.has(l.itemId));
    const regular = floorLoot(now, owners, def.bossType as BossType, false, DROPS), loot = floorLoot(now, owners, "None", false, DROPS);
    dropDirections(drops.length).forEach((dir, i) => this.addFloorItem(drops[i], 1, at, dir, regular));
    dropDirections(keep.length, true).forEach((dir, i) => this.addFloorItem(keep[i].itemId, keep[i].amount, at, dir, loot));
  }

  /** map_addflooritem (map.cpp:2007) for a monster drop: cell from rules/drops.ts floorItemCell, where a cell is free per
   *  map_cell_free with type BL_CHAR|BL_PET (any player, dead or alive, or a live monster on it); clear timer
   *  flooritem_lifetime. */
  addFloorItem(itemId: number, amount: number, at: { x: number; y: number }, dir: DropDir, loot: FloorLoot) {
    const id = `f${this.nextFloorId++}`;
    const free = (x: number, y: number) => mapCellFree(this.map, x, y, (cx, cy) => walkable(this.map, cx, cy), (cx, cy) => this.charOnCell(cx, cy), DROPS);
    const { x, y } = floorItemCell(at.x, at.y, dir, free);
    this.state.floor.set(id, new FloorItem({ itemId, amount, x, y }));
    this.brains.set(id, { nextAttack: 0, repathAt: 0, status: undefined as never, floorLoot: loot, expires: this.clock.currentTime + DROPS.flooritem_lifetime });
  }

  /** map_count_oncell(BL_CHAR) > 0: a player (dead ones stay on the map) or a live monster stands on the cell. */
  charOnCell(x: number, y: number) {
    for (const p of this.state.players.values()) { const c = this.cell(p); if (c.x === x && c.y === y) return true; }
    for (const m of this.state.monsters.values()) { if (m.dead) continue; const c = this.cell(m); if (c.x === x && c.y === y) return true; }
    return false;
  }

  // Runs before onJoin: the client must hold a live session (POST /api/login) and own the character. The character row
  // itself is read in onJoin, after the previous session of the account has been saved.
  async onAuth(_client: Client, opts: JoinOptions) {
    const session = await getSession(opts?.token);
    if (!session) throw new Error("session expired — please log in again");
    const own = (await db.query("SELECT id FROM characters WHERE id = $1 AND account_id = $2", [Number(opts.charId), session.accountId])).rows[0];
    if (!own) throw new Error("character not found");
    return { accountId: session.accountId, charId: Number(own.id) };
  }

  onJoin(client: Client, _opts: JoinOptions, auth: { accountId: number; charId: number }) {
    return serialLogin(auth.accountId, () => this.enter(client, auth.accountId, auth.charId));
  }

  /** Save-then-auth handover, like rAthena: a login while the account is in game kicks the old session and is only served
   *  after its final save (char.cpp char_auth_ok -> mapif_disconnectplayer; char_mapif.cpp chmapif_parse_reqsavechar saves
   *  and only then sets the character offline; chrif.cpp chrif_authreq refuses while the old auth node waits for its save
   *  ack). Here: evict queues the old session's final save on the character's write chain, writesSettled waits for that
   *  chain (also covers a plain leave -> rejoin whose onLeave is still saving), and only then is the row read. */
  async enter(client: Client, accountId: number, charId: number) {
    const prev = online.get(accountId);
    if (prev) { await prev.room.evict(prev.client.sessionId); prev.client.leave(4001); }
    online.set(accountId, { room: this, client });
    this.accountOf.set(client.sessionId, accountId);
    await writesSettled(charId);
    const row = (await db.query("SELECT * FROM characters WHERE id = $1", [charId])).rows[0];
    if (!row) throw new Error("character not found");

    // the character's last map (char.last_map): a login into another map's room is sent on to its own (clif_changemap)
    if (isMapName(row.last_map) && row.last_map !== this.mapName) {
      if (online.get(accountId)?.client === client) online.delete(accountId);
      this.accountOf.delete(client.sessionId);
      client.send(Msg.changeMap, { map: row.last_map, x: row.x, y: row.y } satisfies ChangeMapEvent);
      return;
    }
    let { x, y } = row;
    if (!walkable(this.map, x, y)) ({ x, y } = nearestWalkable(this.map, x, y));
    const job: JobKey = row.job in JOBS ? row.job : "Novice";
    const p = new Player({
      name: row.name, gender: row.gender === "F" ? "F" : "M", hair: row.hair_color % HAIR_COLORS.length, style: (row.hairdo ?? 0) % HAIR_STYLES.length, outfit: outfitOf(row.job),
      weapon: "", shield: "", headgear: "", garment: "",
      x, y, dir: 0, moving: false, sitting: false, dead: false,
      hp: 1, maxHp: 1, sp: 1, maxSp: 1,
      job, level: row.level, exp: row.exp, jobLevel: row.job_level, jobExp: row.job_exp,
      statPoints: row.stat_points, skillPoints: row.skill_points,
      str: row.str, agi: row.agi, vit: row.vit, int: row.int, dex: row.dex, luk: row.luk,
    });
    // everything async happens before the player enters the state: the simulation tick must never see a player without a brain
    const inv = await Inventory.load(row.id, row.zeny);
    if (!row.kit_given) { // first login: novice starter kit, worn
      for (const k of STARTER_KIT) inv.add(k.id, k.amount);
      for (const st of [...inv.items.values()]) if (isEquip(ITEMS.get(st.itemId)!)) inv.equip(st.uid);
      await inv.persist("UPDATE characters SET kit_given = true WHERE id = $1", [row.id]); // queued after the kit rows
    }
    // the shortcut bar starts populated with what the character owns and can use (rules/hotkey.ts seedHotkeys): once per character,
    // only into empty slots, so a layout the player made is never overwritten
    let hotkeys = hotkeyList(row.hotkeys);
    if (!row.hotkeys_seeded) {
      const owned = [...new Set([...inv.items.values()].map((s) => s.itemId))].filter((id) => { const it = ITEMS.get(id); return it && (isUsable(it) || isEquip(it)); });
      hotkeys = seedHotkeys(hotkeys, owned, (id) => !isEquip(ITEMS.get(id)!));
      await inv.persist("UPDATE characters SET hotkeys = $2, hotkeys_seeded = true WHERE id = $1", [row.id, JSON.stringify(hotkeys)]);
    }
    await this.npcEngine.load(client.sessionId, inv); // quest log + character variables
    await this.pets.load(client.sessionId, row.id); // 2.4.0: the character's pets (eggs + the one out)
    p.skillPoints += await this.skills.load(client.sessionId, row.id); // sd->status.skill (the `skill` table); points of not-yet-working skills come back
    this.state.players.set(client.sessionId, p);
    this.brains.set(client.sessionId, { nextAttack: 0, repathAt: 0, status: playerStatus({ job, level: row.level, jobLevel: row.job_level, stats: statsOf(p) }), inv, hotkeys, hotkeyRowShift: isRowShift(row.hotkey_rowshift) ? row.hotkey_rowshift : 0,
      savePoint: isMapName(row.save_map) ? { map: row.save_map, x: row.save_x, y: row.save_y } : undefined });
    this.startInvincible(this.brains.get(client.sessionId)!); // map entry = clif_parse_LoadEndAck -> pc_setinvincibletimer, login included
    this.status.enter(client.sessionId, row.id); // the statuses the character carried from its last map
    this.refreshStatus(client.sessionId, p);
    this.applyLook(p, inv);
    this.sendInv(client, p);
    this.status.sendList(client.sessionId);
    this.npcEngine.enter(client.sessionId); // quest_pc_login + pc_show_questinfo (LoadEndAck)
    this.npcEngine.touch(client.sessionId, Math.round(p.x), Math.round(p.y)); // LoadEndAck: the OnTouch areas of the arrival cell (clif.cpp:11152)
    const hk = this.brains.get(client.sessionId)!;
    client.send(Msg.hotkeys, { keys: hk.hotkeys!, rowShift: hk.hotkeyRowShift! }); // clif_hotkeys_send (+ rotate)
    p.hp = row.hp == null ? p.maxHp : Math.min(Math.max(1, row.hp), p.maxHp);
    p.sp = row.sp == null ? p.maxSp : Math.min(row.sp, p.maxSp);
    this.flushStatus(client.sessionId); // clif_initialstatus + clif_updatestatus at map entry: the owner's own numbers
    this.skills.send(client.sessionId); // clif_skillinfoblock at map entry
    this.pets.enter(client.sessionId); // the pet that was out comes out again (pet_load), pet info + eggs to the owner
    await redis.sadd("online", row.name);
    await party.enter(this, client.sessionId, row.id, accountId).catch((e) => console.error("[party] enter", e)); // party_member_joined
    friends.friendsEnter(charId, row.name, client); // list to the owner, online friends told
  }

  /** Save and remove a player's world state (leave or double-login eviction). Idempotent. */
  async evict(sessionId: string) {
    // map_quit (map.cpp:2294-2299): worn gear that fails pc_isequip comes off before the final save (B11 sweep)
    if (this.state.players.has(sessionId)) { this.skills.cancel(sessionId); this.skills.sweep(sessionId); duel.onGone(this, sessionId); } // unit_remove_map / map_quit leave the duel
    this.skills.leave(sessionId);
    this.pets.leave(sessionId); // the pet leaves with its master, its row saved on the write chain
    this.status.leave(sessionId, this.brains.get(sessionId)?.inv?.charId); // map_quit: sc_data is kept for the next map
    const p = this.state.players.get(sessionId);
    const acc = this.accountOf.get(sessionId);
    const b = this.brains.get(sessionId);
    this.state.players.delete(sessionId);
    this.brains.delete(sessionId);
    this.accountOf.delete(sessionId);
    this.npcEngine.leave(sessionId); // map_quit: the running script is freed
    party.leave(this, sessionId, b?.inv?.charId, !!b?.nextMap); // a logout marks the member offline; a map change keeps it online
    friends.friendsLeave(b?.inv?.charId, sessionId);
    const on = acc === undefined ? undefined : online.get(acc);
    if (on && on.room === this && on.client.sessionId === sessionId) online.delete(acc!);
    for (const b of this.brains.values()) if (b.target === sessionId) b.target = undefined;
    if (!p) return;
    // map_quit -> chrif_save(CSAVE_QUIT): the final save is queued synchronously (before any await) behind every pending
    // inventory/zeny write, then the inventory is closed so nothing of this session can land after it
    const saved = this.save(p, b);
    b?.inv?.close();
    const off = redis.srem("online", p.name); // sent now, so it can't overtake the next session's sadd
    await saved.catch((e) => console.error("[save]", e));
    await b?.inv?.flush();
    await off;
  }

  async onLeave(client: Client) {
    await this.evict(client.sessionId);
  }

  /** chrif_save: queue the character's status on its write chain, behind every inventory/zeny write already queued, so a
   *  session's last save lands last. No-op (resolved) for a player whose session is gone. */
  save(p: Player, b = [...this.brains.entries()].find(([id]) => this.state.players.get(id) === p)?.[1]) {
    if (!b?.inv) return Promise.resolve();
    // last_map / x / y: where the character stands, the map it is changing to, or (dead: logging out = respawning) its save point
    const at: MapPos = b.nextMap ?? (p.dead ? this.savePointOf(b) : { map: this.mapName, x: Math.round(p.x), y: Math.round(p.y) });
    return b.inv.persist(
      `UPDATE characters SET x=$2, y=$3, level=$4, exp=$5, job=$6, job_level=$7, job_exp=$8, str=$9, agi=$10, vit=$11, "int"=$12,
         dex=$13, luk=$14, stat_points=$15, skill_points=$16, hp=$17, sp=$18, hotkeys=$19, hotkey_rowshift=$20, last_map=$21,
         save_map=$22, save_x=$23, save_y=$24, seen_at=now() WHERE id=$1`,
      [b.inv.charId, at.x, at.y, p.level, p.exp, p.job, p.jobLevel, p.jobExp, p.str, p.agi, p.vit, p.int,
        p.dex, p.luk, p.statPoints, p.skillPoints, p.dead ? restartBase(p.job as JobKey, p.maxHp, p.maxSp).hp : p.hp,
        p.dead ? restartValues(p.job as JobKey, p.maxHp, p.maxSp, p.sp).sp : p.sp, JSON.stringify(b.hotkeys ?? []), b.hotkeyRowShift ?? 0, at.map,
        b.savePoint?.map ?? null, b.savePoint?.x ?? null, b.savePoint?.y ?? null]);
  }

  base(p: Player, inv?: Inventory) {
    const gear = inv?.gear() ?? { weapon: FISTS };
    return { job: p.job as JobKey, level: p.level, jobLevel: p.jobLevel, stats: statsOf(p), ...gear };
  }

  /** Recompute derived status after stats / level / job / gear changes; keeps HP/SP within the new maximums. */
  refreshStatus(id: string, p: Player) {
    const b = this.brains.get(id)!;
    const base = { ...this.base(p, b.inv), passives: this.skills.passives(id), sc: this.status.hooks(id) }; // learned passive skills (status_calc_pc), status changes (status_calc_str ...)
    this.pets?.bonus(id, (base as { equip?: Parameters<PetSystem["bonus"]>[1] }).equip); // status_calc_pc "Pet Bonus" (after the cards)
    const s = this.status.apply(id, playerStatus(base)); // the non-stat calc flags of the statuses (hit, flee, DEF, speed, element ...)
    b.status = s;
    b.weapon = base.weapon;
    p.maxHp = s.maxHp; p.maxSp = s.maxSp;
    p.hp = Math.min(p.hp, s.maxHp); p.sp = Math.min(p.sp, s.maxSp);
  }

  // ---------- spawning ----------
  randomTile(minDistFromCenter: number) {
    const cx = this.map.w >> 1, cy = this.map.h >> 1;
    for (;;) {
      const x = 1 + Math.floor(Math.random() * (this.map.w - 2)), y = 1 + Math.floor(Math.random() * (this.map.h - 2));
      if (walkable(this.map, x, y) && Math.hypot(x - cx, y - cy) >= minDistFromCenter) return { x, y };
    }
  }

  /** map_spawnmobs -> npc_parse_mob2 (npc.cpp:5197) for every spawn line of this map (shared/data/spawns.txt): `num`
   *  monsters per line, each with its own centre cell (kept for all its respawns, like md->centerX/Y). With dynamic_mobs the
   *  first player entering the map triggers this; a Colyseus room is created by its first join, so onCreate is that moment. */
  spawnMobs() {
    const lines = parseSpawns(readFileSync(SPAWN_FILE, "utf8"), this.mapName, this.map, (id) => MOB_BY_ID.has(id));
    for (const sd of lines) {
      for (let i = 0; i < sd.num; i++) {
        const id = `m${this.nextMonsterId++}`;
        this.mobSpawns.set(id, { sd, center: spawnCenter(sd, rndValue) });
        this.spawnMonster(id);
      }
    }
  }

  /**
   * mob_spawn (mob.cpp:1100): put monster `id` of its spawn line on the map at a cell picked by mobSpawnCell (area around its
   * centre, else anywhere). No free cell: try again after mob_respawn_time.
   */
  spawnMonster(id: string) {
    const slot = this.mobSpawns.get(id)!, mobId = slot.sd.mobId, def = MOB_BY_ID.get(mobId)!;
    const cell = mobSpawnCell(this.map, slot.sd, slot.center, rndValue);
    if (!cell) { this.clock.setTimeout(() => this.spawnMonster(id), SPAWN_CONF.mob_respawn_time); return; }
    this.addMonster(id, mobId, cell.x, cell.y);
  }

  /** mob_spawn's body (mob.cpp:1175-1195) for monster `id` of species `mobId` standing on (x, y): idle, first random walk 4000-4999 ms
   *  after spawning. Also used for a boss's slaves (server/src/boss.ts), which have no spawn line. */
  addMonster(id: string, mobId: number, x: number, y: number) {
    const def = MOB_BY_ID.get(mobId)!;
    const mon = new Monster({ mobId, x, y, dir: 0, moving: false, hp: def.hp, maxHp: def.hp, dead: false });
    this.state.monsters.set(id, mon);
    const now = this.clock.currentTime;
    this.brains.set(id, {
      nextAttack: 0, repathAt: 0, status: mobStatus(def), dmglog: [],
      mobState: "idle", walkAt: nextWalkTime(now, rnd()), thinkAt: 0, lastLink: -Infinity, lastCanMove: now, loot: [],
    });
    this.boss.spawned(id, mon); // mvptomb_destroy + the MSC_SPAWN skills (a boss's first slaves)
    return mon;
  }

  // ---------- simulation ----------
  actor(id: string): Actor | undefined {
    return this.state.players.get(id) ?? this.state.monsters.get(id);
  }

  // ---------- spawn protection (rules/invincible.ts: pc_setinvincibletimer / pc_delinvincibletimer) ----------
  /** pc_setinvincibletimer: (re)start the player's protection from now (player_invincible_time). Every map entry does this
   *  (clif_parse_LoadEndAck, clif.cpp:10803): login, the respawn warp, a teleport. A running timer is replaced. */
  startInvincible(b: Brain, now = this.clock.currentTime) {
    b.invincibleUntil = setInvincibleTimer(b.invincibleUntil, now);
  }
  /** pc_delinvincibletimer: walking and attacking end the protection (CLIENT_MSGS `invincible: "end"`). */
  endInvincible(b: Brain) {
    b.invincibleUntil = undefined;
  }
  /** invincible_timer != INVALID_TIMER for the unit `id` at `now` (monsters and floor items never are). */
  invincible(id: string, now: number) {
    return isInvincible(this.brains.get(id)?.invincibleUntil, now);
  }
  /** What a monster's AI may take as a target: alive and not under spawn protection (pcTargetable) — mob_ai_sub_hard's
   *  active search, held-target check and attacked-event switch all end in status_check_skilluse + battle_check_target. */
  targetable(id: string, u: Actor, now: number) {
    return pcTargetable({ dead: u.dead, invincibleUntil: this.brains.get(id)?.invincibleUntil }, now);
  }

  // ---------- movement core: rAthena unit_walktoxy & co. (pure rules: shared/rules/walk.ts) ----------
  // A unit stands on one cell, its synced x / y (bl->x / bl->y). A step is a timeline event that fires `speed` ms after the
  // step began (speed * 14 / 10 on a diagonal), and only then do x / y change (unit_walktoxy_timer -> map_moveblock). Walk
  // requests, range checks and FIXPOS stops all read that cell; clients draw the unit between cells from sx / sy (drawOffset).

  /** gettick() for a request: the moment it arrived on the room clock (Clock.now() between two simulation ticks), so a walk is
   *  timed from the request, not from the next 50 ms tick. A test clock without now() gives its current time. */
  exactNow() {
    const c = this.clock as unknown as { currentTime: number; now?: () => number };
    return Math.max(c.currentTime, c.now?.() ?? c.currentTime);
  }

  /** The unit's walk state (rAthena unit_data), created on first use from where it stands. */
  walkOf(b: Brain, u: Pos): WalkState {
    return b.walk ??= { path: [], pos: 0, stepMs: 0, token: 0, to: this.cell(u), changeTarget: false, canmoveTick: 0 };
  }

  /** unit_is_walking (unit.cpp:1782): a step timer is running. */
  walking(b: Brain | undefined) { return b?.walk?.stepAt !== undefined; }

  /** Cell coordinates (bl->x / bl->y): the synced x / y, which change only when a step's timer fires. */
  cell(a: { x: number; y: number }): Cell { return { x: Math.round(a.x), y: Math.round(a.y) }; }

  /** unit_can_move (unit.cpp:1799-1838) as far as modelled, with unit_walktoxy's MD_CANMOVE: alive, canmove_tick passed, not
   *  sitting (players), a monster that can move at all. */
  canMove(id: string, u: Actor, b: Brain, at: number) {
    if (u.dead || this.walkOf(b, u).canmoveTick - at > 0 || this.status.cant(id, "move")) return false; // sc->cant.move: Stone, Freeze, Stun, Sleep
    const p = this.state.players.get(id), m = p ? undefined : this.state.monsters.get(id);
    return p ? !p.sitting && !this.skills.casting(id) : !!m && hasMode(b.mode ?? MOB_BY_ID.get(m.mobId)!.mode, MD.CANMOVE); // unit_can_move: no walking during a cast (ud->skilltimer)
  }

  /** unit_stop_attack (unit.cpp:2826) as a walk runs it: a player drops its attack request (with the client's walk-in), a
   *  monster its swing target (ud->target, `engaged`; the target its AI holds stays). */
  stopAttack(id: string, b: Brain) {
    if (this.state.players.has(id)) { b.target = undefined; b.moveToAttack = false; }
    else b.engaged = undefined;
  }

  /**
   * unit_walktoxy (unit.cpp:841-913): a walk request for unit `id`, checked from the cell it stands on (bl->x / bl->y), also
   * while it is stepping into the next one. `search` is the request's path check: walkRequestPath (path_search, max_walk_path,
   * OFFICIAL_WALKPATH) for a real request; the walks the server makes for the game client (walking in to attack, to an item)
   * keep plain path_search. Flag 4 (every player request, clif_parse_WalkToXY) runs it again at canmove_tick + 1 while the
   * unit still can't move (unit_delay_walktoxy_timer). Accepted during a step, it only sets ud->to: the step ends first and the
   * walk is searched again from the new cell (change_walk_target, walkStep). False = refused: nothing changes. The caller
   * stops the attack (unit_stop_attack) when it is accepted.
   */
  walkToXY(id: string, u: Actor, b: Brain, x: number, y: number, flag: number, at: number,
    search: (m: GameMap, from: Cell, to: Cell) => Cell[] | null = walkRequestPath): boolean {
    const w = this.walkOf(b, u);
    if (!search(this.map, this.cell(u), { x, y })) return false;
    if (flag & 4) {
      const later = delayedWalkAt(w.canmoveTick, at);
      if (later !== undefined) {
        this.timeline.add(later, (t) => this.delayedWalk(id, u, b, x, y, search, t));
        return true;
      }
    }
    if (!(flag & 2) && !this.canMove(id, u, b, at)) return false;
    w.to = { x, y };
    if (w.stepAt !== undefined) { w.changeTarget = true; return true; }
    return this.walkSub(id, u, b, at);
  }

  /** unit_delay_walktoxy_timer (unit.cpp:794-805): the held request runs as unit_walktoxy(flag 0) once the walk delay is over
   *  (unless the unit left the map); accepted, it ends the attack like any walk. */
  delayedWalk(id: string, u: Actor, b: Brain, x: number, y: number, search: (m: GameMap, from: Cell, to: Cell) => Cell[] | null, at: number) {
    if (this.brains.get(id) !== b || this.actor(id) !== u) return;
    if (this.walkToXY(id, u, b, x, y, 0, at, search)) this.stopAttack(id, b);
  }

  /** unit_walktoxy_sub (unit.cpp:254-306): search the walk from the unit's cell to ud->to (walkSubPath: path_search and
   *  OFFICIAL_WALKPATH, no max_walk_path) and start its first step. False = no path. */
  walkSub(id: string, u: Actor, b: Brain, at: number): boolean {
    const w = this.walkOf(b, u);
    const path = walkSubPath(this.map, this.cell(u), w.to);
    if (!path) return false;
    w.path = path; w.pos = 0; w.changeTarget = false;
    this.nextCell(id, u, b, at, true);
    return true;
  }

  /**
   * unit_walktoxy_nextcell (unit.cpp:180-247): start the step into path[pos], its timer due stepTime later (diagonal x14/10);
   * false at the end of the path. A chasing monster first checks its target from the cell it has just reached
   * (unit_update_chase, full check before the last step) and may attack there and stop, or re-path; a player's client walking
   * in to attack, or to an item, stops on the first cell within reach (pcArrived). `first` = nothing reached yet.
   */
  nextCell(id: string, u: Actor, b: Brain, at: number, first: boolean): boolean {
    const w = this.walkOf(b, u);
    if (w.pos >= w.path.length) return false;
    if (b.chaseTo !== undefined && this.state.monsters.has(id)
      && this.mobUpdateChase(id, u as Monster, b, at, w.pos === w.path.length - 1)) return true;
    if (!first && this.state.players.has(id) && this.pcArrived(id, u as Player, b, at)) return true;
    const next = w.path[w.pos], ms = stepTime(b.status.walkMs, u, next), token = ++this.walkSeq;
    w.token = token; w.stepAt = at + ms; w.stepMs = ms;
    u.dir = dirFromDelta(Math.sign(next.x - u.x), Math.sign(next.y - u.y));
    u.moving = true;
    this.timeline.add(at + ms, (t) => this.walkStep(id, u, b, token, t));
    return true;
  }

  /**
   * unit_walktoxy_timer (unit.cpp:542-791), the step's timer: the unit enters the next cell (map_moveblock: only now do its x / y
   * change). A request accepted during the step is searched again from here (change_walk_target -> walkSub; no path: the unit
   * stops on this cell, clif_fixpos); otherwise the next step starts, and at the end of the path a chase is checked once more.
   * `direct` = run by unit_stop_walking to finish the step at once (USW_MOVE_FULL_CELL / USW_MOVE_ONCE).
   */
  walkStep(id: string, u: Actor, b: Brain, token: number, at: number, direct = false) {
    if (this.brains.get(id) !== b || this.actor(id) !== u) return; // the unit left the map (or this is a respawn)
    const w = this.walkOf(b, u);
    if (!direct && w.token !== token) return; // ud->walktimer != tid: the step was stopped or replaced
    w.stepAt = undefined;
    u.moving = false;
    if (u.dead || w.pos >= w.path.length) return;
    const next = w.path[w.pos];
    u.dir = dirFromDelta(Math.sign(next.x - u.x), Math.sign(next.y - u.y));
    if (!walkable(this.map, next.x, next.y)) { if (!this.walkSub(id, u, b, at)) this.haltWalk(u, w); return; } // blocked meanwhile
    u.x = next.x; u.y = next.y;
    // BL_PC: npc_touchnext_areanpc + npc_touch_area_allnpc on the cell just entered (unit.cpp:681-690), before the next step
    if (this.state.players.has(id)) {
      this.npcEngine.touch(id, next.x, next.y);
      // npc_touch_areanpc, NPCTYPE_WARP (npc.cpp:1929-1938): a warp's area moves the player at once (pc_setpos to its
      // destination); dead characters cannot use warps
      const wp = warpAt(this.mapName, next.x, next.y), p = this.state.players.get(id)!;
      if (wp && !p.dead) { this.setPos(id, p, b, wp.to); return; }
    }
    // a remembered step action is tried again half the finished step later (unit.cpp:723-736), the newest timer only
    if (b.stepTarget !== undefined) {
      const tok = b.stepToken = ++this.walkSeq;
      this.timeline.add(at + stepActionDelay(w.stepMs), (t) => this.stepTimer(id, b, tok, t));
    }
    if (w.changeTarget) {
      if (!this.walkSub(id, u, b, at)) this.haltWalk(u, w); // clif_fixpos: it stays on this cell
      return;
    }
    w.pos++;
    if (this.nextCell(id, u, b, at, false)) return;
    // the end of the path: a chase checks its target once more (unit_update_chase, full check), the client's walk-in too
    if (b.chaseTo !== undefined && this.state.monsters.has(id) && this.mobUpdateChase(id, u as Monster, b, at, true)) return;
    if (this.state.players.has(id) && this.pcArrived(id, u as Player, b, at)) return;
    w.to = this.cell(u);
    if (!direct) this.cellStackLimit(id, u, b, at);
  }

  /** unit_walktoxy_timer's official_cell_stack_limit (unit.cpp:764-779): a walk that ended on a cell holding more standing units
   *  than the limit (this one included) walks on to a free neighbour (unit_walktoxy flag 8 -> map_nearby_freecell, unit.cpp:850,
   *  then the request's usual checks); a pending step action then waits for that next step (its timer is dropped). */
  cellStackLimit(id: string, u: Actor, b: Brain, at: number) {
    const here = this.cell(u);
    if (!cellStackExceeded(this.standingOn(here.x, here.y))) return;
    const free = nearbyFreecell(this.map, here.x, here.y, (x, y) => this.standingOn(x, y), Math.random() < 0.5 ? 0 : 1);
    if (free && this.walkToXY(id, u, b, free.x, free.y, 8, at) && b.stepToken !== undefined) b.stepToken = ++this.walkSeq;
  }

  /** map_count_oncell(BL_CHAR|BL_NPC, flag 1) (map.cpp:641-680): the units on a cell without a step timer — players dead or
   *  alive, live monsters, visible NPCs. */
  standingOn(x: number, y: number): number {
    let n = 0;
    for (const [id, p] of this.state.players) if (p.x === x && p.y === y && !this.walking(this.brains.get(id))) n++;
    for (const [id, m] of this.state.monsters) if (!m.dead && m.x === x && m.y === y && !this.walking(this.brains.get(id))) n++;
    for (const npc of this.state.npcs.values()) if (npc.x === x && npc.y === y) n++;
    return n;
  }

  /**
   * unit_stop_walking (unit.cpp:1695-1757), `type` = USW flags: the step timer is cancelled and the unit stands on its cell —
   * USW_FIXPOS: where it is (bl->x / bl->y), never the cell it was stepping into. USW_MOVE_FULL_CELL first finishes a step
   * that is at least half done, USW_MOVE_ONCE a first step; USW_RELEASE_TARGET drops the chase. Without USW_FORCE_STOP a unit
   * that is not walking is left alone (false).
   */
  stopWalking(id: string, u: Actor, b: Brain, type: number, at: number): boolean {
    const w = this.walkOf(b, u);
    if (type & USW.RELEASE_TARGET) b.chaseTo = undefined;
    if (!(type & USW.FORCE_STOP) && w.stepAt === undefined) return false;
    const stepAt = w.stepAt;
    w.stepAt = undefined; w.token = ++this.walkSeq; w.changeTarget = false;
    u.moving = false;
    if ((type & USW.MOVE_ONCE && w.pos === 0) || (type & USW.MOVE_FULL_CELL && stepAt !== undefined && pastHalfStep(stepAt, w.stepMs, at))) {
      w.path.length = Math.min(w.path.length, w.pos + 1); // path_len = path_pos + 1
      this.walkStep(id, u, b, 0, at, true); // unit_walktoxy_timer(INVALID_TIMER, ...): into that cell now
    }
    this.haltWalk(u, w);
    return true;
  }

  /** The end of unit_stop_walking: no path and no timer (a walk the finished step started loses its path as well), the
   *  destination is here, the unit is drawn on its cell. */
  haltWalk(u: Pos, w: WalkState) {
    if (w.stepAt !== undefined) { w.stepAt = undefined; w.token = ++this.walkSeq; }
    w.path = []; w.pos = 0; w.to = this.cell(u); w.changeTarget = false;
    u.moving = false; u.sx = 0; u.sy = 0;
  }

  /** sd->status.save_point; a character that never saved respawns at Hearthmoor's hearth (char_athena.conf start_point, W01). */
  savePointOf(b: Brain): MapPos {
    return b.savePoint ?? TOWN_SAVE;
  }

  /** pc_setpos (pc.cpp): put a player on `to`. Same map: unit_remove_map + the warp, every warp restarts the spawn protection
   *  (LoadEndAck -> pc_setinvincibletimer) and fires the arrival cell's OnTouch areas. Another map: the character is saved with
   *  last_map = that map and the client is told to change rooms (clif_changemap); its leave saves it (b.nextMap) and the new
   *  room loads it after that save (writesSettled), like map-server -> char-server -> map-server. */
  setPos(sid: string, p: Player, b: Brain, to: MapPos) {
    const client = this.clients.getById(sid);
    b.target = undefined; b.goal = undefined;
    this.endShop(client, b); // the warp: unit_remove_map clears sd->npc_shopid (unit.cpp:3678)
    if (to.map !== this.mapName) {
      this.warpUnit(p, b, Math.round(p.x), Math.round(p.y)); // the walk is over
      b.nextMap = to;
      this.save(p, b).catch((e) => console.error("[save]", e));
      client?.send(Msg.changeMap, to satisfies ChangeMapEvent);
      return;
    }
    const c = walkable(this.map, to.x, to.y) ? to : nearestWalkable(this.map, to.x, to.y);
    this.warpUnit(p, b, c.x, c.y);
    this.startInvincible(b);
    this.npcEngine.touch(sid, c.x, c.y);
  }

  /** A warp (pc_setpos / unit_movepos): the unit stands on (x, y) at once and any walk is over (unit_remove_map stops it). */
  warpUnit(u: Pos, b: Brain, x: number, y: number) {
    const w = this.walkOf(b, u);
    u.x = x; u.y = y;
    this.haltWalk(u, w);
  }

  /** unit_stop_walking_soon (unit.cpp:1636-1690): the walk ends after the step in progress, or after the next one once the unit
   *  has crossed the border into the cell ahead (update_pos, exactCell): 0.5-1.5 cells more. */
  stopWalkingSoon(u: Pos, b: Brain, at: number) {
    const w = this.walkOf(b, u), here = this.cell(u);
    let crossed = false;
    if (w.stepAt !== undefined && w.pos < w.path.length) {
      const e = exactCell(here, w.path[w.pos], stepProgress(w.stepAt, w.stepMs, at));
      crossed = e.x !== here.x || e.y !== here.y;
    }
    const remain = stopSoonRemain(w.pos, w.path.length, crossed);
    w.path.length = Math.min(w.path.length, w.pos + remain);
    w.to = remain > 0 ? { ...w.path[w.pos + remain - 1] } : here;
    w.changeTarget = false;
  }

  /** What clients draw between cells: sx / sy = how far the unit has come into the cell it is stepping into, in 16ths of a
   *  cell like rAthena's sub-cell position (unit_data::update_pos), 0 while it stands. */
  drawOffset(u: Pos, b: Brain | undefined, now: number) {
    const w = b?.walk;
    let sx = 0, sy = 0;
    if (w?.stepAt !== undefined && w.pos < w.path.length) {
      const next = w.path[w.pos], k = Math.round(stepProgress(w.stepAt, w.stepMs, now) * 16) / 16;
      sx = (next.x - u.x) * k; sy = (next.y - u.y) * k;
    }
    if (u.sx !== sx) u.sx = sx;
    if (u.sy !== sy) u.sy = sy;
  }

  /**
   * The game client's part of a player's walk, run on every cell the player reaches: walking in to attack (clif_movetoattack),
   * or with an attack asked during the walk, it stops on the first cell within reach and attacks from there; walking to an
   * item, it stops within pc_takeitem's range and picks it up. The stop is USW_FIXPOS on the cell just reached, so the swing
   * starts on arrival and the player never slides on into the next cell. True = stopped.
   */
  pcArrived(id: string, p: Player, b: Brain, at: number): boolean {
    if (b.target && b.moveToAttack) { // only the client's walk-in; an attack asked during a walk is a step action (unitAttack)
      const tgt = this.actor(b.target);
      if (!tgt || tgt.dead || pcAttackStep(this.map, this.cell(p), this.cell(tgt), b.status.rhw.range, tgt.moving) !== "swing") return false;
      this.stopWalking(id, p, b, USW.FIXPOS | USW.FORCE_STOP, at);
      b.moveToAttack = false; // the client stops and asks to attack (CZ_REQUEST_ACT -> unit_attack)
      this.fight(id, p, b, at, b.status.rhw.range);
      return true;
    }
    const g = b.goal, spot = g && this.state.floor.get(g.id), client = this.clients.getById(id);
    if (!g || !spot || !client || distance(spot.x - p.x, spot.y - p.y) > PICKUP_RANGE) return false;
    b.goal = undefined;
    this.stopWalking(id, p, b, USW.FIXPOS | USW.FORCE_STOP, at);
    this.pickup(g.id, p, b, client);
    return true;
  }

  /**
   * unit_attack_timer_sub (unit.cpp:3187): swing at the brain's target every attack delay (ASPD adelay for players, AttackDelay
   * for mobs) while it is within range; range is checked on cells.
   * - Players: pcAttackTimer below decides when the timer runs and what it does (rules/unit.ts pcAttackStep: straight line,
   *   reach = status rhw.range). At the swing battle_weapon_attack refuses a bow / gun without its ammo (ATK_NONE: no swing, no
   *   attack delay, the client is told; battle.cpp:7161-7205) and uses up one ammo per shot (battle_consume_ammo).
   * - Monsters: plain AttackRange only, battle_check_range(md, tbl, rhw.range) (square distance + line). mob_ai_sub_hard calls
   *   unit_attack only after that check (mob.cpp:2133) and every later swing goes back through the AI (unit.cpp:3214-3215 ->
   *   mob_ai_sub_hard_attacktimer), so the walking-target +1 never lets a monster swing farther than its range; out of range
   *   it chases instead (mobAi -> mobChase, unit_walktobl mob.cpp:2214), which mobAi handles, so nothing happens here.
   */
  fight(id: string, a: Actor, b: Brain, now: number, range: number) {
    const tgt = b.target ? this.actor(b.target) : undefined;
    if (!tgt || tgt.dead) { b.target = undefined; return; }
    if (this.state.players.has(id) && this.state.players.has(b.target!) && !duel.canTarget(this, id, b.target!)) { b.target = undefined; return; } // the duel ended
    if (this.status.cant(id, "attack")) return; // sc->cant.attack: Stone, Freeze, Stun, Sleep, the petrify wait
    const pl = this.state.players.get(id);
    const from = this.cell(a), to = this.cell(tgt);
    if (pl) {
      if (!this.pcAttackTimer(id, pl, b, tgt, from, to, range, now)) return;
    } else {
      if (!battleCheckRange(this.map, from, to, range)) return; // monsters: the AI chases
      // in range: mob_ai_sub_hard -> unit_attack + unit_stop_walking(USW_FIXPOS): the monster stands on the cell it is on
      // (bl->x / bl->y), not the one it was stepping into (mob.cpp:2146-2159, unit.cpp:3294-3295)
      this.stopWalking(id, a, b, USW.FIXPOS, now);
      b.engaged = b.target; // in range: mob_ai_sub_hard calls unit_attack -> unit_set_target
      a.dir = dirFromDelta(Math.sign(to.x - from.x), Math.sign(to.y - from.y));
      if (now < b.nextAttack) return;
    }
    // no weight check here: rAthena's normal attack path ignores SC_WEIGHT90 (it only gates skills + regen, rules/weight.ts)
    const weapon = b.weapon ?? FISTS;
    if (pl) { // battle_weapon_attack: a bow / gun without its ammo -> ATK_NONE, the attack stops before any attack delay is set
      const ammo = b.inv?.equipped("ammo");
      const fail = weaponAttackAmmo(weapon.type, ammo ? ITEMS.get(ammo.itemId)!.subType : null);
      if (fail) {
        b.target = undefined;
        const c = this.clients.getById(id);
        if (c) this.notice(c, AMMO_FAIL[fail]);
        return;
      }
    }
    // attackabletime = tick + adelay on the timer's own tick (unit_set_attackdelay, unit.cpp:1890): a running attack chain keeps
    // its exact cadence instead of drifting by up to one 50 ms simulation tick per swing.
    const swingAt = now - b.nextAttack < TICK_MS ? b.nextAttack : now;
    b.nextAttack = swingAt + b.status.attackDelayMs;
    const tb = this.brains.get(b.target!)!;
    // agi/vit_penalty input: defender type + unit_counttargeted (rules decide who it applies to via battle.conf masks)
    const t = { type: this.state.players.has(b.target!) ? BL.PC : BL.MOB, targeted: this.targetedCount(b.target!) };
    const res: AttackResult = pl
      ? playerAttack(b.status, weapon, tb.status, t)
      : mobAttack(b.status as MobStatus, tb.status, t);
    if (pl && shootsAmmo(weapon.type)) this.consumeAmmo(id, pl, b); // battle.cpp:7382-7383: after the calculation, hit or miss
    this.pets.weaponAttack(id, b.target!); // battle_weapon_attack -> pet_target_check (a battle pet joins its master's fight)
    const multi = pl ? this.skills.normalAttack(id, b.target!, res, weapon.type, now) : undefined; // 2.5.0 Triple / Double Attack (skills.ts)
    if (multi !== "replaced") this.delayDamage(id, b.target!, res, swingAt, now, multi);
    if (pl && multi !== "replaced") this.status.afterHit(id, b.target!, res, undefined, 0, this.status.landAt(id, swingAt)); // bAddEff cards (skill_additional_effect)
    // "You can't move during your attack motion" (unit.cpp:3328-3330): attack_walk_delay -> unit_set_walkdelay(src, tick, amotion,
    // 1), never shortening a longer delay; a walk asked meanwhile starts at canmove_tick + 1 (walkToXY flag 4)
    const m = this.motions(id);
    if (attackWalkDelay(m.type)) { const w = this.walkOf(b, a); w.canmoveTick = skillWalkDelay(w.canmoveTick, swingAt, m.amotion); }
  }

  /**
   * A player's attack timer (unit_attack -> unit_attack_timer_sub) together with the game client's part of the loop. True when
   * the player swings now.
   * - The timer runs once the attack delay is over: at once on the request, else at attackabletime (unit.cpp:2971-2977), then
   *   at every attackabletime while attacking. Each run is rules/unit.ts pcAttackStep: a wall on the straight line drops the
   *   target with no walk around it (OFFICIAL_WALKPATH, unit.cpp:3221-3228 -> unit_unattackable 3361-3362); out of reach
   *   (status rhw.range = the weapon's Range, +1 while the target walks) the client is told to walk in (clif_movetoattack,
   *   unit.cpp:3260-3263); else the player swings.
   * - Walking in is the client's job: its walk requests hold no attack at all (unit_walktoxy flag 4 -> unit_unattackable +
   *   unit_stop_attack, unit.cpp:872-874), so the line is not checked on the way. The server walks the player toward the target
   *   for it (re-pathing as the target moves); within reach the client stops and asks to attack again (CZ_REQUEST_ACT ->
   *   unit_attack), which runs the timer — line check first — as soon as the attack delay allows.
   * - While the player walks, reach is looked at on each cell it reaches (pcArrived): the attack starts on arrival at a cell
   *   within reach and the walk stops there (USW_FIXPOS), never half way into the next cell. An attack asked during someone's
   *   own walk waits the same way (rAthena keeps it as a step action until a full step, unit.cpp:2959-2966).
   */
  pcAttackTimer(id: string, p: Player, b: Brain, tgt: Actor, from: Cell, to: Cell, range: number, now: number) {
    const w = this.walkOf(b, p);
    const walkIn = () => { // the client's walk toward the target: again every 400 ms while the target moves away from where it goes
      if (now < b.repathAt || (this.walking(b) && w.to.x === to.x && w.to.y === to.y)) return;
      this.walkToXY(id, p, b, to.x, to.y, 0, now, searchPath);
      b.repathAt = now + 400;
    };
    const chasing = tgt.moving || !!b.stepAttack; // unit_is_walking(target) || ud->state.step_attack: reach + 1
    if (b.stepTarget !== undefined) return false; // a step action waits for its step timer: no attack timer runs yet
    if (b.moveToAttack) {
      if (this.walking(b) || !inPcReach(from, to, pcAttackReach(range, chasing))) { walkIn(); return false; }
      b.moveToAttack = false; // within reach: the client stops and sends the attack request again
    }
    if (now < b.nextAttack) return false; // the timer waits for attackabletime
    const step = pcAttackStep(this.map, from, to, range, chasing);
    if (step === "drop") { b.target = undefined; return false; } // unit_unattackable: the walk itself is left alone
    if (step === "chase") { // clif_movetoattack
      b.moveToAttack = true;
      b.repathAt = 0;
      walkIn();
      return false;
    }
    p.dir = dirFromDelta(Math.sign(to.x - from.x), Math.sign(to.y - from.y));
    // the swing stops a walk on the cell the player stands on, never the one it was stepping into (unit.cpp:3294-3295)
    if (this.walking(b)) this.stopWalking(id, p, b, USW.FIXPOS, now);
    return true;
  }

  /** unit_attack for a player's attack request (unit.cpp:2955-2977), decided when it arrives: during a step and not within
   *  range - 1 it is remembered as a step action (rules/unit.ts pcDefersAttack; retried by stepTimer after each cell change),
   *  otherwise the attack timer runs now (fight -> pcAttackTimer; it waits for attackabletime itself). */
  unitAttack(id: string, p: Player, b: Brain, tgt: Actor, at: number) {
    if (pcDefersAttack(this.map, this.cell(p), this.cell(tgt), b.status.rhw.range, this.walking(b))) {
      b.stepTarget = b.target;
      return;
    }
    this.fight(id, p, b, at, b.status.rhw.range);
  }

  /** unit_step_timer (unit.cpp:439-496): the remembered attack is asked again as unit_attack(continuous + 2) — step_attack
   *  set — unless a newer request replaced it or the target is gone. */
  stepTimer(id: string, b: Brain, tok: number, at: number) {
    if (this.brains.get(id) !== b || b.stepToken !== tok || b.stepTarget === undefined) return;
    const tid = b.stepTarget, p = this.state.players.get(id), tgt = this.actor(tid);
    b.stepTarget = undefined;
    if (!p || p.dead || !tgt || tgt.dead) return;
    b.target = tid; b.stepAttack = true;
    this.unitAttack(id, p, b, tgt, at);
  }

  /** battle_consume_ammo -> pc_delitem (battle.cpp:2645-2669, pc.cpp): the shot uses up consumedAmmo() of the worn ammo and the
   *  client gets the new count (clif_delitem); a stack that runs out is unequipped with a status recalculation (pc_unequipitem
   *  flag 2|1: its arrow ATK is gone from the next shot on, which then fails for want of ammo). */
  consumeAmmo(id: string, p: Player, b: Brain) {
    const ammo = b.inv?.equipped("ammo"), qty = consumedAmmo();
    if (!ammo || !qty || !b.inv!.remove(ammo.uid, qty)) return;
    if (!b.inv!.items.has(ammo.uid)) this.refreshStatus(id, p);
    const c = this.clients.getById(id);
    if (c) this.sendInv(c, p);
  }

  /** unit_counttargeted (unit.cpp:3516): how many units hold `id` as their attack target (ud->target, kept by
   *  unit_set_target). Players set it with the attack request itself (unit_attack); monsters only once they are in range
   *  and swing (mob_ai_sub_hard -> unit_attack), and lose it when they start chasing again (unit_walktobl -> unit_stop_attack,
   *  see mobChase) or drop / switch target. */
  targetedCount(id: string) {
    let n = 0;
    for (const [k, b] of this.brains) if (b.target === id && (b.engaged === id || this.state.players.has(k))) n++;
    return n;
  }

  /** status->amotion / dmotion: players from ASPD / AGI, monsters from mob_db AttackMotion / DamageMotion. */
  motions(id: string): { amotion: number; dmotion: number; type: number } {
    const b = this.brains.get(id)!, mon = this.state.monsters.get(id);
    if (mon) { const def = MOB_BY_ID.get(mon.mobId)!; return { amotion: def.attackMotion, dmotion: def.damageMotion, type: BL.MOB }; }
    return { amotion: pcAmotion(b.status.aspd), dmotion: pcDmotion(b.status.stats.agi), type: BL.PC };
  }

  /**
   * battle_weapon_attack -> clif_damage + battle_delay_damage (battle.cpp:7399, 7437, 417): everyone is told about the swing
   * now (the attacker animates; the client times the number with amotion), and the damage itself is applied damageDelay ms
   * after the swing: the attacker's amotion, capped at 1000 ms for monsters (delay_battle_damage: yes).
   */
  delayDamage(src: string, target: string, res: AttackResult, swingAt: number, now: number, skill?: { skill: number; div: number }) {
    if (res.dmgLv > ATK.BLOCK) { res = { ...res }; this.skills.defend(target, res); } // 2.5.0: Kyrie / Lex Aeterna / Guard (skills.ts)
    const sm = this.motions(src), tm = this.motions(target);
    // clif_damage sends ZC_NOTIFY_ACT to the area of the target (clif.cpp:5292-5297), misses and dodges included; an attack that
    // dealt nothing (lucky / flee / ATK_MISS) goes out with dmotion 0 (battle_calc_attack, battle.cpp:6766-6770: no flinch)
    this.sendArea("AREA", target, Msg.hit, { from: src, to: target, dmg: res.dmg, crit: res.crit, miss: res.miss, lucky: res.lucky, amotion: sm.amotion, dmotion: res.miss ? 0 : tm.dmotion, ...skill } satisfies HitEvent);
    const srcUnit = this.actor(src)!, targetUnit = this.actor(target)!;
    const a = this.cell(srcUnit), t = this.cell(targetUnit);
    const ev: DelayedDamage = { src, srcUnit, target, targetUnit, res, reach: delayedDamageReach(distance(t.x - a.x, t.y - a.y)) };
    const delay = damageDelay(sm.amotion, sm.type);
    if (delay <= 1) this.landDamage(ev, now);
    else this.timeline.add(swingAt + delay, (at) => this.landDamage(ev, at));
  }

  /**
   * battle_delay_damage_sub (battle.cpp:384): when the delay ends the hit is dropped if the target is gone or already dead,
   * or the attacker is gone or now farther away than `reach` (teleported), or the target is a player whose spawn protection
   * runs (invincible_timer, battle.cpp:393: a swing made before a respawn dies with it). Otherwise battle_damage with the
   * attack's dmg_lv (battle.cpp:397).
   */
  landDamage(ev: DelayedDamage, at: number) {
    const tgt = this.actor(ev.target), src = this.actor(ev.src);
    if (tgt !== ev.targetUnit || tgt.dead) return;
    if (this.invincible(ev.target, at)) return;
    if (src !== ev.srcUnit) return;
    // ours, not rAthena (its dead mob is still found by map_id2bl, so the swing lands): a monster's swing in flight dies with it,
    // a slave's too when it goes with its master (BossSystem.killSlave), so nothing hits after the kill / the MVP line
    if (src.dead && this.state.monsters.has(ev.src)) return;
    if (!duel.pairAllowed(this, ev.src, ev.target)) return; // player vs player only inside a duel (the duel may have ended mid-swing)
    const a = this.cell(src), t = this.cell(tgt);
    if (distance(t.x - a.x, t.y - a.y) > ev.reach) return;
    this.applyDamage(ev.src, ev.target, ev.res.dmg, at, ev.res.dmgLv);
  }

  /** battle_damage (battle.cpp:319-361). Only an attack that connected (dmg_lv > ATK_BLOCK) does anything: a dodge (ATK_LUCKY /
   *  ATK_FLEE) or one that connected for less than 1 (ATK_MISS, e.g. an element at 0%) changes no HP, stops nobody (no walk
   *  delay), logs nothing and starts no mob_attacked timer. A connecting hit goes through status_damage (status.cpp:1492): HP,
   *  sit cancel (pc_damage), walk delay, death; then the mob_attacked timer (battle.cpp:361) makes a monster retaliate once the
   *  walk delay has passed. */
  applyDamage(from: string, to: string, dmg: number, at: number, dmgLv: DamageLv) {
    if (dmgLv <= ATK.BLOCK) return;
    const tgt = this.actor(to)!;
    const tb = this.brains.get(to)!;
    const tm = this.motions(to);
    const delay = this.status.isEndure(to) ? 0 : walkDelay(tm.dmotion, tm.type, dmg); // status_damage: no walk delay for an Endure / Boss target (status_isendure)
    if (this.state.monsters.has(to)) {
      const srcUnit = this.actor(from);
      const norm = this.normAttacked(to, from);
      this.timeline.add(at + delay, () => this.mobAttacked(to, tgt, from, srcUnit, norm));
    }
    this.logDamage(from, to, loggedDamage(dmg, tgt.hp));
    this.status.damaged(to, this.state.players.has(from)); // RemoveOnDamaged (Freeze, Stone, Sleep), Endure's hit count
    if (dmg <= 0) return;
    if (this.state.players.has(to)) (tgt as Player).sitting = false; // pc_damage: pc_setstand when hp was lost
    if (this.state.players.has(to)) this.skills.cancel(to, "damage"); // status_damage -> unit_skillcastcancel (CastCancel skills)
    tgt.hp = Math.max(0, tgt.hp - dmg);
    // unit_set_walkdelay(type 0): with damage_walk_delay: 0 (conf/battle/battle.conf) the target just stops on the nearest
    // cell centre: USW_MOVE_FULL_CELL finishes a step that is at least half done, else it stays where it is (unit.cpp:2026-2029).
    if (delay > 0 && tgt.hp > 0) this.stopWalking(to, tgt, tb, USW.MOVE_FULL_CELL, at);
    if (tgt.hp > 0) return;

    this.unitDied(to, tgt, tb, from);
  }

  /** The unit's HP reached 0 (status_damage -> pc_dead / mob_dead). `from` = the killer; undefined for a death without an attacker
   *  (a script's percentheal -100 / heal below 0), which only a player can die of. */
  unitDied(to: string, tgt: Actor, tb: Brain, from: string | undefined) {
    tgt.dead = true;
    if (this.state.players.has(to)) duel.onDeath(this, to, from); // pc_dead: duel_leave (duel_autoleave_when_die)
    this.status.died(to); // status_change_clear: everything but Endure ends with the unit
    this.haltWalk(tgt, this.walkOf(tb, tgt)); // a dead unit stops where it is
    tb.target = undefined;
    for (const b of this.brains.values()) if (b.target === to) b.target = undefined;
    // clif_clearunit_area(CLR_DEAD) -> AREA of the dead unit (clif.cpp:977): status_damage for a player (status.cpp:1769),
    // mob_dead for a monster (mob.cpp:3636, 250 ms later there)
    this.sendArea("AREA", to, Msg.die, (from === undefined ? { id: to } : { id: to, killer: from }) satisfies DieEvent);

    const mon = this.state.monsters.get(to);
    if (mon && from !== undefined) {
      this.shareExp(to, mon.mobId);
      this.dropMobItems(to, mon, from, tb.loot ?? []);
      // mob_dead -> quest_update_objective: the killer, or every member of its party within AREA_SIZE of the monster
      for (const sid of party.questKillers(this, from, this.cell(mon))) this.npcEngine.mobDead(sid, MOB_BY_ID.get(mon.mobId)!);
      // mob_dead -> mob_setdelayspawn (mob.cpp:3652, 1064): the respawn timer starts at death, delay from the spawn line
      const slot = this.mobSpawns.get(to);
      this.boss.dead(to, mon, from, !!slot?.sd.boss); // MVP reward, slaves die with their master, the tomb of a boss_monster line
      if (!slot) this.boss.removeSlaveLater(to, mon); // a slave has no spawn line: it leaves the map instead of respawning
      else this.clock.setTimeout(() => {
        this.state.monsters.delete(to);
        this.brains.delete(to);
        this.spawnMonster(to);
      }, respawnDelay(slot.sd, MOB_BY_ID.get(mon.mobId)!.mode, rnd()));
    }
    const dp = this.state.players.get(to);
    if (dp) { // pc_dead penalty block + pc_lostexp
      const pen = deathPenalty({ job: dp.job as JobKey, level: dp.level, exp: dp.exp, jobLevel: dp.jobLevel, jobExp: dp.jobExp }); // explicit fields: a spread of a Colyseus schema copies nothing
      dp.exp -= pen.base; dp.jobExp -= pen.job;
      // pc_lostexp (pc.cpp:8548/8555): clif_displayexp(SP_BASEEXP, lost) then (SP_JOBEXP, lost), owner only, one event per non-zero part
      const dc = this.clients.getById(to);
      if (pen.base > 0) dc?.send(Msg.exp, { base: pen.base, job: 0, lost: true } satisfies ExpEvent);
      if (pen.job > 0) dc?.send(Msg.exp, { base: 0, job: pen.job, lost: true } satisfies ExpEvent);
      tb.nextHp = tb.nextSp = undefined; // status_natural_heal keeps resetting tick.hp/sp while dead (status.cpp:15569): first heal a full interval after respawn
      this.skills.cancel(to, "death"); // pc_dead -> unit_skillcastcancel
      this.pets.ownerDied(to); // pc_dead: the pet loses IntimacyOwnerDie
      this.closeNpc(this.clients.getById(to), tb); // pc_dead -> pc_close_npc(sd,2): shop session ends, no walking back to an old pickup/NPC after respawn
      this.save(dp).catch((e) => console.error("[save]", e));
    }
    // dead players stay down until they send Msg.respawn ("Return to Save Point")
  }

  /** mob_attacked / mob_norm_attacked -> mob_set_attacked_id (mob.cpp:2257): remember the attacker as attacked_id; the next
   *  AI pass (mobAi, this same tick) decides whether the monster turns on it. */
  mobAttacked(id: string, unit: Actor, from: string, fromUnit: Actor | undefined, norm = false) {
    const mon = this.state.monsters.get(id), b = this.brains.get(id);
    if (mon !== unit || !b || mon.dead || !fromUnit || this.actor(from) !== fromUnit || fromUnit.dead) return;
    b.attacked = { id: from, norm };
  }

  /** battle_weapon_attack (battle.cpp:7417-7426): a monster in attack (berserk) state hit by a normal attack from someone it
   *  isn't fighting, within its attack range + 1, gets the special "normal attacked" event (lets MD_CHANGETARGETMELEE switch).
   *  rAthena decides this at the swing; here it is decided when the hit lands. */
  normAttacked(mobId: string, from: string) {
    const mon = this.state.monsters.get(mobId), b = this.brains.get(mobId), src = this.actor(from);
    if (!mon || !b || !src || b.mobState !== "berserk" || b.target === from) return false;
    const a = this.cell(src), m = this.cell(mon);
    return distance(a.x - m.x, a.y - m.y) <= MOB_BY_ID.get(mon.mobId)!.range + 1;
  }

  // ---------- damage log (mob_log_damage / mob_dead) ----------
  /** Character id of a player session (s_dmglog.id is a char_id, so a relog onto this map is the same attacker). */
  charIdOf(sessionId: string) {
    return this.state.players.has(sessionId) ? this.brains.get(sessionId)?.inv?.charId : undefined;
  }

  /** map_charid2sd + "same map" check: the session currently playing `charId` in this room, if any. */
  sessionOfChar(charId: number) {
    for (const [sid, b] of this.brains) if (b.inv?.charId === charId && this.state.players.has(sid)) return sid;
    return undefined;
  }

  /** mob_dead's view of a log entry: online here (alive or dead) or undefined (left the map). */
  receiver = (charId: number): Receiver | undefined => {
    const sid = this.sessionOfChar(charId), p = sid ? this.state.players.get(sid) : undefined;
    return p ? { baseLevel: p.level, dead: p.dead } : undefined;
  };

  /** status_damage logging: a player's hit on a monster goes into its log as damage (mob_damage, status.cpp:1656); a monster's
   *  normal attack on a player is logged as tanked damage in the monster's own log (status.cpp:1669-1672, counts as tap). */
  logDamage(from: string, to: string, dmg: number) {
    const mb = this.state.monsters.has(to) ? this.brains.get(to) : this.state.monsters.has(from) ? this.brains.get(from) : undefined;
    const charId = this.state.monsters.has(to) ? this.charIdOf(from) : this.charIdOf(to);
    if (!mb?.dmglog || charId === undefined) return;
    if (this.state.monsters.has(to)) mobLogDamage(mb.dmglog, charId, dmg);
    else mobLogDamage(mb.dmglog, charId, 0, dmg);
  }

  /** Damage log of a monster (empty once it respawned). Read-only view for kill rewards and loot priority. */
  dmgLogOf(monsterId: string): DmgLog {
    return this.brains.get(monsterId)?.dmglog ?? [];
  }

  /** mob_dead loot priority (first_sd, second_sd, third_sd) as session ids — for drop ownership. */
  lootOwnerSessions(monsterId: string): string[] {
    return lootOwners(this.dmgLogOf(monsterId), this.receiver).map((c) => this.sessionOfChar(c)!);
  }

  /** mob_dead EXP: every eligible attacker in the log gets its damage share (+ attacker bonus, level penalty); the shares of
   *  members of an even-share party are added up and split by party_exp_share among its members alive on this map, each then
   *  getting its own level penalty (rules/party.ts). */
  shareExp(monsterId: string, mobId: number) {
    const def = MOB_BY_ID.get(mobId)!;
    const { direct, parties } = partyExpAggregate(mobDeadShares(this.dmgLogOf(monsterId), def, this.receiver), party.evenExpParty);
    for (const s of direct) {
      const sid = this.sessionOfChar(s.id)!, p = this.state.players.get(sid)!, g = penalized(s, { baseLevel: p.level }, def);
      this.reward(sid, p, g.base, g.job);
    }
    for (const t of parties) {
      const sids = party.aliveMembersIn(this, t.partyId), each = partyExpSplit(t.base, t.job, sids.length);
      for (const sid of sids) {
        const p = this.state.players.get(sid)!, g = penalized(each, { baseLevel: p.level }, def);
        if (g.base || g.job) this.reward(sid, p, g.base, g.job);
      }
    }
  }

  /** pc_gainexp for one receiver of a kill. */
  reward(id: string, p: Player, base: number, job: number, quest = false) {
    if (p.dead) return; // pc_gainexp: nothing for a dead character (pc.cpp:8458)
    const prog = { job: p.job as JobKey, level: p.level, exp: p.exp, jobLevel: p.jobLevel, jobExp: p.jobExp, statPoints: p.statPoints, skillPoints: p.skillPoints };
    const sent = { base: base !== 0, job: job !== 0 }; // pc_gainexp flag&1 / flag&2: from the amounts before any cap (pc.cpp:8471)
    ({ base, job } = capExpGain(prog, base, job)); // max_exp_gain_rate (pc.cpp:8495-8507)
    const gain = displayedGain(prog, base, job); // computed before gainExp: 0 for an already-maxed part
    const { baseUps, jobUps } = gainExp(prog, base, job);
    Object.assign(p, prog);
    if (baseUps || jobUps) {
      this.refreshStatus(id, p);
      if (baseUps) { p.hp = p.maxHp; p.sp = p.maxSp; } // status_percent_heal(sd, 100, 100) on a base level up
      if (baseUps) this.skills.sweep(id, true); // pc_baselevelchanged (pc.cpp:8306-8313): EquipLevelMax failures come off
      // pc_checkbaselevelup / pc_checkjoblevelup: the owner's clif_updatestatus first, then clif_misceffect to the AREA
      // (pc.cpp:8292, 8347; clif.cpp:4374): players within area_size see the effect, nobody gets a chat line
      this.flushStatus(id);
      if (baseUps) this.sendArea("AREA", id, Msg.levelUp, { id, kind: "base" } satisfies LevelUpEvent);
      if (jobUps) this.sendArea("AREA", id, Msg.levelUp, { id, kind: "job" } satisfies LevelUpEvent);
    }
    // clif_displayexp per part whose amount was non-zero (pc.cpp:8526-8529), 0 shown for an already-maxed part
    if (sent.base || sent.job) this.clients.getById(id)?.send(Msg.exp, (quest ? { ...gain, quest } : gain) satisfies ExpEvent);
    if (!baseUps && !jobUps) return;
    this.skills.send(id); // clif_skillinfoblock after pc_checkjoblevelup (new points) / a base level (tree requirements)
    this.npcEngine.questinfo(id); // pc_checkbaselevelup / pc_checkjoblevelup -> pc_show_questinfo
    this.save(p).catch((e) => console.error("[save]", e));
  }

  // ---------- monster AI (rAthena mob_ai_sub_hard; decisions in shared/rules/mobai.ts) ----------
  /**
   * mob_ai_sub_hard (mob.cpp:1841) for one live monster, every tick. A monster keeps its target until the target is gone or
   * dead, out of its ChaseRange (status_check_visibility, measured from the monster), or unreachable (unit_walktobl fails) —
   * there is no spawn-point leash. Order as in the C++: target validity, attacked event, loot search (MD_LOOTER), active
   * search (MD_AGGRESSIVE) / chase change (MD_CHANGECHASE), then random walk, looting, attacking or chasing.
   * Not modelled yet: mob skills (and rude-attacked skills), MD_ANGRY states, slaves, warp chase, lazy AI for monsters far
   * from players, the 100 ms AI timer grid (MIN_MOBTHINKTIME; we think every 50 ms tick).
   */
  mobAi(id: string, m: Monster, b: Brain, def: Mob, now: number) {
    if (now < (b.thinkAt ?? 0)) return; // next_thinktime (mob_set_delay)
    if (this.boss.slaveAi(id, m, now)) return; // mob_ai_sub_hard_slavemob: follows / dies with its master
    if (this.boss.casting(id) || this.status.mobCasting(id)) { if (this.walking(b)) this.stopWalking(id, m, b, USW.FIXPOS, now); return; } // mob_ai_sub_hard: nothing while ud->skilltimer runs, the cast stops the walk
    const mode = b.mode ?? def.mode, here = this.cell(m);
    const canMove = hasMode(mode, MD.CANMOVE) && !this.status.cant(id, "move"); // unit_can_move: no walking under Stone, Freeze, Stun, Sleep
    if (canMove) b.lastCanMove = now;

    // check the current target (mob.cpp:1903-1932): gone, dead, or a player under spawn protection (invincible_timer, :1912)
    let tgt: Actor | undefined;
    if (b.target) {
      const t = this.actor(b.target);
      if (!t || !this.targetable(b.target, t, now)) {
        // a chasing monster walks on (mob_chase_refresh >= MAX_WALKPATH: its whole path) before dropping a dead / protected target
        if (t && m.moving && canMove) return;
        this.mobUnlock(m, b, now);
      } else {
        tgt = t;
        const tc = this.cell(t);
        // attack timer end (mob_ai_sub_hard_attacktimer) and a stopped chaser out of attack range (mob.cpp:1925): visibility
        const attackEnd = b.engaged === b.target && now >= b.nextAttack;
        if ((attackEnd || (!m.moving && isChasing(b.mobState!) && !battleCheckRange(this.map, here, tc, def.range)))
          && !mobCanSee(here, tc, def.chaseRange)) {
          this.mobUnlock(m, b, now);
          return;
        }
      }
    }
    if (b.lootTarget && !this.state.floor.has(b.lootTarget)) this.mobUnlock(m, b, now); // item taken: map_id2bl fails

    // attacked event (mob.cpp:1935-2001)
    if (b.attacked && hasMode(mode, MD.CANATTACK)) {
      const { id: aid, norm } = b.attacked;
      const abl = aid !== b.target ? this.actor(aid) : undefined;
      if (abl && !abl.dead && (!(tgt || b.lootTarget) || canChangeTarget(b.mobState!, mode, norm))) {
        const ac = this.cell(abl), dist = distance(ac.x - here.x, ac.y - here.y);
        // not an enemy it may target (a protected player: battle_check_target <= 0, :1960), too far, or out of attack range and
        // can't be reached within dist + ChaseRange: "rude attacked" (mob skills, later). A swing's retaliation timer that
        // fires after the attacker died and respawned lands here: the new spawn protection refuses the switch.
        const rude = !this.targetable(aid, abl, now) || dist > MOB_AREA_SIZE
          || (!battleCheckRange(this.map, here, ac, def.range) && !canReach(this.map, here, ac, dist + def.chaseRange));
        if (!rude) { b.target = aid; b.lootTarget = undefined; tgt = abl; }
      }
      b.attacked = undefined;
    }

    // loot search (mob.cpp:2008-2022): only while there is no target at all
    if (canMove && hasMode(mode, MD.LOOTER) && !tgt && !b.lootTarget) {
      const items = [...this.state.floor].map(([fid, f]) => ({ fid, n: Number(fid.slice(1)), x: Math.round(f.x), y: Math.round(f.y) }));
      const pick = pickLoot(this.map, here, items);
      if (pick) b.lootTarget = pick.fid;
    }

    // active search (MD_AGGRESSIVE) / chase target change (MD_CHANGECHASE), mob.cpp:2024-2040
    if (hasMode(mode, MD.AGGRESSIVE) && !tgt && !b.lootTarget) {
      const pid = pickAggroTarget(this.map,
        { ...here, level: def.level, mode, range2: def.skillRange, range3: def.chaseRange, walking: m.moving },
        this.aggroCandidates(now));
      if (pid !== undefined) {
        b.target = pid; tgt = this.actor(pid)!;
        // a new target already in attack range: straight to rush (mob_setstate MSS_RUSH)
        if (battleCheckRange(this.map, here, this.cell(tgt), def.range)) b.mobState = "rush";
      }
    } else if (hasMode(mode, MD.CHANGECHASE) && b.mobState === "rush") {
      const r = Math.min(def.skillRange, def.range);
      for (const c of this.aggroCandidates(now)) { // mob_ai_sub_hard_changechase: every enemy in attack range replaces it
        if (c.id !== b.target && distance(c.x - here.x, c.y - here.y) <= r && battleCheckRange(this.map, here, c, def.range)) {
          b.target = c.id; tgt = this.actor(c.id)!;
        }
      }
    }

    if (!tgt && !b.lootTarget) { // no target: unlock and random walk (mob.cpp:2042-2068)
      this.mobUnlock(m, b, now);
      if (now >= b.walkAt! && !this.mobRandomWalk(id, m, b, def, now)) b.walkAt = now + (rnd() % 1000); // try again soon
      return;
    }

    if (b.lootTarget) { this.mobLoot(id, m, b, now, canMove); return; }
    const t = tgt!, tc = this.cell(t);

    // in attack range: attack (unit_attack), mob.cpp:2135-2162
    if (battleCheckRange(this.map, here, tc, def.range)) {
      this.mobUnitAttack(id, m, b, def, now);
      return;
    }
    // a chase in progress goes on cell by cell (mob_chase_refresh / monster_ai 0x1 off; see mobUpdateChase)
    if (m.moving && isChasing(b.mobState!) && b.chaseTo === b.target) return;
    if (!canMove) { // immobile: keep the target a while, then unlock (mob_unlock_time)
      if (now >= b.nextAttack) {
        if (now - b.lastCanMove! > MONSTER_CONF.mob_unlock_time) this.mobUnlock(m, b, now);
        else b.mobState = "idle";
      }
      return;
    }
    if (!this.mobChase(id, m, b, b.target!, tc, now)) this.mobUnlock(m, b, now); // unreachable: give up
  }

  /** unit_attack (unit.cpp:2902-2990) by a monster on its AI target: the swing target is locked (ud->target), the walk ends on
   *  the monster's cell and it swings now if its attack delay is over (later swings come back here through the AI). From the
   *  AI (in range) and from mobUpdateChase (on arriving within reach). */
  mobUnitAttack(id: string, m: Monster, b: Brain, def: Mob, at: number) {
    b.chaseTo = undefined;
    b.mobState = "berserk";
    const before = b.nextAttack;
    this.fight(id, m, b, at, def.range);
    if (b.nextAttack !== before) this.mobSwung(id, m, b, def, at);
  }

  /** Players a monster may pick as a target (mob_ai_sub_hard_activesearch / _changechase candidates: the enemies
   *  battle_check_target accepts and status_check_skilluse allows — alive and not under spawn protection, see targetable). */
  aggroCandidates(now: number) {
    const out: { id: string; x: number; y: number; level: number }[] = [];
    for (const [pid, p] of this.state.players) if (this.targetable(pid, p, now)) out.push({ id: pid, ...this.cell(p), level: p.level });
    return out;
  }

  /** unit_walktobl(md, tbl, rhw.range, 2) (mob.cpp:2214): chase the target to attack it. False = unreachable. */
  mobChase(id: string, m: Monster, b: Brain, targetId: string, tc: Cell, now: number) {
    if (!this.mobWalkToBl(id, m, b, targetId, tc, MOB_BY_ID.get(m.mobId)!.range, now)) return false;
    b.mobState = "rush"; // unit_walktoxy_sub / unit_walktobl: an attack chase is MSS_RUSH
    return true;
  }

  /**
   * unit_walktobl (unit.cpp:950-1014) for a monster: walk after unit / item `targetId` to the cell beside it that
   * unit_can_reach_bl finds (within its distance + 1; monsters always aim at an adjacent cell, even ranged ones), onto the
   * item's own cell for range 0 (looters), as a chase (ud->target_to + chaserange, checked on every cell by mobUpdateChase).
   * A step in progress finishes first (change_walk_target). False = unreachable (or the monster can't move).
   */
  mobWalkToBl(id: string, m: Monster, b: Brain, targetId: string, tc: Cell, range: number, at: number): boolean {
    const w = this.walkOf(b, m), here = this.cell(m);
    if (!hasMode(b.mode ?? MOB_BY_ID.get(m.mobId)!.mode, MD.CANMOVE)) return false;
    const dest = canReach(this.map, here, tc, distance(tc.x - here.x, tc.y - here.y) + 1);
    if (!dest) { w.to = here; b.chaseTo = undefined; return false; }
    w.to = range === 0 ? { x: tc.x, y: tc.y } : dest;
    b.chaseTo = targetId;
    b.chaseRange = range;
    b.engaged = undefined; // unit_stop_attack
    if (this.walking(b)) { w.changeTarget = true; return true; }
    return this.canMove(id, m, b, at) && this.walkSub(id, m, b, at);
  }

  /**
   * unit_update_chase (unit.cpp:113-170) for a monster walking after a unit or an item (ud->target_to = chaseTo), run on every
   * cell it reaches (unit_walktoxy_nextcell; the full check only before its last step) and at the end of its path: a target
   * unit within ud->chaserange of the cell just reached is attacked from that cell at once (unit_attack) and the walk ends
   * there (USW_FIXPOS) — the swing comes on arrival, not half way into the next cell; a target that is gone, or out of sight
   * on a full check, is unlocked while the walk goes on; a full check re-paths the chase to where the target is now
   * (unit_walktobl). True = the walk was stopped or replaced.
   */
  mobUpdateChase(id: string, m: Monster, b: Brain, at: number, fullcheck: boolean): boolean {
    const w = this.walkOf(b, m), def = MOB_BY_ID.get(m.mobId)!, tid = b.chaseTo!, here = this.cell(m);
    const unit = this.actor(tid), tbl = unit ?? this.state.floor.get(tid);
    if (unit && w.pos > 0 && distance(unit.x - here.x, unit.y - here.y) <= (b.chaseRange ?? def.range)) {
      this.stopWalking(id, m, b, USW.FIXPOS | USW.FORCE_STOP | USW.RELEASE_TARGET, at);
      if (b.target === tid) this.mobUnitAttack(id, m, b, def, at);
      return true;
    }
    if (!tbl || (fullcheck && !mobCanSee(here, this.cell(tbl), def.chaseRange))) { this.mobUnlock(m, b, at); return false; }
    if (fullcheck && unit && b.target === tid && w.pos > 0 && w.canmoveTick - at <= 0) {
      return this.mobWalkToBl(id, m, b, tid, this.cell(unit), b.chaseRange ?? def.range, at);
    }
    return false;
  }

  /** The looting part of mob_ai_sub_hard (mob.cpp:2071-2131): walk onto the item's cell, then put it in the loot bag. */
  mobLoot(id: string, m: Monster, b: Brain, now: number, canMove: boolean) {
    const fid = b.lootTarget!, f = this.state.floor.get(fid)!, here = this.cell(m);
    const fc = this.cell(f);
    let lootRange = 0;
    if (this.walking(b)) {
      // "ready to loot" (mob.cpp:2073-2078): the monster's exact position (md->ud.getx: across the border half way through a
      // step, exactCell) is the item's cell; the loot range then counts from the cell it stands on (bl->x / bl->y)
      const w = b.walk!, e = exactCell(here, w.path[w.pos], stepProgress(w.stepAt!, w.stepMs, now));
      if (e.x === fc.x && e.y === fc.y) lootRange = 1;
      else if (b.chaseTo === fid) return; // already on the way
    }
    if (distance(fc.x - here.x, fc.y - here.y) > lootRange) {
      if (!canMove) { this.mobUnlock(m, b, now); return; }
      b.mobState = "loot";
      // unit_walktobl(md, tbl, 0, 0): reachable (unit_can_reach_bl), then walk onto the item's own cell
      if (!this.mobWalkToBl(id, m, b, fid, fc, 0, now)) this.mobUnlock(m, b, now);
      return;
    }
    if (process.env.DBGLOOT) console.log('MOBLOOT', Math.round(now), f.itemId, f.x, f.y, 'by', id, m.mobId);
    b.loot = addLoot(b.loot ?? [], { itemId: f.itemId, amount: f.amount });
    this.state.floor.delete(fid); // map_clearflooritem
    this.brains.delete(fid);
    this.mobUnlock(m, b, now);
  }

  /** After a monster's swing (unit_attack_timer_sub): MD_ASSIST links same-species allies within assist_range onto the target
   *  (mob_linksearch, at most once per MIN_MOBLINKTIME each), and the AI pauses for the attack motion (mob_set_delay). */
  mobSwung(id: string, m: Monster, b: Brain, def: Mob, now: number) {
    const swingAt = b.nextAttack - b.status.attackDelayMs;
    b.thinkAt = Math.max(b.thinkAt ?? 0, swingAt + def.attackMotion);
    if (!hasMode(b.mode ?? def.mode, MD.ASSIST) || now - b.lastLink! < MIN_MOBLINKTIME) return;
    b.lastLink = now;
    const here = this.cell(m);
    for (const [oid, o] of this.state.monsters) {
      const ob = this.brains.get(oid);
      if (oid === id || o.dead || o.mobId !== m.mobId || !ob || ob.target || ob.lootTarget) continue;
      if (!hasMode(ob.mode ?? MOB_BY_ID.get(o.mobId)!.mode, MD.ASSIST) || now - ob.lastLink! < MIN_MOBLINKTIME) continue;
      const oc = this.cell(o);
      if (!battleCheckRange(this.map, here, oc, MONSTER_CONF.assist_range)) continue; // map_foreachinshootrange
      ob.lastLink = now;
      ob.target = b.target;
    }
  }

  /** mob_unlocktarget (mob.cpp:1617): drop the target (unit, item) and the chase, but keep walking; leaving a fight or a
   *  loot run makes the monster idle and pushes its next random walk 4000-4999 ms out. */
  mobUnlock(m: Monster, b: Brain, now: number) {
    switch (b.mobState) {
      case "walk":
        if (m.moving) break;
        b.mobState = "idle";
        break;
      case "idle":
        break;
      case "loot":
        this.stopWalkingSoon(m, b, now); // looters that lost their target stop after 0.5-1.5 cells moved
      // falls through
      default:
        b.mobState = "idle";
        b.walkAt = nextWalkTime(now, rnd());
    }
    b.target = undefined;
    b.engaged = undefined;
    b.lootTarget = undefined;
    b.chaseTo = undefined;
  }

  /**
   * mob_randomwalk (mob.cpp:1673): pick the first cell of the 15x15 square around the monster (rules randomWalkOffsets)
   * that is passable and can be walked to; the next walk is due 4000-4999 ms after this one ends. False = no walk
   * (not due, MD_NORANDOMWALK, can't move, or no cell worked).
   */
  mobRandomWalk(id: string, m: Monster, b: Brain, def: Mob, now: number) {
    if (now < b.walkAt! || hasMode(b.mode ?? def.mode, MD.NORANDOMWALK) || !this.canMove(id, m, b, now)) return false;
    const here = this.cell(m);
    b.chaseTo = undefined; // "make sure the monster has no target anymore" (attack_continue / target_to)
    const r = rnd(), rdir = rnd() % 4;
    for (const { dx, dy } of randomWalkOffsets(r, rdir)) {
      const x = here.x + dx, y = here.y + dy;
      if ((dx || dy) && walkable(this.map, x, y) && this.walkToXY(id, m, b, x, y, 0, now)) { // unit_walktoxy(md, x, y, 0)
        b.engaged = undefined; // unit_walktoxy -> unit_stop_attack
        b.mobState = "walk";
        b.walkAt = nextWalkTime(now, rnd(), walkpathTime(here, this.walkOf(b, m).path, b.status.walkMs));
        return true;
      }
    }
    return false;
  }

  /** Walk to a floor item, then pick it up (the client's walk + CZ_ITEM_PICKUP). On the way the player looks at every cell it
   *  reaches (pcArrived); standing, it picks the item up within reach or asks to walk there. (NPCs are not walked to: see
   *  clickNpc.) */
  pursueGoal(id: string, p: Player, b: Brain, now: number) {
    const g = b.goal!, client = this.clients.getById(id);
    const spot = this.state.floor.get(g.id);
    if (!spot || !client) { b.goal = undefined; return; }
    const c = this.cell(p), w = this.walkOf(b, p); // pc_takeitem's cell distance
    if (this.walking(b) && w.to.x === spot.x && w.to.y === spot.y) return; // on the way
    if (!this.walking(b) && distance(spot.x - c.x, spot.y - c.y) <= PICKUP_RANGE) {
      b.goal = undefined;
      this.pickup(g.id, p, b, client);
      return;
    }
    if (now >= b.repathAt) {
      this.endInvincible(b); // the real client walks to a far item with WalkToXY (pc_delinvincibletimer); a TakeItem within reach doesn't
      this.walkToXY(id, p, b, spot.x, spot.y, 0, now, searchPath);
      b.repathAt = now + 500;
    }
  }

  tick(_dt?: number) {
    const now = this.clock.currentTime;
    // walk steps, delayed walks, delayed damage and retaliation due by now, each at its own time, before this tick's swings
    this.timeline.run(now);
    this.skills.tick(now); // skill walk-ins
    for (const [id, p] of this.state.players) {
      const b = this.brains.get(id)!;
      if (p.dead) continue;
      if (b.target) this.fight(id, p, b, now, b.status.rhw.range); // status_get_range: the weapon's Range, at least 1
      if (b.goal) this.pursueGoal(id, p, b, now);
      // natural regen; sitting halves the interval (RO); none at 70%+ weight (Renewal)
      if ((b.inv && blocksNaturalRegen(b.inv.weight(), maxWeight(p.job as JobKey, p.str))) || this.status.noRegen(id)) { b.nextHp = now + HP_REGEN_MS; b.nextSp = now + SP_REGEN_MS; continue; } // status_calc_regen_rate: Poison / Bleeding stop regeneration
      const k = p.sitting ? 0.5 : 1;
      b.nextHp ??= now + HP_REGEN_MS * k;
      b.nextSp ??= now + SP_REGEN_MS * k;
      if (hpRegenBlockedByWalk(this.walking(b) || p.moving)) b.nextHp = now + HP_REGEN_MS * k; // status_natural_heal: no HP regen while walking, the timer restarts
      else if (now >= b.nextHp) { b.nextHp = now + HP_REGEN_MS * k; p.hp = Math.min(p.maxHp, p.hp + hpRegen(b.status)); }
      if (now >= b.nextSp) { b.nextSp = now + SP_REGEN_MS * k; p.sp = Math.min(p.maxSp, p.sp + spRegen(b.status)); }
      // skill regen (SM_RECOVERY / MG_SRECOVERY, status_heal_regen's sregen): every natural_heal_skill_interval of time spent not walking and below max
      const dt = Math.min(1000, now - (b.sregenAt ?? now));
      b.sregenAt = now;
      if (this.walking(b) || p.moving) { /* the skill timers only run while standing */ }
      else {
        if (p.hp < p.maxHp && b.status.sregenHp) { b.sregenHpMs = (b.sregenHpMs ?? 0) + dt; if (b.sregenHpMs >= NATURAL_HEAL_SKILL_INTERVAL) { b.sregenHpMs -= NATURAL_HEAL_SKILL_INTERVAL; p.hp = Math.min(p.maxHp, p.hp + b.status.sregenHp); } }
        if (p.sp < p.maxSp && b.status.sregenSp) { b.sregenSpMs = (b.sregenSpMs ?? 0) + dt; if (b.sregenSpMs >= NATURAL_HEAL_SKILL_INTERVAL) { b.sregenSpMs -= NATURAL_HEAL_SKILL_INTERVAL; p.sp = Math.min(p.maxSp, p.sp + b.status.sregenSp); } }
      }
    }
    this.status.tick(now); // status timers (poison, stone, ends) and the monsters' status skills
    for (const [id] of this.state.floor) {
      if (now >= (this.brains.get(id)?.expires ?? 0)) { this.state.floor.delete(id); this.brains.delete(id); }
    }
    for (const [id, m] of this.state.monsters) {
      if (m.dead) continue;
      const b = this.brains.get(id)!, def = MOB_BY_ID.get(m.mobId)!;
      if (!b.target) b.engaged = undefined; // target dropped: unit_set_target(ud, 0)
      this.mobAi(id, m, b, def, now); // its chase is checked on every cell it reaches (nextCell -> mobUpdateChase)
    }
    this.boss.tick(now); // bosses re-check their summon skill once a second
    this.pets.tick(now); // pet_ai_sub_hard: follow / fight, and where clients draw the walking pets
    // where clients draw walking units between cells (the cells themselves change in the step events above)
    for (const [id, p] of this.state.players) this.drawOffset(p, this.brains.get(id), now);
    for (const [id, m] of this.state.monsters) this.drawOffset(m, this.brains.get(id), now);
    // our addition to pc_show_questinfo's triggers: a questinfo condition may read Hp / MaxHp (the "sit until HP is full" quest
    // task, shared/content/tasks.ts), so the icons are re-checked whenever a player's HP reaches or leaves the max
    for (const [id, p] of this.state.players) {
      const b = this.brains.get(id);
      if (!b) continue;
      const full = !p.dead && p.hp >= p.maxHp;
      if (b.hpFull === full) continue;
      const known = b.hpFull !== undefined;
      b.hpFull = full;
      if (known) this.npcEngine.questinfo(id);
    }
    for (const c of this.clients) this.flushStatus(c.sessionId, c); // owners see this tick's HP / SP / EXP / stat changes
  }
}
