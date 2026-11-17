// 60 fps footage recorder (2.9.0): the real client (Vite DEV page, UI included) in a headless Google Chrome on the GPU, recorded
// with raw CDP Page.startScreencast (every compositor frame, acked at once) instead of Playwright's recordVideo (capped ~25 fps).
// Frames keep the browser's own timestamps; ffmpeg turns them into a constant 60 fps 1920x1080 H.264 file. Runs unattended with
// the screen locked (headless: no desktop capture).
//   pnpm --filter client rec60 -- <scene> [seconds] [out.mp4]
//   scenes: client/scripts/scenes/<scene>.ts (default export async (ctx) => {...}); built in: "boss" (Devo beside the character)
// Env: REC_BOT (account, default rec_bot), REC_MAP (map the planted character starts on), REC_URL / REC_PAGE (server / page),
//      REC_GL=swiftshader to compare with the software renderer the other browser bots use.
// Prints the in-page rAF fps and the distinct fps of the file (ffmpeg mpdecimate), the numbers the clip quotes.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, login } from "./bot.ts";
import { distinct } from "./fpscheck.ts";

// KEY=VALUE arguments set env options (REC_MAP=f2_field03 ...), the rest are positional
for (const a of process.argv.slice(2)) { const m = a.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
const [scene = "boss", secArg = "12", outArg] = process.argv.slice(2).filter((a) => a !== "--" && !/^[A-Z_]+=/.test(a));
const SECONDS = Number(secArg);
const url = process.env.REC_URL ?? "http://localhost:2567";
const page0 = process.env.REC_PAGE ?? "http://localhost:5173";
const ACCOUNT = process.env.REC_BOT ?? "rec_bot", NAME = (process.env.REC_NAME ?? `Lumen${ACCOUNT.replace(/\D/g, "")}`).slice(0, 23), PASSWORD = "bot-test-password";
const root = new URL("../../", import.meta.url).pathname;
const out = outArg ?? `${root}.cache/rec/${scene}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.mp4`;
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- the character: dev schema only ----------
const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing to plant into schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 1, options: `-c search_path="${schema}"` });

const token = await login(url, ACCOUNT);
let char = (await apiCall<CharacterSummary[]>(url, "GET", "/characters", token))[0];
if (!char) char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "F", hair: 2, job: "Swordman" });
const map = process.env.REC_MAP;
await db.query(`UPDATE characters SET level = 90, job_level = 40, hp = 30000, sp = 900, vit = 99, str = 80, dex = 70, agi = 60${map ? ", last_map = $2, x = $3, y = $4" : ""} WHERE id = $1`,
  map ? [char.id, map, Number(process.env.REC_X ?? 60), Number(process.env.REC_Y ?? 100)] : [char.id]);
await db.end();

export type RecCtx = { page: Page; say: (m: string) => void; wait: (ms: number) => Promise<void>; seconds: number;
  /** run in the page with window.__ro as `r` */ ro: <T>(f: (r: any, arg: any) => T, arg?: unknown) => Promise<T> };

// ---------- the browser: GPU (Metal through ANGLE), no background throttling ----------
const gl = process.env.REC_GL === "swiftshader" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];
const browser = await chromium.launch({ channel: process.env.CLICK_CHANNEL ?? "chrome", headless: true,
  args: [...gl, "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--force-device-scale-factor=1"] });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(page0);
  await page.fill("#username", ACCOUNT);
  await page.fill("#password", PASSWORD);
  await page.press("#password", "Enter");
  await page.waitForSelector("#sel-start", { state: "visible", timeout: 15_000 });
  await page.click("#sel-start");
  await page.waitForFunction(() => { const r = (window as any).__ro; return !!(r?.room && r.me && r.entities?.get(r.room.sessionId)); }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(2500); // the map's meshes and sprites up
  const ro = <T>(f: (r: any, arg: any) => T, arg?: unknown) => page.evaluate(([src, a]) => (0, eval)(`(${src})`)((window as any).__ro, a), [f.toString(), arg] as const) as Promise<T>;
  const ctx: RecCtx = { page, say, wait, seconds: SECONDS, ro };
  const mod = await import(new URL(`./scenes/${scene}.ts`, import.meta.url).href).catch(() => fail(`no scene client/scripts/scenes/${scene}.ts`));
  const run: (c: RecCtx) => Promise<void> = mod.default;
  // the scene's setup (before the camera rolls) is its `prepare` export
  if (mod.prepare) await mod.prepare(ctx);

  // ---------- record ----------
  const dir = `${root}.cache/rec/frames-${process.pid}`;
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const stamps: number[] = [], unique = new Set<string>();
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    writeFileSync(`${dir}/${String(stamps.length).padStart(6, "0")}.jpg`, Buffer.from(f.data, "base64"));
    stamps.push(f.metadata.timestamp ?? 0);
    unique.add(f.data.length + ":" + f.data.slice(-64));
  });
  await page.evaluate(() => { const w = window as any; w.__raf = 0; w.__long = 0; w.__worst = 0; let last = performance.now(); const tick = (t: number) => { w.__raf++; const d = t - last; last = t; if (w.__raf > 2) { if (d > 25) w.__long++; w.__worst = Math.max(w.__worst, d); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const rafStart = await page.evaluate(() => (window as any).__raf), tRec = Date.now();
  await Promise.race([run(ctx), wait(SECONDS * 1000)]);
  await wait(Math.max(0, SECONDS * 1000 - (Date.now() - tRec)));
  const rafFps = ((await page.evaluate(() => (window as any).__raf)) - rafStart) / ((Date.now() - tRec) / 1000);
  const hitch = await page.evaluate(() => ({ long: (window as any).__long, worst: Math.round((window as any).__worst) }));
  await cdp.send("Page.stopScreencast");
  await wait(200);
  say(`captured ${stamps.length} frames (${unique.size} unique pictures) in ${((stamps.at(-1)! - stamps[0])).toFixed(2)} s; page rAF ${rafFps.toFixed(1)} fps, ${hitch.long} frames > 25 ms, worst frame ${hitch.worst} ms`);
  if (errors.length) say(`page errors: ${errors.slice(0, 3).join(" | ")}`);

  // ---------- frames -> constant 60 fps: output frame k (time k/60) = the newest captured frame at or before it ----------
  // (not ffmpeg's concat demuxer: it puts still images on a 1/25 s time base and collapsed 70 real fps into 25)
  const grid = `${dir}/grid`;
  mkdirSync(grid);
  for (let k = 0, i = 0; stamps[0] + k / 60 <= stamps.at(-1)!; k++) {
    while (i + 1 < stamps.length && stamps[i + 1] <= stamps[0] + k / 60 + 1e-4) i++;
    symlinkSync(`${dir}/${String(i).padStart(6, "0")}.jpg`, `${grid}/${String(k).padStart(6, "0")}.jpg`);
  }
  mkdirSync(out.replace(/\/[^/]*$/, ""), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "60", "-i", `${grid}/%06d.jpg`, "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-r", "60", out]);
  if (!process.env.REC_KEEP) rmSync(dir, { recursive: true, force: true });
  const d = distinct(out);
  say(`OK ${out}: 60 fps file, ${d.frames} distinct frames in ${d.seconds.toFixed(2)} s = ${d.fps.toFixed(1)} distinct fps (mpdecimate), worst second ${d.worstSecond}`);
} finally {
  await browser.close();
}
