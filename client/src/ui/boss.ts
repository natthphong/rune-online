import * as THREE from "three";
import type { Room } from "@colyseus/sdk";
import { Msg, type AnnounceEvent, type BossAggroEvent, type BossChargeEvent, type BossHopEvent, type BossImpactEvent, type BossSlamEvent, type BossSpitEvent,
  type BossSplitEvent, type BossTeleEvent, type MvpEvent, type MvpRewardEvent } from "../../../shared/protocol.ts";
import { ITEMS } from "../../../shared/rules/items.ts";
import type { Fx } from "../fx.ts";
import { getVolume, play } from "../audio.ts";
import { groundAt, hitStop, preload, shake, spawn, telegraph, type SpawnOpts, type TeleShape, type Telegraph } from "../pixelFx.ts";
import { banner, log } from "./hud.ts";
import { t } from "../i18n.ts";

// Boss and MVP messages (server/src/boss.ts; rAthena clif_mvp_effect / clif_mvp_exp / clif_mvp_item / intif_broadcast):
//   mvp         the winner of a boss, sent to everyone around it: our gold "MVP" lettering and pillar over the winner (Fx.mvp), a chat
//               line for those watching, and the big banner for the winner itself;
//   mvpReward   the winner only: "Congratulations! You are the MVP! Your reward EXP Points are N !!" (client.conf mvp_exp_reward_message,
//               msg 717) and the prize item, or that it lies on the floor because the bag was full;
//   announce    a server-wide yellow line (a rare MVP prize, rare_drop_announce).
// 2.7.0 boss feel (shared/rules/bossmoves.ts `area` rows): bossTele = the ground warning that fills up (pixelFx.ts telegraph), bossImpact =
// PixelFX bursts over the shape + screen shake + hit-stop + a low boom, bossAggro = "!" + roar (red vignette on the one it picked, a red aura
// that stays while enraged), bossHop = dust where it leaves and lands. FX per `move` name: MOVES below (unknown names = a ground slam).
// A boss's own look (name colour in the hover tag, bar colour) is main.ts's: the Monster state carries `boss` (1 boss, 2 MVP).

/** Where a drawn unit stands and its name: main.ts' entities, read through this (`top` = head height, `dead`). */
export type BossView = { entity(id: string): { pos: THREE.Vector3; name: string; top?: number; dead?: boolean } | undefined; me(): string | undefined; fx: Fx };

// ---------- the boss sprite's vertical arc (a leap during a wind-up, a hop): main.ts adds bossLift() to the drawn y ----------
const lifts = new Map<string, { t0: number; ms: number; h: number; from: number }>();
/** Height over the ground to draw boss `id` at, now. */
export function bossLift(id: string, now: number) {
  const l = lifts.get(id);
  if (!l) return 0;
  const u = (now - l.t0) / l.ms;
  if (u >= 1) { lifts.delete(id); return 0; }
  if (u < l.from) return -0.12 * Math.sin((u / l.from) * Math.PI); // a crouch before the jump
  const w = (u - l.from) / (1 - l.from);
  return l.h * 4 * w * (1 - w);
}

// ---------- sounds: our SFX at a low pitch (no new files) ----------
function low(name: string, vol: number, rate: number) {
  const v = getVolume();
  if (v <= 0) return;
  const a = new Audio(`/audio/sfx/${name}.mp3`);
  a.preservesPitch = false;
  a.playbackRate = rate;
  a.volume = Math.min(1, v * vol);
  a.play().catch(() => {});
}
let boomAt = 0;
const boom = (k: number) => {
  const now = performance.now();
  if (now - boomAt < 110) return; // a rain of small impacts: one thud per beat
  boomAt = now;
  low("hit", Math.min(1, 0.6 + k * 0.4), 0.45); low("crit", 0.5 * k, 0.55);
  if (k > 0.8) low("tomb_appear", 0.5, 0.6);
};

// ---------- red vignette (DOM, styled here) ----------
let vignette: HTMLDivElement | undefined;
function pulseVignette(strong: boolean) {
  if (!vignette) {
    vignette = document.createElement("div");
    Object.assign(vignette.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "30", opacity: "0",
      background: "radial-gradient(ellipse at center, rgba(120,0,0,0) 52%, rgba(170,10,0,0.42) 82%, rgba(110,0,0,0.75) 100%)" });
    document.body.append(vignette);
  }
  vignette.animate([{ opacity: 0 }, { opacity: strong ? 1 : 0.8, offset: 0.12 }, { opacity: strong ? 0.6 : 0.3, offset: 0.4 }, { opacity: 0 }],
    { duration: strong ? 1600 : 1000, easing: "ease-out" });
}

// ---------- what each move looks like ----------
const cell = (x: number, z: number) => new THREE.Vector3(x, groundAt(x, z), z);
const shapeOf = (m: BossTeleEvent | BossImpactEvent): TeleShape => ({ shape: m.shape, x: m.x, z: m.y, r: Math.max(0.5, m.r), ex: m.ex, ez: m.ey,
  safe: m.safe?.map((s) => ({ x: s.x, z: s.y, r: s.r })) });
/** Random points inside a shape (not in its safe circles), spread out a bit. */
function scatter(sh: TeleShape, n: number) {
  const out: THREE.Vector3[] = [], safe = sh.safe ?? [];
  for (let tries = 0; out.length < n && tries < n * 30; tries++) {
    let x: number, z: number;
    if (sh.shape === "line") {
      const u = Math.random(), s = (Math.random() * 2 - 1) * sh.r * 0.8, ex = sh.ex ?? sh.x, ez = sh.ez ?? sh.z, L = Math.hypot(ex - sh.x, ez - sh.z) || 1;
      x = sh.x + (ex - sh.x) * u - ((ez - sh.z) / L) * s; z = sh.z + (ez - sh.z) * u + ((ex - sh.x) / L) * s;
    } else {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * sh.r * 0.9;
      x = sh.x + Math.cos(a) * d; z = sh.z + Math.sin(a) * d;
    }
    if (safe.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 0.4)) continue;
    const minGap = sh.r * 0.55 / Math.sqrt(Math.max(1, n));
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < minGap)) continue;
    out.push(cell(x, z));
  }
  return out;
}
const area = (sh: TeleShape) => sh.shape === "line" ? 2 * sh.r * Math.hypot((sh.ex ?? sh.x) - sh.x, (sh.ez ?? sh.z) - sh.z) : Math.PI * sh.r * sh.r;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const fx = (name: string, at: THREE.Vector3, o: SpawnOpts = {}) => spawn(name, at, { flip: Math.random() < 0.5, ...o });

type MoveLook = { tone: "danger" | "acid" | "dark"; sheets: string[]; impact(sh: TeleShape): void; heavy?: number };
/** Generic: one big burst for a small shape, a central one plus several scattered for a big one. */
function burst(sh: TeleShape, main: string, extra: string, mainW: number, perCell: number, extraW = 2.6) {
  fx(main, cell(sh.x, sh.z), { size: mainW });
  if (sh.r < 2.5 && sh.shape !== "line") return;
  const pts = scatter(sh, Math.min(16, Math.max(3, Math.round(area(sh) * perCell))));
  pts.forEach((p, i) => fx(extra, p, { size: extraW * rnd(0.8, 1.2), delayMs: 40 + i * rnd(25, 55) }));
}
const MOVES: Record<string, MoveLook> = {
  // the slime's leap-slam: an acid crater
  splash: { tone: "acid", sheets: ["acid", "slam", "poof"], impact: (sh) => {
    fx("slam", cell(sh.x, sh.z), { size: sh.r * 2.4 + 1.5, tint: "#c8ff9a" });
    fx("acid", cell(sh.x, sh.z), { size: sh.r * 1.8 + 1.2 });
    for (const p of scatter({ ...sh, r: sh.r * 1.05 }, Math.max(3, Math.round(sh.r * 2.5)))) fx("acid", p, { size: rnd(1.6, 2.4), delayMs: rnd(40, 200) });
  } },
  // many small acid circles (one telegraph each)
  rain: { tone: "acid", sheets: ["acid"], heavy: 0.4, impact: (sh) => fx("acid", cell(sh.x, sh.z), { size: Math.max(1.8, sh.r * 2.6) }) },
  // earth shockwave around the boss: a slam in the middle, a ring of spikes bursting outward
  stomp: { tone: "danger", sheets: ["slam", "spike", "landing"], impact: (sh) => {
    fx("slam", cell(sh.x, sh.z), { size: sh.r * 2.2 + 2 });
    fx("landing", cell(sh.x, sh.z), { size: sh.r * 2 + 2, delayMs: 30 });
    for (const ring of [0.45, 0.85]) {
      const n = Math.max(4, Math.min(12, Math.round(Math.PI * 2 * sh.r * ring / 1.8)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 2;
        fx(ring < 0.6 ? "landing" : "spike", cell(sh.x + Math.cos(a) * sh.r * ring, sh.z + Math.sin(a) * sh.r * ring), { size: ring < 0.6 ? 2.4 : 2.6, delayMs: ring * 260 });
      }
    }
  } },
  // a line of earth spikes erupting from the boss outward
  quake: { tone: "danger", sheets: ["spike", "quake"], impact: (sh) => {
    const ex = sh.ex ?? sh.x, ez = sh.ez ?? sh.z, L = Math.hypot(ex - sh.x, ez - sh.z), n = Math.max(2, Math.round(L / 1.3));
    for (let i = 0; i <= n; i++) {
      const u = i / n, p = cell(sh.x + (ex - sh.x) * u, sh.z + (ez - sh.z) * u);
      fx(i % 2 ? "quake" : "spike", p, { size: (i % 2 ? 3.2 : 2.4) * (sh.r + 0.6), delayMs: i * 45 });
    }
  } },
  // the dark scythe arc
  cleave: { tone: "dark", sheets: ["reap", "cleave", "darkboom"], impact: (sh) => {
    const ex = sh.ex ?? sh.x, ez = sh.ez ?? sh.z, mid = sh.shape === "line" ? cell((sh.x + ex) / 2, (sh.z + ez) / 2) : cell(sh.x, sh.z);
    const w = sh.shape === "line" ? Math.hypot(ex - sh.x, ez - sh.z) + sh.r * 2 : sh.r * 2.4 + 1;
    fx("reap", mid, { size: w * 1.1, yOffset: 0.6, tint: "#e8b0ff", flip: ex < sh.x });
    fx("cleave", mid, { size: w * 0.8, delayMs: 60, flip: ex < sh.x });
    fx("darkboom", mid, { size: Math.min(6, w * 0.6), delayMs: 120 });
  } },
  // the goat-demon's map-wide sweep: dark blasts everywhere but the safe circles
  reap: { tone: "dark", sheets: ["darkboom", "reap", "boom"], heavy: 1.4, impact: (sh) => {
    fx("reap", cell(sh.x, sh.z), { size: Math.min(14, sh.r * 1.6), yOffset: 1, tint: "#d9a0ff" });
    const pts = scatter(sh, Math.min(18, Math.max(6, Math.round(area(sh) / 7))));
    pts.forEach((p, i) => fx(i % 3 === 0 ? "boom" : "darkboom", p, { size: i % 3 === 0 ? rnd(4, 5.5) : rnd(3.4, 4.6), delayMs: 30 + i * 35, tint: i % 3 === 0 ? "#b48cff" : undefined }));
  } },
  // a poison cloud over the area
  plague: { tone: "acid", sheets: ["poison", "acid"], impact: (sh) => {
    const pts = [cell(sh.x, sh.z), ...scatter(sh, Math.min(10, Math.max(2, Math.round(area(sh) / 5))))];
    pts.forEach((p, i) => fx("poison", p, { size: rnd(3.4, 4.6), delayMs: i * 50, opacity: 0.9 }));
    fx("acid", cell(sh.x, sh.z), { size: 2.6 });
  } },
};
const DEFAULT_MOVE: MoveLook = { tone: "danger", sheets: ["slam", "fireburst", "poof"], impact: (sh) => burst(sh, "slam", "fireburst", sh.r * 2.2 + 2, 1 / 6, 2.8) };
const lookOf = (move: string) => MOVES[move] ?? DEFAULT_MOVE;

export function bindBoss(r: Room, v: BossView) {
  const teles = new Map<string, Telegraph>();
  const keyOf = (m: BossTeleEvent | BossImpactEvent) => `${m.id}:${m.move}:${m.x},${m.y}`;
  const enraged = new Set<string>();

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
    if (e && m.kind === "stomp") quake(e.pos, 2.5);
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
    if (m.to === v.me()) { shake(0.32, 360); hitStop(80); boom(0.6); } else quake(b.pos, 1.5);
  });
  r.onMessage(Msg.announce, (m: AnnounceEvent) => log("announce", m.text));

  /** Shake + hit-stop for an impact at `at` of radius `rad`, scaled by how close my character is. */
  function quake(at: THREE.Vector3, rad: number, heavy = 1, line?: TeleShape) {
    const me = v.entity(v.me() ?? "");
    let d = 0;
    if (me) {
      if (line && line.shape === "line") { // distance to the segment
        const ex = line.ex ?? line.x, ez = line.ez ?? line.z, L2 = (ex - line.x) ** 2 + (ez - line.z) ** 2 || 1;
        const u = Math.max(0, Math.min(1, ((me.pos.x - line.x) * (ex - line.x) + (me.pos.z - line.z) * (ez - line.z)) / L2));
        d = Math.max(0, Math.hypot(me.pos.x - (line.x + (ex - line.x) * u), me.pos.z - (line.z + (ez - line.z) * u)) - line.r);
      } else d = Math.max(0, Math.hypot(me.pos.x - at.x, me.pos.z - at.z) - rad);
    } else d = 8;
    const near = Math.max(0.12, 1 - d / 14), k = Math.min(1.6, (0.4 + rad * 0.12) * heavy);
    shake(0.34 * k * near, 300 + rad * 45 * heavy);
    if (near > 0.55 && k > 0.5) hitStop(Math.min(95, 55 + rad * 8));
    if (near > 0.3) boom(Math.min(1, k * near));
  }

  function onTele(m: BossTeleEvent) {
    const look = lookOf(m.move), sh = shapeOf(m), key = keyOf(m);
    teles.get(key)?.remove();
    teles.set(key, telegraph(sh, m.ms, look.tone));
    preload(...look.sheets);
    const e = v.entity(m.id);
    if (m.leap && e) {
      fx("poof", e.pos, { size: 3 });
      fx("landing", e.pos, { size: 4 });
      lifts.set(m.id, { t0: performance.now(), ms: m.ms, h: 3.2, from: 0.18 });
      low("swing", 0.5, 0.6);
    } else if (m.shape === "sweep") low("boss_spawn", 0.5, 0.7);
  }
  function onImpact(m: BossImpactEvent) {
    const look = lookOf(m.move), sh = shapeOf(m), key = keyOf(m);
    let tele = teles.get(key);
    if (!tele) for (const [k, tl] of teles) if (k.startsWith(`${m.id}:${m.move}:`)) { tele = tl; teles.delete(k); break; } // the shape moved (a leap re-aimed)
    teles.delete(key);
    (tele ?? telegraph(sh, 1, look.tone)).impact();
    lifts.delete(m.id);
    look.impact(sh);
    quake(cell(sh.x, sh.z), sh.shape === "line" ? Math.max(1.5, sh.r * 1.5) : sh.r, look.heavy ?? 1, sh);
  }
  function onAggro(m: BossAggroEvent) {
    const e = v.entity(m.id);
    if (!e) return;
    v.fx.alert(e.pos, e.top ?? 2.5, !!m.enrage);
    v.fx.cue(e.pos, "roar");
    low("boss_spawn", m.enrage ? 0.9 : 0.6, m.enrage ? 0.62 : 0.8);
    if (m.to === v.me() || m.enrage) pulseVignette(!!m.enrage);
    if (m.enrage) {
      shake(0.18, 500);
      if (!enraged.has(m.id)) {
        enraged.add(m.id);
        v.fx.aura(e.pos, () => { const x = v.entity(m.id); const ok = !!x && !x.dead; if (!ok) enraged.delete(m.id); return ok; }, Math.max(1, (e.top ?? 2.5) / 2.2));
      }
    }
  }
  function onHop(m: BossHopEvent) {
    const e = v.entity(m.id);
    if (e) { fx("poof", e.pos, { size: 2.6 }); lifts.set(m.id, { t0: performance.now(), ms: Math.max(150, m.ms), h: 0.9, from: 0.1 }); }
    const land = cell(m.x, m.y);
    setTimeout(() => { fx("landing", land, { size: 3.4 }); fx("poof", land, { size: 2.2, delayMs: 40 }); }, Math.max(0, m.ms - 30));
  }
  r.onMessage(Msg.bossTele, onTele);
  r.onMessage(Msg.bossImpact, onImpact);
  r.onMessage(Msg.bossAggro, onAggro);
  r.onMessage(Msg.bossHop, onHop);

  // dev hook (Playwright / console): drive the FX without the server, e.g.
  //   __fx.tele({ id, move: "stomp", shape: "circle", x, y, r: 3, ms: 1500 }); setTimeout(() => __fx.impact({ ...same }), 1500)
  //   __fx.aggro({ id, to: __ro.room.sessionId, enrage: true }); __fx.hop({ id, x, y, ms: 300 }); __fx.spawn("crit")
  if (import.meta.env.DEV) {
    (window as any).__fx = {
      tele: onTele, impact: onImpact, aggro: onAggro, hop: onHop, shake, hitStop,
      spawn: (name: string, o: SpawnOpts & { x?: number; y?: number } = {}) => {
        const me = v.entity(v.me() ?? "");
        const at = o.x !== undefined && o.y !== undefined ? cell(o.x, o.y) : me?.pos;
        if (at) spawn(name, at, o);
      },
    };
  }
}
