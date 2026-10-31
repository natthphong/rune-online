// Quest log rules, re-implemented from rAthena src/map/quest.cpp (behaviour, not code):
//   QuestDatabase::parseBodyNode  quest_db.yml rows -> s_quest_db (Targets max MAX_QUEST_OBJECTIVES, filters, Drops)
//   split_exact_quest_time / solve_time (common/timer.cpp)  TimeLimit "+1d2h" (relative) or "4h" / "Monday 4h" (fixed)
//   quest_time        expiry of a newly added quest
//   quest_add / quest_change / quest_delete / quest_update_status   the log (active+inactive first, completed at the end)
//   quest_update_objective   kill credit for every non-complete quest + the quest-only Drops while it is held
//   quest_check       HAVEQUEST / PLAYTIME / HUNTING (incl. their quirks with time 0, see the tests)
//   intif_parse_questlog     load order (non-complete first in DB order, completed from the end backwards)
// Quests are our own content (shared/content/quest_db.ts) in the quest_db.yml shape, with OUR monster / item names.
// Pure: no I/O; the server (server/src/quests.ts) persists, the client only renders.
import { MOB_BY_ID, type Mob } from "./data.ts";
import { ITEMS, type Rng } from "./items.ts";
import { isStackable } from "./shop.ts";

/** MAX_QUEST_OBJECTIVES (common/mmo.hpp:111): kill counters per quest log entry (quest table count1..count3). */
export const MAX_QUEST_OBJECTIVES = 3;
/** e_quest_state (common/mmo.hpp:279). */
export const Q_INACTIVE = 0, Q_ACTIVE = 1, Q_COMPLETE = 2;
export type QuestState = typeof Q_INACTIVE | typeof Q_ACTIVE | typeof Q_COMPLETE;
/** e_quest_check_type (quest.hpp): the second argument of checkquest(). */
export type QuestCheckType = "HAVEQUEST" | "PLAYTIME" | "HUNTING";

// ---------- quest_db ----------

/** One Targets entry of quest_db.yml. `Mob` = our monster name (shared/data/mobs.json); without Mob, `Id` + filters. */
export type QuestDbTarget = {
  Mob?: string; Id?: number; Count?: number;
  MinLevel?: number; MaxLevel?: number; Race?: string; Size?: string; Element?: string;
  Location?: string; MapName?: string; MapMobTargets?: Record<string, boolean>;
};
/** One Drops entry: `Mob` omitted = every monster; Rate per 10000. */
export type QuestDbDrop = { Mob?: string; Item: string | number; Count?: number; Rate: number };
/** A quest_db.yml row (rAthena field names). */
export type QuestDbRow = { Id: number; Title: string; TimeLimit?: string; Targets?: QuestDbTarget[]; Drops?: QuestDbDrop[] };

/** s_quest_objective. race/size/element "All" = no filter (RC_ALL / SZ_ALL / ELE_ALL); map null = any map (mapid -1). */
export type QuestObjective = {
  index: number; mobId: number; count: number; minLevel: number; maxLevel: number;
  race: string; size: string; element: string; map: string | null; mapName: string; mobsAllowed: number[];
};
/** s_quest_dropitem (mobId 0 = any monster). */
export type QuestDropItem = { mobId: number; itemId: number; count: number; rate: number };
/** s_quest_db. time = seconds (relative) or seconds of day (+ days) for a fixed reset time (timeAt). */
export type QuestDef = {
  id: number; title: string; time: number; timeAt: boolean; timeWeek: number;
  objectives: QuestObjective[]; drops: QuestDropItem[];
};

/** MAX_LEVEL (common/mmo.hpp, RENEWAL): the MaxLevel fallback when MinLevel > MaxLevel. */
const MAX_LEVEL = 275;
/** RC_* constants the db accepts (RC_FORMLESS..RC_ALL minus the player races), Size_*, Ele_* (script_constants.hpp). */
export const QUEST_RACES = ["Formless", "Undead", "Brute", "Plant", "Insect", "Fish", "Demon", "Demihuman", "Angel", "Dragon", "All"];
export const QUEST_SIZES = ["Small", "Medium", "Large", "All"];
export const QUEST_ELEMENTS = ["Neutral", "Water", "Earth", "Fire", "Wind", "Poison", "Holy", "Dark", "Ghost", "Undead", "All"];
const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

const lower = (s: string) => s.toLowerCase();
/** name -> row, the lowest id winning when two rows share a display name (renamed data has e.g. two "Knife" rows with a
 *  different slot count, where rAthena's aegis names differ): content that needs the other one uses the numeric id. */
function byName<T extends { id: number; name: string }>(rows: Iterable<T>) {
  const m = new Map<string, T>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) if (!m.has(lower(r.name))) m.set(lower(r.name), r);
  return m;
}
const mobByName = byName(MOB_BY_ID.values());
const itemByName = byName(ITEMS.values());
/** Our monster by name (case-insensitive, like mobdb_search_aegisname) or id. */
export const mobNamed = (ref: string | number): Mob | undefined => typeof ref === "number" ? MOB_BY_ID.get(ref) : mobByName.get(lower(ref));
/** Our item by name (case-insensitive, like item_db.search_aegisname) or id. */
export const itemNamed = (ref: string | number) => typeof ref === "number" ? ITEMS.get(ref) : itemByName.get(lower(ref));

/**
 * solve_time (common/timer.cpp:467) for a relative TimeLimit ("+1d", "+2h30mn", "+1m" ...): calendar arithmetic on the
 * local time of `now` (s / n|mn / h / d|j / m (month) / y|a), returning the difference in seconds. A part whose number is
 * 0 is skipped one character at a time, like the C++ (atoi == 0 -> modif_p++).
 */
export function solveTime(spec: string, now: Date = new Date()): number {
  const then = new Date(now.getTime());
  let i = 0;
  while (i < spec.length) {
    const value = Number.parseInt(spec.slice(i), 10) || 0; // atoi
    if (value === 0) { i++; continue; }
    if (spec[i] === "-" || spec[i] === "+") i++;
    while (i < spec.length && spec[i] >= "0" && spec[i] <= "9") i++;
    const c = spec[i], c2 = spec[i + 1];
    if (c === "s") { then.setSeconds(then.getSeconds() + value); i++; }
    else if (c === "n") { then.setMinutes(then.getMinutes() + value); i++; }
    else if (c === "m" && c2 === "n") { then.setMinutes(then.getMinutes() + value); i += 2; }
    else if (c === "h") { then.setHours(then.getHours() + value); i++; }
    else if (c === "d" || c === "j") { then.setDate(then.getDate() + value); i++; }
    else if (c === "m") { then.setMonth(then.getMonth() + value); i++; }
    else if (c === "y" || c === "a") { then.setFullYear(then.getFullYear() + value); i++; }
    else if (i < spec.length) i++;
  }
  return Math.trunc((then.getTime() - now.getTime()) / 1000);
}

/** split_exact_quest_time (quest.cpp:449): a fixed reset time "4h", "1d 4h30mn", "Monday 4h". Hour is required (0..23),
 *  minutes/seconds <= 59; null = invalid. week -1 = no weekday. */
export function splitExactQuestTime(spec: string) {
  let w = -1, d = -1, h = -1, mn = -1, s = -1;
  let i = 0;
  const up = spec.toUpperCase();
  while (i < spec.length) {
    const value = Number.parseInt(spec.slice(i), 10) || 0;
    if (spec[i] === "-" || spec[i] === "+") i++;
    while (i < spec.length && spec[i] >= "0" && spec[i] <= "9") i++;
    const day = WEEKDAYS.findIndex((n) => up.startsWith(n, i));
    if (day >= 0) { w = day; i += WEEKDAYS[day].length; }
    else if (spec[i] === "s") { s = value; i++; }
    else if (spec[i] === "m" && spec[i + 1] === "n") { mn = value; i += 2; }
    else if (spec[i] === "h") { h = value; i++; }
    else if (spec[i] === "d" || spec[i] === "j") { d = value; i++; }
    else if (i < spec.length) i++;
  }
  if (h < 0 || h > 23 || mn > 59 || s > 59) return null;
  return { week: w, day: Math.max(0, d), hour: h, minute: Math.max(0, mn), second: Math.max(0, s) };
}

/** QuestDatabase::parseBodyNode (quest.cpp:42) for every row: rows that rAthena would skip are left out and named in
 *  `warnings` (content tests require none). `now` only matters for calendar-relative limits like "+1m". */
export function parseQuestDb(rows: readonly QuestDbRow[], now: Date = new Date()) {
  const db = new Map<number, QuestDef>();
  const warnings: string[] = [];
  row: for (const r of rows) {
    const where = `quest ${r.Id}`;
    if (!Number.isInteger(r.Id) || r.Id <= 0 || typeof r.Title !== "string") { warnings.push(`${where}: Id and Title are required`); continue; }
    if (db.has(r.Id)) { warnings.push(`${where}: duplicate Id`); continue; }
    const q: QuestDef = { id: r.Id, title: r.Title, time: 0, timeAt: false, timeWeek: -1, objectives: [], drops: [] };
    if (r.TimeLimit !== undefined) {
      if (r.TimeLimit.includes("+")) {
        const t = solveTime(r.TimeLimit, now);
        if (t <= 0) { warnings.push(`${where}: incorrect TimeLimit ${r.TimeLimit}`); continue; }
        q.time = t;
      } else {
        const t = splitExactQuestTime(r.TimeLimit);
        if (!t) { warnings.push(`${where}: incorrect TimeLimit ${r.TimeLimit}`); continue; }
        q.time = t.week > 0 ? t.hour * 3600 + t.minute * 60 + t.second : t.day * 86400 + t.hour * 3600 + t.minute * 60 + t.second;
        q.timeAt = true;
        q.timeWeek = t.week;
      }
    }
    for (const tn of r.Targets ?? []) {
      if (q.objectives.length >= MAX_QUEST_OBJECTIVES) { warnings.push(`${where}: more than ${MAX_QUEST_OBJECTIVES} Targets`); continue row; }
      if (tn.Mob === undefined && tn.Id === undefined) { warnings.push(`${where}: Target without Mob or Id`); continue row; }
      let mobId = 0, index = 0;
      if (tn.Mob !== undefined) {
        const mob = mobNamed(tn.Mob);
        if (!mob) { warnings.push(`${where}: Mob ${tn.Mob} does not exist`); continue row; }
        mobId = mob.id;
      } else {
        index = tn.Id!;
        if (!Number.isInteger(index) || index === 0) { warnings.push(`${where}: target Id can't be 0`); continue row; }
      }
      if (tn.Count === undefined) { warnings.push(`${where}: Target has no Count`); continue row; }
      const o: QuestObjective = { index, mobId, count: tn.Count, minLevel: 0, maxLevel: 0, race: "All", size: "All", element: "All", map: null, mapName: "", mobsAllowed: [] };
      if (tn.Mob === undefined) { // filters only apply to Id targets (quest.cpp:184)
        if (tn.MinLevel !== undefined) o.minLevel = tn.MinLevel;
        if (tn.MaxLevel !== undefined) {
          if (o.minLevel > tn.MaxLevel) warnings.push(`${where}: MinLevel ${o.minLevel} > MaxLevel ${tn.MaxLevel}, MaxLevel set to ${MAX_LEVEL}`);
          o.maxLevel = o.minLevel > tn.MaxLevel ? MAX_LEVEL : tn.MaxLevel;
        }
        const pick = (v: string | undefined, allowed: string[], what: string) => {
          if (v === undefined) return "All";
          const hit = allowed.find((a) => lower(a) === lower(v));
          if (!hit) warnings.push(`${where}: invalid ${what} ${v}`);
          return hit;
        };
        const race = pick(tn.Race, QUEST_RACES, "Race"), size = pick(tn.Size, QUEST_SIZES, "Size"), ele = pick(tn.Element, QUEST_ELEMENTS, "Element");
        if (!race || !size || !ele) continue row;
        o.race = race; o.size = size; o.element = ele;
        if (tn.Location !== undefined && lower(tn.Location) !== "all") o.map = tn.Location;
        if (tn.MapName !== undefined) o.mapName = tn.MapName;
        for (const [name, on] of Object.entries(tn.MapMobTargets ?? {})) {
          const mob = mobNamed(name);
          if (!mob) { warnings.push(`${where}: MapMobTargets mob ${name} does not exist`); continue; }
          if (!on) o.mobsAllowed = o.mobsAllowed.filter((id) => id !== mob.id);
          else if (!o.mobsAllowed.includes(mob.id)) o.mobsAllowed.push(mob.id);
        }
        if (o.minLevel === 0 && o.maxLevel > 0) o.minLevel = 1; // "if max_level is set, min_level is 1"
      }
      q.objectives.push(o);
    }
    for (const dn of r.Drops ?? []) {
      let mobId = 0;
      if (dn.Mob !== undefined) {
        const mob = mobNamed(dn.Mob);
        if (!mob) { warnings.push(`${where}: drop Mob ${dn.Mob} does not exist`); continue; }
        mobId = mob.id;
      }
      const item = itemNamed(dn.Item);
      if (!item) { warnings.push(`${where}: drop Item ${dn.Item} does not exist`); continue; }
      if (dn.Rate === undefined) { warnings.push(`${where}: drop has no Rate`); continue; }
      let count = dn.Count ?? 1;
      if (dn.Count !== undefined && !isStackable(item)) { warnings.push(`${where}: ${item.name} is not stackable, Count capped to 1`); count = 1; }
      q.drops.push({ mobId, itemId: item.id, count, rate: dn.Rate });
    }
    db.set(q.id, q);
  }
  return { db, warnings };
}

// ---------- the quest log (struct quest[] + avail_quests) ----------

/** struct quest: one quest log entry. time = expiry (unix seconds, 0 = none); count = kill counter per objective. */
export type QuestEntry = { questId: number; time: number; count: number[]; state: QuestState };
/** sd->quest_log / sd->num_quests / sd->avail_quests: active + inactive entries first (`avail` of them), completed after. */
export type QuestLog = { entries: QuestEntry[]; avail: number };
export type QuestDb = ReadonlyMap<number, QuestDef>;

const blankCounts = () => Array<number>(MAX_QUEST_OBJECTIVES).fill(0);

/** Local clock parts of a unix time (localtime()); the default follows the server's time zone. */
export type LocalClock = (unixSec: number) => { hour: number; minute: number; second: number; wday: number };
export const localClock: LocalClock = (t) => {
  const d = new Date(t * 1000);
  return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), wday: d.getDay() };
};

/** quest_time (quest.cpp:554): expiry of a quest added at `now` (unix seconds); 0 = no limit. A fixed reset time rolls to
 *  the next day once today's time has passed, and to the given weekday when one is set. */
export function questTime(q: QuestDef | undefined, now: number, local: LocalClock = localClock): number {
  if (!q || q.time < 0) return 0;
  if (!q.timeAt && q.time > 0) return now + q.time;
  if (q.timeAt) {
    const lt = local(now);
    const today = lt.hour * 3600 + lt.minute * 60 + lt.second;
    let shift = today >= q.time % 86400 ? 1 : 0;
    if (q.timeWeek > -1) shift = q.timeWeek < lt.wday + shift ? q.timeWeek + 7 - lt.wday : q.timeWeek - lt.wday;
    return now + shift * 86400 + q.time - today;
  }
  return 0;
}

/** intif_parse_questlog (intif.cpp:2055): rows from the DB -> log. Unknown quests are dropped; non-complete entries keep their
 *  order at the front, completed ones fill from the back (so they end up reversed). */
export function questLoad(rows: readonly QuestEntry[], db: QuestDb): QuestLog {
  const known = rows.filter((r) => db.has(r.questId));
  const front: QuestEntry[] = [], back: QuestEntry[] = [];
  for (const r of known) (r.state !== Q_COMPLETE ? front : back).push({ ...r, count: [...r.count, ...blankCounts()].slice(0, MAX_QUEST_OBJECTIVES) });
  return { entries: [...front, ...back.reverse()], avail: front.length };
}

const findAll = (log: QuestLog, id: number) => log.entries.findIndex((e) => e.questId === id);
const findAvail = (log: QuestLog, id: number) => log.entries.slice(0, log.avail).findIndex((e) => e.questId === id);

/** quest_add (quest.cpp:590): new Q_ACTIVE entry at the end of the available block. -1 = not in the db or already held
 *  (in any state, a completed one included). */
export function questAdd(log: QuestLog, db: QuestDb, id: number, now: number, local?: LocalClock): QuestEntry | -1 {
  const q = db.get(id);
  if (!q || questCheck(log, db, id, "HAVEQUEST", now) >= 0) return -1;
  const e: QuestEntry = { questId: q.id, time: questTime(q, now, local), count: blankCounts(), state: Q_ACTIVE };
  log.entries.splice(log.avail, 0, e);
  log.avail++;
  return e;
}

/** quest_change (quest.cpp:636): replace a held, not completed quest by another one in the same slot (fresh counters and
 *  time). -1 = qid2 unknown or already held, or qid1 not held / completed. */
export function questChange(log: QuestLog, db: QuestDb, qid1: number, qid2: number, now: number, local?: LocalClock): QuestEntry | -1 {
  const q = db.get(qid2);
  if (!q || questCheck(log, db, qid2, "HAVEQUEST", now) >= 0 || questCheck(log, db, qid1, "HAVEQUEST", now) < 0) return -1;
  const i = findAvail(log, qid1);
  if (i < 0) return -1;
  const e: QuestEntry = { questId: q.id, time: questTime(q, now, local), count: blankCounts(), state: Q_ACTIVE };
  log.entries[i] = e;
  return e;
}

/** quest_delete (quest.cpp:685): remove the entry whatever its state. false = not held. */
export function questDelete(log: QuestLog, id: number): boolean {
  const i = findAll(log, id);
  if (i < 0) return false;
  if (log.entries[i].state !== Q_COMPLETE) log.avail--;
  log.entries.splice(i, 1);
  return true;
}

/** quest_update_status (quest.cpp:849): only an available (active / inactive) entry changes; completing one swaps it with the
 *  last available entry and moves the block boundary. false = not available. */
export function questUpdateStatus(log: QuestLog, id: number, state: QuestState): boolean {
  const i = findAvail(log, id);
  if (i < 0) return false;
  log.entries[i].state = state;
  if (state < Q_COMPLETE) return true;
  const last = --log.avail;
  if (i < last) [log.entries[i], log.entries[last]] = [log.entries[last], log.entries[i]];
  return true;
}

/**
 * quest_check (quest.cpp:898). -1 = not in the log. Otherwise:
 *  HAVEQUEST: the state, with Q_INACTIVE reported as 1 (Q_ACTIVE);
 *  PLAYTIME:  2 when the expiry is before now (also for a quest without limit: its time is 0), else 1 if complete, else 0;
 *  HUNTING:   for an available entry: 2 when every objective count is reached (no objectives = reached), else 1 when the
 *             expiry is before now (again also time 0), else 0; a completed entry gives 0.
 */
export function questCheck(log: QuestLog, db: QuestDb, id: number, type: QuestCheckType, now: number): number {
  const e = log.entries.find((x) => x.questId === id);
  if (!e) return -1;
  if (type === "HAVEQUEST") return e.state === Q_INACTIVE ? 1 : e.state;
  if (type === "PLAYTIME") return e.time < now ? 2 : e.state === Q_COMPLETE ? 1 : 0;
  if (e.state === Q_INACTIVE || e.state === Q_ACTIVE) {
    const q = db.get(e.questId);
    if (!q || q.objectives.every((o, j) => e.count[j] >= o.count)) return 2;
    if (e.time < now) return 1;
  }
  return 0;
}

/** buildin_isbegin_quest (script.cpp:21154): quest_check HAVEQUEST mapped to 0 not started, 1 held, 2 completed. */
export function isbeginQuest(log: QuestLog, db: QuestDb, id: number, now: number): number {
  const i = questCheck(log, db, id, "HAVEQUEST", now);
  return i + (i < 1 ? 1 : 0);
}

/** The monster facts quest_update_objective compares (mob_data: mob_id, level, status race / size / def_ele). */
export type QuestKill = { mobId: number; level: number; race: string; size: string; element: string };
export const questKillOf = (m: Mob): QuestKill => ({ mobId: m.id, level: m.level, race: m.race, size: m.size, element: m.element });

/** One objective against a kill (quest.cpp:773-802): a Mob target matches its id; an Id target must pass all seven checks
 *  (level min / max, race, size, element, map, MapMobTargets). */
export function objectiveMatches(o: QuestObjective, kill: QuestKill, map: string): boolean {
  if (o.mobId === kill.mobId) return true;
  if (o.mobId !== 0) return false;
  return (o.minLevel === 0 || o.minLevel <= kill.level)
    && (o.maxLevel === 0 || o.maxLevel >= kill.level)
    && (o.race === "All" || lower(o.race) === lower(kill.race))
    && (o.size === "All" || lower(o.size) === lower(kill.size))
    && (o.element === "All" || lower(o.element) === lower(kill.element))
    && (o.map === null || o.map === map)
    && (o.mobsAllowed.length === 0 || o.mobsAllowed.includes(kill.mobId));
}

/** rnd_value(1, base) <= chance (common/random.hpp rnd_chance) on a [0,1) random source. */
export const rndChance = (chance: number, base: number, r: Rng) => 1 + Math.floor(r() * base) <= chance;

/**
 * quest_update_objective (quest.cpp:757) for the character that killed `kill` on `map`: every available entry that is not
 * complete gets +1 on each matching objective still below its count; then each of that quest's Drops for this monster
 * (or any monster) rolls rnd_chance(Rate, 10000) (Rate >= 10000 always drops) and goes straight to the inventory.
 * Returns the quest ids whose counters changed and the items to add, in order.
 */
export function questUpdateObjective(log: QuestLog, db: QuestDb, kill: QuestKill, map: string, r: Rng = Math.random) {
  const updated: number[] = [];
  const drops: { itemId: number; count: number; questId: number }[] = [];
  for (let i = 0; i < log.avail; i++) {
    const e = log.entries[i];
    if (e.state === Q_COMPLETE) continue;
    const q = db.get(e.questId);
    if (!q) continue;
    q.objectives.forEach((o, j) => {
      if (objectiveMatches(o, kill, map) && e.count[j] < o.count) {
        e.count[j]++;
        if (!updated.includes(e.questId)) updated.push(e.questId);
      }
    });
    for (const d of q.drops) {
      if (d.mobId !== 0 && d.mobId !== kill.mobId) continue;
      if (d.rate < 10000 && !rndChance(d.rate, 10000, r)) continue;
      if (!ITEMS.has(d.itemId)) continue;
      drops.push({ itemId: d.itemId, count: d.count, questId: e.questId });
    }
  }
  return { updated, drops };
}

/** Seconds left before an entry expires (0 = none or expired) — the quest window's "time limit" line. */
export const questTimeLeft = (e: Pick<QuestEntry, "time">, now: number) => (e.time > 0 ? Math.max(0, e.time - now) : 0);
