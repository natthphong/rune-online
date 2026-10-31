// Auto-play check (C12): a fresh character turns Auto on and must finish the first two Chapter-1 quests (Bloom Patrol: kill 5
// Puddleblooms; Gel Beads for the Plaza: bring 10 beads) with no input at all (auto answers the quest menus itself and never picks
// a shop / job / hearth option). The bot runs the client's own auto-play module (client/src/autoplay.ts) and navigation planner
// (client/src/navi.ts) against the server: walking, talking, Next / Close, fighting, looting and reporting are all theirs.
//   pnpm --filter client auto [serverUrl]
import { Msg, type NpcMenuEvent, type QuestLogEvent, type StatusEvent } from "../../shared/protocol.ts";
import { Q, NPC } from "../../shared/content/f1/chapter1.ts";
import { autoOn, bindAuto, onAuto, plan, setAuto } from "../src/autoplay.ts";
import { tickNavi } from "../src/navi.ts";
import { setNaviRoom } from "../src/navi.ts";
import { deleteChar, joinAs } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string) => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 900 s"), 900_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${m}`);

const ACCOUNT = process.env.AUTO_BOT ?? "auto_bot";
const { room: r, token, char } = await joinAs(url, ACCOUNT, ACCOUNT, true);
const S = r.state as any;
setNaviRoom(r);
bindAuto(r, { pageMs: 120, log: (t) => say(t) }); // before any message arrives (questMark / inv / status on join)
let leaving = false;
r.onLeave((code: number) => { if (!leaving) fail(`disconnected (code ${code}): the dev server restarted? run again`); });
let quests: QuestLogEvent["quests"] = [], own: StatusEvent | undefined;
const done = new Set<number>(), menus: string[] = [];
r.onMessage(Msg.quests, (m: QuestLogEvent) => {
  for (const q of quests) if (!m.quests.some((x) => x.id === q.id)) { done.add(q.id); say(`quest ${q.id} complete`); }
  for (const q of m.quests) if (!quests.some((x) => x.id === q.id)) say(`quest ${q.id} accepted`);
  quests = m.quests;
});
r.onMessage(Msg.status, (m: StatusEvent) => { own = m; });
for (const t of [Msg.chat, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.statUpAck, Msg.shopClose, Msg.takeItem, Msg.skills, Msg.skillFail,
  Msg.notice, Msg.exp, Msg.itemGet, Msg.zenyGet, Msg.cutin, Msg.npcTalk, Msg.emotion, Msg.npcClear]) r.onMessage(t, () => {});

// W01 r1: auto answers the quest menus itself (autoplay.ts menuAnswer); the bot only records them and fails if one is never answered
let menuAt = 0;
r.onMessage(Msg.npcMenuList, (m: NpcMenuEvent) => { menus.push(`${m.npc}: ${m.options.join(" / ")}`); menuAt = Date.now(); });
r.onMessage(Msg.npcMes, () => { menuAt = 0; });
setInterval(() => { if (menuAt && Date.now() - menuAt > 15000) fail(`a menu waited 15 s for an answer: ${menus.at(-1)}`); }, 1000);
let deaths = 0, respawning = false;
r.onMessage(Msg.die, async (m: { id: string }) => {
  if (m.id !== r.sessionId) return;
  if (++deaths > 3) fail("died more than 3 times");
  say("died: respawn, Auto on again");
  respawning = true;
  await wait(400); r.send(Msg.respawn);
  await wait(1500); setAuto(true); respawning = false;
});

await wait(1500);
// a fresh Fledgling spends its starting points like the quest bot (the status window is the player's, not auto's)
r.send(Msg.statUp, { stat: "str", amount: 20 }); r.send(Msg.statUp, { stat: "agi", amount: 10 }); r.send(Msg.statUp, { stat: "dex", amount: 10 });
setInterval(() => tickNavi(performance.now(), false), 120);
let last = "";
onAuto((on, task) => { if (task && task !== last) { last = task; say(`AUTO: ${task}`); } });
await wait(500);
setAuto(true);
if (!autoOn()) fail("Auto did not turn on");
say(`Auto on; first step: ${JSON.stringify(plan())}`);

const goal = () => done.has(Q.PATROL) && done.has(Q.BEADS);
while (!goal()) {
  if (!autoOn() && !respawning && !S.players.get(r.sessionId)?.dead) fail(`Auto stopped by itself (task "${last}")`);
  await wait(500);
}
say(`OK: Bloom Patrol and Gel Beads completed hands-free (menus answered: ${menus.join(" | ")}; deaths ${deaths}; Base Lv ${own?.level})`);
setAuto(false);
leaving = true;
await r.leave();
await deleteChar(url, token, char);
console.log("auto: OK");
process.exit(0);
