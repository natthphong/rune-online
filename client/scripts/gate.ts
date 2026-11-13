// Run the release gate's bots one after another against the local dev server and print PASS / FAIL per bot:
//   node scripts/gate.ts [bot ...]      default: smoke quest auto dungeon boss devo clickskill create grind
// Logs go to ../../.cache/gate/<bot>.log (repo root .cache). Exit 1 when any bot failed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const bots = process.argv.slice(2).length ? process.argv.slice(2) : ["smoke", "quest", "auto", "dungeon", "boss", "devo", "clickskill", "create", "grind"];
const dir = new URL("../../../.cache/gate/", import.meta.url);
mkdirSync(dir, { recursive: true });
let bad = 0;
for (const b of bots) {
  const t = Date.now();
  let r = spawnSync("node", [`scripts/${b}.ts`], { encoding: "utf8", timeout: 900_000 });
  if (r.status !== 0) r = spawnSync("node", [`scripts/${b}.ts`], { encoding: "utf8", timeout: 900_000 }); // one retry: bots fight random monsters
  writeFileSync(new URL(`${b}.log`, dir), `${r.stdout}\n${r.stderr}`);
  console.log(`${r.status === 0 ? "PASS" : "FAIL"} ${b} ${Math.round((Date.now() - t) / 1000)}s`);
  if (r.status !== 0) { bad++; console.log((r.stdout + r.stderr).trim().split("\n").slice(-6).join("\n")); }
}
process.exit(bad ? 1 : 0);
