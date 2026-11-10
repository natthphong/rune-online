// Make Character in real Chrome (playwright-core), 1920x1080: every job x gender x hair style of the live preview on one contact
// sheet (what 2c checks against the in-world sprite), plus the screen itself with one job picked.
//   node scripts/createshots.ts [outDir] [pageBase] [serverUrl] [job]
//   -> <outDir>/02c-preview-matrix.png, <outDir>/02c-make-character-after.png
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, login } from "./bot.ts";

const [dir = ".", page0 = "http://localhost:5173", url = "http://localhost:2567", hero = "Mage"] = process.argv.slice(2);
const ACCOUNT = process.argv[7] ?? "layer_bot_a"; // (the server allows 8 logins per account per 5 minutes: pass another test account when re-running a lot)
const token = await login(url, ACCOUNT);
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) await apiCall(url, "DELETE", `/characters/${c.id}`, token, { confirmName: c.name });
const browser = await chromium.launch({ channel: process.env.CLICK_CHANNEL ?? "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => { if (m.text().startsWith("STUCK")) console.log("page:", m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) console.log("http", r.status(), r.url()); });
  await page.goto(page0);
  await page.fill("#username", ACCOUNT);
  await page.fill("#password", "bot-test-password");
  await page.press("#password", "Enter");
  await page.waitForSelector("#sel-start", { state: "visible", timeout: 15_000 });
  await page.click("#sel-start"); // no characters: Start opens Make Character
  await page.waitForSelector("#create-screen:not([hidden]) #cr-jobs button", { timeout: 10_000 });
  const jobs = await page.$$eval("#cr-jobs button", (bs) => bs.map((b) => (b as HTMLElement).dataset.job!));
  const styles = await page.$$eval("#cr-styles button", (bs) => bs.length);
  await page.evaluate(([cols, rows]) => {
    const cv = Object.assign(document.createElement("canvas"), { width: cols * 124, height: rows * 170 });
    const g = cv.getContext("2d")!; g.fillStyle = "#dfe5f5"; g.fillRect(0, 0, cv.width, cv.height);
    (window as any).__sheet = cv;
  }, [styles * 2, jobs.length]);
  if (process.argv[6] !== "only") await page.evaluate(async ([jobs, styles]) => {
    const hit = (sel: string) => (document.querySelector(sel) as HTMLElement).click();
    const g = ((window as any).__sheet as HTMLCanvasElement).getContext("2d")!, src = document.getElementById("cr-preview") as HTMLCanvasElement;
    for (const [j, job] of (jobs as string[]).entries()) for (const [gi, gender] of ["M", "F"].entries()) for (let s = 0; s < (styles as number); s++) {
      const live = (window as any).__crLive, hair = (j + s) % 9;
      hit(`#cr-jobs button[data-job="${job}"]`); hit(`#cr-gender button[data-g="${gender}"]`);
      hit(`#cr-styles button:nth-child(${s + 1})`); hit(`#cr-colors button:nth-child(${hair + 1})`);
      const t0 = performance.now(), ok = () => { const l = live.shown; return l && l.job === job && l.gender === gender && l.style === s && l.hair === hair; };
      while (!ok() && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50)); // this look's sheets are in
      if (!ok()) console.log(`STUCK ${job} ${gender} ${s + 1}`);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))); // and painted
      const x = (gi * (styles as number) + s) * 124, y = j * 170;
      g.drawImage(src, 0, 0, 240, 300, x, y, 124, 155);
      g.fillStyle = "#223"; g.font = "11px sans-serif"; g.fillText(`${job} ${gender} ${s + 1}`, x + 4, y + 166);
    }
  }, [jobs, styles] as const);
  const data = await page.evaluate(() => ((window as any).__sheet as HTMLCanvasElement).toDataURL("image/png"));
  if (process.argv[6] !== "only") writeFileSync(`${dir}/02c-preview-matrix.png`, Buffer.from(data.split(",")[1], "base64"));
  await page.click(`#cr-jobs button[data-job="${hero}"]`);
  await page.click(`#cr-gender button[data-g="M"]`);
  await page.click(`#cr-styles button:nth-child(4)`);
  await page.click(`#cr-colors button:nth-child(4)`);
  await page.fill("#cr-name", "Aurelia");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${dir}/02c-make-character-after.png` });
  const zoom = await page.evaluate(() => { // the head, 5x, hard pixels
    const src = document.getElementById("cr-preview") as HTMLCanvasElement, cv = Object.assign(document.createElement("canvas"), { width: 600, height: 500 });
    const g = cv.getContext("2d")!; g.imageSmoothingEnabled = false; g.fillStyle = "#dfe5f5"; g.fillRect(0, 0, 600, 500);
    g.drawImage(src, 60, 60, 120, 100, 0, 0, 600, 500);
    return cv.toDataURL("image/png");
  });
  writeFileSync(`${dir}/02c-preview-zoom.png`, Buffer.from(zoom.split(",")[1], "base64"));
  console.log(`${dir}/02c-preview-matrix.png\n${dir}/02c-make-character-after.png`);
} finally { await browser.close(); }
process.exit(0);
