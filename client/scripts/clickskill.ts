// Browser check of the click-to-target skill path (2.5.3 regression: a skill aimed by clicking a monster failed outside a duel;
// the protocol bots send Msg.useSkill themselves and never go through it). A real Chrome plays the page: log in through the
// login form, Start on Select Character, a Swordman with Bash on F1 (planted in the dev schema), F1 arms Bash (skill cursor),
// a mouse click on the monster's drawn sprite sends the use, and the server's Bash hit on that monster must come back.
// Needs the Vite DEV page (window.__ro) pointed at the same game server, the dev schema (plant) and Google Chrome:
//   VITE_SERVER_URL=http://localhost:2567 pnpm --filter client dev        (the usual pnpm dev already is)
//   pnpm --filter client clickskill [serverUrl] [pageUrl]                   defaults http://localhost:2567 http://localhost:5173
// Then (2.5.3 footage bug) an MVP is hovered and dies under the still mouse: its tooltip and name tag must go at once, not on
// the next mouse move.
// Each run logs in twice (API plant + the form); the login limit is 8 per 5 min per account: CLICK_BOT=<name> for rapid reruns.
// CLICK_HEADED=1 shows the browser. The monster is a dev spawn (Msg.devBoss, refused in production) next to the character.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { SKILL_ID } from "../../shared/rules/skill.ts";
import { MOBS } from "../../shared/rules/data.ts";
import { skillHotkey } from "../../shared/rules/hotkey.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, login } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const page0 = process.argv[3] ?? "http://localhost:5173";
const ACCOUNT = process.env.CLICK_BOT ?? "click_bot", NAME = ACCOUNT.slice(0, 23), PASSWORD = "bot-test-password"; // bot.ts's test password
const MOB = 1002; // a field-1 monster
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timer = setTimeout(() => fail("timed out after 120 s"), 120_000);
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);

// ---------- the plant: dev schema only (like jobs.ts) ----------
const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing to plant into schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 1, options: `-c search_path="${schema}"` });

const token = await login(url, ACCOUNT);
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) await apiCall(url, "DELETE", `/characters/${c.id}`, token, { confirmName: c.name });
const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: NAME, gender: "M", hair: 0 });
await db.query(`UPDATE characters SET job = 'Swordman', level = 20, job_level = 20, sp = 400, str = 30, dex = 30, hotkeys = $2::jsonb,
  hotkeys_seeded = true WHERE id = $1`, [char.id, JSON.stringify([skillHotkey(SKILL_ID.SM_BASH, 5)])]);
// Basic Training 9 is in every job's tree under its first-job skills (a Swordman got there through it)
for (const [id, lv] of [[SKILL_ID.NV_BASIC, 9], [SKILL_ID.SM_BASH, 5]]) {
  await db.query(`INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, $3) ON CONFLICT (char_id, id) DO UPDATE SET lv = EXCLUDED.lv`, [char.id, id, lv]);
}
say(`planted ${NAME}: Swordman, Bash 5 on F1`);

// ---------- the browser ----------
const browser = await chromium.launch({ channel: process.env.CLICK_CHANNEL ?? "chrome", headless: !process.env.CLICK_HEADED, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let spawned = "";
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(page0);
  await page.fill("#username", ACCOUNT);
  await page.fill("#password", PASSWORD);
  await page.press("#password", "Enter");
  await page.waitForSelector("#sel-start", { state: "visible", timeout: 15_000 });
  await page.click("#sel-start");
  await page.waitForFunction(() => { const r = (window as any).__ro; return !!(r?.room && r.me && r.entities?.get(r.room.sessionId)); }, undefined, { timeout: 30_000 });
  say("in game through the login form and Select Character");

  // a monster beside the character (dev spawn), then wait until the client draws it
  const before = await page.evaluate(() => [...(window as any).__ro.entities.values()].filter((e: any) => e.isMonster).map((e: any) => e.id));
  await page.evaluate((mobId) => { const r = (window as any).__ro; r.room.send("devBoss", { op: "spawn", id: "", mobId, x: r.me.x + 3, y: r.me.y }); }, MOB);
  await page.waitForFunction((b) => [...(window as any).__ro.entities.values()].some((e: any) => e.isMonster && !e.dead && !b.includes(e.id)), before, { timeout: 10_000 });
  spawned = await page.evaluate((b) => [...(window as any).__ro.entities.values()].find((e: any) => e.isMonster && !e.dead && !b.includes(e.id)).id, before);
  await page.waitForTimeout(1500); // sprite sheets loaded, the billboard eased onto its cell
  await page.evaluate(() => { const r = (window as any).__ro; (window as any).__bash = []; r.room.onMessage("hit", (m: any) => { if (m.from === r.room.sessionId) (window as any).__bash.push(m); }); });

  // F1 arms Bash: the targeting cursor
  await page.mouse.move(5, 400);
  await page.keyboard.press("F1");
  await page.waitForFunction(() => document.body.classList.contains("skill-cursor"), undefined, { timeout: 3000 }).catch(() => fail("F1 did not arm Bash (no skill-cursor)"));
  say("F1 armed Bash (skill cursor)");

  // a pixel of the monster's drawn sprite: project its billboard, then let the client's own per-pixel pick confirm it
  const pixelOf = (id: string) => page.evaluate((id) => {
    const r = (window as any).__ro, e = r.entities.get(id), cam = r.camera;
    const p = e.obj.position.clone(); p.y += (e.view.height ?? 1) * 0.5;
    p.project(cam);
    const cx = (p.x + 1) / 2 * innerWidth, cy = (1 - p.y) / 2 * innerHeight;
    for (let rad = 0; rad <= 80; rad += 4) for (let a = 0; a < 16; a++) {
      const x = cx + Math.cos(a * Math.PI / 8) * rad, y = cy + Math.sin(a * Math.PI / 8) * rad;
      if (r.pickMonster(x, y)?.id === id) return { x, y };
    }
    return undefined;
  }, id);
  const at = await pixelOf(spawned);
  if (!at) fail(`no pixel of monster ${spawned} picks it`);
  await page.mouse.click(at!.x, at!.y);
  say(`clicked ${spawned} at (${Math.round(at!.x)}, ${Math.round(at!.y)})`);

  await page.waitForFunction(([id, sk]) => (window as any).__bash.some((m: any) => m.to === id && m.skill === sk), [spawned, SKILL_ID.SM_BASH] as const, { timeout: 8000 })
    .catch(async () => fail(`no Bash hit on ${spawned} after the click; chat: ${await page.evaluate(() => [...document.querySelectorAll("#chat-log > *")].slice(-5).map((n) => n.textContent).join(" | "))}`));
  const hit = await page.evaluate((id) => (window as any).__bash.find((m: any) => m.to === id), spawned);
  if (hit.skill !== SKILL_ID.SM_BASH) fail(`hit was skill ${hit.skill}, not Bash`);
  say(`OK: Bash landed on ${spawned} from a mouse click (${hit.miss ? "miss" : `${hit.dmg} damage`}), outside any duel`);
  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  await page.evaluate((id) => (window as any).__ro.room.send("devBoss", { op: "remove", id }), spawned);
  await page.waitForTimeout(300);

  // ---- an MVP dies under a still mouse: tooltip + name tag go at once
  const mvp = MOBS.find((m) => m.bossType === "Mvp") ?? fail("no MVP in mobs.json");
  const seen = await page.evaluate(() => [...(window as any).__ro.entities.keys()]);
  await page.evaluate((mobId) => { const r = (window as any).__ro; r.room.send("devBoss", { op: "spawn", id: "", mobId, x: r.me.x - 4, y: r.me.y }); }, mvp.id);
  await page.waitForFunction((b) => [...(window as any).__ro.entities.values()].some((e: any) => e.isMonster && e.boss === 2 && !e.dead && !b.includes(e.id)), seen, { timeout: 10_000 });
  const boss = await page.evaluate((b) => [...(window as any).__ro.entities.values()].find((e: any) => e.isMonster && e.boss === 2 && !e.dead && !b.includes(e.id)).id, seen);
  await page.waitForTimeout(1500);
  const bp = (await pixelOf(boss)) ?? fail(`no pixel of the MVP ${boss} picks it`);
  await page.mouse.move(bp.x, bp.y);
  await page.waitForFunction(() => !document.getElementById("tooltip")!.hidden, undefined, { timeout: 3000 }).catch(() => fail("no tooltip over the MVP"));
  const tag = () => page.evaluate((id) => { const l = (window as any).__ro.entities.get(id)?.label; return l ? !l.hidden : false; }, boss);
  if (!(await tag())) fail("the MVP has no name tag while alive");
  await page.evaluate((id) => (window as any).__ro.room.send("devBoss", { op: "kill", id }), boss);
  await page.waitForFunction((id) => (window as any).__ro.entities.get(id)?.dead, boss, { timeout: 5000 });
  await page.waitForTimeout(300); // a few frames, the mouse never moves
  const tipShown = await page.evaluate(() => !document.getElementById("tooltip")!.hidden);
  if (tipShown) fail("the dead MVP's tooltip stayed under the still mouse");
  if (await tag()) fail("the dead MVP's name tag stayed on screen");
  say(`OK: ${mvp.name} died under the still mouse: tooltip and name tag gone at once`);
  await page.evaluate((id) => (window as any).__ro.room.send("devBoss", { op: "remove", id }), boss);
  await page.waitForTimeout(300);
} finally {
  await browser.close();
}
await apiCall(url, "DELETE", `/characters/${char.id}`, token, { confirmName: NAME });
await db.end();
clearTimeout(timer);
say("PASS: click-to-target skill");
process.exit(0);
