// rec60 scene: the character walks back and forth (the camera pans every frame): the capture's own ceiling, whatever is on screen.
import type { RecCtx } from "../rec60.ts";

export default async function run(c: RecCtx) {
  const home: { x: number; y: number } = await c.ro((r) => ({ x: Math.round(r.me.x), y: Math.round(r.me.y) }));
  for (let i = 0; i < 20; i++) {
    await c.ro((r, p) => r.room.send("move", p), { x: home.x + (i % 2 ? -8 : 8), y: home.y });
    await c.wait(1600);
  }
}
