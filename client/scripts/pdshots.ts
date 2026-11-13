// Screenshots of the paper-doll lab (client/dev/paperdoll.html) in real Chrome (playwright-core), 1920 wide:
//   node scripts/pdshots.ts [outDir] [pageBase] [prefix]
// -> <prefix>frames.png (every frame of every complete body), <prefix>matrix-after.png / <prefix>matrix-before.png (jobs x hair
//    styles with the paper doll / with the old art, same page, &pd=0), <prefix>exploded.png, <prefix>gear.png
import { chromium } from "playwright-core";

const [dir = ".", page0 = "http://localhost:5173", prefix = "pd-"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: process.env.CLICK_CHANNEL ?? "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const [q, name] of [["", "frames"], ["?view=matrix", "matrix"], ["?view=exploded", "exploded"], ["?view=gear", "gear"]]) {
    await page.goto(`${page0}/dev/paperdoll.html${q}`);
    await page.waitForSelector("body[data-ready='1']", { timeout: 120000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${prefix}${name}.png`, fullPage: true });
    console.log(`${dir}/${prefix}${name}.png`);
  }
  if (errors.length) { console.error("page errors:", errors); process.exitCode = 1; }
} finally { await browser.close(); }
