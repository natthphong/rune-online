// Make Character with a starting job, end to end (2.7.0). For each of Novice, Swordman, Archer, Mage, Acolyte, Thief, Merchant
// a character is created through the same request the Make Character screen sends (shared/look.ts createRequest -> POST /api/characters),
// the character list must return it with the job, a bad job must be refused (400), then the character joins the world and must hold:
// the job, Job Lv 1 / Base Lv 1, Basic Training 9, the starter skills (rules/jobstart.ts) learned and on the first hotkey slots, the
// job's weapon equipped (Archer: arrows too). A job start then walks out to the Verdant Plains and uses its first starter skill on a monster
// (the cast / use event, the skill hit or the heal). Characters are deleted afterwards.
//   pnpm --filter client create [serverUrl]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Msg, type HitEvent, type HotkeysEvent, type InvEvent, type SkillCastEvent, type SkillFailEvent, type SkillUseEvent, type SkillsEvent, type StatusEvent } from "../../shared/protocol.ts";
import { createRequest, type CharacterSummary, type StartJob } from "../../shared/look.ts";
import { FIELD } from "../../shared/maps.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { hotkeySkill } from "../../shared/rules/hotkey.ts";
import { statPointsAt } from "../../shared/rules/exp.ts";
import { jobStart } from "../../shared/rules/jobstart.ts";
import { itemNamed } from "../../shared/rules/quest.ts";
import { SKILLS, SKILL_ID, skillCost } from "../../shared/rules/skill.ts";
import { apiCall, botRoom, deleteChar, login, walkNear } from "./bot.ts";

const url = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:2567";
const ACCOUNT = process.env.CREATE_BOT ?? "create_bot";
const JOBS_RUN: StartJob[] = ["Novice", "Swordman", "Archer", "Mage", "Acolyte", "Thief", "Merchant"];
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 300 s"), 300_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);

const token = await login(url, ACCOUNT);
/** The screen's request, sent with the bot's token. */
const create = (d: Parameters<typeof createRequest>[0]) => { const r = createRequest(d); return apiCall<CharacterSummary>(url, r.method, r.path, token, r.body); };
for (const c of await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)) await deleteChar(url, token, c); // leftovers of a stopped run

// the server refuses a job that is not a first job (or the Fledgling)
for (const job of ["Knight", "Gunslinger", "", 7]) {
  const r = createRequest({ slot: 8, name: "crb_bad", gender: "M", hair: 0, job: job as string });
  const err = await apiCall(url, r.method, r.path, token, { ...r.body, job }).then(() => "created", (e: Error) => e.message);
  if (!/-> 400/.test(err)) fail(`job ${JSON.stringify(job)} was not refused with 400: ${err}`);
}
if ((await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)).length) fail("a refused job still created a character");
say("bad jobs refused (400), nothing created");

const report: string[] = [];
for (const [i, job] of JOBS_RUN.entries()) {
  const name = `crb_${job}`.slice(0, 16);
  // ---- create + list
  const made = await create({ slot: i, name, gender: i % 2 ? "F" : "M", hair: i, style: i % 3, job });
  const listed = (await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)).find((c) => c.id === made.id);
  if (!listed) fail(`${job}: the character is not in GET /api/characters`);
  if (listed!.job !== job || made.job !== job) fail(`${job}: the list says job ${listed!.job} (create said ${made.job})`);
  const baseLv = jobStart(job)?.level ?? 1;
  if (listed!.level !== baseLv || listed!.jobLevel !== 1) fail(`${job}: Base ${listed!.level} / Job ${listed!.jobLevel}, wanted ${baseLv} / 1`);
  if (!listed!.look?.outfit) fail(`${job}: no look for the select screen`);
  say(`${job}: created #${made.id}, listed as ${listed!.job} Lv ${listed!.level}/${listed!.jobLevel}, outfit ${listed!.look.outfit}`);
  // a second create into the same slot is still refused
  if (i === 0) await create({ slot: 0, name: "crb_dupe", gender: "M", hair: 0, job }).then(() => fail("a used slot was accepted"), (e: Error) => { if (!/409/.test(e.message)) fail(`used slot: ${e.message}`); });

  // ---- join the world
  const room = await botRoom(url, token, listed!);
  let inv: InvEvent | undefined, own: StatusEvent | undefined, skills: SkillsEvent | undefined, hk: HotkeysEvent | undefined;
  const casts: SkillCastEvent[] = [], uses: SkillUseEvent[] = [], hits: HitEvent[] = [], fails: SkillFailEvent[] = [];
  let leaving = false;
  room.onLeave((code: number) => { if (!leaving) fail(`${job}: disconnected (code ${code}): the dev server restarted? run again`); });
  room.onMessage(Msg.inv, (m: InvEvent) => { inv = m; });
  room.onMessage(Msg.status, (m: StatusEvent) => { own = m; });
  room.onMessage(Msg.skills, (m: SkillsEvent) => { skills = m; });
  room.onMessage(Msg.hotkeys, (m: HotkeysEvent) => { hk = m; });
  room.onMessage(Msg.skillCast, (m: SkillCastEvent) => casts.push(m));
  room.onMessage(Msg.skillUse, (m: SkillUseEvent) => uses.push(m));
  room.onMessage(Msg.hit, (m: HitEvent) => hits.push(m));
  room.onMessage(Msg.skillFail, (m: SkillFailEvent) => fails.push(m));
  room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) setTimeout(() => room.send(Msg.respawn), 300); });
  room.onMessage("*", () => {});
  await until(() => !!inv && !!own && !!skills && !!hk, 6000, `${job}: no inventory / status / skills / hotkeys at login`);
  await wait(400);
  const me = () => (room.state as any).players.get(room.sessionId);
  const lv = (key: string) => skills!.list.find((e) => e.id === SKILL_ID[key])?.lv ?? 0;
  const worn = (slot: string) => inv!.items.find((s) => s.equip === slot);
  if (me().job !== job) fail(`${job}: in-world job is ${me().job}`);
  if (own!.level !== baseLv || own!.jobLevel !== 1) fail(`${job}: in-world levels ${own!.level}/${own!.jobLevel}`);
  if (job !== "Novice" && own!.statPoints !== statPointsAt(baseLv)) fail(`${job}: ${own!.statPoints} status points, wanted ${statPointsAt(baseLv)}`);
  // the Fledgling's kit is worn too (a Knife in the weapon hand unless the job's weapon took its place)
  if (!inv!.items.some((s) => s.itemId === 1201)) fail(`${job}: the starter kit is missing`);

  const start = jobStart(job);
  const info: string[] = [];
  if (!start) {
    if (lv("NV_BASIC") !== 0) fail(`Novice: Basic Training ${lv("NV_BASIC")}, wanted 0`);
    if (hk!.keys.some((k) => hotkeySkill(k))) fail("Novice: a skill is on the hotkey bar");
    if (worn("weapon")?.itemId !== 1201) fail(`Novice: weapon ${worn("weapon")?.itemId}, wanted the Knife`);
    info.push("no skills, Knife worn (the old path)");
  } else {
    if (lv("NV_BASIC") !== 9) fail(`${job}: Basic Training ${lv("NV_BASIC")}, wanted 9`);
    if (own!.skillPoints !== 0) fail(`${job}: ${own!.skillPoints} unspent skill points, wanted 0`);
    start.skills.forEach(([key, want], slot) => {
      if (lv(key) !== want) fail(`${job}: ${key} is ${lv(key)}, wanted ${want}`);
      const h = hotkeySkill(hk!.keys[slot]);
      if (!h || h.id !== SKILL_ID[key] || h.lv !== want) fail(`${job}: hotkey slot F${slot + 1} is ${hk!.keys[slot]}, wanted ${key} Lv ${want}`);
    });
    const [first, ...more] = start.kit, wantWeapon = itemNamed(first.item)!;
    if (worn("weapon")?.itemId !== wantWeapon.id) fail(`${job}: worn weapon ${worn("weapon") ? ITEMS.get(worn("weapon")!.itemId)!.name : "none"}, wanted ${wantWeapon.name} (bag: ${inv!.items.map((s) => `${ITEMS.get(s.itemId)!.name}${s.equip ? `@${s.equip}` : ""}`).join(", ")})`);
    for (const k of more) if (inv!.items.find((s) => s.itemId === itemNamed(k.item)!.id)?.amount !== k.count || !worn("ammo")) fail(`${job}: ${k.item} x${k.count} not carried / worn`);
    // the potions the Fledgling kit puts on the bar come after the skills
    info.push(`${start.skills.map(([k, l]) => `${SKILLS.get(SKILL_ID[k])!.name} ${l}`).join(" + ")} on F1${start.skills.length > 1 ? `-F${start.skills.length}` : ""}, ${ITEMS.get(wantWeapon.id)!.name} worn${more.length ? " + arrows" : ""}`);

    // ---- a starter skill on a monster
    await room.travel(FIELD);
    await until(() => (room.state as any).monsters?.size > 0, 8000, `${job}: no monsters on the plains`);
    const sk = SKILLS.get(SKILL_ID[start.skills[0][0]])!, skLv = lv(start.skills[0][0]);
    const tried = new Set<string>();
    let used = false;
    for (let attempt = 0; attempt < 4 && !used; attempt++) {
      let target: string | undefined;
      if (sk.target === "Support") target = room.sessionId;
      else {
        const S = room.state as any;
        const live = [...S.monsters.entries()].filter(([id, m]: any) => !m.dead && !tried.has(id))
          .sort(([, a]: any, [, b]: any) => Math.hypot(a.x - me().x, a.y - me().y) - Math.hypot(b.x - me().x, b.y - me().y));
        if (!live.length) { await wait(1000); continue; }
        const [id, m] = live[0] as [string, any];
        tried.add(id);
        target = id;
        await walkNear(room, () => ({ x: m.x, y: m.y }), 6, 20_000);
      }
      const sp0 = own?.sp ?? 0, hits0 = hits.length;
      casts.length = 0; uses.length = 0; fails.length = 0;
      room.send(Msg.useSkill, { id: sk.id, lv: skLv, target });
      const tw = Date.now();
      while (!uses.some((u) => u.id === sk.id && u.src === room.sessionId) && !fails.length && Date.now() - tw < 9000) await wait(100);
      if (fails.length) { if (fails[0].why === "target") continue; fail(`${job} ${sk.name}: refused (${fails[0].why}: ${fails[0].text})`); }
      if (!uses.some((u) => u.id === sk.id)) continue;
      const use = uses.find((u) => u.id === sk.id)!;
      if (sk.target === "Support") { if (use.heal === undefined) fail(`${job} ${sk.name}: no heal amount`); info.push(`${sk.name} ${skLv} cast (heal ${use.heal})`); }
      else {
        await until(() => hits.slice(hits0).some((h) => h.from === room.sessionId && h.skill === sk.id), 4000, `${job} ${sk.name}: no skill hit`);
        const h = hits.slice(hits0).filter((x) => x.from === room.sessionId && x.skill === sk.id);
        info.push(`${sk.name} ${skLv} hit ${h.map((x) => (x.miss ? "miss" : x.dmg)).join("+")} on a monster, cast ${casts.find((c) => c.id === sk.id)?.castMs ?? 0} ms`);
      }
      await until(() => (own?.sp ?? 0) <= sp0 || skillCost(sk, skLv).sp === 0, 3000, `${job} ${sk.name}: SP not spent`);
      used = true;
    }
    if (!used) fail(`${job} ${sk.name}: never used on a monster (fails ${JSON.stringify(fails)})`);
  }
  say(`OK ${job}: ${info.join("; ")}`);
  report.push(`${job}: ${info.join("; ")}`);
  leaving = true;
  await room.leave();
  await wait(700);
  await deleteChar(url, token, made);
}
// ---- Select Character vs the world: after wearing a headgear (a Hat planted in the dev schema) next to the job's weapon and relogging,
// the summary's look (what the select portrait draws) must equal the public look fields the world shows (what main.ts lookOfState reads)
{
  const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
  const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
  const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
  if (!schema || schema === "ro") fail(`refusing to plant into schema ${schema}: run against the local dev server (ro_dev)`);
  const db = new (createRequire(new URL("../../server/package.json", import.meta.url))("pg").Pool)({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 1, options: `-c search_path="${schema}"` });
  const made = await create({ slot: 0, name: "crb_look", gender: "F", hair: 3, style: 2, job: "Swordman" });
  const hat = (await db.query("INSERT INTO inventory (char_id, item_id, amount) VALUES ($1, $2, 1) RETURNING uid", [made.id, itemNamed("Hat")!.id])).rows[0].uid;
  let room = await botRoom(url, token, made);
  room.onMessage("*", () => {});
  const sid = () => room.sessionId, pub = () => { const p = (room.state as any).players.get(sid()); return { gender: p.gender, hair: p.hair, style: p.style, outfit: p.outfit, job: p.job, weapon: p.weapon || null, shield: p.shield || null, headgear: p.headgear || null, garment: p.garment || null }; };
  await until(() => !!(room.state as any).players.get(sid()), 6000, "look: not in the world");
  room.send(Msg.equip, { uid: Number(hat) });
  await until(() => pub().headgear === "hat", 5000, "look: the Hat was not worn");
  const world = pub();
  await room.leave(); await wait(900);
  const sum = (await apiCall<CharacterSummary[]>(url, "GET", "/characters", token)).find((c) => c.id === made.id)!.look;
  const shown = { gender: sum.gender, hair: sum.hair, style: sum.style, outfit: sum.outfit, job: sum.job, weapon: sum.weapon || null, shield: sum.shield || null, headgear: sum.headgear || null, garment: sum.garment || null };
  if (JSON.stringify(shown) !== JSON.stringify(world)) fail(`select look differs from the world's: summary ${JSON.stringify(shown)} vs world ${JSON.stringify(world)}`);
  if (world.weapon !== "sword" || world.headgear !== "hat" || world.style !== 2 || world.hair !== 3 || world.job !== "Swordman") fail(`look: unexpected world look ${JSON.stringify(world)}`);
  say(`OK look: Select Character look == in-world look after Hat + Sword and a relog (${JSON.stringify(world)})`);
  await deleteChar(url, token, made);
  await db.end();
}
clearTimeout(timeout);
console.log(`create: ${JOBS_RUN.length} characters made, joined, checked and deleted\n  ${report.join("\n  ")}`);
console.log("PASS: create bot");
process.exit(0);
