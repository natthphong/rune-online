// Screenshots of the layered bodies in real Chrome (playwright-core), 1920x1080:
//   node scripts/layershots.ts lab [outDir] [pageBase]          client/dev/layers.html -> 02b-layers-exploded.png (base / outfit /
//                                                               hair / weapon + composited) and 02b-hair-outfit-swaps.png (jobs x styles x genders)
//   node scripts/layershots.ts world [outDir] [pageBase] [url]  a Mage logs in through the page, an Archer and a Swordman bot stand
//                                                               beside her in town -> 02b-in-world.png (dev schema only: plants jobs)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, login } from "./bot.ts";

const [mode = "lab", dir = ".", page0 = "http://localhost:5173", url = "http://localhost:2567"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: process.env.CLICK_CHANNEL ?? "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const shot = (n: string) => `${dir}/${n}`;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  if (mode === "lab") {
    for (const [q, name] of [["", "02b-layers-exploded.png"], ["?view=swaps", "02b-hair-outfit-swaps.png"]]) {
      await page.goto(`${page0}/dev/layers.html${q}`);
      await page.waitForSelector("body[data-ready='1']", { timeout: 60000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot(name), fullPage: true });
      console.log(shot(name));
    }
  } else {
    const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
    const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
    const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
    if (!schema || schema === "ro") throw new Error(`refusing to plant into schema ${schema}: local dev server only (ro_dev)`);
    const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 1, options: `-c search_path="${schema}"` });
    const plant = async (account: string, gender: string, job: string, hair: number, style: number) => {
      const token = await login(url, account);
      for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) await apiCall(url, "DELETE", `/characters/${c.id}`, token, { confirmName: c.name });
      const c = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot: 0, name: account.slice(0, 16), gender, hair, style });
      await db.query("UPDATE characters SET job = $2 WHERE id = $1", [c.id, job]);
      return { token, char: { ...c, job } };
    };
    const me = await plant("layer_bot_a", "F", "Mage", 4, 2);
    const others = [await plant("layer_bot_b", "M", "Archer", 5, 0), await plant("layer_bot_c", "F", "Swordman", 3, 3)];
    await page.goto(page0);
    await page.fill("#username", "layer_bot_a");
    await page.fill("#password", "bot-test-password");
    await page.press("#password", "Enter");
    await page.waitForSelector("#sel-start", { state: "visible", timeout: 15_000 });
    await page.click("#sel-start");
    await page.waitForFunction(() => { const r = (window as any).__ro; return !!(r?.room && r.me && r.entities?.get(r.room.sessionId)); }, undefined, { timeout: 30_000 });
    const at = await page.evaluate(() => { const r = (window as any).__ro; return { x: r.me.x, y: r.me.y }; });
    const rooms = await Promise.all(others.map((o) => botRoom(url, o.token, o.char)));
    rooms.forEach((r, i) => r.send("move", { x: at.x + (i ? 2 : -2), y: at.y - 1 }));
    await page.waitForTimeout(4000); // walked over, standing (idle frame = layered), sheets loaded
    await page.screenshot({ path: shot("02b-in-world.png") });
    console.log(shot("02b-in-world.png"), me.char.name);
    for (const r of rooms) await r.leave();
    await db.end();
  }
} finally { await browser.close(); }
process.exit(0);
