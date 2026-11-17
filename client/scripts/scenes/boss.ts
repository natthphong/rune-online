// rec60 scene: a boss fight beside the character (Devo by default; REC_MOB=<mob id>). The character runs in and fights; the boss
// telegraphs its moves. The fps acceptance shot of 2.9.0 (10 s of a boss fight, >= 50 distinct fps).
import type { RecCtx } from "../rec60.ts";

const MOB = Number(process.env.REC_MOB ?? 3999);
let boss = "";

export async function prepare(c: RecCtx) {
  const before: string[] = await c.ro((r) => [...r.entities.values()].filter((e: any) => e.isMonster).map((e: any) => e.id));
  await c.ro((r, mobId) => r.room.send("devBoss", { op: "spawn", id: "", mobId, x: r.me.x - 7, y: r.me.y }), MOB);
  await c.page.waitForFunction((b) => [...(window as any).__ro.entities.values()].some((e: any) => e.isMonster && !e.dead && !b.includes(e.id)), before, { timeout: 10_000 });
  boss = await c.ro((r, b: string[]) => [...r.entities.values()].find((e: any) => e.isMonster && !e.dead && !b.includes(e.id)).id, before);
  c.say(`boss ${MOB} spawned: ${boss}`);
  await c.wait(800);
}

export default async function run(c: RecCtx) {
  for (let t = 0; t < c.seconds * 1000; t += 1000) {
    await c.ro((r, id) => r.room.send("attack", { id }), boss);
    await c.wait(1000);
  }
}
