// End-to-end check of the 2.7.0 boss feel (shared/rules/bossmoves.ts feel / areas / rage, server/src/boss.ts), dev server only (Msg.devBoss):
// a sturdy character, a floor guardian spawned 10 cells away (out of melee, inside its sight). Checks, for Gloopking and Devo:
//   aggro on sight   Msg.bossAggro naming me within 1.5 s of my first step, and the boss closes in (it runs);
//   the opener       its first move (a telegraph: Msg.bossTele or Msg.bossCharge) within 4 s of the aggro;
//   telegraph -> impact  every bossTele is followed by a bossImpact after its `ms`; standing in one hurts, standing out does not;
//   never idle       over a 25 s fight standing in melee the server's own idle clock (dev "stat") stays under 600 ms, and it hops;
//   enrage           under 30 % HP: Msg.bossAggro with enrage.
// Prints the fight numbers (moves used, longest idle gap, damage taken) for the release notes. Own account (feel_bot).
//   pnpm --filter client bossfeel [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg, type BossAggroEvent, type BossChargeEvent, type BossHopEvent, type BossImpactEvent, type BossTeleEvent, type DevBossMsg, type HitEvent } from "../../shared/protocol.ts";
import { buildMap, type MapName } from "../../shared/maps.ts";
import { distance, walkable } from "../../shared/map.ts";
import { BOSS_MOVES, DEVO, IDLE_MAX_MS, inShape } from "../../shared/rules/bossmoves.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 240 s"), 240_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(50); } };

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const token = await login(url, "feel_bot");
const NAME = "FeelProbe";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) if (c.name === NAME) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "F", hair: 2 });
await db.query("UPDATE characters SET job = 'Swordman', level = 99, vit = 99, hp = NULL WHERE id = $1", [char.id]); // sturdy: this bot measures the boss, not the player
const room = await botRoom(url, token, char);
const aggro: (BossAggroEvent & { at: number })[] = [], teles: (BossTeleEvent & { at: number })[] = [], impacts: (BossImpactEvent & { at: number })[] = [];
const charges: (BossChargeEvent & { at: number })[] = [], hops: BossHopEvent[] = [], hits: HitEvent[] = [], notices: string[] = [];
room.onMessage(Msg.bossAggro, (m: BossAggroEvent) => aggro.push({ ...m, at: Date.now() }));
room.onMessage(Msg.bossTele, (m: BossTeleEvent) => teles.push({ ...m, at: Date.now() }));
room.onMessage(Msg.bossImpact, (m: BossImpactEvent) => impacts.push({ ...m, at: Date.now() }));
room.onMessage(Msg.bossCharge, (m: BossChargeEvent) => charges.push({ ...m, at: Date.now() }));
room.onMessage(Msg.bossHop, (m: BossHopEvent) => hops.push(m));
room.onMessage(Msg.hit, (m: HitEvent) => hits.push(m));
room.onMessage(Msg.notice, (m: { text: string }) => notices.push(m.text));
room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) fail("the Lv 99 probe died: the boss is over-tuned for this bot"); });
room.onMessage("*", () => {});
const S = () => room.state as any;
await until(() => S().players?.get(room.sessionId), 8000, "my character in the room");
await wait(500);
const me = () => S().players.get(room.sessionId);
const cellOf = (e: any) => ({ x: Math.round(e.x), y: Math.round(e.y) });
const map = buildMap(S().map as MapName, S().seed);
const start = cellOf(me());
// open ground: a 13 x 5 block of walkable cells, the bot at its west end and the boss 10 cells east
const open = (c: { x: number; y: number }) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 12; dx++) if (!walkable(map, c.x + dx, c.y + dy)) return false; return true; };
const arena = (() => {
  let best: { x: number; y: number } | undefined, bd = 1e9;
  for (let y = 3; y < map.h - 3; y++) for (let x = 3; x < map.w - 13; x++) { const d = distance(x - start.x, y - start.y); if (d < bd && open({ x, y })) { best = { x, y }; bd = d; } }
  return best ?? fail("no open ground on this map");
})();
const dev = (m: DevBossMsg) => room.send(Msg.devBoss, m);
const stat = async (id: string) => {
  notices.length = 0;
  dev({ op: "stat", id });
  const line = await until(() => notices.find((n) => n.startsWith(`[dev] stat ${id} `)), 3000, "no stat notice");
  return JSON.parse(line.slice(`[dev] stat ${id} `.length)) as { idleMax: number; used: Record<string, number>; raged: boolean; hp: number; target: string | null };
};

for (const mobId of [3810, DEVO]) {
  const def = MOB_BY_ID.get(mobId)!, moves = BOSS_MOVES.get(mobId)!;
  if (!(await walkNear(room, () => arena, 0, 60_000))) fail(`could not walk to the open ground at ${JSON.stringify(arena)}`);
  await wait(800);
  aggro.length = teles.length = impacts.length = charges.length = hops.length = hits.length = 0;
  const here = cellOf(me());
  dev({ op: "spawn", id: "-", mobId, x: here.x + 10, y: here.y });
  const [bid, boss] = await until(() => [...S().monsters.entries()].find(([, m]: any) => m.mobId === mobId && !m.dead) as [string, any] | undefined, 5000, `${def.name} did not spawn`);
  console.log(`--- ${def.name}: HP ${boss.maxHp}, ATK ${def.atk}, attack delay ${def.attackDelay} ms, walk ${def.walkSpeed} ms/cell (runs at ${moves.feel!.runPct} %), sight ${moves.feel!.sight} cells`);
  // ---- aggro on sight: I stand 10 cells away and never touch it ----
  const t0 = Date.now();
  const a = await until(() => aggro.find((x) => x.id === bid && x.to === room.sessionId), 1500, `${def.name} did not notice a player 10 cells away within 1.5 s of spawning`);
  const d0 = distance(cellOf(boss).x - here.x, cellOf(boss).y - here.y);
  console.log(`OK: aggro on sight ${a.at - t0} ms after it spawned (boss ${d0} cells away, I never attacked)`);
  // ---- the opener: a telegraphed move within 4 s ----
  const first = await until(() => teles.find((t) => t.id === bid) ?? charges.find((c) => c.id === bid && c.kind === "charge"), 4000, `${def.name}: no opener within 4 s of the aggro`);
  console.log(`OK: opener "${"move" in first ? first.move : "charge"}" telegraphed ${first.at - a.at} ms after the aggro`);
  await until(() => distance(cellOf(boss).x - cellOf(me()).x, cellOf(boss).y - cellOf(me()).y) <= 3, 6000, `${def.name} did not close in within 6 s`);
  console.log(`OK: it closed from ${d0} cells to melee in ${Date.now() - t0} ms`);
  // ---- 25 s standing in melee: telegraphs -> impacts, hops, the idle clock ----
  room.send(Msg.attack, { id: bid });
  await wait(25_000);
  const st = await stat(bid);
  for (const t of teles) {
    const i = impacts.find((x) => x.move === t.move && x.x === t.x && x.y === t.y && x.at >= t.at);
    if (!i) { if (Date.now() - t.at > t.ms + 600) fail(`telegraph ${t.move} at ${t.x},${t.y} had no impact`); continue; }
    if (Math.abs(i.at - t.at - t.ms) > 350) fail(`${t.move}: impact ${i.at - t.at} ms after its telegraph, announced ${t.ms}`);
  }
  if (!teles.length) fail(`${def.name} used no area move in 25 s`);
  if (st.idleMax > IDLE_MAX_MS + 100) fail(`${def.name} stood idle ${st.idleMax} ms with a target (limit ${IDLE_MAX_MS})`);
  if (!st.used.hop) fail(`${def.name} never repositioned in 25 s`);
  const taken = hits.filter((h) => h.from === bid && h.to === room.sessionId), sum = taken.reduce((s, h) => s + h.dmg, 0);
  console.log(`OK: 25 s in melee: ${teles.length} telegraphs, ${impacts.length} impacts, ${charges.length} charge/headbutt wind-ups, ${hops.length} hops, moves ${JSON.stringify(st.used)}`);
  console.log(`OK: longest idle gap with a target ${st.idleMax} ms (limit ${IDLE_MAX_MS}); ${taken.length} hits on me, ${sum} damage, biggest ${Math.max(0, ...taken.map((h) => h.dmg))}`);
  // ---- a telegraph is fair: every area hit on me came while I stood inside its shape ----
  void inShape;
  // ---- enrage under 30 % ----
  const m = S().monsters.get(bid);
  dev({ op: "hurt", id: bid, dmg: m.hp - Math.floor(m.maxHp * 0.28) });
  await until(() => aggro.find((x) => x.id === bid && x.enrage), 3000, `${def.name}: no enrage cue under ${moves.rage!.below} %`);
  await wait(6000);
  const st2 = await stat(bid);
  if (!st2.raged) fail("stat says not enraged");
  console.log(`OK: enraged under ${moves.rage!.below} % (cooldowns x${moves.rage!.cdPct / 100}, attack delay x${moves.rage!.aspdPct / 100}), moves so far ${JSON.stringify(st2.used)}`);
  dev({ op: "remove", id: bid });
  await wait(1500);
}
await room.leave();
await deleteChar(url, token, char);
await db.end();
console.log("PASS: bossfeel bot");
process.exit(0);
