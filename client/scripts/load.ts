// Load test: N bots on the busiest field click-walk and attack; reports bytes/msgs per client and move->response latency.
//   pnpm --filter client load [url] [N] [seconds]     (server side: start it with RO_TICK_STATS=1 for tick p50/p95/max)
import { Room } from "@colyseus/sdk";
import { Msg } from "../../shared/protocol.ts";
import { joinAs, routeTo, type BotRoom } from "./bot.ts";
import { FIELD } from "../../shared/maps.ts";
import { mapOfState } from "../../shared/maps.ts";
import { OFFICIAL_WALKPATH, walkable } from "../../shared/map.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const N = Number(process.argv[3] ?? 5), SECS = Number(process.argv[4] ?? 60);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pct = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN;

// count raw bytes / messages per room instance (every incoming websocket frame)
const bytes = new Map<Room, { b: number; m: number }>();
const orig = (Room.prototype as any).onMessageCallback;
(Room.prototype as any).onMessageCallback = function (ev: any) {
  const c = bytes.get(this) ?? { b: 0, m: 0 }; bytes.set(this, c);
  c.b += ev.data?.byteLength ?? ev.data?.length ?? 0; c.m++;
  return orig.call(this, ev);
};
const totals = () => { let b = 0, m = 0; for (const c of bytes.values()) { b += c.b; m += c.m; } return { b, m }; };

const lat: number[] = [];
let sent = 0, attacks = 0;
async function bot(i: number, stop: () => boolean) {
  const { room } = await joinAs(url, `load_bot_${i}`, `LoadBot${i}`, true);
  for (const t of [Msg.hit, Msg.chat, Msg.statUpAck, Msg.takeItem, Msg.heal, Msg.die]) room.onMessage(t, () => {});
  room.onMessage("*", () => {});
  await room.travel(FIELD);
  while (!stop()) {
    const r = room as BotRoom, S = r.state as any, me = S.players.get(r.sessionId);
    if (!me || me.dead) { if (me?.dead) r.send(Msg.respawn); await sleep(500); if (r.map !== FIELD) await r.travel(FIELD).catch(() => {}); continue; }
    if (me.sitting) r.send(Msg.sit);
    const map = mapOfState(S), here = { x: Math.round(me.x), y: Math.round(me.y) };
    if (Math.random() < 0.3) { // attack the nearest live monster
      let best: string | undefined, bd = 1e9;
      for (const [id, m] of S.monsters.entries()) { if ((m as any).dead) continue; const d = Math.hypot((m as any).x - me.x, (m as any).y - me.y); if (d < bd) { bd = d; best = id; } }
      if (best && bd < 12) { r.send(Msg.attack, { id: best }); attacks++; await sleep(500 + Math.random() * 500); continue; }
    }
    let to = { x: here.x + Math.round((Math.random() - 0.5) * 24), y: here.y + Math.round((Math.random() - 0.5) * 24) };
    if (!walkable(map, to.x, to.y)) continue;
    const path = routeTo(map, here, to);
    if (!path.length) continue;
    const target = path[Math.min(path.length, OFFICIAL_WALKPATH - 4) - 1];
    const x0 = me.x, y0 = me.y, t0 = performance.now();
    r.send(Msg.move, target); sent++;
    for (let k = 0; k < 100; k++) { // poll for the first change of our own position
      await sleep(5);
      const p = S.players.get(r.sessionId);
      if (!p || p.x !== x0 || p.y !== y0) { lat.push(performance.now() - t0); break; }
    }
    await sleep(500 + Math.random() * 500);
  }
  await room.leave().catch(() => {});
}

let done = false;
const bots: Promise<void>[] = [];
for (let i = 1; i <= N; i++) { bots.push(bot(i, () => done).catch((e) => console.error(`bot ${i}:`, e.message))); await sleep(150); }
await sleep(5000); // settle, then measure
const a = totals(), t0 = Date.now(), lat0 = lat.length;
await sleep(SECS * 1000);
const b = totals(), dt = (Date.now() - t0) / 1000;
const l = lat.slice(lat0);
done = true;
await Promise.all(bots);
console.log(JSON.stringify({ N, secs: dt, bytesPerClientPerSec: Math.round((b.b - a.b) / dt / N), msgsPerClientPerSec: +((b.m - a.m) / dt / N).toFixed(1),
  moveSamples: l.length, moveMsP50: +pct(l, 0.5).toFixed(1), moveMsP95: +pct(l, 0.95).toFixed(1), attacks }));
process.exit(0);
