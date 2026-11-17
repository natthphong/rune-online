// Still for the clip: wait ~3 s on the planted spot, then screenshot to REC_SHOT (1920x1080).
import type { RecCtx } from "../rec60.ts";

export default async function (ctx: RecCtx) {
  await ctx.wait(3000);
  const path = process.env.REC_SHOT;
  if (!path) throw new Error("set REC_SHOT=<png path>");
  await ctx.page.screenshot({ path });
  ctx.say(`shot ${path}`);
}
