// i18n check (2.5.0): every t("key") in src/**/*.ts exists in locales/en.json, every data-i18n* key in index.html too,
// th.json keys are a subset of en.json, and placeholders match. Reports the keys still missing in th. `node scripts/i18n-check.ts`
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const load = (l: string) => JSON.parse(readFileSync(join(root, "src/locales", `${l}.json`), "utf8")) as Record<string, string>;
const en = load("en"), th = load("th");
const files: string[] = [];
(function walk(d: string) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "locales") walk(p); } else if (p.endsWith(".ts") && f !== "i18n.ts") files.push(p); } })(join(root, "src"));

const used = new Map<string, string>(); // key -> first place (t("literal") calls and data-i18n attributes: these MUST exist in en.json)
const allSrc = files.map((f) => readFileSync(f, "utf8")).join("\n");
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?<![\w.$])(?:t|tr)\(\s*"([\w.]+)"/g)) if (!used.has(m[1])) used.set(m[1], f.slice(root.length));
}
const html = readFileSync(join(root, "index.html"), "utf8");
for (const m of html.matchAll(/data-i18n(?:-\w+)?="([\w.]+)"/g)) if (!used.has(m[1])) used.set(m[1], "index.html");

const has = (k: string) => k in en || `${k}_one` in en || `${k}_other` in en;
const errors: string[] = [];
for (const [k, where] of used) if (!has(k)) errors.push(`missing in en.json: ${k} (${where})`);
for (const k of Object.keys(th)) if (!(k in en)) errors.push(`th.json key not in en.json: ${k}`);
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const k of Object.keys(th)) if (k in en && vars(th[k]) !== vars(en[k])) errors.push(`placeholders differ in th: ${k}`);
// a key is "referenced" if its text appears quoted anywhere in the sources (keyed tables, ternaries) or in index.html
const unused = Object.keys(en).filter((k) => { const b = k.replace(/_(one|other)$/, ""); return !allSrc.includes(`"${b}"`) && !html.includes(`"${b}"`); });
const noTh = Object.keys(en).filter((k) => !(k in th));
console.log(`keys: en ${Object.keys(en).length}, th ${Object.keys(th).length}; t() keys used ${used.size}; files ${files.length}`);
if (unused.length) console.log(`note ${unused.length} en keys never referenced as a quoted literal (built dynamically, or stale): ${unused.slice(0, 12).join(", ")}${unused.length > 12 ? " ..." : ""}`);
if (noTh.length) console.log(`missing th (${noTh.length}): ${noTh.slice(0, 40).join(", ")}${noTh.length > 40 ? " ..." : ""}`);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("PASS i18n-check");
