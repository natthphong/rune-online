// 2.9.0 end-to-end check of the roaming mini-bosses (shared/minibosses.ts, server/src/minibosses.ts, server/src/boss.ts), dev server
// only (planted character, Msg.devBoss "mini"). One sturdy climber on floor 1's Greenhollow Wilds:
//   floor 1  Ashgrim and Ceruleen forced here (server-wide announce with the floor and level);
//            Ashgrim's ultimate, the Long Harvest: a sweep of r >= 40 told to the whole map, >= 3 safe circles, one within 11 cells of
//            the bot; the bot runs into it and the reap does not touch it;
//            Ceruleen's phase change below 50 % HP: Msg.bossForm (ms > 0), then a NEW monster of the phase-2 form on its cell with the
//            same HP share (Msg.bossForm ms = 0, from = the old id);
//            both die: the "defeated ... will rise again on floor N" announce;
//   floor 2  the bot walks up to the Sunscour Ruins; both forced again: their max HP / level there are higher than on floor 1.
//   pnpm --filter client minibosses [url]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Msg, type AnnounceEvent, type BossFormEvent, type BossImpactEvent, type BossTeleEvent, type DevBossMsg, type HitEvent } from "../../shared/protocol.ts";
import { F1_WILD, F2_WILD, type MapName } from "../../shared/maps.ts";
import { MINIS, miniOf } from "../../shared/minibosses.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
import { wildGate } from "../../shared/wilds.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login, walkNear } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 480 s"), 480_000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(50); } };

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

const token = await login(url, "minis_bot");
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) await deleteChar(url, token, c);
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: "MiniHunter", gender: "M", hair: 2 });
const start = wildGate(F1_WILD).arrival;
await db.query("UPDATE characters SET job = 'Swordman', level = 99, vit = 99, agi = 80, str = 60, hp = NULL, last_map = $2, x = $3, y = $4 WHERE id = $1",
  [char.id, F1_WILD, start.x, start.y + 14]);
const room = await botRoom(url, token, char, F1_WILD as MapName);
const announces: string[] = [], forms: BossFormEvent[] = [], teles: BossTeleEvent[] = [], impacts: BossImpactEvent[] = [], hits: HitEvent[] = [];
room.onMessage(Msg.announce, (m: AnnounceEvent) => announces.push(m.text));
room.onMessage(Msg.bossForm, (m: BossFormEvent) => forms.push(m));
room.onMessage(Msg.bossTele, (m: BossTeleEvent) => teles.push(m));
room.onMessage(Msg.bossImpact, (m: BossImpactEvent) => impacts.push(m));
const aggro: string[] = [], notes: string[] = [];
room.onMessage(Msg.notice, (m: { text: string }) => notes.push(m.text));
room.onMessage(Msg.bossAggro, (m: { id: string; to: string }) => { if (m.to === room.sessionId) aggro.push(m.id); });
room.onMessage(Msg.hit, (m: HitEvent) => { if (m.to === room.sessionId) hits.push(m); });
room.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => room.send(Msg.npcClose, { npc: m.npc }));
room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) fail(`the Lv 99 bot died on ${room.map}`); });
room.onMessage("*", () => {});
const S = () => room.state as any;
const me = () => S().players?.get(room.sessionId);
const cellOf = (e: any) => ({ x: Math.round(e.x), y: Math.round(e.y) });
const dev = (m: DevBossMsg) => room.send(Msg.devBoss, m);
await until(() => me() && room.map === F1_WILD, 8000, "my character on the Greenhollow Wilds");
await walkNear(room, () => ({ x: start.x, y: start.y + 12 }), 0, 5000); // a step ends the login protection (monsters ignore a protected player)
await wait(800);

/** Force a mini-boss 8 cells east of the bot; its id, monster and floor row. */
async function force(key: string, floor: number) {
  const mini = MINIS.find((m) => m.key === key)!, mobId = mini.ids[floor as 1 | 2 | 3];
  announces.length = 0;
  const before = new Set(S().monsters.keys()); // one may already roam this map (it rose here on its own): the forced one is a NEW id
  dev({ op: "mini", id: "", move: key, x: 1 });
  const [id, m] = await until(() => [...S().monsters.entries()].find(([k, x]: any) => !before.has(k) && x.mobId === mobId && !x.dead) as [string, any] | undefined, 6000, `${key} did not rise on floor ${floor}`);
  const ann = await until(() => announces.find((a) => a.includes(mini.name) && a.includes(`floor ${floor}`)), 5000, `no announce for ${key} on floor ${floor}`);
  say(`OK: ${ann}  (HP ${m.maxHp}, Lv ${MOB_BY_ID.get(mobId)!.level})`);
  return { id, m, mobId };
}
const hpOf: Record<string, number[]> = { ashgrim: [], ceruleen: [] };

// ---- floor 1: Ashgrim's Long Harvest ----
const ash = await force("ashgrim", 1);
hpOf.ashgrim.push(ash.m.maxHp);
await until(() => aggro.includes(ash.id), 6000, "Ashgrim did not turn on the bot at sight");
dev({ op: "hurt", id: ash.id, dmg: Math.ceil(ash.m.maxHp * 0.25) });
await wait(400);
teles.length = impacts.length = 0;
dev({ op: "move", id: ash.id, move: "reap" });
const reap = await until(() => teles.find((t) => t.id === ash.id && t.move === "reap"), 4000, "no Long Harvest telegraph");
if (reap.shape !== "sweep" || reap.r < 40 || (reap.safe?.length ?? 0) < 3) fail(`Long Harvest: ${JSON.stringify({ shape: reap.shape, r: reap.r, safe: reap.safe?.length })}`);
const c0 = cellOf(me()), near = reap.safe!.map((z) => ({ ...z, d: Math.hypot(z.x - c0.x, z.y - c0.y) })).sort((a, b) => a.d - b.d)[0];
if (near.d > 11) fail(`nearest safe circle ${near.d.toFixed(1)} cells away`);
say(`OK: Long Harvest telegraph r ${reap.r}, ${reap.safe!.length} safe circles, nearest ${near.d.toFixed(1)} cells, ${reap.ms} ms to run`);
if (!(await walkNear(room, () => near, 0, reap.ms - 300))) fail("could not reach the safe circle in time");
const hitsBefore = hits.length;
await until(() => impacts.find((i) => i.id === ash.id && i.move === "reap"), reap.ms + 2000, "no Long Harvest impact");
await wait(150);
const reaped = hits.slice(hitsBefore).filter((h) => h.from === ash.id && (h as any).dmg > 1500);
if (reaped.length) fail(`the reap hit the bot inside a safe circle: ${JSON.stringify(reaped)}`);
say(`OK: inside the safe circle at ${cellOf(me()).x},${cellOf(me()).y} the reap missed the bot`);

// ---- floor 1: Ceruleen's phase change ----
const cer = await force("ceruleen", 1);
hpOf.ceruleen.push(cer.m.maxHp);
dev({ op: "hurt", id: cer.id, dmg: Math.ceil(cer.m.maxHp * 0.45) });
await wait(600);
forms.length = 0;
dev({ op: "hurt", id: cer.id, dmg: Math.ceil(cer.m.maxHp * 0.06) });
const start2 = await until(() => forms.find((f) => f.id === cer.id && f.ms > 0), 4000, "no transform start (Msg.bossForm)");
const done = await until(() => forms.find((f) => f.ms === 0 && f.from === cer.id), start2.ms + 3000, "no transform end");
const nm = await until(() => S().monsters.get(done.id), 2000, "the phase-2 monster is not in the state");
const info = miniOf(nm.mobId);
if (info?.phase !== 2 || info.floor !== 1) fail(`phase-2 monster is mob ${nm.mobId}`);
if (S().monsters.get(cer.id)) fail("the phase-1 monster is still there");
const share = nm.hp / nm.maxHp;
if (share > 0.52 || share < 0.4) fail(`phase 2 HP share ${share.toFixed(2)}`);
say(`OK: Ceruleen turned (${start2.ms} ms) into mob ${nm.mobId} at ${Math.round(share * 100)} % HP`);

// both die: announced and rolled onto a floor
announces.length = 0;
dev({ op: "kill", id: ash.id });
dev({ op: "kill", id: done.id });
await until(() => announces.filter((a) => a.includes("has been defeated on floor 1")).length >= 2, 6000, `no defeat announces (${announces.join(" | ")})`);
say(`OK: ${announces.find((a) => a.includes("defeated"))}`);

// ---- floor 2: the same two, stronger ----
dev({ op: "var", id: "-", move: "f1_seal", dmg: 1 });
dev({ op: "var", id: "-", move: "tower_f1", dmg: 1 });
await wait(300);
await room.travel(F2_WILD as MapName, 240_000);
await until(() => me() && room.map === F2_WILD, 8000, "on the Sunscour Ruins");
await wait(800);
for (const key of ["ashgrim", "ceruleen"]) {
  const x = await force(key, 2);
  hpOf[key].push(x.m.maxHp);
  // the boss feel rule: with a target it never stands idle longer than IDLE_MAX_MS (550 ms); 8 s of fight, then its own numbers
  room.send(Msg.attack, { id: x.id });
  await wait(8000);
  notes.length = 0;
  dev({ op: "stat", id: x.id });
  const st = await until(() => notes.find((n) => n.startsWith(`[dev] stat ${x.id}`)), 3000, `no stat for ${key}`);
  const fight = JSON.parse(st.slice(`[dev] stat ${x.id} `.length) || "null");
  if (!fight || fight.idleMax > 600) fail(`${key} idle ${fight?.idleMax} ms with a target`);
  say(`OK: ${key} on floor 2 in 8 s: longest idle ${fight.idleMax} ms, moves ${JSON.stringify(fight.used)}`);
  dev({ op: "kill", id: x.id });
  await wait(300);
}
for (const key of ["ashgrim", "ceruleen"]) if (!(hpOf[key][1] > hpOf[key][0])) fail(`${key} is not stronger on floor 2: ${hpOf[key]}`);
say(`OK scaling: Ashgrim HP floor 1 ${hpOf.ashgrim[0]} < floor 2 ${hpOf.ashgrim[1]}; Ceruleen ${hpOf.ceruleen[0]} < ${hpOf.ceruleen[1]}`);
void walkNear;
await room.leave();
await deleteChar(url, token, char);
await db.end();
console.log("PASS: minibosses bot");
process.exit(0);
