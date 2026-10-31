// End-to-end boss check (C07), dev server only: two bots, a mini boss with slaves and an MVP spawned through the server's dev-only GM
// shortcut (Msg.devBoss; refused when NODE_ENV=production). Checks: boss flags in the state, slaves on spawn and dying with their master,
// the MVP going to the top damage dealer (not the killer), the MVP effect + reward messages, the tomb 9 s after the death with its dialog
// (boss, time, killer), and the tomb leaving when the boss spawns again.
//   pnpm --filter client boss [serverUrl]
import { Client } from "@colyseus/sdk";
import { Msg, type ChangeMapEvent, type DevBossMsg, type ItemGetEvent, type MvpEvent, type MvpRewardEvent, type NpcMesEvent } from "../../shared/protocol.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { MOBS } from "../../shared/rules/data.ts";
import { buildMap, roomOf, type MapName } from "../../shared/maps.ts";
import { distance, walkable } from "../../shared/map.ts";
import { deleteChar, joinAs } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 150 s"), 150_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(100); } };

/** A fresh character logs in on the map room and is sent on to its last map (clif_changemap): follow it, both bots land in one room. */
async function enter(name: string) {
  const j = await joinAs(url, name, name, true);
  let to: ChangeMapEvent | undefined;
  j.room.onMessage(Msg.changeMap, (m: ChangeMapEvent) => { to = m; });
  j.room.onMessage("*", () => {});
  await wait(1200);
  if (!to) return j;
  await j.room.leave();
  const room = await new Client(url).joinOrCreate(roomOf(to.map as MapName), { token: j.token, charId: j.char.id });
  return { ...j, room };
}
const A = await enter("boss_bot_a"), B = await enter("boss_bot_b");
const bots = [A, B];
const S = (A.room.state as any);
const quiet = [Msg.hit, Msg.chat, Msg.exp, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.status, Msg.takeItem, Msg.inv, Msg.quests, Msg.questMark, Msg.emotion, Msg.npcTalk,
  Msg.skills, Msg.cutin, Msg.npcNextBtn, Msg.npcClear, Msg.npcEnd, Msg.announce];
for (const b of bots) {
  for (const t of quiet) b.room.onMessage(t, () => {});
  b.room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === b.room.sessionId) b.room.send(Msg.respawn); });
}
const mvpFx: { bot: string; m: MvpEvent }[] = [], rewards: Record<string, MvpRewardEvent[]> = { a: [], b: [] }, items: ItemGetEvent[] = [], mes: NpcMesEvent[] = [];
const deaths: Record<string, number> = {};
let notices: string[] = [];
for (const [k, b] of [["a", A], ["b", B]] as const) {
  b.room.onMessage(Msg.mvp, (m: MvpEvent) => mvpFx.push({ bot: k, m }));
  b.room.onMessage(Msg.mvpReward, (m: MvpRewardEvent) => rewards[k].push(m));
  b.room.onMessage(Msg.itemGet, (m: ItemGetEvent) => { if (k === "a") items.push(m); });
  b.room.onMessage(Msg.notice, (m: { text: string }) => notices.push(m.text));
}
A.room.onMessage(Msg.npcMes, (m: NpcMesEvent) => mes.push(m));
A.room.onMessage(Msg.npcCloseBtn, () => {});
A.room.onMessage(Msg.die, (m: { id: string }) => { deaths[m.id] ??= Date.now(); if (process.env.BOSS_DEBUG) console.log("die", m); });

const map = buildMap(S.map as MapName, S.seed);
const me = () => S.players.get(A.room.sessionId);
await until(() => me() && S.players.get(B.room.sessionId), 5000, "bots did not join");
// a walkable cell 9 cells from the bots (outside every aggro range, inside the 14-cell area of the events and the 15 of an NPC click)
const here = { x: Math.round(me().x), y: Math.round(me().y) };
const far = (() => {
  for (const [dx, dy] of [[9, 0], [-9, 0], [0, 9], [0, -9], [7, 7], [-7, -7], [7, -7], [-7, 7]]) {
    const c = { x: here.x + dx, y: here.y + dy };
    if (walkable(map, c.x, c.y) && distance(c.x - here.x, c.y - here.y) >= 7) return c;
  }
  return fail("no free cell to spawn the boss on");
})();
const dev = (b: typeof A, m: DevBossMsg) => b.room.send(Msg.devBoss, m);
const live = (mobId: number) => [...S.monsters.entries()].find(([, m]: any) => m.mobId === mobId && !m.dead) as [string, any] | undefined;
const slavesOf = (ids: number[]) => [...S.monsters.entries()].filter(([k, m]: any) => String(k).startsWith("b") && ids.includes(m.mobId) && !m.dead).length;
const tombOf = (id: string) => S.npcs.get(`tomb_${id}`);
let tombCount = 0;
const ids: string[] = [];

async function kill(id: string, mvpShare: number, killerShare: number) {
  const m = S.monsters.get(id);
  dev(A, { op: "hurt", id, dmg: Math.floor(m.maxHp * mvpShare) });
  await wait(200);
  dev(B, { op: "hurt", id, dmg: Math.floor(m.maxHp * killerShare) });
  await wait(200);
  dev(B, { op: "kill", id });
  await until(() => S.monsters.get(id)?.dead, 3000, `${id} did not die`);
}

// ---- 1) a mini boss: wire flag, slaves on spawn, slaves die with it, tomb (boss_monster line) but no MVP ----
const mini = MOBS.find((m) => m.bossType === "Boss" && m.slaves.length) ?? fail("no mini boss with slaves in mobs.json");
dev(A, { op: "spawn", id: "-", mobId: mini.id, x: far.x, y: far.y });
const [miniId, miniMon] = await until(() => live(mini.id), 5000, `${mini.name} did not spawn`);
ids.push(miniId);
if (miniMon.boss !== 1) fail(`${mini.name}: Monster.boss ${miniMon.boss}, expected 1`);
const slaveIds = [...new Set(mini.slaves.flatMap((s) => s.ids))];
const onspawn = mini.slaves.find((s) => s.cond === "onspawn");
await until(() => slavesOf(slaveIds) >= (onspawn?.amount ?? 1), 3000, `${mini.name}: ${slavesOf(slaveIds)} slaves after spawn, expected ${onspawn?.amount}`);
console.log(`OK: ${mini.name} (boss flag 1) spawned with ${slavesOf(slaveIds)} slaves`);
await kill(miniId, 0.6, 0.3);
await until(() => slavesOf(slaveIds) === 0, 4000, `${mini.name}: slaves still alive after the master died`);
if (mvpFx.length) fail(`${mini.name} is not an MVP but an MVP effect came`);
if (rewards.a.length || rewards.b.length) fail("mini boss gave an MVP reward");
console.log("OK: slaves died with their master, no MVP effect for a mini boss");
const t0 = await until(() => deaths[miniId], 4000, "no die event for the mini boss");
await until(() => tombOf(miniId), 13_000, `no tomb for ${mini.name}`);
const delay = Date.now() - t0;
if (delay < 8000 || delay > 11_500) fail(`tomb appeared after ${delay} ms, expected ~9000`);
if (tombOf(miniId).kind !== "tomb") fail("tomb npc has the wrong kind");
tombCount++;
console.log(`OK: mini boss tomb appeared after ${delay} ms`);

// ---- 2) the MVP: top damage dealer (A) gets the effect and reward even though B lands the killing blow ----
const mvpMob = MOBS.find((m) => m.bossType === "Mvp") ?? fail("no MVP in mobs.json");
dev(A, { op: "spawn", id: "-", mobId: mvpMob.id, x: far.x, y: far.y });
const [mvpId, mvpMon] = await until(() => live(mvpMob.id), 5000, `${mvpMob.name} did not spawn`);
ids.push(mvpId);
if (mvpMon.boss !== 2) fail(`${mvpMob.name}: Monster.boss ${mvpMon.boss}, expected 2`);
await kill(mvpId, 0.6, 0.3);
await until(() => mvpFx.length >= 2, 3000, "the MVP effect did not reach both bots");
if (mvpFx.some((x) => x.m.id !== A.room.sessionId)) fail("the MVP effect names the killer, not the top damage dealer");
if (mvpFx[0].m.boss !== mvpMob.name) fail(`MVP effect names ${mvpFx[0].m.boss}`);
await until(() => rewards.a.length, 3000, "the MVP got no reward message");
if (rewards.b.length) fail("the killer (not the MVP) got an MVP reward");
const rw = rewards.a[0];
console.log(`OK: MVP effect on the top damage dealer, reward: exp ${rw.exp}, prize ${rw.itemId ? ITEMS.get(rw.itemId)?.name : "none this time"}${rw.floor ? " (on the floor)" : ""}`);
if (rw.itemId && !rw.floor) {
  await until(() => items.some((i) => i.itemId === rw.itemId), 2000, "prize item not announced to the MVP");
  console.log("OK: prize went into the MVP's inventory");
}
if (process.env.BOSS_DEBUG) console.log("A", me().x, me().y, me().dead, "mvp", S.monsters.get(mvpId)?.x, S.monsters.get(mvpId)?.y, Object.keys(deaths));
const t1 = await until(() => deaths[mvpId], 4000, "no die event for the MVP");
await until(() => tombOf(mvpId), 13_000, `no tomb for ${mvpMob.name}`);
tombCount++;
console.log(`OK: MVP tomb appeared after ${Date.now() - t1} ms`);

// ---- 3) the tomb dialog: boss, time of death, killer (the MVP) ----
A.room.send(Msg.npc, { id: `tomb_${mvpId}` });
await until(() => mes.some((m) => m.text.includes("Defeated by")) && mes.length >= 5, 3000, "tomb dialog did not open");
const text = mes.map((m) => m.text).join("\n");
if (!text.includes(mvpMob.name) || !/\d\d:\d\d/.test(text) || !text.includes("boss_bot_a")) fail(`tomb dialog wrong:\n${text}`);
console.log("OK: tomb dialog names the boss, the time and the MVP");
A.room.send(Msg.npcClose, { npc: `tomb_${mvpId}` });

// ---- 4) the tomb goes when the boss is back (respawn 15-20 s) ----
await until(() => S.monsters.get(mvpId) && !S.monsters.get(mvpId).dead && !tombOf(mvpId), 30_000, "tomb still there after the boss respawned");
console.log("OK: tomb removed when the boss respawned");

// clean up: the test lines and the characters
for (const id of ids) dev(A, { op: "remove", id });
await wait(300);
for (const b of bots) { b.room.leave(); await deleteChar(url, b.token, b.char); }
console.log(`PASS: boss bot (${tombCount} tombs)`);
process.exit(0);
