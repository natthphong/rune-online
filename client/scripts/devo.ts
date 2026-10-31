// End-to-end check of floor 2's MVP Devo (shared/rules/bossmoves.ts, server/src/boss.ts), dev server only (the boss bot's GM shortcut,
// Msg.devBoss, is refused in production): one sturdy character, Devo spawned a few cells away. Checks: the charge telegraph (the boss
// stands still for the wind-up, then dashes and ends far from where it started), the impact (damage + the bot thrown >= 2 cells), the
// phase-2 kids (3 of Cragcub below 50 % HP + the locale-keyed chat cue), the enrage shout below 25 %. Own account (devo_bot).
//   pnpm --filter client devo [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg, type BossChargeEvent, type BossSlamEvent, type BossSplitEvent, type DevBossMsg, type HitEvent } from "../../shared/protocol.ts";
import { buildMap, type MapName } from "../../shared/maps.ts";
import { distance, walkable } from "../../shared/map.ts";
import { BOSS_MOVES, DEVO } from "../../shared/rules/bossmoves.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 120 s"), 120_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(50); } };

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const token = await login(url, "devo_bot");
const NAME = "DevoProbe";
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) if (c.name === NAME) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "M", hair: 1 });
await db.query("UPDATE characters SET job = 'Swordman', level = 99, vit = 99, hp = NULL WHERE id = $1", [char.id]); // sturdy enough to take a few rams
const room = await botRoom(url, token, char);
const charges: BossChargeEvent[] = [], slams: BossSlamEvent[] = [], splits: BossSplitEvent[] = [], hits: HitEvent[] = [];
room.onMessage(Msg.bossCharge, (m: BossChargeEvent) => charges.push(m));
room.onMessage(Msg.bossSlam, (m: BossSlamEvent) => slams.push(m));
room.onMessage(Msg.bossSplit, (m: BossSplitEvent) => splits.push(m));
room.onMessage(Msg.hit, (m: HitEvent) => hits.push(m));
let st: any;
room.onMessage(Msg.status, (m: any) => { st = m; });
room.onMessage("*", () => {});
const S = () => room.state as any;
await until(() => S().players?.get(room.sessionId), 8000, "my character in the room");
await wait(500);
const me = () => S().players.get(room.sessionId);
const cellOf = (e: any) => ({ x: Math.round(e.x), y: Math.round(e.y) });
const map = buildMap(S().map as MapName, S().seed);
// open ground for the fight: the nearest cell with a 3-row, 17-cell lane of walkable cells (a goat needs room to run, 5 behind the bot and 11 ahead), the bot walks there
const start = cellOf(me());
const open17 = (c: { x: number; y: number }) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -5; dx <= 11; dx++) if (!walkable(map, c.x + dx, c.y + dy)) return false; return true; };
const arena = (() => {
  let best: { x: number; y: number } | undefined, bd = 1e9;
  for (let y = 2; y < map.h - 2; y++) for (let x = 6; x < map.w - 12; x++) { const d = distance(x - start.x, y - start.y); if (d < bd && open17({ x, y })) { best = { x, y }; bd = d; } }
  return best ?? fail("no open ground on this map");
})();
if (!(await walkNear(room, () => arena, 1, 60_000))) fail(`could not walk to the open ground at ${JSON.stringify(arena)}`);
await wait(600);
const here = cellOf(me());
const spot = { x: here.x + 6, y: here.y }; // 6 cells east on open ground: a clear lane
const dev = (m: DevBossMsg) => room.send(Msg.devBoss, m);
dev({ op: "spawn", id: "-", mobId: DEVO, x: spot.x, y: spot.y });
const [bid, boss] = await until(() => [...S().monsters.entries()].find(([, m]: any) => m.mobId === DEVO && !m.dead) as [string, any] | undefined, 5000, "Devo did not spawn");
if (boss.boss !== 2) fail(`Devo Monster.boss ${boss.boss}, expected 2 (MVP)`);
console.log(`OK: Devo (MVP) spawned at ${spot.x},${spot.y}, HP ${boss.hp}/${boss.maxHp}, I am at ${here.x},${here.y}`);
const ch = BOSS_MOVES.get(DEVO)!.charge!;

// ---- the charge: telegraph, then the dash ----
// the protection a fresh arrival has ends when the character acts: step once so the goat may target it
room.send(Msg.move, { x: here.x, y: here.y + (walkable(map, here.x, here.y + 1) ? 1 : -1) });
if (process.env.DEVO_DEBUG) setInterval(() => console.log(`map ${S().map} boss ${S().monsters.get(bid)?.x?.toFixed(1)},${S().monsters.get(bid)?.y?.toFixed(1)} me ${me()?.x?.toFixed(1)},${me()?.y?.toFixed(1)} hp ${st?.hp}/${st?.maxHp} dead ${me()?.dead} ev ${charges.length}/${slams.length}/${hits.length}`), 2000);
const wind = await until(() => charges.find((c) => c.kind === "charge"), 40_000, "no charge telegraph in 40 s");
const p0 = cellOf(boss), t0 = Date.now();
if (wind.windMs !== ch.windMs) fail(`wind-up ${wind.windMs} ms, expected ${ch.windMs}`);
await wait(wind.windMs - 250);
const pw = cellOf(boss);
if (distance(pw.x - p0.x, pw.y - p0.y) > 1) fail(`Devo moved ${JSON.stringify(p0)} -> ${JSON.stringify(pw)} during its wind-up`);
await wait(250 + wind.dashMs + 400);
const p1 = cellOf(boss);
const ran = distance(p1.x - p0.x, p1.y - p0.y);
if (ran < 3) fail(`Devo ran only ${ran} cells (${JSON.stringify(p0)} -> ${JSON.stringify(p1)}) after its charge`);
console.log(`OK: charge telegraphed ${wind.windMs} ms (boss still), then dashed ${ran} cells to ${p1.x},${p1.y} in ${wind.dashMs} ms (event ${Date.now() - t0} ms ago)`);
const slam = await until(() => slams.find((s) => s.from === bid && s.to === room.sessionId), 15_000, "no impact on me (bossSlam)");
if (!hits.some((h) => h.from === bid && h.to === room.sessionId && h.dmg > 0)) fail("the slam came without a damage hit");
console.log(`OK: ${slam.kind} slammed me (thrown to ${slam.kx},${slam.ky}, stun ${slam.stunMs} ms), damage ${hits.filter((h) => h.from === bid).map((h) => h.dmg).join("/")}`);

// ---- phase 2: the kids below 50 %, the enrage cue below 25 % ----
const hurtTo = async (pct: number) => { const m = S().monsters.get(bid); const dmg = m.hp - Math.floor(m.maxHp * pct / 100); if (dmg > 0) dev({ op: "hurt", id: bid, dmg }); await wait(400); };
const kids = () => [...S().monsters.entries()].filter(([k, m]: any) => String(k).startsWith("b") && m.mobId === BOSS_MOVES.get(DEVO)!.split![0].ids[0] && !m.dead).length;
if (kids() !== 0 || splits.length) fail("kids/cues before phase 2");
await hurtTo(49);
await until(() => kids() >= 3, 4000, `no kids after Devo fell under 50 % (${kids()})`);
const s1 = splits.find((s) => s.key === "boss.devo.kids") ?? fail("no kids cue with its locale key");
console.log(`OK: phase 2: ${kids()} kids summoned, cue "${s1.text}" (${s1.key}, ${s1.kind})`);
await hurtTo(24);
const s2 = await until(() => splits.find((s) => s.key === "boss.devo.rage"), 4000, "no enrage cue below 25 %");
console.log(`OK: enrage cue "${s2.text}" (${s2.key})`);
const more = charges.length;
await wait(12_000);
console.log(`OK: ${charges.length - more} more telegraphs in 12 s while enraged (${charges.length} in total)`);

dev({ op: "remove", id: bid });
await wait(300);
await room.leave();
await deleteChar(url, token, char);
await db.end();
console.log("PASS: devo bot");
process.exit(0);
