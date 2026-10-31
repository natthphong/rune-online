// End-to-end status-change check (B14), dev server only. Characters are planted in the dev schema (like jobs.ts; the deployed schema is
// refused) as an Acolyte, a Swordman and a Mage with the status skills learned, then, through the ordinary protocol:
//   Acolyte   Blessing / Increase AGI / Angelus on itself (stats, speed, max HP, the visible option, the icon list with its time),
//             Decrease AGI on a monster (it slows), Blind (dev) cut by Cure, Silence and Stun (dev) refusing skills and walking,
//             Sleep (dev) broken by a monster's hit, a monster's Poison attack (mob_skill_db NPC_POISON) landing, draining HP, and
//             stopping regeneration, statuses surviving a map change
//   Swordman  Provoke on a monster (ATK + / DEF -), Endure on itself (MDEF +, 7 hits)
//   Mage      Frost Diver freezing a monster, Stone Curse petrifying one (two phases)
// Debuffs the skills cannot give (Silence, Stun, Sleep, Blind) come from the dev-only Msg.devStatus shortcut; "dump" reads a unit's numbers back.
//   pnpm --filter client status [serverUrl]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Msg, type DevStatusMsg, type HitEvent, type ScListEvent, type SkillDelayEvent, type SkillFailEvent, type SkillUseEvent, type StatusEvent,
} from "../../shared/protocol.ts";
import { FIELD, mapOfState } from "../../shared/maps.ts";
import { pathSearchLong, walkable } from "../../shared/map.ts";
import { SKILLS, SKILL_ID, treeRows } from "../../shared/rules/skill.ts";
import type { CharacterSummary } from "../../shared/look.ts";
import { apiCall, botRoom, deleteChar, login } from "./bot.ts";

const url = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("timed out after 400 s"), 400_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (f: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) fail(what); await wait(80); } };
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);
const check = (cond: unknown, what: string) => { if (!cond) fail(what); };

const envOf = (file: string) => Object.fromEntries((() => { try { return readFileSync(new URL(file, import.meta.url), "utf8"); } catch { return ""; } })().split("\n")
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const env = { ...envOf("../../../.env"), ...envOf("../../.env") };
const schema = process.env.DB_SCHEMA ?? env.DB_SCHEMA;
if (!schema || schema === "ro") fail(`refusing to plant into schema ${schema}: run against a local dev server (ro_dev)`);
const pg = createRequire(new URL("../../server/package.json", import.meta.url))("pg");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? env.DATABASE_URL, max: 2, options: `-c search_path="${schema}"` });

type Dump = { id: string; walkMs: number; hit: number; flee: number; def: number; def2: number; mdef: number; aspd: number; maxHp: number; atkPercent: number; element: string;
  stats: Record<string, number>; sc: string[]; opt: string; cant?: { move: boolean; cast: boolean; attack: boolean } };

/** Skills (with their prerequisites at the level they ask) to plant for a job. */
function plan(job: string, want: Record<string, number>) {
  const rows = treeRows(job), out: Record<number, number> = { [SKILL_ID.NV_BASIC]: 9 };
  const need = (id: number, lv: number) => {
    if ((out[id] ?? 0) >= lv) return;
    out[id] = lv;
    for (const q of rows.find((r) => r.id === id)?.requires ?? []) need(q.id, q.level);
  };
  for (const [k, lv] of Object.entries(want)) need(SKILL_ID[k], lv);
  return out;
}

async function session(account: string, name: string, job: string, skills: Record<string, number>, field = true) {
  const token = await login(url, account);
  const list = await apiCall<CharacterSummary[]>(url, "GET", "/characters", token);
  const old = list.find((x) => x.name === name);
  if (old) await apiCall(url, "DELETE", `/characters/${old.id}`, token, { confirmName: name });
  const slot = [...Array(9).keys()].find((n) => !new Set(list.filter((x) => x.name !== name).map((x) => x.slot)).has(n)) ?? 0;
  const char = await apiCall<CharacterSummary>(url, "POST", "/characters", token, { slot, name, gender: "M", hair: 0 });
  // plant: job, levels, stats, the skills with their prerequisites (never touching the deployed schema)
  await db.query(`UPDATE characters SET job = $2, level = 40, job_level = 30, skill_points = 0, stat_points = 0, str = 40, agi = 30, vit = 40, "int" = 60,
    dex = 40, luk = 30, zeny = 5000, sp = 900, hp = 9000 WHERE id = $1`, [char.id, job]);
  for (const [id, lv] of Object.entries(plan(job, skills))) await db.query(`INSERT INTO skill (char_id, id, lv) VALUES ($1, $2, $3) ON CONFLICT (char_id, id) DO UPDATE SET lv = $3`, [char.id, Number(id), lv]);
  const room = await botRoom(url, token, char);
  const S: any = new Proxy({}, { get: (_t, k) => (room.state as any)[k] });
  const o = {
    room, token, char, S, own: undefined as StatusEvent | undefined, list: [] as ScListEvent["list"], listAt: 0, fails: [] as SkillFailEvent[], uses: [] as SkillUseEvent[],
    hits: [] as HitEvent[], dumps: [] as Dump[], notices: [] as string[], canactAt: 0, deaths: 0,
    me: () => S.players.get(room.sessionId),
    has: (sc: string) => o.list.some((e) => e.sc === sc),
    entry: (sc: string) => o.list.find((e) => e.sc === sc),
    dev: (m: DevStatusMsg) => room.send(Msg.devStatus, m),
    /** A unit's numbers right now (the server answers with a notice). */
    async dump(target?: string): Promise<Dump> {
      const id = target ?? room.sessionId, from = o.dumps.length;
      o.dev({ op: "dump", target });
      await until(() => o.dumps.slice(from).some((d) => d.id === id), 3000, `no dump of ${id}`);
      return o.dumps.slice(from).find((d) => d.id === id)!;
    },
    /** Learn nothing: use a planted skill, wait for it to go off. target undefined = self. */
    async cast(key: string, lv: number, target?: string) {
      const sk = SKILLS.get(SKILL_ID[key])!, from = o.uses.length, ff = o.fails.length;
      await until(() => Date.now() >= o.canactAt, 6000, "after-cast delay never ended");
      room.send(Msg.useSkill, { id: sk.id, lv, target: sk.target === "Support" ? target ?? room.sessionId : target });
      const tw = Date.now();
      while (!o.uses.slice(from).some((u) => u.id === sk.id) && !o.fails.slice(ff).length && Date.now() - tw < 7000) await wait(60);
      return { used: o.uses.slice(from).some((u) => u.id === sk.id), fails: o.fails.slice(ff) };
    },
    /** Walk next to a live monster and return its id. */
    async nearMonster(within = 4, notId?: string, minHp = 0): Promise<string> {
      for (let tries = 0; tries < 50; tries++) {
        const p = o.me();
        const live = [...S.monsters.entries()].filter(([id, mm]: any) => !mm.dead && id !== notId && mm.maxHp < 5000 && mm.maxHp >= minHp)
          .sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
        if (!live.length) { await wait(1000); continue; }
        const [id, mm] = live[0] as [string, any];
        if (Math.max(Math.abs(mm.x - p.x), Math.abs(mm.y - p.y)) <= within) return id;
        room.send(Msg.move, { x: Math.round(mm.x), y: Math.round(mm.y) });
        await wait(600);
      }
      return fail("no monster reached");
    },
    leave: async () => { await room.leave(); await wait(500); },
  };
  room.onMessage(Msg.status, (m: StatusEvent) => { o.own = m; });
  room.onMessage(Msg.scList, (m: ScListEvent) => { o.list = m.list; o.listAt = Date.now(); });
  room.onMessage(Msg.skillFail, (m: SkillFailEvent) => { o.fails.push(m); });
  room.onMessage(Msg.skillUse, (m: SkillUseEvent) => { if (m.src === room.sessionId) o.uses.push(m); });
  room.onMessage(Msg.skillDelay, (m: SkillDelayEvent) => { o.canactAt = Date.now() + m.delayMs + 60; });
  room.onMessage(Msg.hit, (m: HitEvent) => { o.hits.push(m); });
  room.onMessage(Msg.notice, (m: { text: string }) => {
    o.notices.push(m.text);
    if (m.text.startsWith("[dev-status] ")) o.dumps.push(JSON.parse(m.text.slice(13)));
  });
  // the arrival cell is inside Guide Lio's OnTouch area: a dialog that locks the character (pc_cant_act) is closed like a player would
  for (const t of [Msg.npcNextBtn, Msg.npcCloseBtn, Msg.npcMenuList]) room.onMessage(t, (m: { npc: string }) => { setTimeout(() => room.send(Msg.npcClose, { npc: m.npc }), 50); });
  room.onMessage("*", () => {});
  room.onMessage(Msg.die, (m: { id: string }) => { if (m.id === room.sessionId) { o.deaths++; setTimeout(() => room.send(Msg.respawn), 300); } });
  await until(() => !!o.own && o.listAt > 0, 6000, "no status / status list at login");
  await wait(800);
  if (field) await room.travel(FIELD); // the monsters are out the west gate
  return o;
}

// =============================== Acolyte ===============================
{
  const s = await session("status_bot_a", "StatusAco", "Acolyte", { AL_BLESSING: 5, AL_INCAGI: 3, AL_DECAGI: 2, AL_ANGELUS: 3, AL_CURE: 1, AL_HEAL: 3 }, false);
  // ---- statuses survive a map change: Silence given in town is still running, with less time, in the field
  s.dev({ op: "start", sc: "Silence", ms: 120_000, force: true });
  await until(() => s.has("Silence"), 3000, "no Silence before the warp");
  const before = s.entry("Silence")!;
  await s.room.travel(FIELD);
  await until(() => s.has("Silence"), 8000, "Silence was lost on the map change");
  const after = s.entry("Silence")!;
  check(after.ms < before.ms && after.ms > 90_000, `Silence kept its remaining time over the warp: ${before.ms} -> ${after.ms}`);
  say(`OK statuses survive a map change (Silence ${Math.round(before.ms / 1000)} s -> ${Math.round(after.ms / 1000)} s left)`);
  s.dev({ op: "end", sc: "Silence" });
  await until(() => !s.has("Silence"), 3000, "Silence would not end");
  const base = await s.dump();
  check(base.sc.length === 0 && base.opt === "", `fresh character carries statuses: ${JSON.stringify(base.sc)}`);
  // ---- buffs from its own skills
  let r = await s.cast("AL_BLESSING", 5);
  check(r.used, `Blessing did not go off: ${JSON.stringify(r.fails)}`);
  await until(() => s.has("Blessing"), 3000, "no Blessing icon");
  const bless = s.entry("Blessing")!;
  check(bless.lv === 5 && bless.ms > 135_000 && bless.ms <= 140_000, `Blessing 5 lasts 140 s, list says ${bless.ms} ms`);
  let d = await s.dump();
  check(d.stats.str === base.stats.str + 5 && d.stats.int === base.stats.int + 5 && d.stats.dex === base.stats.dex + 5, `Blessing +5 STR/INT/DEX: ${JSON.stringify(base.stats)} -> ${JSON.stringify(d.stats)}`);
  check(d.hit > base.hit + 10, `Blessing raises HIT (+2 per level and the DEX): ${base.hit} -> ${d.hit}`);
  r = await s.cast("AL_INCAGI", 3);
  check(r.used, `Increase AGI did not go off: ${JSON.stringify(r.fails)}`);
  await until(() => s.has("IncreaseAgi"), 3000, "no Increase AGI icon");
  d = await s.dump();
  check(d.walkMs === 112 && base.walkMs === 150, `Increase AGI 150 -> 112 ms/cell: ${base.walkMs} -> ${d.walkMs}`);
  check(d.stats.agi === base.stats.agi + 5 && d.aspd > base.aspd, `Increase AGI +5 AGI and faster attacks: agi ${base.stats.agi} -> ${d.stats.agi}, aspd ${base.aspd} -> ${d.aspd}`);
  r = await s.cast("AL_ANGELUS", 3);
  check(r.used, `Angelus did not go off: ${JSON.stringify(r.fails)}`);
  await until(() => s.has("Angelus") && s.me().opt.includes("angelus"), 3000, `Angelus not shown (list ${s.list.map((e) => e.sc)}, opt "${s.me().opt}")`);
  d = await s.dump();
  check(d.maxHp === base.maxHp + 150 && d.def2 > base.def2, `Angelus 3: max HP +150, soft DEF up: ${base.maxHp} -> ${d.maxHp}, ${base.def2} -> ${d.def2}`);
  say(`OK buffs: Blessing ${bless.lv} (${Math.round(bless.ms / 1000)} s), Increase AGI (walk 150 -> 112 ms), Angelus (max HP ${base.maxHp} -> ${d.maxHp}), option "${s.me().opt}"`);

  // ---- Decrease AGI on a monster
  const mob = await s.nearMonster(5);
  const mob0 = await s.dump(mob);
  let slowed: Dump | undefined;
  for (let i = 0; i < 8 && !slowed; i++) {
    r = await s.cast("AL_DECAGI", 2, mob);
    if (!r.used && r.fails.some((f) => f.why === "target")) { slowed = undefined; break; }
    const m1 = await s.dump(mob);
    if (m1.sc.includes("DecreaseAgi")) slowed = m1;
  }
  check(slowed && slowed.walkMs > mob0.walkMs && slowed.stats.agi === Math.max(0, mob0.stats.agi - 4), `Decrease AGI 2 slows the monster: ${JSON.stringify(mob0.walkMs)} -> ${slowed?.walkMs}, agi ${mob0.stats.agi} -> ${slowed?.stats.agi}`);
  say(`OK Decrease AGI on a monster: walk ${mob0.walkMs} -> ${slowed!.walkMs} ms, AGI ${mob0.stats.agi} -> ${slowed!.stats.agi}`);

  // ---- Blind (dev) is cut by Cure; Silence refuses skills; Stun refuses skills and walking
  const clean = await s.dump();
  s.dev({ op: "start", sc: "Blind", ms: 60_000, force: true });
  await until(() => s.has("Blind") && s.me().opt.includes("blind"), 3000, "Blind not shown");
  d = await s.dump();
  check(d.hit < clean.hit && d.flee < clean.flee, `Blind cuts HIT and FLEE by 25 %: ${clean.hit}/${clean.flee} -> ${d.hit}/${d.flee}`);
  r = await s.cast("AL_CURE", 1);
  check(r.used, `Cure did not go off: ${JSON.stringify(r.fails)}`);
  await until(() => !s.has("Blind"), 3000, "Cure left Blind on");
  d = await s.dump();
  check(d.hit === clean.hit && d.flee === clean.flee && !s.me().opt.includes("blind"), "Blind's numbers did not come back");
  s.dev({ op: "start", sc: "Silence", ms: 2500, force: true });
  await until(() => s.has("Silence") && s.me().opt.includes("silence"), 3000, "Silence not shown");
  r = await s.cast("AL_HEAL", 1);
  check(!r.used && r.fails.some((f) => f.why === "status"), `a silenced character used Heal: ${JSON.stringify(r)}`);
  await until(() => !s.has("Silence"), 6000, "Silence never ended");
  r = await s.cast("AL_HEAL", 1);
  check(r.used, `Heal still refused after Silence ended: ${JSON.stringify(r.fails)}`);
  const at = { x: Math.round(s.me().x), y: Math.round(s.me().y) };
  const wm = mapOfState(s.room.state as any);
  const away = [[4, 0], [-4, 0], [0, 4], [0, -4], [3, 3], [-3, -3]].map(([dx, dy]) => ({ x: at.x + dx, y: at.y + dy })).find((c) => walkable(wm, c.x, c.y) && pathSearchLong(wm, at.x, at.y, c.x, c.y)) ?? fail("nowhere to walk");
  s.dev({ op: "start", sc: "Stun", ms: 2200, force: true });
  await until(() => s.has("Stun") && s.me().opt.includes("stun"), 3000, "Stun not shown");
  s.room.send(Msg.move, away);
  await wait(900);
  check(Math.round(s.me().x) === at.x && Math.round(s.me().y) === at.y && !s.me().moving, "a stunned character walked");
  r = await s.cast("AL_HEAL", 1);
  check(!r.used && r.fails.some((f) => f.why === "status"), "a stunned character used Heal");
  await until(() => !s.has("Stun"), 5000, "Stun never ended");
  s.room.send(Msg.move, away);
  await until(() => Math.round(s.me().x) !== at.x || Math.round(s.me().y) !== at.y || s.me().moving, 3000, "could not walk after the Stun");
  say("OK Blind (cut by Cure), Silence and Stun refuse skills / walking and end on time");

  // ---- a monster's Poison attack (mob_skill_db NPC_POISON): Sleep broken by the hit, Poison drains HP and stops regeneration
  if (s.S.map !== FIELD) await s.room.travel(FIELD); // chasing a monster can walk through a warp
  s.dev({ op: "clear" });
  await until(() => s.list.length === 0, 3000, "dev clear left statuses on");
  const known = new Set([...s.S.monsters].filter(([, m]: any) => m.mobId === 1001).map(([k]: any) => k));
  s.room.send(Msg.devBoss, { op: "spawn", mobId: 1001, id: "x" }); // a Scorchtail (poison attack lv 3): a boss_monster line, it appears somewhere on the map
  await until(() => [...s.S.monsters].some(([k, m]: any) => m.mobId === 1001 && !m.dead && !known.has(k)), 4000, "no Scorchtail spawned");
  const poisoner = [...s.S.monsters].find(([k, m]: any) => m.mobId === 1001 && !m.dead && !known.has(k))![0] as string;
  /** Walk up to the Scorchtail (within the monster skills' 7 cells; the attack skill needs its melee range). It wanders, so this runs before every try. */
  const closeIn = async (max = 3) => {
    for (let hop = 0; hop < 40; hop++) {
      const mm = s.S.monsters.get(poisoner), p = s.me();
      if (!mm || mm.dead || !p) return;
      if (Math.max(Math.abs(mm.x - p.x), Math.abs(mm.y - p.y)) <= max) return;
      s.room.send(Msg.move, { x: Math.round(mm.x), y: Math.round(mm.y) });
      await wait(500);
    }
  };
  await closeIn(2);
  s.dev({ op: "start", sc: "Sleep", ms: 30_000, force: true });
  await until(() => s.has("Sleep") && s.me().opt.includes("sleep"), 3000, `Sleep not shown (map ${s.S.map}, deaths ${s.deaths}, hp ${s.own?.hp}, list ${s.list.map((e) => e.sc)}, opt "${s.me().opt}")`);
  let slept = true;
  for (let i = 0; i < 25 && slept; i++) {
    await closeIn();
    s.dev({ op: "mobskill", target: poisoner });
    await wait(500);
    slept = s.has("Sleep");
  }
  const pm = s.S.monsters.get(poisoner), pp = s.me();
  check(!slept, `Sleep was never broken by a monster's hit (RemoveOnDamaged): monster ${pm?.x},${pm?.y} dead ${pm?.dead}, me ${pp.x},${pp.y} map ${s.S.map}, hits on me ${s.hits.filter((h) => h.to === s.room.sessionId).length}, notices ${JSON.stringify(s.notices.slice(-2))}`);
  let poisoned = false;
  for (let i = 0; i < 120 && !poisoned; i++) { // 60 % x (1 - VIT %) per landed hit, and the hit must land: 120 tries leave a false failure far below 1/1000
    await closeIn();
    if (s.me().dead) { await wait(1500); continue; }
    s.dev({ op: "mobskill", target: poisoner });
    await wait(700);
    poisoned = s.has("Poison");
  }
  { const pm2 = s.S.monsters.get(poisoner), pp2 = s.me();
    check(poisoned && s.me().opt.includes("poison"), `the monster's Poison attack never poisoned (60 % per hit at skill level 3): monster ${pm2?.x},${pm2?.y} dead ${pm2?.dead}, me ${pp2.x},${pp2.y} map ${s.S.map} deaths ${s.deaths} hp ${s.own?.hp}, hits on me ${s.hits.filter((h) => h.to === s.room.sessionId).length}, list ${s.list.map((e) => e.sc)}`); }
  const hp0 = s.own!.hp, e = s.entry("Poison")!;
  check(e.ms > 1000, `Poison lasts a while: ${e.ms} ms`);
  await wait(4500);
  check(s.has("Poison") && s.own!.hp < hp0 - 20, `Poison drains HP: ${hp0} -> ${s.own!.hp}`);
  say(`OK a Scorchtail's poison attack: Sleep broken by its hit, then poisoned (HP ${hp0} -> ${s.own!.hp} in 4.5 s)`);
  s.dev({ op: "end", sc: "Poison" });
  await until(() => !s.has("Poison") && !s.me().opt.includes("poison"), 3000, "Poison would not end");
  s.dev({ op: "clear" });
  await s.leave();
  await deleteChar(url, s.token, s.char);
}

// =============================== Swordman ===============================
{
  const s = await session("status_bot_s", "StatusSwo", "Swordman", { SM_PROVOKE: 5, SM_ENDURE: 3 });
  const me0 = await s.dump();
  let r = await s.cast("SM_ENDURE", 3);
  check(r.used, `Endure did not go off: ${JSON.stringify(r.fails)}`);
  await until(() => s.has("Endure"), 3000, "no Endure icon");
  const en = s.entry("Endure")!;
  check(en.ms > 15_000 && en.ms <= 16_000, `Endure 3 lasts 16 s: ${en.ms}`);
  let d = await s.dump();
  check(d.mdef === me0.mdef + 3, `Endure 3: MDEF + 3: ${me0.mdef} -> ${d.mdef}`);
  const mob = await s.nearMonster(5);
  const m0 = await s.dump(mob);
  let prov: Dump | undefined;
  for (let i = 0; i < 8 && !prov; i++) {
    r = await s.cast("SM_PROVOKE", 5, mob);
    check(r.used || r.fails.length === 0, `Provoke refused: ${JSON.stringify(r.fails)}`);
    const m1 = await s.dump(mob);
    if (m1.sc.includes("Provoke")) prov = m1;
  }
  check(prov && prov.atkPercent === 100 + 2 + 15 && prov.def < m0.def + 1 && prov.def2 < m0.def2 + 1, `Provoke 5: ATK 117 %, DEF -30 %: atk ${prov?.atkPercent}, def ${m0.def} -> ${prov?.def}, def2 ${m0.def2} -> ${prov?.def2}`);
  say(`OK Endure (MDEF +3, ${Math.round(en.ms / 1000)} s) and Provoke 5 on a monster (ATK ${prov!.atkPercent} %, DEF ${m0.def} -> ${prov!.def})`);
  await s.leave();
  await deleteChar(url, s.token, s.char);
}

// =============================== Mage ===============================
{
  const s = await session("status_bot_m", "StatusMag", "Mage", { MG_FROSTDIVER: 10, MG_STONECURSE: 5 });
  const mob2 = await s.nearMonster(5);
  let waiting: Dump | undefined, stone: Dump | undefined;
  for (let i = 0; i < 14 && !stone; i++) { // 40 % at level 5
    const r = await s.cast("MG_STONECURSE", 5, mob2);
    if (!r.used && r.fails.some((f) => f.why !== "failed")) fail(`Stone Curse refused: ${JSON.stringify(r.fails)}`);
    const m1 = await s.dump(mob2);
    if (m1.sc.includes("StoneWait")) {
      waiting = m1;
      await wait(5600); // Duration1: the petrify starts after 5 s
      const m2 = await s.dump(mob2);
      if (m2.sc.includes("Stone")) stone = m2;
    }
  }
  check(waiting && waiting.cant?.attack && !waiting.cant.move, `Stone Curse: the wait stops attacks but not walking: ${JSON.stringify(waiting?.cant)}`);
  check(stone && stone.element === "Earth" && stone.cant?.move && stone.cant.attack && stone.opt.includes("stone"), `Stone Curse petrified the monster after the wait: ${JSON.stringify(stone)}`);
  say(`OK Stone Curse: first "${waiting!.opt}" (cannot attack), then "${stone!.opt}" (Earth 1, cannot move)`);
  let frozen: Dump | undefined, mob = "";
  const fdFails: string[] = [];
  for (let i = 0; i < 30 && !frozen; i++) { // 38 % at level 1 (min(lv * 3 + 35, lv + 60)), minus the monster's MDEF; a dead target is replaced
    if (!mob || !s.S.monsters.get(mob) || s.S.monsters.get(mob).dead) mob = await s.nearMonster(5);
    const r = await s.cast("MG_FROSTDIVER", 1, mob);
    if (!r.used) { fdFails.push(r.fails.map((f) => f.why).join("/") || "unused"); await wait(1500); continue; }
    await wait(900);
    const m1 = await s.dump(mob);
    if (m1.sc.includes("Freeze")) frozen = m1;
  }
  check(frozen && frozen.element === "Water" && frozen.opt.includes("freeze") && frozen.cant?.move && frozen.cant.attack, `Frost Diver froze a monster: ${JSON.stringify(frozen)} (refused casts: ${fdFails.join(", ") || "none"})`);
  check(s.S.monsters.get(mob)?.opt.includes("freeze"), "the freeze is not in the synced state");
  say(`OK Frost Diver froze a monster (Water 1, cannot move or attack, option "${frozen!.opt}")`);
  await s.leave();
  await deleteChar(url, s.token, s.char);
}

clearTimeout(timeout);
await db.end();
console.log("status: buffs, debuffs, cures, monster skills, resistances through the protocol all checked");
process.exit(0);
