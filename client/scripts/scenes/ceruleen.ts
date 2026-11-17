// rec60 scene: Ceruleen, the jelly that turns into a swordsman of water. Rises 8 cells east, hurt to ~55 %, fought for 3 s, then hurt past
// 50 % so the transform plays on camera, then the human form is fought. PNGs of the key moments go to REC_SHOTS.
import type { RecCtx } from "../rec60.ts";

const SHOTS = process.env.REC_SHOTS ?? "/Users/AR697030/short/curate/ro-series/episodes/2026-11-17/dev-shots";
let boss = "";

const findBoss = (c: RecCtx) => c.ro((r) => [...r.entities.values()].find((e: any) => e.isMonster && !e.dead && e.name === "Ceruleen")?.id ?? "");
const hurtTo = (c: RecCtx, id: string, pct: number) => c.ro((r, a: { id: string; pct: number }) => {
  const e = r.entities.get(a.id);
  if (e) r.room.send("devBoss", { op: "hurt", id: a.id, dmg: Math.round(e.hp - e.maxHp * a.pct / 100) });
}, { id, pct });

export async function prepare(c: RecCtx) {
  await c.ro((r) => r.room.send("devBoss", { op: "mini", id: "", move: "ceruleen", x: 1 }));
  await c.page.waitForFunction(() => [...(window as any).__ro.entities.values()].some((e: any) => e.isMonster && !e.dead && e.name === "Ceruleen"), undefined, { timeout: 10_000 });
  boss = await findBoss(c);
  c.say(`Ceruleen: ${boss}`);
  await hurtTo(c, boss, 55);
  await c.wait(1200);
}

export default async function run(c: RecCtx) {
  const shot = (n: string) => c.page.screenshot({ path: `${SHOTS}/${n}.png` });
  for (let t = 0; t < 3000; t += 500) { await c.ro((r, id: string) => r.room.send("attack", { id }), boss); await c.wait(500); }
  await shot("04-ceruleen-jelly");
  await hurtTo(c, boss, 45); // under 50 %: the transform starts
  c.say("hurt past 50 %");
  await c.wait(700);
  await shot("04-ceruleen-transform-early");
  await c.wait(900);
  await shot("04-ceruleen-transform");
  await c.wait(1100);
  await shot("04-ceruleen-transform-end");
  await c.wait(900);
  const form = await findBoss(c); // the new entity (phase 2)
  c.say(`phase 2: ${form}`);
  await shot("04-ceruleen-phase2");
  for (let t = 0; t < 6000; t += 500) { await c.ro((r, id: string) => r.room.send("attack", { id }), form || boss); await c.wait(500); }
  await shot("04-ceruleen-phase2-fight");
}
