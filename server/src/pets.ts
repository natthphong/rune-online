// Pets (2.4.0): rAthena src/map/pet.cpp on our room. Rules (numbers) in shared/rules/pet.ts; this file runs them:
// - catching: a taming item -> pet_catch_process_start (Msg.petCatchStart), the monster picked -> pet_catch_process_end
// - eggs: an inventory row with pet_id (rAthena card0 = CARD0_PET); hatching (pet_select_egg / pet_birth_process) removes it,
//   pet_return_egg puts it back with the same pet
// - the pet unit (MapState.pets "pet<id>"): pet_ai_sub_hard follow / attack, walking on our own step timers (same x/y/sx/sy
//   motion as monsters), never a target for monsters or players
// - timers: pet_hungry (hunger, intimacy, autofeed, running away at intimacy 0), petheal / petskillsupport
// - status: the pet_db Script bonus joins the owner's status calc (status_calc_pc "Pet Bonus"), see bonus()
// Persistence: table `pet` (migration 019), written through the owner's inventory chain like inventory rows.
import type { Client } from "@colyseus/core";
import { existsSync, readFileSync } from "node:fs";
import {
  Msg, dirFromDelta, type HealEvent, type HitEvent, type PetAutoFeedMsg, type PetCatchMsg, type PetCatchResultEvent, type PetCatchStartEvent,
  type PetCommandMsg, type PetEggsEvent, type SkillUseEvent, type PetEmoteEvent, type PetHatchMsg, type PetInfoEvent, type PetNoticeEvent, type PetRenameMsg,
} from "../../shared/protocol.ts";
import { distance, walkable } from "../../shared/map.ts";
import { MOB_BY_ID, type Element, type JobKey } from "../../shared/rules/data.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { takeItemTick } from "../../shared/rules/drops.ts";
import { FISTS, mobStatus, type MobStatus } from "../../shared/rules/status.ts";
import { ATK, BL, attrFix, damageDelay, mobAttack, playerAttack } from "../../shared/rules/battle.ts";
import { battleCheckRange } from "../../shared/rules/mobai.ts";
import { stepTime, walkSubPath, type Cell } from "../../shared/rules/walk.ts";
import { scriptBonus, type EquipBonus, type ItemBonus } from "../../shared/rules/bonus.ts";
import { SKILLS, inSplash, skillLv } from "../../shared/rules/skill.ts";
import { respawnDelay } from "../../shared/rules/spawn.ts";
import { ET } from "../../shared/rules/script.ts";
import {
  PET_CONF, PET_HUNGER, autoFeedDue, catchBlock, catchRate, feed, hungerTick, newPet, ownerDied, performance, petBonuses, petHitDamage,
  petHealAmount, petInfo, petRow, supportRate, supportReady, validPetName, type PetDb, type PetRow, type PetSupport,
  LEGENDARY_PET, breathChance, breathDamage, legendaryHitDamage,
} from "../../shared/rules/pet.ts";
import { db } from "./db.ts";
import type { Inventory } from "./inventory.ts";
import { Pet, type MapRoom, type Player } from "./rooms/MapRoom.ts";

// ---------- data (shared/data/pets.json, written by tools/rathena/import.ts) ----------
const PETS_FILE = new URL("../../shared/data/pets.json", import.meta.url);
const RAW: Record<string, unknown>[] = existsSync(PETS_FILE) ? JSON.parse(readFileSync(PETS_FILE, "utf8")) : [];
export const PET_DB = new Map<number, PetDb>(RAW.map(petRow).filter((r) => r.mobId > 0).map((r) => [r.mobId, r]));
const byItem = (k: "tameItem" | "eggItem" | "foodItem" | "equipItem") => new Map([...PET_DB.values()].filter((r) => r[k] > 0).map((r) => [r[k], r]));
/** pet_db_search(PET_CATCH / PET_EGG / PET_EQUIP) */
export const PET_BY_TAME = byItem("tameItem"), PET_BY_EGG = byItem("eggItem"), PET_BY_EQUIP = byItem("equipItem");
/** AREA_SIZE: a pet farther than this from its master (a warp, a blocked path) is put back beside it (pc_setpos moves sd->pd along). */
const LEASH = 14;
const LOOT_EVERY_MS = 1000, LOOT_RANGE = 4; // petloot (see petLoot)
const rnd = () => Math.random();

/** A hatched pet on this map: struct pet_data (server side; its synced part is the Pet schema). */
type PetUnit = {
  key: string; owner: string; row: PetRow; db: PetDb; status: MobStatus;
  path: Cell[]; pos: number; stepAt?: number; stepMs: number; token: number; to?: Cell; speedMs: number; // ud->walkpath / walktimer
  lootAt: number; target?: string; nextAttack: number; thinkAt: number; canMoveAt: number;
  timers: { clear(): void }[];
  /** petskillbonus: the bonus running now (pet_skill_bonus_timer), until this room time */
  skillBonus?: { bonus: ItemBonus; until: number };
};

/** Per character on this map: every pet row it owns (eggs + the one out), loaded at map entry. */
type Owner = { charId: number; pets: Map<number, PetRow>; out?: PetUnit; catchItem?: number; catchUid?: number };

export class PetSystem {
  room: MapRoom;
  owners = new Map<string, Owner>();
  /** DEV ONLY: the next catch attempt of this session succeeds (pets bot) */
  private devCatch = new Set<string>();
  constructor(room: MapRoom) { this.room = room; }

  private inv(sid: string): Inventory | undefined { return this.room.brains.get(sid)?.inv; }
  private client(sid: string): Client | undefined { return this.room.clients.getById(sid); }
  private send(sid: string, type: string, msg: unknown) { this.client(sid)?.send(type, msg); }
  private notice(sid: string, text: string) { this.send(sid, Msg.petNotice, { text } satisfies PetNoticeEvent); }
  private persist(sid: string, sql: string, args: unknown[]) { this.inv(sid)?.persist(sql, args).catch(() => {}); }
  private save(sid: string, r: PetRow) {
    this.persist(sid, "UPDATE pet SET name=$2, renamed=$3, hunger=$4, intimacy=$5, equip=$6, autofeed=$7, incubate=$8 WHERE id=$1",
      [r.id, r.name, r.renamed, r.hunger, r.intimacy, r.equip, r.autoFeed, r.incubate]);
  }

  // ---------- requests (registered by MapRoom) ----------
  register() {
    const r = this.room;
    r.onGuarded("petCatch", (c, m: PetCatchMsg) => this.catchEnd(c.sessionId, String(m?.id ?? "")));
    r.onGuarded("petHatch", (c, m: PetHatchMsg) => this.hatch(c.sessionId, Number(m?.uid)));
    r.onGuarded("petCommand", (c, m: PetCommandMsg) => this.menu(c.sessionId, m?.op));
    r.onGuarded("petRename", (c, m: PetRenameMsg) => this.rename(c.sessionId, String(m?.name ?? "")));
    r.onGuarded("petAutoFeed", (c, m: PetAutoFeedMsg) => this.autoFeed(c.sessionId, !!m?.on));
    if (process.env.NODE_ENV === "production") return;
    // DEV ONLY (pets bot): plant hunger / intimacy, give items, make the next catch succeed
    r.onMessage(Msg.devPet, (c: Client, m: { op: string; value?: number; itemId?: number; amount?: number }) => {
      const sid = c.sessionId, o = this.owners.get(sid), u = o?.out, inv = this.inv(sid);
      switch (m?.op) {
        case "breath": this.devBreath.add(sid); return; // 2.4.0 legendary pets: the next swings are all fire breaths (legend bot)
        case "hunger": case "intimacy":
          if (!u) return;
          if (m.op === "hunger") u.row.hunger = Math.max(0, Math.min(100, Number(m.value)));
          else u.row.intimacy = Math.max(1, Math.min(1000, Number(m.value)));
          this.changed(sid, u);
          return;
        case "starve": // the next pet_hungry runs now
          if (u) { for (const t of u.timers.splice(0)) t.clear(); this.startTimers(sid, u, 0); }
          return;
        case "give": {
          const it = ITEMS.get(Number(m.itemId));
          if (!it || !inv) return;
          inv.add(it.id, Math.max(1, Number(m.amount ?? 1)));
          const p = r.state.players.get(sid);
          if (p) r.sendInv(c, p);
          return;
        }
        case "catch": this.devCatch.add(sid); return;
        case "floor": { // one floor item 3 cells from the owner; value = 0: free for all, else loot priority held by another character
          const p = r.state.players.get(sid), it = ITEMS.get(Number(m.itemId));
          if (!p || !it) return;
          const c = r.cell(p), at = [[3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy })).find((q) => walkable(r.map, q.x, q.y)) ?? c;
          const now = r.clock.currentTime, foreign = Number(m.value) > 0;
          r.addFloorItem(it.id, 1, at, null, { first: foreign ? 999_999_999 : 0, second: 0, third: 0, firstTick: now + 3000, secondTick: now + 5000, thirdTick: now + 7000 });
          return;
        }
        case "ownerHp": { // the owner's HP as a percentage (support pet check)
          const p = r.state.players.get(sid);
          if (p && !p.dead) { p.hp = Math.max(1, Math.trunc((p.maxHp * Number(m.value)) / 100)); r.flushStatus(sid); }
          return;
        }
      }
    });
  }

  // ---------- map entry / exit ----------
  /** Map entry (before the player joins the state): every pet row of the character. */
  async load(sid: string, charId: number) {
    const { rows } = await db.query("SELECT * FROM pet WHERE char_id = $1", [charId]);
    const pets = new Map<number, PetRow>();
    for (const x of rows) {
      pets.set(Number(x.id), { id: Number(x.id), charId, mobId: x.mob_id, name: x.name, renamed: x.renamed, level: x.level, hunger: x.hunger,
        intimacy: x.intimacy, equip: x.equip, autoFeed: x.autofeed, incubate: x.incubate });
    }
    this.owners.set(sid, { charId, pets });
  }
  /** After the player is in the state: the pet that was out comes out again (rAthena keeps sd->status.pet_id across relogs and
   *  maps: pet_load at LoadEndAck), and the client gets its pet info + eggs. */
  enter(sid: string) {
    const o = this.owners.get(sid);
    if (!o) return;
    const out = [...o.pets.values()].find((r) => !r.incubate && PET_DB.has(r.mobId));
    if (out) this.spawn(sid, o, out);
    else this.sendInfo(sid);
  }
  /** map_quit / a map change: the pet leaves with its master (unit_free), its row saved; it stays "out" for the next map. */
  leave(sid: string) {
    const o = this.owners.get(sid);
    if (!o) return;
    if (o.out) { this.save(sid, o.out.row); this.despawn(o); }
    this.owners.delete(sid);
    this.devCatch.delete(sid); this.devBreath.delete(sid);
  }

  private spawn(sid: string, o: Owner, row: PetRow) {
    const p = this.room.state.players.get(sid), db = PET_DB.get(row.mobId), def = MOB_BY_ID.get(row.mobId);
    if (!p || !db || !def) return;
    const c = this.freeCellNear(this.room.cell(p));
    const key = `pet${row.id}`;
    this.room.state.pets.set(key, new Pet({ mobId: row.mobId, owner: sid, name: row.name, x: c.x, y: c.y, dir: p.dir, moving: false,
      hungry: row.hunger <= PET_HUNGER.HUNGRY, accessory: row.equip }));
    const u: PetUnit = { key, owner: sid, row, db, status: mobStatus(def), path: [], pos: 0, stepMs: 0, token: 0, speedMs: 150,
      lootAt: 0, nextAttack: 0, thinkAt: 0, canMoveAt: 0, timers: [] };
    o.out = u;
    this.startTimers(sid, u);
    this.sendInfo(sid);
    this.refresh(sid);
  }
  private despawn(o: Owner) {
    const u = o.out;
    if (!u) return;
    for (const t of u.timers) t.clear();
    u.token++;
    this.room.state.pets.delete(u.key);
    o.out = undefined;
  }

  private freeCellNear(c: Cell): Cell {
    for (const [dx, dy] of [[0, 1], [-1, 1], [1, 1], [-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1], [0, 2], [2, 0], [-2, 0], [0, -2]]) {
      if (walkable(this.room.map, c.x + dx, c.y + dy)) return { x: c.x + dx, y: c.y + dy };
    }
    return c;
  }

  // ---------- owner messages ----------
  sendInfo(sid: string) {
    const u = this.owners.get(sid)?.out;
    this.send(sid, Msg.petInfo, { pet: u ? petInfo(u.row, u.db) : null } satisfies PetInfoEvent);
  }
  /** ZC_PETEGG_LIST: the eggs that can hatch now (none while a pet is out). */
  sendEggs(sid: string) {
    const o = this.owners.get(sid), inv = this.inv(sid);
    if (!o || !inv) return;
    const uids = o.out ? [] : inv.rows().filter((s) => s.petId !== undefined && o.pets.has(s.petId)).map((s) => s.uid);
    this.send(sid, Msg.petEggs, { uids } satisfies PetEggsEvent);
  }
  private sendInv(sid: string) {
    const c = this.client(sid), p = this.room.state.players.get(sid);
    if (c && p) this.room.sendInv(c, p);
  }
  /** status_calc_pc after the pet came out / went in / changed tier. */
  private refresh(sid: string) {
    const p = this.room.state.players.get(sid);
    if (p && this.room.brains.has(sid)) this.room.refreshStatus(sid, p);
  }
  /** clif_send_petdata(HUNGER / INTIMACY) + the synced hungry flag. */
  private changed(sid: string, u: PetUnit) {
    const s = this.room.state.pets.get(u.key);
    if (s) s.hungry = u.row.hunger <= PET_HUNGER.HUNGRY;
    this.save(sid, u.row);
    this.sendInfo(sid);
    this.refresh(sid);
  }

  /** status_calc_pc "Pet Bonus": the pet_db Script of the pet that is out, for its intimacy tier (pet.ts petBonuses). */
  bonus(sid: string, equip: EquipBonus | undefined) {
    const u = this.owners.get(sid)?.out;
    if (!u || !equip) return;
    for (const b of petBonuses(u.db, u.row.intimacy, u.row.hunger)) scriptBonus(equip, b, "none");
    if (u.skillBonus && this.room.clock.currentTime < u.skillBonus.until) scriptBonus(equip, u.skillBonus.bonus, "none");
  }

  // ---------- items ----------
  /** pc_useitem for the pet items: a taming item starts the catch, an egg hatches, the pet's accessory is put on it. True = handled. */
  useItem(sid: string, uid: number, itemId: number): boolean {
    const o = this.owners.get(sid);
    if (!o) return false;
    if (PET_BY_TAME.has(itemId)) { // item script `pet <mob>` -> pet_catch_process_start -> clif_catch_process
      o.catchItem = itemId; o.catchUid = uid;
      this.send(sid, Msg.petCatchStart, { itemId } satisfies PetCatchStartEvent);
      return true;
    }
    if (PET_BY_EGG.has(itemId)) { this.hatch(sid, uid); return true; }
    const acc = PET_BY_EQUIP.get(itemId);
    if (acc && o.out && o.out.db.equipItem === itemId) { this.equip(sid, uid); return true; }
    return false;
  }

  /** buildin_getitem on an egg item -> pet_create_egg: a new pet row (the egg arrives once its row exists, like pet_get_egg). */
  makeEgg(sid: string, eggItem: number): boolean {
    const dbr = PET_BY_EGG.get(eggItem), o = this.owners.get(sid), inv = this.inv(sid), p = this.room.state.players.get(sid);
    if (!dbr || !o || !inv || !p) return false;
    if (inv.canAdd(ITEMS.get(eggItem)!, 1, p.job as JobKey, p.str)) return false; // pc_inventoryblank
    void this.createPet(sid, o, dbr);
    return true;
  }
  private async createPet(sid: string, o: Owner, dbr: PetDb) {
    const def = MOB_BY_ID.get(dbr.mobId)!, n = newPet(dbr, def.level, def.name), inv = this.inv(sid);
    if (!inv) return;
    // intif_create_pet -> mapif_pet_created: the row on the owner's chain, then the egg (pet_get_egg)
    const res = await inv.persist("INSERT INTO pet (char_id, mob_id, name, level, hunger, intimacy) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [o.charId, n.mobId, n.name, n.level, n.hunger, n.intimacy]) as { rows: { id: number }[] };
    const id = Number(res.rows[0].id);
    if (this.owners.get(sid) !== o) return; // left meanwhile: the egg row is lost with the session (the pet row stays)
    o.pets.set(id, { id, charId: o.charId, ...n });
    inv.addEgg(dbr.eggItem, id);
    this.send(sid, Msg.itemGet, { itemId: dbr.eggItem, amount: 1 });
    this.sendInv(sid);
  }

  /** pet_catch_process_end: the monster picked with the catch cursor. The taming item goes on the attempt, success or not. */
  catchEnd(sid: string, monId: string) {
    const o = this.owners.get(sid), inv = this.inv(sid), p = this.room.state.players.get(sid);
    if (!o || !inv || !p) return;
    const item = o.catchItem, uid = o.catchUid;
    o.catchItem = o.catchUid = undefined;
    const result = (ok: boolean, mobId: number) => this.room.sendArea("AREA", sid, Msg.petCatchResult, { ok, mobId } satisfies PetCatchResultEvent);
    const mon = this.room.state.monsters.get(monId);
    if (!item || uid === undefined || !mon || mon.dead) { if (item) result(false, mon?.mobId ?? 0); return; } // no process / bad target
    const st = inv.items.get(uid);
    if (!st || st.itemId !== item) return result(false, mon.mobId);
    const dbr = PET_DB.get(mon.mobId), a = this.room.cell(p), b = this.room.cell(mon);
    const egg = dbr ? ITEMS.get(dbr.eggItem) : undefined;
    const why = catchBlock({ tameItem: item, db: dbr, distance: distance(a.x - b.x, a.y - b.y), bagFull: !egg || !!inv.canAdd(egg, 1, p.job as JobKey, p.str) });
    if (why) { this.notice(sid, why); return result(false, mon.mobId); }
    inv.remove(uid, 1);
    this.sendInv(sid);
    const rate = catchRate(dbr!.captureRate, mon.hp, mon.maxHp);
    const ok = this.devCatch.delete(sid) || Math.floor(rnd() * 10000) < rate; // rnd_chance(rate, 10000)
    result(ok, mon.mobId);
    if (!ok) { this.notice(sid, "Taming failed."); return; }
    this.removeCaught(monId);
    void this.createPet(sid, o, dbr!);
  }
  /** unit_remove_map + status_kill on the caught monster: gone without EXP or drops; its spawn line respawns it as usual. */
  private removeCaught(id: string) {
    const r = this.room, mon = r.state.monsters.get(id), b = r.brains.get(id);
    if (!mon || !b) return;
    mon.dead = true;
    r.status.died(id);
    r.haltWalk(mon, r.walkOf(b, mon));
    for (const x of r.brains.values()) if (x.target === id) x.target = undefined;
    r.sendArea("AREA", id, Msg.die, { id });
    const slot = r.mobSpawns.get(id);
    r.clock.setTimeout(() => {
      r.state.monsters.delete(id); r.brains.delete(id);
      if (slot) r.spawnMonster(id);
    }, slot ? respawnDelay(slot.sd, MOB_BY_ID.get(mon.mobId)!.mode, Math.floor(Math.random() * 0x80000000)) : 1000);
  }

  /** pet_select_egg -> pet_birth_process: only with no pet out; the egg leaves the bag while the pet is out. */
  hatch(sid: string, uid: number) {
    const o = this.owners.get(sid), inv = this.inv(sid), st = inv?.items.get(uid);
    if (!o || !inv || !st || !PET_BY_EGG.has(st.itemId)) return;
    if (o.out) return this.notice(sid, "You already have a pet out.");
    const row = st.petId !== undefined ? o.pets.get(st.petId) : undefined;
    if (!row || !PET_DB.has(row.mobId)) return this.notice(sid, "This egg is empty.");
    inv.remove(uid, 1);
    row.incubate = false;
    this.save(sid, row);
    this.spawn(sid, o, row);
    this.sendInv(sid);
  }

  /** pet_return_egg: the egg comes back with the same pet (same row, same intimacy / hunger). */
  returnEgg(sid: string) {
    const o = this.owners.get(sid), u = o?.out, inv = this.inv(sid), p = this.room.state.players.get(sid);
    if (!o || !u || !inv || !p) return;
    const egg = ITEMS.get(u.db.eggItem);
    if (!egg) return;
    const why = inv.canAdd(egg, 1, p.job as JobKey, p.str);
    if (why) return this.notice(sid, `Can't return the pet: ${why}.`);
    u.row.incubate = true;
    this.save(sid, u.row);
    inv.addEgg(egg.id, u.row.id);
    this.despawn(o);
    this.sendInfo(sid);
    this.refresh(sid);
    this.sendInv(sid);
  }

  // ---------- pet menu (pet_menu) ----------
  menu(sid: string, op: PetCommandMsg["op"] | undefined) {
    const u = this.owners.get(sid)?.out;
    // clif_send_petstatus (also with no pet: null); with no pet out the egg list follows (our stand-in for using an incubator:
    // ZC_PETEGG_LIST is only sent on request, the client opens its egg window when it arrives)
    if (op === "info") { this.sendInfo(sid); if (!u) this.sendEggs(sid); return; }
    if (!u || u.row.intimacy <= 0) return;
    switch (op) {
      case "feed": return void this.food(sid, u);
      case "perform": return this.perform(u);
      case "return": return this.returnEgg(sid);
      case "unequip": return this.unequip(sid, u);
    }
  }
  /** pet_food. False = no food in the bag. */
  private food(sid: string, u: PetUnit): boolean {
    const inv = this.inv(sid), st = inv?.rows().find((s) => s.itemId === u.db.foodItem && !s.equip);
    if (!inv || !st) {
      this.notice(sid, `You have no ${ITEMS.get(u.db.foodItem)?.name ?? "pet food"}.`); // clif_pet_food(fail)
      return false;
    }
    inv.remove(st.uid, 1);
    const f = feed(u.row, u.db);
    u.row.hunger = f.hunger; u.row.intimacy = f.intimacy;
    this.sendInv(sid);
    if (u.row.intimacy <= 0) { this.runAway(sid); return true; }
    this.emote(u, f.overfed ? ET.ANGER : ET.DELIGHT); // the pet's mood as an emotion over it: an over-fed pet sulks
    this.changed(sid, u);
    return true;
  }
  /** pet_performance: stops 2 s and dances (CHANGESTATEPET_PERFORMANCE), nothing consumed. */
  private perform(u: PetUnit) {
    this.stop(u);
    u.canMoveAt = this.room.clock.currentTime + 2000;
    // the performance number (1-4, pet.ts performance) as the emotion the client shows over the pet; 4 = the loyal special one
    this.emote(u, [ET.DELIGHT, ET.THROB, ET.LUV, ET.BEST][performance(u.row.intimacy, u.db.specialPerformance) - 1]);
  }
  private emote(u: PetUnit, emote: number) {
    this.room.sendArea("AREA", u.owner, Msg.petEmote, { id: u.key, emote } satisfies PetEmoteEvent);
  }
  /** pet_change_name: once (pet_rename: no). */
  rename(sid: string, name: string) {
    const u = this.owners.get(sid)?.out;
    if (!u) return;
    if (u.row.renamed) return this.notice(sid, "Your pet has already been named.");
    const n = validPetName(name);
    if (!n) return this.notice(sid, "That name can't be used.");
    u.row.name = n; u.row.renamed = true;
    const s = this.room.state.pets.get(u.key);
    if (s) s.name = n;
    this.changed(sid, u);
  }
  autoFeed(sid: string, on: boolean) {
    const u = this.owners.get(sid)?.out;
    if (!u) return;
    if (!u.db.allowAutoFeed) return this.notice(sid, "This pet can't be fed automatically.");
    u.row.autoFeed = on;
    this.changed(sid, u);
  }
  /** pet_equipitem: the accessory item goes onto the pet. */
  private equip(sid: string, uid: number) {
    const u = this.owners.get(sid)?.out, inv = this.inv(sid);
    if (!u || !inv || u.row.equip) return;
    if (!inv.remove(uid, 1)) return;
    u.row.equip = u.db.equipItem;
    const s = this.room.state.pets.get(u.key);
    if (s) s.accessory = u.row.equip;
    this.sendInv(sid);
    this.changed(sid, u);
  }
  /** pet_unequipitem: the accessory comes back to the bag. */
  private unequip(sid: string, u: PetUnit) {
    const inv = this.inv(sid), p = this.room.state.players.get(sid), it = ITEMS.get(u.row.equip);
    if (!inv || !p || !it) return;
    if (inv.canAdd(it, 1, p.job as JobKey, p.str)) return this.notice(sid, "Your bag is full.");
    inv.add(it.id, 1);
    u.row.equip = 0;
    const s = this.room.state.pets.get(u.key);
    if (s) s.accessory = 0;
    this.sendInv(sid);
    this.changed(sid, u);
  }

  // ---------- timers ----------
  private startTimers(sid: string, u: PetUnit, firstHunger = u.db.hungryDelay) {
    const clock = this.room.clock;
    const hungry = () => { // pet_hungry
      if (this.owners.get(sid)?.out !== u) return;
      const h = hungerTick(u.row, u.db);
      u.row.hunger = h.hunger; u.row.intimacy = h.intimacy;
      if (h.starving) this.unlock(u);
      if (u.row.intimacy <= 0) return this.runAway(sid);
      if (u.row.hunger <= PET_HUNGER.VERY_HUNGRY) this.emote(u, ET.HUNGRY); // a starving pet complains (the client also reads `hungry`)
      this.changed(sid, u);
      if (autoFeedDue(u.row, u.db)) this.food(sid, u);
      u.timers.push(clock.setTimeout(hungry, h.interval));
    };
    u.timers.push(clock.setTimeout(hungry, firstHunger));
    for (const s of u.db.support) {
      const run = () => {
        if (this.owners.get(sid)?.out !== u) return;
        u.timers.push(clock.setTimeout(run, this.support(sid, u, s)));
      };
      u.timers.push(clock.setTimeout(run, s.delay * 1000));
    }
  }

  /** pet_heal_timer / pet_skill_support_timer / pet_skill_bonus_timer: returns the delay to the next try (rAthena gates the
   *  SupportScript on pet_status_support; every support pet of ours runs it). */
  private support(sid: string, u: PetUnit, s: PetSupport): number {
    const p = this.room.state.players.get(sid);
    if (!p) return 1000;
    const ready = supportReady(s, { dead: p.dead, hp: p.hp, maxHp: p.maxHp, sp: p.sp, maxSp: p.maxSp });
    if (!ready.ok) return ready.waitMs;
    if (u.row.hunger <= 0) return s.delay * 1000; // a starving pet doesn't help (our tie-in); rAthena's timers check no intimacy
    this.unlock(u);
    this.stop(u);
    const sk = s.type === "skill" ? [...SKILLS.values()].find((k) => k.id === s.skill || k.key === s.skill) : undefined;
    if (s.type === "heal" || sk?.key === "AL_HEAL") { // status_heal(sd, lv, 0) / unit_skilluse_id(pd, master, AL_HEAL) + clif_skill_nodamage
      const def = MOB_BY_ID.get(u.row.mobId)!;
      const amount = s.type === "heal" ? s.amount : petHealAmount(u.row.level, def.int, s.type === "skill" ? s.lv : 1);
      const hp = Math.min(p.maxHp - p.hp, amount);
      p.hp += hp;
      this.room.sendArea("AREA_WOS", sid, Msg.heal, { id: sid, itemId: 0 } satisfies HealEvent);
      this.send(sid, Msg.heal, { id: sid, itemId: 0, hp } satisfies HealEvent);
      this.room.flushStatus(sid);
    } else if (sk && s.type === "skill") {
      this.room.status.skillStatus(sid, sid, sk, s.lv); // unit_skilluse_id(pd, master, skill, lv): Blessing / Increase AGI ...
    } else if (s.type === "bonus") { // pet_skill_bonus_timer: the bonus for `duration` s, then status_calc_pc again
      u.skillBonus = { bonus: s.bonus, until: this.room.clock.currentTime + s.duration * 1000 };
      this.refresh(sid);
      u.timers.push(this.room.clock.setTimeout(() => { if (this.owners.get(sid)?.out === u) this.refresh(sid); }, s.duration * 1000 + 10));
      return (s.delay + s.duration) * 1000;
    }
    this.emote(u, ET.OK);
    return s.delay * 1000;
  }

  /** pet_hungry / pet_food at intimacy 0: the pet runs away for good (owner's decision 2026-10-24): unit gone, row and egg deleted. */
  private runAway(sid: string) {
    const o = this.owners.get(sid), u = o?.out;
    if (!o || !u) return;
    this.emote(u, ET.CRY);
    this.despawn(o);
    o.pets.delete(u.row.id);
    this.persist(sid, "DELETE FROM pet WHERE id = $1", [u.row.id]);
    this.notice(sid, `${u.row.name} ran away. Pets need food to stay with you.`);
    this.sendInfo(sid);
    this.refresh(sid);
  }

  /** pc_dead: the pet loses IntimacyOwnerDie and drops its target. */
  ownerDied(sid: string) {
    const u = this.owners.get(sid)?.out;
    if (!u) return;
    u.row.intimacy = ownerDied(u.row.intimacy, u.db);
    this.unlock(u);
    if (u.row.intimacy <= 0) return this.runAway(sid);
    this.changed(sid, u);
  }

  // ---------- battle support (battle_weapon_attack -> pet_target_check) ----------
  /** A normal attack between `src` and `tgt`: a master hitting a monster may send its battle pet at it (type 0, AttackRate); a
   *  master hit by a monster may make it retaliate (type 1, RetaliateRate). */
  weaponAttack(src: string, tgt: string) {
    const r = this.room;
    if (r.state.players.has(src) && r.state.monsters.has(tgt)) this.targetCheck(src, tgt, false);
    else if (r.state.monsters.has(src) && r.state.players.has(tgt)) this.targetCheck(tgt, src, true);
  }
  private targetCheck(sid: string, monId: string, retaliate: boolean) {
    const u = this.owners.get(sid)?.out, mon = this.room.state.monsters.get(monId), p = this.room.state.players.get(sid);
    if (!u || !mon || mon.dead || !p || u.db.kind !== "battle") return;
    const pc = this.room.state.pets.get(u.key)!, a = { x: pc.x, y: pc.y }, b = this.room.cell(mon);
    if (distance(a.x - b.x, a.y - b.y) > (MOB_BY_ID.get(u.row.mobId)?.skillRange ?? 9)) return; // check_distance_bl(range2)
    const rate = supportRate(u.db, u.row, { retaliate, targetMobId: mon.mobId, masterDead: p.dead });
    if (Math.floor(rnd() * 10000) < rate && (!u.target || Math.floor(rnd() * 10000) < u.db.changeTargetRate)) u.target = monId;
  }
  /** pet_unlocktarget */
  private unlock(u: PetUnit) { u.target = undefined; }

  // ---------- AI + walking (pet_ai_sub_hard) ----------
  tick(now: number) {
    for (const [sid, o] of this.owners) {
      const u = o.out, p = this.room.state.players.get(sid), s = u && this.room.state.pets.get(u.key);
      if (!u || !p || !s) continue;
      this.drawOffset(u, s, now);
      if (now < u.thinkAt) continue;
      u.thinkAt = now + PET_CONF.think_ms;
      this.think(sid, u, s, p, now);
      if (u.db.kind === "companion" && now >= u.lootAt) { u.lootAt = now + LOOT_EVERY_MS; this.petLoot(sid, p); }
    }
  }
  private think(sid: string, u: PetUnit, s: Pet, p: { x: number; y: number; dir: number; dead: boolean }, now: number) {
    const r = this.room, me = { x: s.x, y: s.y }, master = r.cell(p), d = distance(me.x - master.x, me.y - master.y);
    const ownerB = r.brains.get(sid);
    if (d > LEASH) { // the master warped / ran out of sight: the pet is put beside it (pc_setpos moves the pet along)
      this.stop(u); this.unlock(u);
      const c = this.freeCellNear(master);
      s.x = c.x; s.y = c.y;
      return;
    }
    const def = MOB_BY_ID.get(u.row.mobId)!;
    const range3 = def.chaseRange || 12;
    if (d > range3) { // master too far: chase it at double speed (status.speed = master speed / 2)
      this.unlock(u);
      this.walkTo(u, s, master, Math.max(1, Math.trunc((ownerB?.status.walkMs ?? 150) / 2)), now, 3);
      return;
    }
    u.speedMs = ownerB?.status.walkMs ?? 150; // pet_walk_speed 1: the master's speed
    let tgt = u.target ? r.state.monsters.get(u.target) : undefined;
    if (u.target && (!tgt || tgt.dead || distance(tgt.x - me.x, tgt.y - me.y) > range3 || p.dead)) { this.unlock(u); tgt = undefined; }
    if (!tgt) {
      if (d <= PET_CONF.follow_range) return; // already next to master
      if (u.stepAt !== undefined && u.to && distance(u.to.x - master.x, u.to.y - master.y) <= PET_CONF.follow_range) return;
      const back = this.behind(master, p.dir);
      this.walkTo(u, s, back, u.speedMs, now, 0) || this.walkTo(u, s, master, u.speedMs, now, 1);
      return;
    }
    const tc = r.cell(tgt), range = Math.max(1, def.range);
    if (!battleCheckRange(r.map, me, tc, range)) { // chase
      if (!(u.stepAt !== undefined && u.to && distance(u.to.x - tc.x, u.to.y - tc.y) <= range)) {
        if (!this.walkTo(u, s, tc, u.speedMs, now, range)) this.unlock(u);
      }
      return;
    }
    this.stop(u);
    s.dir = dirFromDelta(Math.sign(tc.x - me.x), Math.sign(tc.y - me.y));
    if (now >= u.nextAttack) this.attack(sid, u, s, u.target!, now);
  }
  /** petloot (companion pets; rAthena's pet_db Loot support): every second the pet gathers ONE floor item the owner may already take
   *  (loot-priority window over) within LOOT_RANGE cells of the owner and hands it over at once. Our simplification: the pet doesn't
   *  walk to the item and carries nothing (rAthena keeps a bag of up to PETLOOT_MAX and returns it on a timer). */
  private petLoot(sid: string, p: Player) {
    const r = this.room, b = r.brains.get(sid), client = this.client(sid);
    if (!b?.inv || !client || p.dead) return;
    const c = r.cell(p), now = r.clock.currentTime;
    for (const [id, f] of r.state.floor) {
      if (distance(f.x - c.x, f.y - c.y) > LOOT_RANGE) continue;
      const fb = r.brains.get(id);
      if (!fb || (fb.floorLoot && now < takeItemTick(fb.floorLoot, b.inv.charId))) continue;
      const n = r.state.floor.size;
      r.pickup(id, p, b, client, LOOT_RANGE, true);
      if (r.state.floor.size < n) return;
    }
  }
  /** unit_calc_pos: a cell behind the master (opposite its facing), else beside it. */
  private behind(c: Cell, dir: number): Cell {
    const DX = [0, -1, -1, -1, 0, 1, 1, 1], DY = [1, 1, 0, -1, -1, -1, 0, 1]; // dirFromDelta order: 0 = south (+y) clockwise
    const bx = c.x - 2 * DX[dir & 7], by = c.y - 2 * DY[dir & 7];
    return walkable(this.room.map, bx, by) ? { x: bx, y: by } : this.freeCellNear(c);
  }
  /** One swing of a battle pet: HitEvent from the pet's key; the hit lands for its master (mob_log_damage BL_PET -> the master's
   *  char_id; mob_dead with a pet src rewards sd = the pet's master), so the kill's EXP, drops and quest credit are the owner's. */
  private attack(sid: string, u: PetUnit, s: Pet, monId: string, now: number) {
    const r = this.room, ob = r.brains.get(sid), tb = r.brains.get(monId), mon = r.state.monsters.get(monId);
    if (!ob || !tb || !mon) return;
    u.nextAttack = now + u.status.attackDelayMs;
    const t = { type: BL.MOB, targeted: r.targetedCount(monId) };
    if (u.db.rarity === "legendary" && this.breath(sid, u, monId, now)) return; // unit_attack_timer_sub: pet_attackskill first
    const res = mobAttack(u.status, tb.status, t);
    const own = playerAttack(ob.status, ob.weapon ?? FISTS, tb.status, t);
    const ownDmg = own.miss ? Math.max(own.dmg, 1) : own.dmg;
    const dmg = res.miss || res.lucky ? 0 : u.db.rarity === "legendary" ? legendaryHitDamage(res.dmg, this.ownerSwing(ob, tb.status, monId)) : petHitDamage(res.dmg, ownDmg, u.row.level);
    const def = MOB_BY_ID.get(u.row.mobId)!, tdef = MOB_BY_ID.get(mon.mobId)!;
    r.sendArea("AREA", monId, Msg.hit, { from: u.key, to: monId, dmg, crit: false, miss: dmg <= 0, lucky: res.lucky,
      amotion: def.attackMotion, dmotion: dmg > 0 ? tdef.damageMotion : 0 } satisfies HitEvent);
    if (dmg <= 0) return;
    const delay = damageDelay(def.attackMotion, BL.MOB);
    r.timeline.add(now + Math.max(1, delay), (at) => {
      const m2 = r.state.monsters.get(monId);
      if (m2 !== mon || mon.dead || !r.state.players.has(sid) || this.owners.get(sid)?.out !== u) return;
      r.applyDamage(sid, monId, dmg, at, res.dmgLv);
    });
  }

  /** pet_attackskill for a legendary pet (2.4.0): its petskillattack (the dragon's fire breath, MG_FIREBALL) replaces this swing with
   *  chance rate + intimacy * bonusrate / 1000 % (breathChance). Ground splash like the skill (SplashArea around the target, every
   *  live monster in it); each target takes breathDamage of the owner's swing on IT, through the Fire row of the element table
   *  (attr_fix), credited to the owner like the pet's normal hit. The client sees Msg.skillUse from the pet + one skill Msg.hit per
   *  target (clif_skill_damage). True = the breath went off. */
  private breath(sid: string, u: PetUnit, monId: string, now: number): boolean {
    const a = u.db.attacks[0], r = this.room, ob = r.brains.get(sid), mon = r.state.monsters.get(monId), sk = a && SKILLS.get(a.skill);
    if (!a || !sk || !ob || !mon || mon.dead) return false;
    if (Math.floor(rnd() * 100) >= (this.devBreath.has(sid) ? 100 : breathChance(a, u.row.intimacy))) return false;
    const c = r.cell(mon), splash = Math.max(1, skillLv(sk.splash, a.lv) || 1), def = MOB_BY_ID.get(u.row.mobId)!;
    r.sendArea("AREA", monId, Msg.skillUse, { src: u.key, id: a.skill, lv: a.lv, target: monId, x: c.x, y: c.y } satisfies SkillUseEvent);
    const delay = damageDelay(def.attackMotion, BL.MOB);
    for (const [id, m] of r.state.monsters) {
      const tb = r.brains.get(id), tdef = MOB_BY_ID.get(m.mobId), mc = r.cell(m);
      if (m.dead || !tb || !tdef || !inSplash(c.x, c.y, splash, mc.x, mc.y)) continue;
      const dmg = attrFix(breathDamage(this.ownerSwing(ob, tb.status, id), def.matk), LEGENDARY_PET.breathElement, tdef.element as Element, tdef.elementLevel);
      r.sendArea("AREA", id, Msg.hit, { from: u.key, to: id, dmg, crit: false, miss: dmg <= 0, lucky: false, amotion: def.attackMotion,
        dmotion: dmg > 0 ? tdef.damageMotion : 0, skill: a.skill, div: 1 } satisfies HitEvent);
      if (dmg <= 0) continue;
      r.timeline.add(now + Math.max(1, delay), (at) => {
        if (r.state.monsters.get(id) !== m || m.dead || !r.state.players.has(sid) || this.owners.get(sid)?.out !== u) return;
        r.applyDamage(sid, id, dmg, at, ATK.DEF);
      });
    }
    return true;
  }
  /** The owner's swing on this target as the legendary share's base: its damage roll with the hit roll left out (the target can't
   *  flee or lucky-dodge it), so an owner's miss never shrinks the pet's hit to the floor; the pet's own attack still rolls to hit. */
  private ownerSwing(ob: { status: Parameters<typeof playerAttack>[0]; weapon?: Parameters<typeof playerAttack>[1] }, def: Parameters<typeof playerAttack>[2], id: string): number {
    const own = playerAttack(ob.status, ob.weapon ?? FISTS, { ...def, noFlee: true, flee2: 0 }, { type: BL.MOB, targeted: this.room.targetedCount(id) });
    return Math.max(own.dmg, 1);
  }
  /** DEV ONLY (legendary pets bot, devPet op "breath"): sessions whose legendary pet breathes on every swing */
  private devBreath = new Set<string>();

  private stop(u: PetUnit) {
    const s = this.room.state.pets.get(u.key);
    u.stepAt = undefined; u.token++; u.path = []; u.pos = 0; u.to = undefined;
    if (s) { s.moving = false; s.sx = 0; s.sy = 0; }
  }
  /** unit_walktoxy / unit_walktobl(range): a path to `to` (stopping `range` cells short), stepped on the room timeline. */
  private walkTo(u: PetUnit, s: Pet, to: Cell, speedMs: number, now: number, range: number): boolean {
    if (now < u.canMoveAt) return true;
    // a step in progress finishes first: the new path starts from the cell it enters (change_walk_target)
    const stepping = u.stepAt !== undefined && u.pos < u.path.length, cur = stepping ? u.path[u.pos] : { x: s.x, y: s.y };
    let path = walkSubPath(this.room.map, cur, to);
    if (!path) return false;
    if (range > 0) { // unit_walktobl: stop as soon as the target is within range
      const i = path.findIndex((c) => distance(c.x - to.x, c.y - to.y) <= range);
      if (i >= 0) path = path.slice(0, i + 1);
    }
    u.speedMs = speedMs;
    if (stepping) { u.path = [cur, ...path]; u.pos = 0; u.to = u.path[u.path.length - 1]; return true; }
    if (!path.length) return true;
    u.path = path; u.pos = 0; u.to = path[path.length - 1];
    this.nextStep(u, s, now);
    return true;
  }
  private nextStep(u: PetUnit, s: Pet, at: number) {
    if (u.pos >= u.path.length) { u.stepAt = undefined; s.moving = false; s.sx = 0; s.sy = 0; return; }
    const next = u.path[u.pos], ms = stepTime(u.speedMs, s, next), token = ++u.token;
    u.stepAt = at + ms; u.stepMs = ms;
    s.dir = dirFromDelta(Math.sign(next.x - s.x), Math.sign(next.y - s.y));
    s.moving = true;
    this.room.timeline.add(at + ms, (t) => {
      if (u.token !== token || this.room.state.pets.get(u.key) !== s) return;
      if (walkable(this.room.map, next.x, next.y)) { s.x = next.x; s.y = next.y; }
      u.pos++;
      this.nextStep(u, s, t);
    });
  }
  private drawOffset(u: PetUnit, s: Pet, now: number) {
    let sx = 0, sy = 0;
    if (u.stepAt !== undefined && u.pos < u.path.length) {
      const next = u.path[u.pos], k = Math.round(Math.min(1, Math.max(0, 1 - (u.stepAt - now) / u.stepMs)) * 16) / 16;
      sx = (next.x - s.x) * k; sy = (next.y - s.y) * k;
    }
    if (s.sx !== sx) s.sx = sx;
    if (s.sy !== sy) s.sy = sy;
  }
}
