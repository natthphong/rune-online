// Grant items / levels / zeny to a character, offline (2.4.0: the owner's legendary card + egg; 2.5.0: sets, levels, zeny). Admin tool, not part of the server.
//
//   node server/scripts/grant.ts --schema <ro_dev|ro> --char <name> [--item <itemId|name> [--amount n]] [--set <file.json>]
//        [--job <JobKey>] [--force-job] [--base-level N] [--job-level N] [--zeny N] [--stat-points N] [--skill-points N] [--yes] [--redis-prefix <p>]
//
//   --set file.json   a JSON list granted in ONE transaction with everything else: [{ "item": 1163 | "Highland Claymore", "amount": 1,
//                     "refine": 7, "cards": [4001, 4002] }, ...] (refine / cards only for worn-type pieces, one row per piece).
//   --base-level N    raise the base level to N (never lowers; refused above the job's max): base_exp = 0 and the stat points that
//                     levelling gives (statpoint.yml, shared/rules/exp.ts statPointsAt) are added. HP / SP are refilled on next login.
//   --job <JobKey>    change the job first (pc_jobchange, like the Job Master): job level 1, job EXP 0, skills and skill points kept, Basic Skill
//                     raised to 9 when lower (the change needs it). 1st jobs only (Swordman, Mage, ...); 2nd / transcendent jobs and Novice
//                     need --force-job. Applied before --job-level, so `--job Swordman --job-level 45` ends at Swordman 45.
//   --job-level N     the same for the job level: job_exp = 0 and 1 skill point per job level (pc_checkjoblevelup).
//   --zeny N          ADD N zeny (the total stays <= 1,000,000,000 = MAX_ZENY).   --stat-points / --skill-points N: ADD N points.

// Writes the inventory rows the way the server does (server/src/inventory.ts add / addEgg; columns uid, char_id, item_id, amount, equip,
// refine, card0..3, pet_id): a stackable item merges into the character's plain bag stack (pc_additem), anything else gets one row per
// piece; an egg item (type Petegg) first gets its pet row like a successful taming (pet_catch_process_end -> intif_create_pet:
// shared/rules/pet.ts newPet = the species' level and name, hunger 100, the pet_db IntimacyStart, in its egg) and the egg row points at it.
// Refuses while the character is online (the Redis set `<prefix>online` that makes the API answer 409), and for schema `ro` (the
// deployed game) unless --yes is given. Prints the character's rows of that item (and its pets) before and after, in one transaction.
// Env: DATABASE_URL / REDIS_URL from the shell or the repo's .env (loaded when missing). Redis prefix defaults to "<schema>:".
import pg from "pg";
import { Redis } from "ioredis";
import { existsSync } from "node:fs";
import { ITEMS, isEquip } from "../../shared/rules/items.ts";
import { isStackable } from "../../shared/rules/shop.ts";
import { MOB_BY_ID } from "../../shared/rules/data.ts";
import { newPet, petRow } from "../../shared/rules/pet.ts";
import { statPointsAt } from "../../shared/rules/exp.ts";
import { JOBS } from "../../shared/rules/data.ts";
import { isSecondJob, isTrans } from "../../shared/rules/status.ts";
import { readFileSync } from "node:fs";
import petsJson from "../../shared/data/pets.json" with { type: "json" };

for (const f of ["../../../.env", "../../.env"]) { // repo root (shared infra), then the game's (only fills what is still unset)
  const u = new URL(f, import.meta.url);
  if (existsSync(u)) for (const [k, v] of Object.entries(parseEnv(u))) process.env[k] ??= v;
}
function parseEnv(u: URL): Record<string, string> {
  const before = { ...process.env };
  process.loadEnvFile(u);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (before[k] !== v && v !== undefined) { out[k] = v; if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  return out;
}

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const schema = opt("schema"), charName = opt("char");
const usage = "usage: node server/scripts/grant.ts --schema <ro_dev|ro> --char <name> [--item <id|name> [--amount n]] [--set file.json] [--job <JobKey>] [--force-job] [--base-level N] [--job-level N] [--zeny N] [--stat-points N] [--skill-points N] [--yes]";
const fail = (msg: string): never => { console.error(`grant: ${msg}`); process.exit(1); };
if (!schema || !charName) fail(usage);
if (!/^[a-z_][a-z0-9_]*$/.test(schema!)) fail(`bad schema name ${schema}`);
if (schema === "ro" && !args.includes("--yes")) fail("schema ro is the deployed game: add --yes to really write there");
const MAX_ZENY = 1_000_000_000;

type Req = { item: typeof ITEMS extends Map<number, infer I> ? I : never; amount: number; refine: number; cards: number[] };
const find = (ref: unknown) => {
  const it = typeof ref === "number" || /^\d+$/.test(String(ref)) ? ITEMS.get(Number(ref)) : [...ITEMS.values()].find((i) => i.name.toLowerCase() === String(ref).toLowerCase());
  return it ?? fail(`no item ${JSON.stringify(ref)} in shared/data/items.json`);
};
const requests: Req[] = [];
const addReq = (ref: unknown, amount = 1, refine = 0, cards: number[] = []) => {
  const item = find(ref);
  if (!Number.isInteger(amount) || amount < 1 || amount > 30000) fail(`bad amount for ${item.name}`);
  if (!Number.isInteger(refine) || refine < 0 || refine > 20) fail(`bad refine for ${item.name}`);
  if ((refine || cards.length) && !(isEquip(item) && !isStackable(item))) fail(`${item.name}: refine / cards only for worn-type pieces`);
  if (cards.length > (item.slots ?? 0)) fail(`${item.name}: ${cards.length} cards for ${item.slots ?? 0} slots`);
  for (const c of cards) if (ITEMS.get(c)?.type !== "Card") fail(`${c} is not a card`);
  requests.push({ item, amount, refine, cards });
};
if (opt("item") !== undefined) addReq(opt("item"), Math.trunc(Number(opt("amount") ?? 1)));
if (opt("set")) {
  const list = JSON.parse(readFileSync(opt("set")!, "utf8")) as { item: unknown; amount?: number; refine?: number; cards?: unknown[] }[];
  if (!Array.isArray(list)) fail("--set file must hold a JSON list");
  for (const r of list) addReq(r.item, r.amount ?? 1, r.refine ?? 0, (r.cards ?? []).map((c) => find(c).id));
}
const num = (k: string) => { const v = opt(k); if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 0) fail(`bad --${k}`); return n; };
const newJob = opt("job");
const baseTo = num("base-level"), jobTo = num("job-level"), zenyAdd = num("zeny"), statAdd = num("stat-points"), skillAdd = num("skill-points");
if (!requests.length && newJob === undefined && baseTo === undefined && jobTo === undefined && zenyAdd === undefined && statAdd === undefined && skillAdd === undefined) fail(usage);
const pets = petsJson as Record<string, unknown>[];
const petOf = (item: Req["item"]) => (item.type === "Petegg" ? pets.map(petRow).find((p) => p.eggItem === item.id) ?? fail(`${item.name}: no pets.json row hatches from it`) : undefined);
for (const r of requests) petOf(r.item); // fail early
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) fail("DATABASE_URL / REDIS_URL not set (shell or repo .env)");

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: `-c search_path="${schema}"` });
const redis = new Redis(process.env.REDIS_URL!, { keyPrefix: opt("redis-prefix") ?? `${schema}:`, lazyConnect: true, maxRetriesPerRequest: 2 });
try {
  const { rows: chars } = await db.query("SELECT id, name, job, level, job_level, stat_points, skill_points, zeny FROM characters WHERE name = $1", [charName]);
  if (!chars.length) fail(`no character named ${charName} in schema ${schema}`);
  const ch = chars[0], charId = Number(ch.id);
  await redis.connect();
  if (await redis.sismember("online", charName!)) fail(`${charName} is online — log it out first (the API's 409 check)`);
  let jobKey = ch.job as keyof typeof JOBS, curJobLevel = Number(ch.job_level);
  if (!(jobKey in JOBS)) fail(`unknown job ${ch.job}`);
  let jobChanged = false;
  if (newJob !== undefined) {
    if (!(newJob in JOBS)) fail(`unknown job ${newJob} (JobKeys: ${Object.keys(JOBS).join(", ")})`);
    const k = newJob as keyof typeof JOBS;
    if ((isSecondJob(k) || isTrans(k) || k === "Novice") && !args.includes("--force-job")) fail(`${newJob} is not a 1st job: add --force-job if you really mean it`);
    if (k !== jobKey) { jobKey = k; curJobLevel = 1; jobChanged = true; }
  }
  const job = JOBS[jobKey];
  const show = async (when: string) => {
    const { rows } = await db.query("SELECT job, level, exp, job_level, job_exp, stat_points, skill_points, zeny FROM characters WHERE id = $1", [charId]);
    console.log(`${when}: ${charName} (char ${charId}, ${ch.job}) `, JSON.stringify(rows[0]));
    if (requests.length) {
      const inv = await db.query("SELECT uid, item_id, amount, equip, refine, card0, card1, card2, card3, pet_id FROM inventory WHERE char_id = $1 AND item_id = ANY($2) ORDER BY uid", [charId, [...new Set(requests.map((r) => r.item.id))]]);
      console.log(`${when}: rows of the granted items:`);
      console.table(inv.rows);
    }
  };
  // character columns first (checked before anything is written)
  const set: string[] = [], vals: unknown[] = [charId];
  const col = (sql: string, v: unknown) => { vals.push(v); set.push(sql.replace("?", `$${vals.length}`)); };
  if (jobChanged) { col("job = ?", jobKey); set.push("job_exp = 0"); }
  let stat = 0, skill = skillAdd ?? 0;
  if (baseTo !== undefined) {
    if (baseTo < ch.level) fail(`--base-level ${baseTo} is below the current level ${ch.level} (grant never lowers)`);
    if (baseTo > job.maxBaseLevel) fail(`--base-level ${baseTo}: ${jobKey} stops at ${job.maxBaseLevel}`);
    if (baseTo > ch.level) { stat += statPointsAt(baseTo) - statPointsAt(ch.level); col("level = ?", baseTo); set.push("exp = 0"); }
  }
  if (jobTo !== undefined) {
    if (jobTo < curJobLevel) fail(`--job-level ${jobTo} is below the current job level ${curJobLevel}`);
    if (jobTo > job.maxJobLevel) fail(`--job-level ${jobTo}: ${jobKey} stops at ${job.maxJobLevel}`);
    if (jobTo > curJobLevel) { skill += jobTo - curJobLevel; col("job_level = ?", jobTo); if (!jobChanged) set.push("job_exp = 0"); }
  }
  if (jobChanged && !set.some((x) => x.startsWith("job_level"))) set.push("job_level = 1");
  stat += statAdd ?? 0;
  if (stat) col("stat_points = stat_points + ?", stat);
  if (skill) col("skill_points = skill_points + ?", skill);
  if (zenyAdd !== undefined) {
    if (Number(ch.zeny) + zenyAdd > MAX_ZENY) fail(`zeny would pass ${MAX_ZENY.toLocaleString()}`);
    col("zeny = zeny + ?", zenyAdd);
  }
  await show("before");
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    if (set.length) await c.query(`UPDATE characters SET ${set.join(", ")} WHERE id = $1`, vals);
    if (jobChanged) await c.query("INSERT INTO skill (char_id, id, lv) VALUES ($1, 1, 9) ON CONFLICT (char_id, id) DO UPDATE SET lv = GREATEST(skill.lv, 9)", [charId]); // NV_BASIC 9
    for (const { item, amount, refine, cards } of requests) {
      const pet = petOf(item);
      if (pet) {
        const mob = MOB_BY_ID.get(pet.mobId) ?? fail(`pet species ${pet.mobId} not in mobs.json`);
        for (let i = 0; i < amount; i++) { // one pet + one egg row each (pet_create_egg per egg, like buildin_getitem)
          const n = newPet(pet, mob.level, mob.name);
          const r = await c.query("INSERT INTO pet (char_id, mob_id, name, level, hunger, intimacy) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            [charId, n.mobId, n.name, n.level, n.hunger, n.intimacy]);
          await c.query("INSERT INTO inventory (char_id, item_id, amount, pet_id) VALUES ($1, $2, 1, $3)", [charId, item.id, r.rows[0].id]);
        }
      } else if (isStackable(item)) { // pc_additem: merge into the plain bag stack (not worn, no refine / cards / pet)
        const s = await c.query("SELECT uid FROM inventory WHERE char_id = $1 AND item_id = $2 AND equip IS NULL AND refine = 0 AND card0 = 0 AND card1 = 0 AND card2 = 0 AND card3 = 0 AND pet_id IS NULL ORDER BY uid LIMIT 1", [charId, item.id]);
        if (s.rows.length) await c.query("UPDATE inventory SET amount = amount + $2 WHERE uid = $1", [s.rows[0].uid, amount]);
        else await c.query("INSERT INTO inventory (char_id, item_id, amount) VALUES ($1, $2, $3)", [charId, item.id, amount]);
      } else {
        for (let i = 0; i < amount; i++)
          await c.query("INSERT INTO inventory (char_id, item_id, amount, refine, card0, card1, card2, card3) VALUES ($1, $2, 1, $3, $4, $5, $6, $7)",
            [charId, item.id, refine, cards[0] ?? 0, cards[1] ?? 0, cards[2] ?? 0, cards[3] ?? 0]);
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  await show("after");
  console.log(`granted to ${charName} in schema ${schema}: ${requests.map((r) => `${r.amount} x ${r.item.name}`).join(", ") || "no items"}${jobChanged ? ` | job -> ${jobKey}` : ""}${stat ? ` | stat points +${stat}` : ""}${skill ? ` | skill points +${skill}` : ""}${zenyAdd ? ` | zeny +${zenyAdd}` : ""}`);
} finally {
  redis.disconnect();
  await db.end();
}
