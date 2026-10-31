// End-to-end progression check: a fresh character spends its 48 stat points, then hunts the weakest monster
// until it gains a Base level and a Job level.   pnpm --filter client grind [serverUrl]
import { Msg, type ExpEvent, type LevelUpEvent, type StatusEvent } from "../../shared/protocol.ts";
import { deleteChar, joinAs } from "./bot.ts";
import { MOBS } from "../../shared/rules/data.ts";
import { FIELD, FIELD_MOBS } from "../../shared/maps.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const timeout = setTimeout(() => fail("no base level-up within 180 s"), 180_000);

const name = "grind_bot";
const { room: r, token, char } = await joinAs(url, "grind_bot", name, true); // fresh character every run
const me = () => (r.state as any).players.get(r.sessionId);
// stats, points, EXP and HP reach only their owner (Msg.status), never the synced state
let own: StatusEvent | undefined;
r.onMessage(Msg.status, (m: StatusEvent) => { own = m; });
r.onMessage("*", () => {}); // the other owner messages (inventory, acks, quests ...) aren't checked here
const mine = (): StatusEvent => own ?? fail("no Msg.status from the server");
await new Promise((ok) => setTimeout(ok, 500));
if (me().str !== undefined || me().statPoints !== undefined || me().hp !== undefined) fail("private numbers in the synced state");
const start = { level: mine().level, jobLevel: mine().jobLevel, points: mine().statPoints };

// 48 points -> STR/AGI/DEX 9 (8 raises x 2 points each)
for (const stat of ["str", "agi", "dex"] as const) for (let i = 0; i < 8; i++) r.send(Msg.statUp, { stat });
await new Promise((ok) => setTimeout(ok, 800));
if (mine().str !== 9 || mine().statPoints !== 0) fail(`stat allocation: str=${mine().str} points=${mine().statPoints}`);

// W01: a new character starts in Hearthmoor; the weakest species of the Verdant Plains, out the west gate
const weakest = MOBS.filter((m) => FIELD_MOBS[FIELD].mobs.includes(m.id)).sort((a, b) => a.level - b.level)[0];
await r.travel(FIELD);
let exp = 0, kills = 0, deaths = 0;
const ups: LevelUpEvent[] = [];
r.onMessage(Msg.exp, (m: ExpEvent) => { exp += m.base; kills++; });
r.onMessage(Msg.levelUp, (m: LevelUpEvent) => { if (m.id === r.sessionId) ups.push(m); });
for (const t of [Msg.hit, Msg.chat, Msg.statUpAck, Msg.takeItem, Msg.heal]) r.onMessage(t, () => {});
r.onMessage(Msg.die, (m: { id: string }) => { if (m.id === r.sessionId) { deaths++; r.send(Msg.respawn); } });

let travelling = false;
const hunt = () => {
  if (r.map !== FIELD) { // a death respawns at the town's hearth: walk back out
    if (!travelling) { travelling = true; r.travel(FIELD).catch((e) => fail(String(e))).finally(() => { travelling = false; }); }
    return;
  }
  const p = me();
  if (!p) return;
  const live = [...(r.state as any).monsters.entries()].filter(([, m]: any) => !m.dead && m.mobId === weakest.id);
  live.sort(([, a]: any, [, b]: any) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  if (live.length) r.send(Msg.attack, { id: live[0][0] });
};
hunt();
const loop = setInterval(hunt, 2500);
while (!ups.some((u) => u.kind === "base")) await new Promise((ok) => setTimeout(ok, 250));
clearInterval(loop);
clearTimeout(timeout);
await new Promise((ok) => setTimeout(ok, 300)); // the level-up's Msg.status came before its effect; the public level with the next patch
const p = mine();
if (me().level !== p.level) fail(`public base level ${me().level} != own ${p.level}`);
console.log(`OK: ${name} killed ${kills}x ${weakest.name} (+${exp} base EXP, ${deaths} deaths): Lv ${start.level}->${p.level}, Job ${start.jobLevel}->${p.jobLevel}, stat points 0->${p.statPoints}, HP ${p.hp}/${p.maxHp}`);
if (p.statPoints <= 0) fail("base level-up granted no stat points");
if (!ups.some((u) => u.kind === "job")) fail("no job level-up");
await r.leave();
await new Promise((ok) => setTimeout(ok, 300)); // let the server save + mark it offline before deleting
await deleteChar(url, token, char);
process.exit(0);
