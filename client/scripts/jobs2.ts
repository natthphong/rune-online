// 2.5.0 end-to-end: the 2nd-job change and 2nd-job skills. For a few first jobs a fresh character is planted in the dev schema (the
// deployed schema is refused) as a Lv 99 / Job 50 first job with its first-job skills learned (the ready ones, >= 49 points past the
// Novice's 9) and no skill points left, then, through the ordinary protocol only: the Guild Grandmaster refuses nothing, changes the
// job (pc_jobchange: job level 1, the gift, the tinted outfit), the character is planted skill points, learns 2-3 skills of the new job
// (prerequisites first, pc_skillup) and uses them on monsters in the field: the cast, the skill going off, a HitEvent carrying the
// skill id (or, for a party buff, the status on the caster).
//   pnpm --filter client jobs2 [serverUrl]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Msg, type HitEvent, type InvEvent, type NpcMenuEvent, type NpcMesEvent, type QuestLogEvent, type SkillCastEvent, type SkillDelayEvent,
  type SkillFailEvent, type SkillsEvent, type SkillUseEvent, type StatusEvent,
} from "../../shared/protocol.ts";
import { FIELD, mapOfState } from "../../shared/maps.ts";
import { naviNextStep, naviRoute, nearestWalkable } from "../../shared/navi.ts";
import { npcCheckNear } from "../../shared/rules/npc.ts";
import { itemNamed } from "../../shared/rules/quest.ts";
import { SKILLS, SKILL_ID, skillLearnable, treeRows } from "../../shared/rules/skill.ts";
import { JOBS, type FirstJob, type JobKey } from "../../shared/rules/data.ts";
import { GRANDMASTER, PATHS, REBIRTH, REBIRTH_FEE } from "../../shared/content/f1/jobs2.ts";
import { MASTERS } from "../../shared/content/f1/jobs.ts";
import { outfitOf, type CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login } from "./bot.ts";

const url = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 600 s"), 600_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(100); } };
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);

// ---------- Postgres (the dev schema the server uses; never the deployed one) ----------
const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing to plant into schema ${schema}: run against the local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

/** The runs: first job -> 2nd job (the first path of PATHS), the skills it learns (prerequisites are learned first) and uses. */
const PLAN: { first: FirstJob; path?: number; learn: [string, number][]; use: string[]; weapon?: string; plantItem?: string }[] = [
  { first: "Swordman", learn: [["KN_PIERCE", 5], ["KN_BOWLINGBASH", 3]], use: ["KN_PIERCE", "KN_BOWLINGBASH"], weapon: "Pike" },
  { first: "Mage", learn: [["WZ_EARTHSPIKE", 3], ["WZ_STORMGUST", 1], ["WZ_FROSTNOVA", 1]], use: ["WZ_EARTHSPIKE", "WZ_STORMGUST", "WZ_FROSTNOVA"] },
  { first: "Acolyte", learn: [["PR_GLORIA", 1], ["PR_MAGNUS", 1], ["PR_KYRIE", 1]], use: ["PR_GLORIA", "PR_KYRIE", "PR_MAGNUS"] },
  { first: "Merchant", path: 1, learn: [["AM_ACIDTERROR", 1], ["AM_POTIONPITCHER", 1]], use: ["AM_ACIDTERROR", "AM_POTIONPITCHER"], plantItem: "Red Tonic" },
  { first: "Thief", learn: [["AS_SONICBLOW", 3], ["AS_GRIMTOOTH", 1]], use: ["AS_SONICBLOW", "AS_GRIMTOOTH"], weapon: "Iron Talons", plantItem: "Iron Talons" },
  { first: "Archer", learn: [["HT_BLITZBEAT", 3]], use: ["HT_BLITZBEAT"] },
];
const only = process.env.JOBS2_ONLY; // e.g. JOBS2_ONLY=Mage
const ACCOUNT = process.env.JOBS2_BOT ?? "jobs2_bot";
const tokens = new Map<string, string>();
const tokenFor = async (name: string) => { const acc = `${ACCOUNT}_${name.slice(0, 3).toLowerCase()}`; if (!tokens.has(acc)) tokens.set(acc, await login(url, acc)); return tokens.get(acc)!; };
async function joinWith(name: string, fresh: boolean) {
  const TOKEN = await tokenFor(name);
  const list = await apiCall<CharacterSummary[]>(url, "GET", "/characters", TOKEN);
  let c = list.find((x) => x.name === name);
  if (c && fresh) { await apiCall(url, "DELETE", `/characters/${c.id}`, TOKEN, { confirmName: name }); c = undefined; }
  if (!c) {
    const used = new Set(list.filter((x) => x.name !== name).map((x) => x.slot));
    const slot = [...Array(9).keys()].find((n) => !used.has(n)) ?? 0;
    c = await apiCall<CharacterSummary>(url, "POST", "/characters", TOKEN, { slot, name, gender: "M", hair: 0 });
  }
  const room = await botRoom(url, TOKEN, c);
  return { room, token: TOKEN, char: c };
}
/** skillUp order for `key` to `lv` with every prerequisite first (skill_tree.yml Requires, recursively). */
function learnOrder(job: JobKey, key: string, lv: number, have: Map<number, number>, out: number[]) {
  const id = SKILL_ID[key], row = treeRows(job).find((r) => r.id === id);
  if (!row) fail(`${key} is not in the ${job} tree`);
  for (const q of row!.requires) learnOrder(job, SKILLS.get(q.id)!.key, q.level, have, out);
  while ((have.get(id) ?? 0) < lv) { have.set(id, (have.get(id) ?? 0) + 1); out.push(id); }
}
const report: string[] = [];
for (const plan of PLAN) {
  if (only && plan.first !== only) continue;
  const path = PATHS[plan.first][plan.path ?? 0], job = path.job, name = `${JOBS[job].name.slice(0, 7)}_${ACCOUNT.replace(/\W/g, "").slice(-5)}`;
  // ---- 1) plant a Lv 99 / Job 50 first job with its (ready) first-job skills at max, no points left
  let s = await session(name, true);
  await s.leave();
  const firstRows = treeRows(plan.first).filter((r) => skillLearnable(r.id)); // working skills + prerequisite stand-ins (Steal, Hiding ...)
  await db.query(`UPDATE characters SET job = $2, level = 99, job_level = 50, skill_points = 0, stat_points = 0, str = 60, agi = 40, vit = 50,
    "int" = 80, dex = 70, luk = 30, zeny = 50000 WHERE id = $1`, [s.charId, plan.first]);
  for (const r of firstRows) await db.query(`INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, $3) ON CONFLICT (char_id, id) DO UPDATE SET lv = EXCLUDED.lv`, [s.charId, r.id, r.maxLevel]);
  s = await session(name, false);
  await until(() => s.me()?.job === plan.first && s.own?.skillPoints === 0, 5000, `${job}: plant not seen (job ${s.me()?.job}, points ${s.own?.skillPoints})`);
  // ---- 2) the Grandmaster: [about A, about B, become A, become B, nothing] -> become the first path, then "Yes"
  const lines = await s.talk(GRANDMASTER.npc, [PATHS[plan.first].filter((p) => !p.gender || p.gender === "M").length + 1 + (plan.path ?? 0), 1]);
  await until(() => s.me().job === job, 4000, `${job}: no job change (${lines.slice(-2).join(" / ")})`);
  await until(() => s.own?.jobLevel === 1, 3000, `${job}: job level not reset to 1`);
  if (s.me().outfit !== outfitOf(job)) fail(`${job}: outfit ${s.me().outfit}, want ${outfitOf(job)}`);
  for (const g of path.gift) await until(() => s.count(itemNamed(g.item)!.id) >= g.count, 3000, `${job}: no ${g.item} from the Grandmaster`);
  await s.leave();
  // ---- 3) skill points for the new job, learn the skills (prerequisites first)
  const have = new Map<number, number>(firstRows.map((r) => [r.id, r.maxLevel]));
  const order: number[] = [];
  for (const [k, l] of plan.learn) learnOrder(job, k, l, have, order);
  await db.query(`UPDATE characters SET job_level = 50, skill_points = $2 WHERE id = $1`, [s.charId, order.length]);
  if (plan.plantItem) await db.query("INSERT INTO inventory (char_id, item_id, amount) VALUES ($1, $2, 1)", [s.charId, itemNamed(plan.plantItem)!.id]); // a 2nd-job weapon / a potion to throw
  if (plan.plantItem === "Red Tonic") await db.query(`UPDATE characters SET hp = 300 WHERE id = $1`, [s.charId]); // something to heal
  s = await session(name, false);
  await until(() => s.own?.skillPoints === order.length, 4000, `${job}: planted ${order.length} points not seen (${s.own?.skillPoints})`);
  for (const id of order) { s.room.send(Msg.skillUp, { id }); await wait(40); }
  await until(() => plan.learn.every(([k, l]) => s.lv(k) >= l), 6000, `${job}: skills not learned: ${plan.learn.map(([k]) => `${k}=${s.lv(k)}`).join(" ")} (notices ${s.notices.slice(-2).join(" / ")})`);
  await s.room.travel(FIELD);
  if (plan.weapon) { const st = s.inv!.items.find((it) => it.itemId === itemNamed(plan.weapon!)!.id); if (!st) fail(`${job}: no ${plan.weapon}`); if (!st!.equip) s.room.send(Msg.equip, { uid: st!.uid }); await wait(400); }
  const results: string[] = [];
  const retries = new Map<string, number>();
  for (let ui = 0; ui < plan.use.length; ui++) {
    const key = plan.use[ui];
    const sk = SKILLS.get(SKILL_ID[key])!, lv = s.lv(key);
    s.casts.length = 0; s.uses.length = 0; s.cancels = 0; s.fails.length = 0;
    const hitsFrom = s.hits.length;
    let target: string | undefined, x: number | undefined, y: number | undefined;
    const tried = new Set<string>();
    for (let attempt = 1; ; attempt++) {
      target = x = y = undefined;
      if (sk.target === "Support") target = s.room.sessionId;
      else if (sk.target !== "Self") {
        const mob = await s.nearMonster(sk.target === "Ground" ? 6 : 5, tried);
        tried.add(mob);
        if (sk.target === "Ground") { const mm = s.S.monsters.get(mob); x = Math.round(mm.x); y = Math.round(mm.y); } else target = mob;
      } else await s.nearMonster(1);
      await until(() => Date.now() >= s.canactAt, 6000, "after-cast delay never ended");
      s.room.send(Msg.useSkill, { id: sk.id, lv, target, x, y });
      const tw = Date.now();
      while (!s.casts.some((c) => c.src === s.room.sessionId && c.id === sk.id) && Date.now() - tw < 6000) await wait(100);
      if (s.casts.some((c) => c.src === s.room.sessionId && c.id === sk.id)) break;
      if (attempt >= 3) fail(`${job} ${key}: no cast event (fails ${JSON.stringify(s.fails.slice(-2))}, notices ${JSON.stringify(s.notices.slice(-3))})`);
    }
    const cast = s.casts.find((c) => c.id === sk.id)!;
    const tw2 = Date.now();
    while (!s.uses.some((u) => u.src === s.room.sessionId && u.id === sk.id) && !s.cancels && Date.now() - tw2 < cast.castMs + 5000) await wait(100);
    const done = s.uses.some((u) => u.src === s.room.sessionId && u.id === sk.id);
    if (!done && (s.cancels || s.fails.length) && (retries.get(key) ?? 0) < 4) { // CastCancel: a hit breaks the cast; the target may die meanwhile
      retries.set(key, (retries.get(key) ?? 0) + 1); say(`${job} ${key}: ${s.cancels ? "cast interrupted" : s.fails[0].text}, again`); ui--; continue;
    }
    await until(() => s.uses.some((u) => u.src === s.room.sessionId && u.id === sk.id), 100, `${job} ${key}: the skill never went off (${s.fails.slice(-1).map((f) => f.text)})`);
    const thrown = s.uses.find((u) => u.src === s.room.sessionId && u.id === sk.id);
    if (key === "AM_POTIONPITCHER") { // a heal on yourself: the potion is gone, the number is the heal
      if (thrown?.heal === undefined) fail(`${job} ${key}: no heal amount`);
      results.push(`${sk.name} ${lv}: heal ${thrown!.heal}`);
      continue;
    }
    const buff = ({ PR_GLORIA: "Gloria", PR_KYRIE: "Kyrie" } as Record<string, string>)[key];
    if (buff) {
      await until(() => s.scs.some((e) => e.sc === buff), 3000, `${job} ${key}: no ${buff} status (${JSON.stringify(s.scs)})`);
      results.push(`${sk.name} ${lv}: status ${s.scs.map((e) => e.sc).join("+")}`);
      continue;
    }
    const tw3 = Date.now();
    while (!s.hits.slice(hitsFrom).some((h) => h.from === s.room.sessionId && h.skill === sk.id) && Date.now() - tw3 < 8000) await wait(100);
    if (!s.hits.slice(hitsFrom).some((h) => h.from === s.room.sessionId && h.skill === sk.id) && (sk.target === "Ground" || sk.target === "Self") && (retries.get(key) ?? 0) < 4) {
      retries.set(key, (retries.get(key) ?? 0) + 1); say(`${job} ${key}: the monster left the area, again`); ui--; continue; // a ground unit hits whoever stands in it
    }
    await until(() => s.hits.slice(hitsFrom).some((h) => h.from === s.room.sessionId && h.skill === sk.id), 100, `${job} ${key}: no skill hit`);
    await wait(sk.target === "Ground" ? 2500 : 300); // ground units hit in waves
    const hit = s.hits.slice(hitsFrom).filter((h) => h.from === s.room.sessionId && h.skill === sk.id);
    results.push(`${sk.name} ${lv}: cast ${cast.castMs} ms, ${hit.length} hit event(s): ${hit.slice(0, 4).map((h) => (h.miss ? "miss" : `${h.dmg}${h.div && h.div > 1 ? `(${h.div})` : ""}`)).join(", ")}`);
  }
  say(`OK ${plan.first} -> ${job} (${JOBS[job].name}, outfit ${s.me().outfit}): ${results.join("; ")}`);
  report.push(`${JOBS[job].name}: ${results.join("; ")}`);
  await s.leave();
  await deleteChar(url, s.token, s.char);
}
// ---- the rebirth (valkyrie.txt): a Lv 99 / Job 50 Lancer -> Keeper -> High Fledgling (level 1, 100 points, no skills) -> the Vanguard
// master -> High Vanguard -> the Grandmaster -> Dragoon (Lord Knight)
if (!only || only === "Rebirth") {
  const name = `Reborn_${ACCOUNT.replace(/\W/g, "").slice(-5)}`;
  let s = await session(name, true);
  await s.leave();
  await db.query(`UPDATE characters SET job = 'Knight', level = 99, job_level = 50, skill_points = 0, stat_points = 0, str = 80, agi = 50, vit = 60,
    "int" = 20, dex = 40, luk = 10, zeny = 1300000 WHERE id = $1`, [s.charId]);
  await db.query(`INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, 9), ($1, $3, 10) ON CONFLICT (char_id, id) DO UPDATE SET lv = EXCLUDED.lv`, [s.charId, SKILL_ID.NV_BASIC, SKILL_ID.SM_BASH]);
  s = await session(name, false);
  await until(() => s.me()?.job === "Knight", 5000, "rebirth: Knight plant not seen");
  const hp99 = s.own!.maxHp;
  await s.talk(REBIRTH.npc, [1]);
  await until(() => s.me().job === "Novice_High" && s.own?.level === 1 && s.own?.statPoints === 100, 4000, `rebirth: not a Lv 1 High Fledgling with 100 points (${s.me().job} Lv ${s.own?.level}, ${s.own?.statPoints} pts)`);
  await until(() => (s.skills?.list ?? []).every((e) => e.lv === 0) && s.inv!.zeny === 1300000 - REBIRTH_FEE, 3000, "rebirth: skills kept or fee not paid");
  say(`rebirth: Lancer Lv 99 (max HP ${hp99}) -> ${JOBS.Novice_High.name} Lv 1, 100 status points, skills reset, ${REBIRTH_FEE} zeny paid`);
  await s.leave();
  await db.query(`UPDATE characters SET job_level = 10 WHERE id = $1`, [s.charId]);
  await db.query(`INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, 9)`, [s.charId, SKILL_ID.NV_BASIC]);
  s = await session(name, false);
  const m = MASTERS.find((x) => x.job === "Swordman")!;
  await s.talk(m.npc, [2, m.answer, 1]);
  await until(() => s.me().job === "Swordman_High", 4000, `rebirth: the Vanguard master didn't make a High Vanguard (${s.me().job})`);
  await s.leave();
  await db.query(`UPDATE characters SET level = 99, job_level = 50, skill_points = 0 WHERE id = $1`, [s.charId]);
  for (const r of treeRows("Swordman").filter((x) => skillLearnable(x.id) && SKILLS.get(x.id)!.key.startsWith("SM_"))) await db.query(`INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, $3) ON CONFLICT (char_id, id) DO UPDATE SET lv = EXCLUDED.lv`, [s.charId, r.id, r.maxLevel]);
  s = await session(name, false);
  await s.talk(GRANDMASTER.npc, [2, 1]); // [about, become, nothing] -> become
  await until(() => s.me().job === "Lord_Knight", 4000, `rebirth: no Dragoon (${s.me().job})`);
  const hpTrans = s.own!.maxHp;
  say(`rebirth: ${JOBS.Swordman_High.name} -> ${JOBS.Lord_Knight.name} at the Grandmaster (outfit ${s.me().outfit}, max HP ${hpTrans} vs ${hp99} as a Lancer)`);
  report.push(`Rebirth: Lancer 99/50 -> High Fledgling 1/1 (100 pts) -> High Vanguard -> Dragoon (max HP ${hp99} -> ${hpTrans})`);
  await s.leave();
  await deleteChar(url, s.token, s.char);
}
clearTimeout(timeout);
await db.end();
console.log(`jobs2: 2nd-job change at the Grandmaster + 2nd-job skills used\n  ${report.join("\n  ")}`);
process.exit(0);

// ---------- one connected session ----------
async function session(name: string, fresh: boolean) {
  const { room, token, char } = await joinWith(name, fresh);
  const S: any = new Proxy({}, { get: (_t, k) => (room.state as any)[k] }); // the current room's state (warps change the room)
  const o = {
    room, token, char, charId: char.id as number, S,
    inv: undefined as InvEvent | undefined, own: undefined as StatusEvent | undefined, skills: undefined as SkillsEvent | undefined,
    quests: [] as QuestLogEvent["quests"], fails: [] as SkillFailEvent[], casts: [] as SkillCastEvent[], uses: [] as SkillUseEvent[],
    hits: [] as HitEvent[], notices: [] as string[], cancels: 0, scs: [] as { sc: string; lv: number; ms: number }[], delay: undefined as SkillDelayEvent | undefined, canactAt: 0, leaving: false,
    me: () => S.players.get(room.sessionId),
    lv: (key: string) => o.skills?.list.find((e) => e.id === SKILL_ID[key])?.lv ?? 0,
    count: (itemId: number) => o.inv?.items.filter((st) => st.itemId === itemId).reduce((n, st) => n + st.amount, 0) ?? 0,
    leave: async () => { o.leaving = true; await room.leave(); await wait(700); },
    talk, nearMonster,
  };
  room.onLeave((code: number) => { if (!o.leaving) fail(`disconnected (code ${code}): the dev server restarted? run again`); });
  room.onMessage(Msg.inv, (m: InvEvent) => { o.inv = m; });
  room.onMessage(Msg.status, (m: StatusEvent) => { o.own = m; });
  room.onMessage(Msg.skills, (m: SkillsEvent) => { o.skills = m; });
  room.onMessage(Msg.quests, (m: QuestLogEvent) => { o.quests = m.quests; });
  room.onMessage(Msg.skillFail, (m: SkillFailEvent) => { o.fails.push({ ...m, at: Date.now() - t0 } as SkillFailEvent); });
  room.onMessage(Msg.skillCast, (m: SkillCastEvent) => { o.casts.push(m); });
  room.onMessage(Msg.skillUse, (m: SkillUseEvent) => { o.uses.push(m); });
  room.onMessage(Msg.skillDelay, (m: SkillDelayEvent) => { o.delay = m; o.canactAt = Date.now() + m.delayMs + 50; });
  room.onMessage(Msg.hit, (m: HitEvent) => { o.hits.push(m); });
  room.onMessage(Msg.skillCancel, (m: { src: string }) => { if (m.src === room.sessionId) o.cancels++; });
  room.onMessage(Msg.scList, (m: { list: { sc: string; lv: number; ms: number }[] }) => { o.scs = m.list; });
  room.onMessage(Msg.notice, (m: { text: string }) => { o.notices.push(m.text); });
  room.onMessage("*", () => {});
  room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) setTimeout(() => room.send(Msg.respawn), 300); });
  // dialog transcript (answered like quest.ts does)
  type Ev = { npc: string; t: "mes" | "next" | "close" | "menu" | "end" | "clear"; text?: string; options?: string[] };
  const events: Ev[] = [];
  let read = 0, talking = false;
  // an OnTouch area walked into on the way (Lio, Mira, the lookout ...) opens a dialog that locks the character (pc_cant_act):
  // outside talk() the bot closes it like a player would
  const stray = (npc: string) => { if (!talking) setTimeout(() => room.send(Msg.npcClose, { npc }), 50); };
  for (const t of [Msg.npcNextBtn, Msg.npcCloseBtn, Msg.npcMenuList]) room.onMessage(t, (m: { npc: string }) => stray(m.npc));
  room.onMessage(Msg.npcMes, (m: NpcMesEvent) => events.push({ npc: m.npc, t: "mes", text: m.text }));
  room.onMessage(Msg.npcNextBtn, (m: { npc: string }) => events.push({ npc: m.npc, t: "next" }));
  room.onMessage(Msg.npcCloseBtn, (m: { npc: string }) => events.push({ npc: m.npc, t: "close" }));
  room.onMessage(Msg.npcMenuList, (m: NpcMenuEvent) => events.push({ npc: m.npc, t: "menu", options: m.options }));
  room.onMessage(Msg.npcEnd, (m: { npc: string }) => events.push({ npc: m.npc, t: "end" }));
  room.onMessage(Msg.npcClear, (m: { npc: string }) => events.push({ npc: m.npc, t: "clear" }));
  await until(() => !!o.inv && !!o.own && !!o.skills, 5000, "no inventory / status / skills at login");
  // the spawn cell is inside Guide Lio's OnTouch area: close whatever opened
  await wait(500);
  for (const e of events.splice(0)) if (e.t === "next" || e.t === "close" || e.t === "menu") room.send(Msg.npcClose, { npc: e.npc });
  await wait(300);
  events.length = 0;

  async function talk(npc: string, choices: number[]) {
    const n = S.npcs.get(npc);
    if (!n) fail(`NPC ${npc} is not in the room state`);
    await walkTo(n.x, n.y, 3);
    talking = true;
    read = events.length;
    room.send(Msg.npc, { id: npc });
    const lines: string[] = [];
    for (;;) {
      await until(() => events.length > read, 6000, `dialog with ${npc} stalled after: ${lines.slice(-2).join(" / ")}`);
      const ev = events[read++];
      if (ev.npc !== npc) continue;
      if (ev.t === "mes") lines.push(ev.text!);
      else if (ev.t === "next") { await wait(60); room.send(Msg.npcNext, { npc }); }
      else if (ev.t === "menu") {
        const c = choices.shift();
        if (c === undefined) fail(`unexpected menu ${ev.options!.join("/")} (${npc}) after ${lines.slice(-2).join(" / ")}`);
        await wait(60); room.send(Msg.npcMenu, { npc, choice: c });
      } else if (ev.t === "close") { await wait(60); room.send(Msg.npcClose, { npc }); await wait(250); if (events.length === read) break; }
      else if (ev.t === "end") break;
    }
    if (choices.length) fail(`menu choices left over: ${choices} (${npc}): ${lines.join(" / ")}`);
    await wait(300);
    talking = false;
    return lines;
  }
  async function walkTo(x: number, y: number, within: number) {
    const m = mapOfState(room.state as any), goal = nearestWalkable(m, x, y)!;
    for (let hop = 0; hop < 80; hop++) {
      const me = o.me(), c = { x: Math.round(me.x), y: Math.round(me.y) };
      if (Math.max(Math.abs(c.x - x), Math.abs(c.y - y)) <= within && npcCheckNear(c, { x, y })) return;
      const step = naviNextStep(m, naviRoute(m, c.x, c.y, goal.x, goal.y), c);
      if (!step) fail(`no navigation step from ${c.x},${c.y} to ${goal.x},${goal.y}`);
      room.send(Msg.move, { x: step!.x, y: step!.y });
      const tw = Date.now();
      while (o.me().moving || Math.round(o.me().x) !== step!.x || Math.round(o.me().y) !== step!.y) {
        if (Date.now() - tw > 10_000) break;
        await wait(100);
      }
    }
    fail(`could not reach ${x},${y}`);
  }
  /** Walk next to the nearest live monster (within `within` cells) and return its id. */
  async function nearMonster(within: number, skip: ReadonlySet<string> = new Set()): Promise<string> {
    for (let tries = 0; tries < 40; tries++) {
      const p = o.me();
      const live = [...S.monsters.entries()].filter(([mid, mm]: any) => !mm.dead && !skip.has(mid)) // skip: tried and out of reach
        .sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
      if (!live.length) { await wait(1000); continue; }
      const [id, mm] = live[0] as [string, any];
      if (Math.max(Math.abs(mm.x - p.x), Math.abs(mm.y - p.y)) <= within) return id;
      room.send(Msg.move, { x: Math.round(mm.x), y: Math.round(mm.y) });
      await wait(700);
    }
    return fail("no monster reached");
  }
  return o;
}
