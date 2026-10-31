// End-to-end NPC dialog + quest check (C01/C02/C03): a fresh character plays the whole of Floor 1 Chapter 1 through the server.
// Guide Lio's pages, the lock while talking, Bloom Patrol and Gel Beads (kill counts, quest-only drops) as before, then the
// chain: Mira's Hat (isequipped), Mira's crate delivered to Ranger Vessa, the status point lesson, the Fire-element hunt with
// quest-only Ember Coals, the old lookout's OnTouch area (a dialog that opens by walking in, percentheal), Herbalist Tamsin's
// tea from the shortcut bar and sitting until HP is full, the two-objective pest hunt, the news for Lio, and Warden Orrin's
// level gate. At every step the "?" / "!" icon must sit over the NPC the step needs. Then the quest log / variables are
// checked in Postgres (dev schema only) and again after a relog. Walks use the client's navigation planner
// (shared/navi.ts): normal moves only.
//   pnpm --filter client quest [serverUrl]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Msg, type CutinEvent, type EmotionEvent, type ExpEvent, type InvEvent, type ItemGetEvent, type NoticeEvent, type NpcMenuEvent, type NpcMesEvent,
  type NpcTalkEvent, type QuestLogEvent, type QuestMarkEvent, type StatusEvent, type ZenyEvent,
} from "../../shared/protocol.ts";
import { walkable } from "../../shared/map.ts";
import { NPC_HOMES, TOWN, buildMap, habitatOf, mapOfState, type MapName } from "../../shared/maps.ts";
import { naviNextStep, naviRoute, nearestWalkable } from "../../shared/navi.ts";
import { npcCheckNear } from "../../shared/rules/npc.ts";
import { QTYPE } from "../../shared/rules/script.ts";
import { itemNamed } from "../../shared/rules/quest.ts";
import { QUEST_INFO, F1_GATE_LEVEL } from "../../shared/content/quest_db.ts";
import { CHAPTER1, NPC, Q, SPOT } from "../../shared/content/f1/chapter1.ts";
import { deleteChar, joinAs } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string) => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 1200 s"), 1_200_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const id = (name: string) => itemNamed(name)!.id;
const GEL = id("Gel Bead"), COAL = id("Ember Coal"), CRATE = id("Supply Crate"), TEA = id("Herb Tea"), HAT = id("Hat");
const PUDDLEBLOOM = 1002, SOOTCAP = 1113, CINDERPAW = 1049, TUMHOG = 1063, LOAMBLOOM = 1010;

// ---------- Postgres (the dev schema the server uses; never the deployed one) ----------
const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
// A desktop build (RO_STORE=pglite, /health says store "pglite") keeps its database inside the server process: there is nothing
// to read from here, so the DB rows step is skipped (also with QUEST_DB_CHECK=0); the relog step still checks the stored log.
const health: { store?: string } = await fetch(new URL("/health", url)).then((res) => res.json()).catch(() => ({}));
const dbCheck = process.env.QUEST_DB_CHECK !== "0" && health.store !== "pglite";
if (dbCheck && (!schema || schema === "ro")) fail(`refusing to read schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = dbCheck ? new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` }) : null;

// ---------- the bot ----------
const ACCOUNT = process.env.QUEST_BOT ?? "quest_bot"; // another account when several agents run this bot at once
const { room: r, token, char } = await joinAs(url, ACCOUNT, ACCOUNT, true);
const S: any = new Proxy({}, { get: (_t, k) => (r.state as any)[k] }); // the current room's state (the bot follows map changes)
let leaving = false;
r.onLeave((code: number) => { if (!leaving) fail(`disconnected (code ${code}): the dev server restarted? run again`); });
let inv: InvEvent | undefined, quests: QuestLogEvent["quests"] = [], own: StatusEvent | undefined;
const marks = new Map<string, number>(), notices: string[] = [], exp: ExpEvent[] = [], gets: ItemGetEvent[] = [], zeny: number[] = [];
const talks: NpcTalkEvent[] = [], emotions: EmotionEvent[] = [], cutins: CutinEvent[] = [];
r.onMessage(Msg.inv, (m: InvEvent) => { inv = m; });
r.onMessage(Msg.quests, (m: QuestLogEvent) => { quests = m.quests; });
r.onMessage(Msg.questMark, (m: QuestMarkEvent) => { marks.set(m.npc, m.icon); });
r.onMessage(Msg.notice, (m: NoticeEvent) => { notices.push(m.text); });
r.onMessage(Msg.exp, (m: ExpEvent) => { exp.push(m); });
r.onMessage(Msg.itemGet, (m: ItemGetEvent) => { gets.push(m); });
r.onMessage(Msg.zenyGet, (m: ZenyEvent) => { zeny.push(m.amount); });
r.onMessage(Msg.cutin, (m: CutinEvent) => { cutins.push(m); });
r.onMessage(Msg.status, (m: StatusEvent) => { own = m; });
r.onMessage(Msg.npcTalk, (m: NpcTalkEvent) => { talks.push(m); });
r.onMessage(Msg.emotion, (m: EmotionEvent) => { emotions.push(m); });
for (const t of [Msg.hit, Msg.chat, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.statUpAck, Msg.shopClose, Msg.shop, Msg.takeItem, Msg.skills, Msg.skillFail]) r.onMessage(t, () => {});
r.onMessage(Msg.die, (m: { id: string }) => { if (m.id === r.sessionId) { say("died; back to the save point"); setTimeout(() => r.send(Msg.respawn), 300); } });
const me = () => S.players.get(r.sessionId);
const cell = () => ({ x: Math.round(me().x), y: Math.round(me().y) });
const count = (itemId: number) => inv?.items.filter((s) => s.itemId === itemId).reduce((n, s) => n + s.amount, 0) ?? 0;
const entry = (qid: number) => quests.find((q) => q.id === qid);
const map = () => mapOfState(r.state as any);
/** The icon over each NPC that shows one, e.g. { npc_merchant: QUEST2 }. */
// W01: the server shows the icons of the NPCs in the character's room only, so the check looks at the NPCs of this room and, when
// it expects an icon over an NPC of another map, walks there first
const shownMarks = () => Object.fromEntries([...marks].filter(([id, i]) => i !== QTYPE.NONE && S.npcs?.get(id)).sort(([a], [b]) => a.localeCompare(b)));
const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
async function expectMarks(want: Record<string, number>, what: string) {
  const where = [...new Set(Object.keys(want).map((id) => NPC_HOMES[id]?.map).filter(Boolean))];
  if (where.length === 1 && where[0] !== r.map) await r.travel(where[0]!);
  await until(() => JSON.stringify(shownMarks()) === JSON.stringify(sorted(want)), 4000, `${what}: marks ${JSON.stringify(shownMarks())}, want ${JSON.stringify(want)}`);
}

// dialog transcript: every event in order (with its NPC), answered by `answer`
type Ev = { npc: string } & ({ t: "mes"; text: string } | { t: "next" } | { t: "close" } | { t: "menu"; options: string[] } | { t: "end" } | { t: "clear" });
const events: Ev[] = [];
let read = 0; // events consumed so far
r.onMessage(Msg.npcMes, (m: NpcMesEvent) => events.push({ npc: m.npc, t: "mes", text: m.text }));
r.onMessage(Msg.npcNextBtn, (m: { npc: string }) => events.push({ npc: m.npc, t: "next" }));
r.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => events.push({ npc: m.npc, t: "close" }));
r.onMessage(Msg.npcMenuList, (m: NpcMenuEvent) => events.push({ npc: m.npc, t: "menu", options: m.options }));
r.onMessage(Msg.npcEnd, (m: { npc: string }) => events.push({ npc: m.npc, t: "end" }));
r.onMessage(Msg.npcClear, (m: { npc: string }) => events.push({ npc: m.npc, t: "clear" }));

/** Answer an open dialog like a player: Next on every page, the given menu choices in order, Close at the end (a close2 is
 *  closed and the script may go on). `onFirstPage` runs once while the first page waits for Next. Returns the lines. */
async function answer(npc: string, choices: number[], onFirstPage?: () => Promise<void>) {
  const lines: string[] = [];
  let pages = 0;
  for (;;) {
    await until(() => events.length > read, 6000, `dialog with ${npc} stalled after: ${lines.slice(-2).join(" / ")}`);
    const ev = events[read++];
    if (ev.npc !== npc) fail(`a dialog event from ${ev.npc} while talking to ${npc}`);
    if (ev.t === "mes") lines.push(ev.text);
    else if (ev.t === "next") {
      if (!pages++ && onFirstPage) await onFirstPage();
      await wait(60); r.send(Msg.npcNext, { npc });
    } else if (ev.t === "menu") {
      const c = choices.shift();
      if (c === undefined) fail(`unexpected menu ${ev.options.join("/")} (${npc})`);
      lines.push(`> ${c === 255 ? "Cancel" : ev.options[c! - 1]}`);
      await wait(60); r.send(Msg.npcMenu, { npc, choice: c });
      if (c === 255) break;
    } else if (ev.t === "close") {
      await wait(60); r.send(Msg.npcClose, { npc });
      await wait(250);
      if (events.length === read) break; // close / close3: the script is over (a close2 goes on with more events)
    } else if (ev.t === "end") break;
  }
  if (choices.length) fail(`menu choices left over: ${choices} (${npc})`);
  await wait(300);
  return lines;
}
/** Click an NPC (walking into its npc_checknear range first) and answer its dialog. */
async function talk(npc: string, choices: number[] = [], onFirstPage?: () => Promise<void>) {
  if (!S.npcs.get(npc) && NPC_HOMES[npc]) await r.travel(NPC_HOMES[npc].map); // W01: the NPC lives on another map
  const n = S.npcs.get(npc);
  if (!n) fail(`NPC ${npc} is not in the room state`);
  if (!npcCheckNear(cell(), n)) await walkTo(n.x, n.y, 6);
  read = events.length;
  r.send(Msg.npc, { id: npc });
  return answer(npc, choices, onFirstPage);
}

/** Walk with the navigation planner until within `within` cells of (x, y): each request is an ordinary move. `stop` ends the
 *  walk early (e.g. a dialog opened by an OnTouch area on the way). */
async function walkTo(x: number, y: number, within: number, stop?: () => boolean, on?: MapName) {
  if (on && r.map !== on) await r.travel(on);
  const m = map(), goal = nearestWalkable(m, x, y)!;
  for (let hop = 0; hop < 60; hop++) {
    if (stop?.()) return;
    if (me().dead) { await until(() => !me().dead, 10_000, "no respawn"); await wait(800); }
    const c = cell();
    if (Math.max(Math.abs(c.x - x), Math.abs(c.y - y)) <= within) return;
    // like the tracker (client/src/navi.ts): stop where the route first comes within range (never aim at an occupied NPC cell:
    // official_cell_stack_limit moves a walk that ends on a standing unit on to a free neighbour)
    const full = naviRoute(m, c.x, c.y, goal.x, goal.y);
    const cut = full.findIndex((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y)) <= within);
    const route = cut >= 0 ? full.slice(0, cut + 1) : full;
    const step = naviNextStep(m, route, c);
    if (!step) fail(`no navigation step from ${c.x},${c.y} to ${goal.x},${goal.y}`);
    r.send(Msg.move, { x: step!.x, y: step!.y });
    const tw = Date.now();
    // done at the step, or once the walk has stopped elsewhere (a walk ending on a standing unit goes on to a free neighbour and
    // stops there; the next hop re-plans from where it is)
    while (!(stop?.()) && (me().moving || (cell().x !== step!.x || cell().y !== step!.y) && Date.now() - tw < 600)) {
      if (Date.now() - tw > 10_000) fail(`walk to ${step!.x},${step!.y} did not finish`);
      if (me().dead) break;
      await wait(100);
    }
  }
  fail(`could not reach ${x},${y}`);
}

/** Fight the nearest of `mobIds` (picking up nearby `loot` items) until `done()`. Returns the kills. */
async function hunt(done: () => boolean, what: string, mobIds: number[], loot: number[] = [], ms = 240_000) {
  let kills = 0;
  const off = r.onMessage(Msg.die, (m: { id: string; killer?: string }) => { if (m.killer === r.sessionId && mobIds.includes(S.monsters.get(m.id)?.mobId)) kills++; });
  const t = Date.now();
  while (!done()) {
    if (Date.now() - t > ms) fail(`${what}: not done after ${ms / 1000} s (${kills} kills)`);
    const p = me();
    if (p.dead) { await wait(500); continue; }
    if (p.sitting) r.send(Msg.sit); // stand up to fight
    const near = (a: any) => Math.hypot(a.x - p.x, a.y - p.y);
    const floor = [...S.floor.entries()].filter(([, f]: any) => loot.includes(f.itemId)).sort(([, a]: any, [, b]: any) => near(a) - near(b));
    if (floor.length && near(floor[0][1]) < 8) { r.send(Msg.pickup, { id: floor[0][0] }); await wait(900); continue; }
    // a monster can spawn on a cell walled in by trees and water (any walkable cell will do for mob_spawn): skip what no walk reaches
    const reach = (m: any) => { const c = cell(); return naviRoute(map(), c.x, c.y, Math.round(m.x), Math.round(m.y)).length > 0 || near(m) < 2; };
    const live = [...S.monsters.entries()].filter(([, m]: any) => !m.dead && mobIds.includes(m.mobId) && reach(m)).sort(([, a]: any, [, b]: any) => near(a) - near(b));
    if (!live.length) { // W01: none here: walk to the nearest field they live on
      const home = habitatOf(mobIds, r.map);
      if (home && home !== r.map) { say(`${what}: heading for ${home}`); await r.travel(home); continue; }
      await wait(500); continue;
    }
    const [mid, mob] = live[0] as any;
    if (near(mob) > 12) await walkTo(Math.round(mob.x), Math.round(mob.y), 4);
    r.send(Msg.attack, { id: mid });
    await wait(1200);
  }
  off();
  return kills;
}
/** Spend status points (pc_statusup) until fewer than 2 are left: VIT first (faster regen for the rest lesson), then DEX. */
async function spendPoints() {
  for (let i = 0; i < 40 && (own?.statPoints ?? 0) >= 2; i++) {
    r.send(Msg.statUp, { stat: i % 2 ? "dex" : "vit", amount: 1 });
    await wait(80);
  }
  await until(() => (own?.statPoints ?? 99) < 2, 3000, `status points not spent (${own?.statPoints})`);
}
const rewardOf = (qid: number) => QUEST_INFO.get(qid)!;
/** The quest's listed EXP reached the player as a quest reward (Msg.exp quest flag). */
function expectExp(qid: number) {
  const rw = rewardOf(qid);
  if (!rw.RewardEXP && !rw.RewardJEXP) return;
  // at the Fledgling's last job level (10) the Job part shows 0 (displayedGain: nothing left to gain), like pc_gainexp
  const jobOk = (j: number) => j === (rw.RewardJEXP ?? 0) || (j === 0 && (own?.jobLevel ?? 0) >= 10);
  if (!exp.some((e) => e.quest && e.base === (rw.RewardEXP ?? 0) && jobOk(e.job))) fail(`quest ${qid} EXP ${JSON.stringify(exp)}`);
}

// 0) a fresh Fledgling with points in STR / AGI / DEX, standing on the plaza (inside Lio's OnTouch area: he calls out)
await until(() => !!inv && !!own && marks.has(NPC.guide), 4000, "no inventory / status / questinfo on login");
if (marks.get(NPC.guide) !== QTYPE.QUEST) fail(`guide should show "!" to a new character, got ${marks.get(NPC.guide)}`);
if (quests.length) fail("a fresh character has quests");
await until(() => talks.some((t) => t.npc === NPC.guide), 3000, "Lio's OnTouch greeting (npctalk) did not arrive");
if (!emotions.some((e) => e.id === NPC.guide)) fail("Lio's OnTouch emotion did not arrive");
say(`OK: login: empty quest log, "!" over Guide Lio, his OnTouch greeting: "${talks.find((t) => t.npc === NPC.guide)!.text}"`);
r.send(Msg.statUp, { stat: "str", amount: 20 }); r.send(Msg.statUp, { stat: "agi", amount: 10 }); r.send(Msg.statUp, { stat: "dex", amount: 10 });
const guide = S.npcs.get(NPC.guide);
if (!guide || guide.name !== "Guide Lio") fail("Guide Lio is not in the room state");
if (S.npcs.has(NPC.lookout) || S.npcs.has(NPC.miraShop)) fail("invisible / floating NPCs must not reach the client");

// 1) first talk: the intro pages, then Cancel at the menu (select cancel ends the script; the intro variable is saved)
let lines = await talk(NPC.guide, [255]);
if (!cutins.some((c) => c.image === "guide_lio" && c.type === 2)) fail("cutin guide_lio at the bottom right expected");
if (!lines.some((l) => l.includes("Verdant Floor")) || lines[0] !== "[Guide Lio]") fail(`intro missing: ${lines.join(" | ")}`);
say(`OK: intro (${lines.length} lines) + cutin; Cancel at the menu ended the script`);
const c0 = cell(), free = nearestWalkable(map(), c0.x + 2, c0.y + 1)!;
r.send(Msg.move, free);
await until(() => cell().x === free.x && cell().y === free.y, 5000, "can't walk after the dialog ended (lock not released)");
say("OK: the lock is released once the script ends");

// 2) second talk: no intro again; Where am I? (3 pages) -> Any work? -> accept. While the first page waits: locked.
lines = await talk(NPC.guide, [1, 2, 1], async () => {
  const p0 = cell(), to = nearestWalkable(map(), p0.x - 3, p0.y)!;
  const tonic = inv!.items.find((s) => s.itemId === 569), knife = inv!.items.find((s) => s.equip === "weapon");
  notices.length = 0;
  r.send(Msg.move, to);
  r.send(Msg.npc, { id: NPC.guide });
  r.send(Msg.useItem, { uid: tonic!.uid });
  r.send(Msg.unequip, { uid: knife!.uid });
  const mob = [...S.monsters.entries()].find(([, m]: any) => !m.dead);
  if (mob) r.send(Msg.attack, { id: mob[0] });
  await wait(900);
  if (cell().x !== p0.x || cell().y !== p0.y || me().moving) fail("walked while talking (pc_cant_act)");
  if (count(569) !== tonic!.amount) fail("used an item while talking (pc_useitem: npc_id)");
  if (!inv!.items.find((s) => s.uid === knife!.uid)?.equip) fail("unequipped while talking");
  if (notices.filter((n) => /busy/i.test(n)).length < 2 || !notices.some((n) => /equipment/i.test(n))) fail(`expected busy / can't-equip answers, got ${JSON.stringify(notices)}`);
  say(`OK: while talking: no walk, no attack, no item use, no unequip, NPC click busy (${notices.length} answers)`);
});
if (lines.filter((l) => l === "[Guide Lio]").length < 4 || lines.some((l) => l.includes("new face"))) fail(`unexpected second talk: ${lines.join(" | ")}`);
if (!lines.some((l) => l.includes("<NAVI>"))) fail("the offer should carry a navigation link");
await until(() => entry(Q.PATROL)?.state === 1, 2000, "Bloom Patrol not in the quest log");
await expectMarks({}, "while the patrol runs");
say(`OK: talked through ${lines.length} lines; Bloom Patrol accepted, counts ${entry(Q.PATROL)!.count}`);
r.send(Msg.questActive, { id: Q.PATROL, active: false }); // CZ_ACTIVE_QUEST (the quest window's tracker box)
await until(() => entry(Q.PATROL)?.state === 0, 2000, "questActive false did not make the quest inactive");
r.send(Msg.questActive, { id: Q.PATROL, active: true });
await until(() => entry(Q.PATROL)?.state === 1, 2000, "questActive true did not make it active again");
say("OK: quest hidden and shown again (CZ_ACTIVE_QUEST)");

// 3) the kill quest: counts go up one per Puddlebloom, up to 5, then "?" over the guide
const seen: number[] = [];
const watch = setInterval(() => { const c = entry(Q.PATROL)?.count[0]; if (c !== undefined && c !== seen.at(-1)) seen.push(c); }, 50);
const kills1 = await hunt(() => (entry(Q.PATROL)?.count[0] ?? 0) >= 5, "Bloom Patrol", [PUDDLEBLOOM], [GEL]);
clearInterval(watch);
if (seen.some((c, i) => i && c !== seen[i - 1] + 1) || Math.max(...seen) !== 5) fail(`kill counts should go 0..5 one by one, saw ${seen}`);
await expectMarks({ [NPC.guide]: QTYPE.QUEST2 }, "patrol done");
say(`OK: kill counter ${seen.join(" -> ")} (${kills1} kills), "?" over the guide`);

// 4) report: completequest + the listed rewards, then the bead quest is offered and taken
const z0 = inv!.zeny, red0 = count(501);
exp.length = 0; gets.length = 0; zeny.length = 0;
lines = await talk(NPC.guide, [1]);
const r1 = rewardOf(Q.PATROL);
await until(() => entry(Q.BEADS)?.state === 1 && !entry(Q.PATROL), 2000, "after the report: patrol gone from the log, beads active");
expectExp(Q.PATROL);
if (zeny[0] !== r1.RewardZeny || inv!.zeny !== z0 + r1.RewardZeny!) fail(`zeny reward ${zeny} (${z0} -> ${inv!.zeny})`);
if (count(501) !== red0 + 3 || !gets.some((g) => g.itemId === 501 && g.amount === 3 && g.quest)) fail("Red Tonic x3 reward missing");
if (!cutins.some((c) => c.image === "guide_lio_cheer")) fail("Lio's cheering face on the report");
say(`OK: report: +${r1.RewardEXP}/${r1.RewardJEXP} EXP, +${zeny[0]} z, Red Tonic x3; "Gel Beads for the Plaza" accepted`);

// 5) collect: Gel Beads from drops (floor) and the quest's own Drops (straight into the bag), "?" at 10
gets.length = 0;
const kills2 = await hunt(() => count(GEL) >= 10, "Gel Beads", [PUDDLEBLOOM], [GEL]);
const questDrops = gets.filter((g) => g.itemId === GEL && g.quest).length;
if (kills2 >= 12 && !questDrops) fail(`no quest-only Gel Bead drop in ${kills2} kills (Rate 5000)`);
await expectMarks({ [NPC.guide]: QTYPE.QUEST2 }, "10 beads");
say(`OK: ${count(GEL)} Gel Beads after ${kills2} kills (${questDrops} quest drops), "?" over the guide`);

// 6) report the beads: delitem 10 + rewards, and Lio hands over to Mira (A Merchant's Thanks): "?" over Mira
const gel0 = count(GEL), z1 = inv!.zeny;
exp.length = 0; gets.length = 0; zeny.length = 0;
lines = await talk(NPC.guide);
await until(() => !entry(Q.BEADS) && count(GEL) === gel0 - 10 && entry(Q.THANKS)?.state === 1, 2000, "beads not taken / Mira's quest not given");
expectExp(Q.BEADS);
if (inv!.zeny !== z1 + rewardOf(Q.BEADS).RewardZeny! || count(502) !== 2 || count(601) !== 1) fail("bead rewards missing");
await expectMarks({ [NPC.merchant]: QTYPE.QUEST2 }, "talk to Mira");
say(`OK: report: -10 Gel Beads, rewards; [Main] "A Merchant's Thanks": "?" moved to Mira`);

// 7) Mira: thanks with a Hat (+ the equipment tutorial page with its centre illustration), then wear it and show her
cutins.length = 0;
lines = await talk(NPC.merchant);
await until(() => count(HAT) === 1 && entry(Q.DRESSED)?.state === 1 && !entry(Q.THANKS), 2000, "no Hat / Dressed for the Climb");
if (!cutins.some((c) => c.image === "mira" && c.type === 2) || !cutins.some((c) => c.image === "tut_equip" && c.type === 3)) fail(`cutins ${JSON.stringify(cutins)}`);
await expectMarks({}, "Hat not worn yet");
r.send(Msg.equip, { uid: inv!.items.find((s) => s.itemId === HAT)!.uid });
await until(() => !!inv!.items.find((s) => s.itemId === HAT)?.equip, 2000, "the Hat did not go on");
await expectMarks({ [NPC.merchant]: QTYPE.QUEST2 }, "Hat worn");
exp.length = 0;
lines = await talk(NPC.merchant, [1]);
await until(() => entry(Q.CRATE)?.state === 1 && count(CRATE) === 1 && !entry(Q.DRESSED), 2000, "no crate / delivery quest");
expectExp(Q.DRESSED);
await expectMarks({ [NPC.ranger]: QTYPE.QUEST2 }, "deliver the crate");
say(`OK: Mira: Hat given, worn (isequipped), reported; Supply Crate for Ranger Vessa; "?" moved to Vessa`);

// 8) Vessa: her OnTouch spots the crate; delivery, then the status point lesson
talks.length = 0;
await walkTo(SPOT.ranger.x, SPOT.ranger.y, 3, undefined, SPOT.ranger.map);
await until(() => talks.some((t) => t.npc === NPC.ranger && t.text.includes("crate")), 3000, "Vessa's OnTouch line about the crate");
exp.length = 0; cutins.length = 0;
const unspent = (own?.statPoints ?? 0) >= 2; // with every point already spent the lesson completes at once and the hunt is offered
lines = await talk(NPC.ranger, unspent ? [] : [1]);
await until(() => count(CRATE) === 0 && !entry(Q.CRATE) && (unspent ? entry(Q.STATS)?.state === 1 : entry(Q.EMBERS)?.state === 1), 2000, "delivery not taken / no stats lesson");
expectExp(Q.CRATE);
if (unspent) {
  if (!cutins.some((c) => c.image === "tut_status" && c.type === 3)) fail("the status tutorial page has its illustration");
  await expectMarks({}, "points unspent");
  await spendPoints();
  await expectMarks({ [NPC.ranger]: QTYPE.QUEST2 }, "points spent");
  exp.length = 0;
  lines = await talk(NPC.ranger, [1]);
}
await until(() => entry(Q.EMBERS)?.state === 1 && !entry(Q.STATS), 2000, "stats lesson not done / fire hunt not given");
expectExp(Q.STATS);
say(`OK: Vessa: crate delivered (delitem), status points spent (StatusPoint ${own!.statPoints}), "Embers in the Grass" accepted`);

// 9) the fire hunt: any Fire monster counts (Id + Element target), Ember Coals are quest-only drops
gets.length = 0;
const kills3 = await hunt(() => (entry(Q.EMBERS)?.count[0] ?? 0) >= 6 && count(COAL) >= 4, "Embers in the Grass", [SOOTCAP, CINDERPAW]);
if (!gets.some((g) => g.itemId === COAL && g.quest)) fail("Ember Coals should arrive as quest drops");
await expectMarks({ [NPC.ranger]: QTYPE.QUEST2 }, "embers ready");
exp.length = 0;
lines = await talk(NPC.ranger);
await until(() => entry(Q.LOOKOUT)?.state === 1 && !entry(Q.EMBERS) && count(id("Guard")) === 1, 2000, "embers not reported / no lookout quest");
expectExp(Q.EMBERS);
await expectMarks({}, "scouting the lookout");
say(`OK: ${kills3} Fire kills, ${count(COAL)} coals left after delitem 4; Guard received; "The Old Lookout" given`);

// 10) the old lookout: walking into its (invisible) area opens its dialog; a bramble takes 40% of the max HP
read = events.length;
const hp0 = own!.hp, maxHp0 = own!.maxHp;
let minHp = hp0; // the lookout's own EXP may level the character up (a full heal), so watch the lowest HP during its dialog
const offHp = r.onMessage(Msg.status, (m: StatusEvent) => { minHp = Math.min(minHp, m.hp); });
await walkTo(SPOT.lookout.x, SPOT.lookout.y, 1, () => events.length > read, SPOT.lookout.map);
await until(() => events.length > read, 8000, "walking into the old lookout opened no dialog (OnTouch)");
lines = await answer(NPC.lookout, []);
if (lines[0] !== "-! The Old Lookout !-") fail(`lookout dialog: ${lines.join(" | ")}`);
await until(() => entry(Q.TRAIL)?.state === 1 && !entry(Q.LOOKOUT), 2000, "lookout not completed by its OnTouch");
offHp();
// percentheal -40 = 40% of the max off whatever HP was left after the lookout's reward (a level-up there heals fully first)
const lost = Math.trunc((own!.maxHp * 40) / 100);
if (minHp > Math.max(hp0, own!.maxHp) - lost) fail(`the bramble (percentheal -40) should take ${lost} HP (max ${maxHp0} -> ${own!.maxHp}): ${hp0} -> lowest ${minHp}`);
if (!emotions.some((e) => e.id === r.sessionId)) fail("the lookout's emotion over the player (playerattached)");
await expectMarks({ [NPC.herbalist]: QTYPE.QUEST2 }, "find Tamsin");
say(`OK: the lookout's OnTouch dialog (${lines.length} lines), bramble HP ${hp0} -> ${minHp} (now ${own!.hp}/${own!.maxHp}); "?" over Herbalist Tamsin`);

// 11) Tamsin: Herb Tea for the shortcut bar, then sit until HP is full
cutins.length = 0;
lines = await talk(NPC.herbalist);
await until(() => count(TEA) === 1 && entry(Q.REST)?.state === 1 && !entry(Q.TRAIL), 2000, "no tea / rest lesson");
if (!["tut_hotkey", "tut_sit"].every((n) => cutins.some((c) => c.image === n && c.type === 3))) fail("the tea / sit pages have their illustrations");
await expectMarks({}, "tea not drunk");
r.send(Msg.hotkeys, { keys: [TEA] }); // put the tea in slot F1, then "press" it: the client sends the item use
await wait(200);
r.send(Msg.useItem, { uid: inv!.items.find((s) => s.itemId === TEA)!.uid });
await until(() => count(TEA) === 0, 2000, "the tea was not drunk");
// sitting needs Basic Training Lv 3 (basic_skill_check, clif.cpp:11741): the lesson's skill task, learned with skill points (Alt+S)
if ((own!.skillPoints ?? 0) < 3) fail(`only ${own!.skillPoints} skill points for Basic Training 3 at the rest lesson`);
for (let i = 0; i < 3; i++) r.send(Msg.skillUp, { id: 1 }); // NV_BASIC
await wait(500);
if (own!.hp < own!.maxHp) {
  r.send(Msg.sit);
  await until(() => me().sitting, 2000, "did not sit down");
  await until(() => own!.hp >= own!.maxHp, 240_000, `HP not full after sitting (${own!.hp}/${own!.maxHp})`);
  r.send(Msg.sit);
}
await expectMarks({ [NPC.herbalist]: QTYPE.QUEST2 }, "rested");
exp.length = 0;
lines = await talk(NPC.herbalist, [1]);
await until(() => entry(Q.PESTS)?.state === 1 && !entry(Q.REST), 2000, "rest not reported / no pest hunt");
expectExp(Q.REST);
say(`OK: tea drunk from the shortcut bar, HP full after sitting; "Pests in the Herb Beds" accepted`);

// 12) the two-objective hunt, then the news for Lio and the warden's gate
// W01: Tumhogs on the plains, Loamblooms in the Whisperwood east of town
const kills4 = await hunt(() => (entry(Q.PESTS)?.count[0] ?? 0) >= 5, "Pests in the Herb Beds (Tumhogs)", [TUMHOG], [], 360_000)
  + await hunt(() => (entry(Q.PESTS)?.count[1] ?? 0) >= 2, "Pests in the Herb Beds (Loamblooms)", [LOAMBLOOM], [], 360_000);
await expectMarks({ [NPC.herbalist]: QTYPE.QUEST2 }, "pests done");
exp.length = 0;
lines = await talk(NPC.herbalist);
await until(() => entry(Q.NEWS)?.state === 1 && !entry(Q.PESTS), 2000, "pests not reported");
expectExp(Q.PESTS);
await expectMarks({ [NPC.guide]: QTYPE.QUEST2 }, "news for Lio");
say(`OK: ${kills4} pest kills (5 Tumhogs + 2 Loamblooms counted); "?" back over Lio`);
exp.length = 0;
lines = await talk(NPC.guide);
await until(() => entry(Q.GATE)?.state === 1 && !entry(Q.NEWS), 2000, "news not told / no gate quest");
expectExp(Q.NEWS);
await expectMarks({ [NPC.warden]: QTYPE.QUEST2 }, "meet Orrin");
say(`OK: Lio heard the news (Base Lv ${own!.level}, Job Lv ${own!.jobLevel}); "?" over Warden Orrin`);

// 13) Orrin: the level gate; hunt to the gate level if needed, then the chapter ends
talks.length = 0;
await walkTo(SPOT.warden.x, SPOT.warden.y, 3, undefined, SPOT.warden.map);
await until(() => talks.some((t) => t.npc === NPC.warden), 3000, "Orrin's OnTouch hail");
// W01: once the chapter ends Orrin sends you to Bren and warns about the south road (no menu: his gate is an ordinary warp)
lines = await talk(NPC.warden);
await until(() => entry(Q.PROVEN)?.state === 1 || !!lines.length && own!.level >= F1_GATE_LEVEL, 2000, "no Proven Climber");
if (own!.level < F1_GATE_LEVEL) {
  if (!lines.some((l) => l.includes(`Base Lv ${F1_GATE_LEVEL}`))) fail(`Orrin should name the gate level: ${lines.join(" | ")}`);
  await expectMarks({}, "below the gate level");
  say(`OK: Orrin: Base Lv ${own!.level} < ${F1_GATE_LEVEL}, sent hunting`);
  await hunt(() => own!.level >= F1_GATE_LEVEL, "the gate level", [1011, 1007, LOAMBLOOM], [], 480_000); // the Whisperwood (quest 1014's navi)
  exp.length = 0;
  lines = await talk(NPC.warden);
}
await until(() => entry(Q.PROVEN) === undefined && count(id("Cutter")) === 1, 3000, "chapter not completed");
expectExp(Q.PROVEN);
if (!lines.some((l) => l.includes("Chapter 1 complete"))) fail(`no chapter end page: ${lines.join(" | ")}`);
if (!lines.some((l) => l.includes("stays sealed"))) fail(`Orrin should warn about the south road and the sealed stair: ${lines.join(" | ")}`);
// W01: Orrin stands in Hearthmoor, so the next Main stop (Bren "?") and Pella's side work ("!") are in sight
await expectMarks({ npc_hearthkeeper: QTYPE.QUEST2, npc_pella: QTYPE.QUEST }, "after the chapter");
const minutes = ((Date.now() - t0) / 60_000).toFixed(1);
say(`OK: Chapter 1 complete at Base Lv ${own!.level} / Job Lv ${own!.jobLevel} (bot time ${minutes} min); "?" over Bren, "!" over Pella`);

// 14) Postgres: all 14 quests completed, the intro variable, zeny written through
await wait(800);
if (db) {
  const rows = (await db.query("SELECT quest_id, state FROM quest WHERE char_id = $1 ORDER BY quest_id", [char.id])).rows;
  const vars = (await db.query(`SELECT "key", value FROM char_reg_num WHERE char_id = $1`, [char.id])).rows;
  const z = Number((await db.query("SELECT zeny FROM characters WHERE id = $1", [char.id])).rows[0].zeny);
  if (JSON.stringify(rows.map((q: any) => [q.quest_id, Number(q.state)])) !== JSON.stringify([...CHAPTER1.map((qid) => [qid, 2]), [1016, 1]])) fail(`quest rows ${JSON.stringify(rows)}`);
  if (vars.length !== 1 || vars[0].key !== "f1_guide" || Number(vars[0].value) !== 1) fail(`char_reg_num ${JSON.stringify(vars)}`);
  if (z !== inv!.zeny) fail(`DB zeny ${z} != ${inv!.zeny}`);
  say(`OK: DB ${schema}: quests ${CHAPTER1[0]}-${CHAPTER1.at(-1)} all completed, f1_guide=1, zeny ${z}`);
} else say(`NOTE: DB rows step skipped (${health.store === "pglite" ? "server store is pglite: its database is inside the server process" : "QUEST_DB_CHECK=0"})`);

// 15) relog: the log is read back (completed quests are kept, not shown), no icon anywhere, Orrin still talks about the road
leaving = true;
await r.leave();
await wait(800);
const again = await joinAs(url, ACCOUNT, ACCOUNT, false);
let q2: QuestLogEvent | undefined;
const m2: QuestMarkEvent[] = [];
again.room.onMessage(Msg.quests, (m: QuestLogEvent) => { q2 = m; });
again.room.onMessage(Msg.questMark, (m: QuestMarkEvent) => { m2.push(m); });
again.room.onMessage("*", () => {});
await wait(1500);
if (!q2 || q2.quests.map((q) => q.id).join() !== "1016") fail(`after relog the quest list should hold only "A Warm Hearth" (1016), got ${JSON.stringify(q2)}`);
const shown2 = Object.fromEntries(m2.filter((m) => m.icon !== QTYPE.NONE).map((m) => [m.npc, m.icon]));
if (JSON.stringify(shown2) !== JSON.stringify({ npc_hearthkeeper: QTYPE.QUEST2, npc_pella: QTYPE.QUEST }) && JSON.stringify(shown2) !== JSON.stringify({ npc_pella: QTYPE.QUEST, npc_hearthkeeper: QTYPE.QUEST2 }))
  fail(`after relog only Bren's "?" and Pella's "!" expected, got ${JSON.stringify(m2)}`);
say("OK: relog: completed quests kept in the DB, only the next stops marked (Bren ?, Pella !)");
await again.room.leave();
await wait(500);
clearTimeout(timeout);
await deleteChar(url, token, char);
await db?.end();
if (!walkable(buildMap(TOWN, 1337), guide.x, guide.y)) fail("guide not on a walkable cell");
say(`PASS: Floor 1 Chapter 1 end to end (${minutes} min)`);
process.exit(0);
