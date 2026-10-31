// End-to-end job change + skills check (C04). For each of the six first jobs a fresh character is planted in the dev schema as a
// Fledgling at Job Lv 10 with 9 skill points (like the critics' offline plants; the deployed schema is refused), then, through the
// ordinary protocol only: sitting is refused below Basic Training 3 (basic_skill_check), Basic Training is learned to 9 with
// skill points (pc_skillup), the job master is talked to (wrong answer first, then the right one) and changes the job
// (pc_jobchange: job level 1, the starter weapon, the equipment sweep: an Acolyte loses the Knife), "A Calling" completes. Then the
// character is planted 12 skill points of its new job, learns the job's skills and uses each implemented one on a monster (or
// itself for Heal): the cast bar event, SP / zeny / ammo spent, the skill hit (or heal) arriving, the after-cast delay refusal.
//   pnpm --filter client jobs [serverUrl]
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
import { SKILLS, SKILL_ID, skillCost } from "../../shared/rules/skill.ts";
import type { FirstJob, JobKey } from "../../shared/rules/data.ts";
import { CALLING, MASTERS } from "../../shared/content/f1/jobs.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login } from "./bot.ts";

const url = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:2567";
const KEEP = process.argv.includes("--keep");
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

/** The skills each job's run learns (in this order) and the ones it uses, with the target kind. */
const PLAN: Record<FirstJob, { learn: [string, number][]; use: string[] }> = {
  Swordman: { learn: [["SM_BASH", 5], ["SM_MAGNUM", 1]], use: ["SM_BASH", "SM_MAGNUM"] },
  Mage: { learn: [["MG_FIREBOLT", 2], ["MG_COLDBOLT", 1], ["MG_LIGHTNINGBOLT", 1], ["MG_NAPALMBEAT", 4], ["MG_SOULSTRIKE", 1]], use: ["MG_FIREBOLT", "MG_COLDBOLT", "MG_LIGHTNINGBOLT", "MG_NAPALMBEAT", "MG_SOULSTRIKE"] },
  Archer: { learn: [["AC_DOUBLE", 5], ["AC_SHOWER", 1]], use: ["AC_DOUBLE", "AC_SHOWER"] },
  Acolyte: { learn: [["AL_HEAL", 3]], use: ["AL_HEAL"] },
  Merchant: { learn: [["MC_MAMMONITE", 3]], use: ["MC_MAMMONITE"] },
  Thief: { learn: [["TF_POISON", 3]], use: ["TF_POISON"] },
};
const ACCOUNT = process.env.JOBS_BOT ?? "jobs_bot";
// one account (and login) per job: a second runner on the same account kicks the session (close code 4001)
const tokens = new Map<string, string>();
const tokenFor = async (name: string) => { const acc = `${ACCOUNT}_${name.slice(0, 3)}`; if (!tokens.has(acc)) tokens.set(acc, await login(url, acc)); return tokens.get(acc)!; };
/** joinAs with the job's token: character `name` (recreated when fresh) joins the map. */
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
  const room = await botRoom(url, TOKEN, c); // W01: joins the character's map (Hearthmoor for a new one) and follows warps
  return { room, token: TOKEN, char: c };
}
const report: string[] = [];

for (const m of MASTERS.filter((x) => !process.env.JOBS_ONLY || x.job === process.env.JOBS_ONLY)) {
  const job = m.job, name = `${job.slice(0, 6)}_${ACCOUNT.replace(/\W/g, "").slice(-6)}`; // names are global: one set per account
  // ---- 1) a fresh Fledgling, planted at Job Lv 10 with 9 skill points
  let s = await session(name, true);
  await s.leave();
  await db.query(`UPDATE characters SET level = 20, job_level = 10, skill_points = 9, stat_points = 0, str = 30, agi = 20, vit = 20, "int" = 30,
    dex = 30, luk = 10, zeny = 5000 WHERE id = $1`, [s.charId]);
  s = await session(name, false);
  await until(() => !!s.skills && s.own?.skillPoints === 9, 4000, `${job}: planted points not seen`);
  // sitting needs Basic Training 3
  s.room.send(Msg.sit);
  await until(() => s.fails.some((f) => f.why === "basic"), 3000, `${job}: sitting was not refused below Basic Training 3`);
  for (let i = 0; i < 9; i++) s.room.send(Msg.skillUp, { id: SKILL_ID.NV_BASIC });
  await until(() => s.lv("NV_BASIC") === 9 && s.own?.skillPoints === 0, 4000, `${job}: Basic Training not learned to 9 (${s.lv("NV_BASIC")})`);
  s.room.send(Msg.sit);
  await until(() => s.me().sitting, 3000, `${job}: could not sit with Basic Training 9`);
  s.room.send(Msg.sit);
  await until(() => !s.me().sitting, 3000, `${job}: could not stand up`);
  // ---- 2) the master: a wrong answer changes nothing, the right one changes the job
  const wrong = m.answer === 1 ? 2 : 1;
  let lines = await s.talk(m.npc, [2, wrong]);
  if (s.me().job !== "Novice") fail(`${job}: a wrong answer changed the job`);
  lines = await s.talk(m.npc, [2, m.answer, 1]);
  await until(() => s.me().job === job, 3000, `${job}: no job change (${lines.slice(-2).join(" / ")})`);
  await until(() => s.own?.jobLevel === 1, 3000, `${job}: job level not reset to 1`);
  for (const k of m.kit) await until(() => s.count(itemNamed(k.item)!.id) >= k.count, 3000, `${job}: no ${k.item} from the master`);
  if (job === "Acolyte") await until(() => !s.inv!.items.find((it) => it.itemId === 1201)?.equip, 3000, "Acolyte: the Knife stayed worn (pc_jobchange equipment sweep)");
  await until(() => s.quests.every((q) => q.id !== CALLING), 3000, `${job}: "A Calling" still held`);
  await s.leave();
  // ---- 3) points for the new job, then every implemented skill on a target
  const plan = PLAN[job];
  const need = plan.learn.reduce((n, [, l]) => n + l, 0);
  await db.query(`UPDATE characters SET job_level = 20, skill_points = $2, sp = 400 WHERE id = $1`, [s.charId, need]);
  // 2.5.0: a skill whose effect comes later keeps its points (every tree skill takes points, like rAthena): 2 planted in Waygate stay
  await db.query(`INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, 2) ON CONFLICT (char_id, id) DO UPDATE SET lv = 2`, [s.charId, SKILL_ID.AL_WARP]);
  s = await session(name, false);
  await until(() => s.own?.skillPoints === need, 4000, `${job}: planted job points not seen / a later skill's points refunded (have ${s.own?.skillPoints})`);
  if (job === "Acolyte" && s.lv("AL_WARP") !== 2) throw new Error(`${job}: the later skill lost its levels`);
  for (const [key, lv] of plan.learn) for (let i = 0; i < lv; i++) s.room.send(Msg.skillUp, { id: SKILL_ID[key] });
  await until(() => plan.learn.every(([k, l]) => s.lv(k) === l), 5000, `${job}: skills not learned: ${plan.learn.map(([k]) => `${k}=${s.lv(k)}`).join(" ")}`);
  await s.room.travel(FIELD); // W01: the guild row is in town, the monsters out the west gate
  // wear the master's weapon (and the arrows)
  for (const k of m.kit) { const st = s.inv!.items.find((it) => it.itemId === itemNamed(k.item)!.id)!; if (!st.equip) s.room.send(Msg.equip, { uid: st.uid }); await wait(300); }
  const results: string[] = [];
  for (const key of plan.use) {
    const sk = SKILLS.get(SKILL_ID[key])!, lv = s.lv(key);
    const sp0 = s.own!.sp, zeny0 = s.inv!.zeny, arrows0 = s.count(itemNamed("Arrow")!.id);
    s.casts.length = 0; s.uses.length = 0;
    const hitsFrom = s.hits.length;
    let target: string | undefined, x: number | undefined, y: number | undefined;
    // a target can die from the previous skill's hits while this one walks in (the request then just ends): pick again, 3 tries
    const tried = new Set<string>();
    for (let attempt = 1; ; attempt++) {
      if (sk.target === "Support") target = s.room.sessionId;
      else if (sk.target !== "Self") {
        const mob = await s.nearMonster(sk.target === "Ground" ? 6 : 5, tried);
        tried.add(mob);
        if (sk.target === "Ground") { const mm = s.S.monsters.get(mob); x = Math.round(mm.x); y = Math.round(mm.y); } else target = mob;
      } else await s.nearMonster(1);
      await until(() => Date.now() >= s.canactAt, 5000, "after-cast delay never ended");
      s.fails.length = 0; // a refusal of an earlier attempt is not this one's
      s.room.send(Msg.useSkill, { id: sk.id, lv, target, x, y });
      const tw = Date.now();
      while (!s.casts.some((c) => c.src === s.room.sessionId && c.id === sk.id) && Date.now() - tw < 6000) await wait(100);
      if (s.casts.some((c) => c.src === s.room.sessionId && c.id === sk.id)) {
        // the target can also die during the cast (USESKILL_FAIL "target" at castend): pick again
        const c0 = s.casts.find((c) => c.src === s.room.sessionId && c.id === sk.id)!, tc = Date.now();
        while (!s.uses.some((u) => u.src === s.room.sessionId && u.id === sk.id) && !s.fails.some((f) => f.id === sk.id && f.why === "target") && Date.now() - tc < c0.castMs + 4000) await wait(100);
        if (attempt < 3 && !s.uses.some((u) => u.src === s.room.sessionId && u.id === sk.id) && s.fails.some((f) => f.id === sk.id && f.why === "target")) { s.casts.length = 0; s.fails.length = 0; continue; }
        break;
      }
      if (attempt >= 3) fail(`${job} ${key}: no cast event (fails ${JSON.stringify(s.fails)}, notices ${JSON.stringify(s.notices.slice(-3))}, me ${JSON.stringify({ x: s.me().x, y: s.me().y, moving: s.me().moving })})`);
    }
    const cast = s.casts.find((c) => c.id === sk.id)!;
    await until(() => s.uses.some((u) => u.src === s.room.sessionId && u.id === sk.id), cast.castMs + 4000, `${job} ${key}: the skill never went off (${s.fails.slice(-1).map((f) => f.text)})`);
    const use = s.uses.find((u) => u.id === sk.id)!;
    if (sk.target === "Support") {
      if (use.heal === undefined) fail(`${job} ${key}: no heal amount`);
    } else {
      await until(() => s.hits.slice(hitsFrom).some((h) => h.from === s.room.sessionId && h.skill === sk.id), 4000, `${job} ${key}: no skill hit`);
    }
    const cost = skillCost(sk, lv);
    await until(() => s.own!.sp <= sp0 - cost.sp + 40, 3000, `${job} ${key}: SP not spent (${sp0} -> ${s.own!.sp}, cost ${cost.sp})`); // regen may tick in between
    if (cost.zeny) await until(() => s.inv!.zeny === zeny0 - cost.zeny, 3000, `${job} ${key}: zeny not spent`);
    if (cost.ammo) await until(() => s.count(itemNamed("Arrow")!.id) === arrows0 - cost.ammo, 3000, `${job} ${key}: arrows not spent`);
    const hit = s.hits.slice(hitsFrom).filter((h) => h.from === s.room.sessionId && h.skill === sk.id);
    results.push(`${sk.name} ${lv}: cast ${cast.castMs} ms, ${use.heal !== undefined ? `heal ${use.heal}` : hit.map((h) => (h.miss ? "miss" : `${h.dmg}${h.div && h.div > 1 ? `(${h.div} hits)` : ""}`)).join(", ")}`);
    // the after-cast delay refuses a second use at once
    if ((s.delay?.delayMs ?? 0) > 300) {
      s.fails.length = 0;
      s.room.send(Msg.useSkill, { id: sk.id, lv, target: target ?? s.room.sessionId, x, y });
      await until(() => s.fails.some((f) => f.why === "delay" || f.why === "cooldown"), 2000, `${job} ${key}: no after-cast delay refusal (delay ${JSON.stringify(s.delay)}, fails ${JSON.stringify(s.fails)}, casts ${s.casts.length})`);
    }
  }
  say(`OK ${job}: Basic Training 9, sit gate, ${m.name} (wrong answer refused), job changed, kit given${job === "Acolyte" ? ", Knife swept off" : ""}; ${results.join("; ")}`);
  report.push(`${job}: ${results.join("; ")}`);
  await s.leave();
  // --keep: the Mage (or KEEP_JOB, e.g. a job with its own outfit) stays for the loop's shots (shot.ts cast / game)
  if (!(KEEP && job === (process.env.KEEP_JOB ?? "Mage"))) await deleteChar(url, s.token, s.char);
}
clearTimeout(timeout);
await db.end();
console.log(`jobs: all six first jobs changed and every implemented skill used\n  ${report.join("\n  ")}`);
process.exit(0);

// ---------- one connected session ----------
async function session(name: string, fresh: boolean) {
  const { room, token, char } = await joinWith(name, fresh);
  const S: any = new Proxy({}, { get: (_t, k) => (room.state as any)[k] }); // the current room's state (warps change the room)
  const o = {
    room, token, char, charId: char.id as number, S,
    inv: undefined as InvEvent | undefined, own: undefined as StatusEvent | undefined, skills: undefined as SkillsEvent | undefined,
    quests: [] as QuestLogEvent["quests"], fails: [] as SkillFailEvent[], casts: [] as SkillCastEvent[], uses: [] as SkillUseEvent[],
    hits: [] as HitEvent[], notices: [] as string[], delay: undefined as SkillDelayEvent | undefined, canactAt: 0, leaving: false,
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
