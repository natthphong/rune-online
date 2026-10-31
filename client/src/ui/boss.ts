import * as THREE from "three";
import type { Room } from "@colyseus/sdk";
import { Msg, type AnnounceEvent, type BossChargeEvent, type BossSlamEvent, type BossSpitEvent, type BossSplitEvent, type MvpEvent, type MvpRewardEvent } from "../../../shared/protocol.ts";
import { ITEMS } from "../../../shared/rules/items.ts";
import type { Fx } from "../fx.ts";
import { play } from "../audio.ts";
import { banner, log } from "./hud.ts";
import { t } from "../i18n.ts";

// Boss and MVP messages (server/src/boss.ts; rAthena clif_mvp_effect / clif_mvp_exp / clif_mvp_item / intif_broadcast):
//   mvp         the winner of a boss, sent to everyone around it: our gold "MVP" lettering and pillar over the winner (Fx.mvp), a chat
//               line for those watching, and the big banner for the winner itself;
//   mvpReward   the winner only: "Congratulations! You are the MVP! Your reward EXP Points are N !!" (client.conf mvp_exp_reward_message,
//               msg 717) and the prize item, or that it lies on the floor because the bag was full;
//   announce    a server-wide yellow line (a rare MVP prize, rare_drop_announce).
// A boss's own look (name colour in the hover tag, bar colour) is main.ts's: the Monster state carries `boss` (1 boss, 2 MVP).

/** Where a drawn unit stands and its name: main.ts' entities, read through this. */
export type BossView = { entity(id: string): { pos: THREE.Vector3; name: string } | undefined; me(): string | undefined; fx: Fx };

export function bindBoss(r: Room, v: BossView) {
  r.onMessage(Msg.mvp, (m: MvpEvent) => {
    const e = v.entity(m.id);
    if (!e) return;
    v.fx.mvp(e.pos);
    play("sfx", "mvp_fanfare", 0.8);
    if (m.id === v.me()) banner("MVP!", m.boss);
    else log("mvp", `${e.name} is the MVP for defeating ${m.boss}!`);
  });
  r.onMessage(Msg.mvpReward, (m: MvpRewardEvent) => {
    log("mvp", `Congratulations! You are the MVP of ${m.boss}!`);
    if (m.exp > 0) log("system", `Congratulations! You are the MVP! Your reward EXP Points are ${m.exp.toLocaleString()} !!`);
    const it = m.itemId ? ITEMS.get(m.itemId) : undefined;
    if (it) log("exp", m.floor ? `MVP prize: ${it.name} — your bag is full, it dropped at your feet.` : `MVP prize: ${it.name}.`);
  });
  // our floor-boss moves (shared/rules/bossmoves.ts): the slime spit's glob (its damage comes as an ordinary Msg.hit on landing)
  // and the split cue (the slaves arrive as ordinary monsters)
  r.onMessage(Msg.bossSpit, (m: BossSpitEvent) => {
    const a = v.entity(m.from), b = v.entity(m.to);
    if (a && b) v.fx.spit(a.pos, b.pos, m.ms);
  });
  r.onMessage(Msg.bossSplit, (m: BossSplitEvent) => {
    const e = v.entity(m.id);
    if (e) { if (m.kind === "stomp" || m.kind === "roar") v.fx.cue(e.pos, m.kind); else v.fx.split(e.pos); }
    log("announce", m.key ? t(m.key) : m.text);
  });
  // Devo's charge: the red lane + dust while it winds up, the dash streak; a headbutt rears first (boss/ move rows in shared/rules/bossmoves.ts)
  r.onMessage(Msg.bossCharge, (m: BossChargeEvent) => {
    const e = v.entity(m.id);
    if (!e) return;
    if (m.kind === "head") { v.fx.rear(e.pos, m.windMs); return; }
    const end = e.pos.clone();
    end.x = m.ex; end.z = m.ey;
    v.fx.charge(e.pos, end, m.windMs, m.dashMs);
    play("sfx", "mvp_fanfare", 0.15);
  });
  r.onMessage(Msg.bossSlam, (m: BossSlamEvent) => {
    const a = v.entity(m.from), b = v.entity(m.to);
    if (!b) return;
    const dx = a ? b.pos.x - a.pos.x : 1, dz = a ? b.pos.z - a.pos.z : 0, n = Math.hypot(dx, dz) || 1;
    v.fx.slam(b.pos, dx / n, dz / n);
  });
  r.onMessage(Msg.announce, (m: AnnounceEvent) => log("announce", m.text));
}
