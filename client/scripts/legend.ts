// End-to-end check of the 2.4.0 LEGENDARY pet + the grant tool, dev server only (uses the dev-only Msg.devPet / Msg.devBoss shortcuts):
// a fresh character (account legend_bot) is refused by server/scripts/grant.ts while online, then (logged out) gets the legendary egg
// and the legendary card through the tool on schema ro_dev, logs back in, finds the egg (with its pet row) and the card in the bag,
// hatches the Sunscale Wyrmling, goes to the plains and fights: the pet lands a normal hit (legendary share) and, with the dev
// "breath" op forcing pet_attackskill, a fire breath (Msg.skillUse from the pet + skill HitEvents, splash over the clustered foes).
// The character is deleted at the end.
//   pnpm --filter client legend [serverUrl]      (the grant tool needs DATABASE_URL / REDIS_URL from the repo .env)
import { execFileSync } from "node:child_process";
import { Msg, type DevBossMsg, type HitEvent, type PetInfoEvent, type SkillUseEvent } from "../../shared/protocol.ts";
import { ITEMS } from "../../shared/rules/items.ts";
import { FIELD, buildMap, type MapName } from "../../shared/maps.ts";
import { walkable } from "../../shared/map.ts";
import petsJson from "../../shared/data/pets.json" with { type: "json" };
import { botRoom, deleteChar, joinAs } from "./bot.ts";

const url = process.argv[2] ?? "http://localhost:2567";
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail("timed out after 240 s"), 240_000);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async <T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) return fail(what); await wait(100); } };

const legend = (petsJson as { mobId: number; eggItem: number; rarity?: string; name: string }[]).find((p) => p.rarity === "legendary") ?? fail("no legendary pet in pets.json");
const card = [...ITEMS.values()].find((i) => i.type === "Card" && (i as { rarity?: string }).rarity === "legendary");
const NAME = process.env.LEGEND_BOT_ACCOUNT ?? "legend_bot";
const GRANT = new URL("../../server/scripts/grant.ts", import.meta.url).pathname;
const grant = (item: number) => execFileSync("node", [GRANT, "--schema", "ro_dev", "--char", NAME, "--item", String(item)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const { room: r0, token, char } = await joinAs(url, NAME, NAME, true);
let r = r0;
let info: PetInfoEvent["pet"] | undefined, inv: { uid: number; itemId: number; amount: number; petId?: number }[] = [];
const hits: HitEvent[] = [], uses: SkillUseEvent[] = [];
function wire() {
  for (const t of [Msg.chat, Msg.exp, Msg.levelUp, Msg.hotkeys, Msg.heal, Msg.status, Msg.takeItem, Msg.quests, Msg.questMark, Msg.emotion, Msg.npcTalk,
    Msg.skills, Msg.cutin, Msg.announce, Msg.itemGet, Msg.petEmote, Msg.die, Msg.shop, Msg.scList, Msg.friends, Msg.party, Msg.duel, Msg.petEggs,
    Msg.petNotice, Msg.notice]) if (t) r.onMessage(t, () => {});
  r.onMessage(Msg.petInfo, (m: PetInfoEvent) => { info = m.pet; });
  r.onMessage(Msg.hit, (m: HitEvent) => hits.push(m));
  r.onMessage(Msg.skillUse, (m: SkillUseEvent) => uses.push(m));
  r.onMessage(Msg.inv, (m: { items: typeof inv }) => { inv = m.items; });
}
wire();
const S = () => r.state as any;
const me = () => S().players.get(r.sessionId);
const cell = () => ({ x: Math.round(me().x), y: Math.round(me().y) });
const myPet = () => [...S().pets.entries()].find(([, p]: any) => p.owner === r.sessionId) as [string, any] | undefined;
const devPet = (m: Record<string, unknown>) => r.send(Msg.devPet, m);
const devBoss = (m: DevBossMsg) => r.send(Msg.devBoss, m);
await until(() => me(), 8000, "no player");

// ---- the grant tool: refused while online, then the egg (+ its pet row) and the legendary card while logged out ----
try { grant(legend.eggItem); fail("grant ran while the character was online"); } catch (e) {
  const err = String((e as { stderr?: string }).stderr ?? e);
  if (!/online/.test(err)) fail(`grant refused for another reason: ${err}`);
}
console.log("ok   grant refused while online");
await r.leave();
await wait(1000);
const out = grant(legend.eggItem);
if (!/granted.* 1 x /.test(out)) fail(`grant egg: ${out}`);
console.log(out.trim().split("\n").map((l) => `     ${l}`).join("\n"));
if (card) { const o2 = grant(card.id); if (!/granted.* 1 x /.test(o2)) fail(`grant card: ${o2}`); console.log(`ok   grant tool gave the legendary card ${card.id} ${card.name}`); }
else console.log("note no legendary card in items.json yet");
info = undefined;
r = await botRoom(url, token, char);
wire();
await until(() => me(), 8000, "no player after relog");
const egg = await until(() => inv.find((s) => s.itemId === legend.eggItem && s.petId), 5000, "no legendary egg with a pet row after the grant");
if (card) await until(() => inv.some((s) => s.itemId === card.id), 3000, "no legendary card after the grant");
console.log(`ok   bag has the ${ITEMS.get(legend.eggItem)!.name} (${legend.eggItem}, pet row ${egg.petId})${card ? ` and ${card.name} (${card.id})` : ""}`);

// ---- hatch ----
r.send(Msg.petHatch, { uid: egg.uid });
await until(() => myPet() && info?.mobId === legend.mobId, 5000, "the legendary pet did not hatch");
const pkey = myPet()![0];
console.log(`ok   hatched ${info!.name} Lv${info!.level} (${info!.kind}), intimacy ${info!.intimacy}, hunger ${info!.hunger}`);
if (info!.kind !== "battle") fail(`legendary pet kind ${info!.kind}`);

// ---- fight on the plains: a normal legendary hit, then a forced fire breath over clustered foes ----
await r.travel(FIELD as MapName);
await until(() => me() && myPet(), 6000, "not on the field with the pet");
devPet({ op: "intimacy", value: 1000 }); // loyal: AttackRate 5000 x band 1.0 = 50 % per owner swing
const FOE = 1008; // passive, immobile, Earth: Fire breath x1.5 (attr_fix)
const map = buildMap(S().map as MapName, S().seed);
const before = new Set([...S().monsters.keys()]);
const foes = () => [...S().monsters.entries()].filter(([k, m]: any) => !before.has(k) && m.mobId === FOE && !m.dead).map(([k]) => k as string);
async function stock() {
  const h = cell(), spots = [[1, 0], [2, 0], [1, 1], [2, 1], [1, -1]].map(([dx, dy]) => ({ x: h.x + dx, y: h.y + dy })).filter((c) => walkable(map, c.x, c.y));
  for (const c of spots.slice(0, Math.max(0, 3 - foes().length))) devBoss({ op: "spawn", id: "", mobId: FOE, x: c.x, y: c.y });
  await until(() => foes().length > 0, 4000, "no foes spawned");
}
async function swingUntil(ok: () => boolean, ms: number) {
  const t0 = Date.now();
  while (!ok() && Date.now() - t0 < ms) {
    if (foes().length < 2) await stock();
    r.send(Msg.attack, { id: foes()[0] });
    await wait(300);
  }
}
hits.length = 0;
await stock();
await swingUntil(() => hits.some((h) => h.from === pkey && !h.skill && h.dmg > 0), 60_000);
const ph = hits.find((h) => h.from === pkey && !h.skill && h.dmg > 0) ?? fail("no normal hit from the legendary pet");
const mine = hits.filter((h) => h.from === r.sessionId && h.dmg > 0).map((h) => h.dmg);
console.log(`ok   legendary pet hit ${ph.to} for ${ph.dmg} (owner's hits: ${mine.slice(0, 6).join(", ")})`);
devPet({ op: "breath" });
const u0 = uses.length;
await swingUntil(() => uses.slice(u0).some((u) => u.src === pkey) && hits.some((h) => h.from === pkey && h.skill), 60_000);
const use = uses.slice(u0).find((u) => u.src === pkey) ?? fail("no Msg.skillUse from the pet (fire breath)");
const bh = hits.filter((h) => h.from === pkey && h.skill === use.id);
if (!bh.length) fail("no skill HitEvent from the pet's breath");
const first = bh.filter((h) => h === bh[0] || hits.indexOf(h) - hits.indexOf(bh[0]) < 5);
console.log(`ok   fire breath (skill ${use.id} lv${use.lv}) on ${use.target} at ${use.x},${use.y}: ${first.map((h) => `${h.to}=${h.dmg}`).join(" ")}`);

await r.leave();
await deleteChar(url, token, char);
console.log("PASS legendary pet");
process.exit(0);
