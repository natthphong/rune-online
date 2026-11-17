// rec60 scene: Ashgrim's ultimate, the Long Harvest. The mini-boss rises 8 cells east, is hurt under 80 %, the character fights it for 2 s,
// the Harvest is forced, the character runs into the nearest pale safe circle (read off the telegraph decal's uniforms) and survives the impact.
// PNGs of the key moments go to REC_SHOTS (default: the 2026-11-17 episode's dev-shots).
import type { RecCtx } from "../rec60.ts";

const SHOTS = process.env.REC_SHOTS ?? "/Users/AR697030/short/curate/ro-series/episodes/2026-11-17/dev-shots";
let boss = "";

const findBoss = (c: RecCtx, name: string) => c.ro((r, n: string) => [...r.entities.values()].find((e: any) => e.isMonster && !e.dead && e.name === n)?.id ?? "", name);

export async function prepare(c: RecCtx) {
  await c.ro((r) => r.room.send("devBoss", { op: "mini", id: "", move: "ashgrim", x: 1 }));
  await c.page.waitForFunction(() => [...(window as any).__ro.entities.values()].some((e: any) => e.isMonster && !e.dead && e.name === "Ashgrim"), undefined, { timeout: 10_000 });
  boss = await findBoss(c, "Ashgrim");
  c.say(`Ashgrim: ${boss}`);
  // under 80 % so the Harvest is allowed
  await c.ro((r, id: string) => { const e = r.entities.get(id); r.room.send("devBoss", { op: "hurt", id, dmg: Math.round(e.hp - e.maxHp * 0.7) }); }, boss);
  await c.wait(1200);
}

export default async function run(c: RecCtx) {
  const shot = (n: string) => c.page.screenshot({ path: `${SHOTS}/${n}.png` });
  // the boss by name each time (another bot sharing the map may bring its own Ashgrim: the registry keeps only one)
  const cur = async () => (boss = (await findBoss(c, "Ashgrim")) || boss);
  for (let t = 0; t < 2000; t += 500) { await c.ro((r, id: string) => r.room.send("attack", { id }), await cur()); await c.wait(500); }
  // forced until the sweep's warning shows (the boss may be mid-swing for a moment)
  for (let i = 0; i < 6; i++) {
    await c.ro((r, id: string) => r.room.send("devBoss", { op: "move", id, move: "reap" }), await cur());
    await c.wait(450);
    if (await c.ro(() => (window as any).__pfx.decals.some((x: any) => x.mat.uniforms.uShape.value === 2))) break;
  }
  c.say("the Long Harvest is forced");
  await c.wait(400);
  // the nearest safe circle: the sweep decal's uniforms hold them as (x, z, r)
  const spot = await c.ro((r) => {
    const d = (window as any).__pfx.decals.find((x: any) => x.mat.uniforms.uShape.value === 2);
    if (!d) return null;
    const u = d.mat.uniforms, me = r.me;
    let best: { x: number; y: number } | null = null, bd = 1e9;
    for (let i = 0; i < u.uSafeN.value; i++) {
      const s = u.uSafe.value[i], dist = Math.hypot(s.x - me.x, s.y - me.y);
      if (dist < bd) { bd = dist; best = { x: Math.round(s.x), y: Math.round(s.y) }; }
    }
    return best;
  });
  c.say(`safe circle: ${JSON.stringify(spot)}`);
  if (spot) await c.ro((r, s: { x: number; y: number }) => r.room.send("move", s), spot);
  await c.wait(1500);
  await shot("04-ashgrim-harvest-telegraph");
  await c.wait(2300);
  await shot("04-ashgrim-harvest-telegraph-late");
  await c.wait(650); // ~5.5 s after the cast: the impact is landing
  await shot("04-ashgrim-harvest-impact");
  await c.wait(1500);
  await shot("04-ashgrim-harvest-after");
  for (let t = 0; t < 4000; t += 500) { await c.ro((r, id: string) => r.room.send("attack", { id }), await cur()); await c.wait(500); }
}
