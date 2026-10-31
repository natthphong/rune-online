import * as THREE from "three";

// Skill presentation, all our own art (procedural canvas textures): the casting circle under a caster, the cast bar over it
// (clif_skillcasting: a bar that fills over the cast time), the skill's name shouted over the caster when it goes off, and one
// small effect per kind of skill — bolts falling on the target (the classic client drops its bolts from the sky), a ring of
// fire / arrows bursting on the ground, a rising column of light for a heal, a streak for arrows, a flash for strikes.

const ELE_HEX: Record<string, string> = {
  Fire: "#ff7a2a", Water: "#7fd2ff", Wind: "#ffe95a", Earth: "#c9a061", Ghost: "#c9a8ff", Holy: "#fff4b0", Poison: "#9be05a",
  Dark: "#a07ad0", Undead: "#b8c090", Neutral: "#ffffff",
};
export const eleColor = (ele: string | undefined) => ELE_HEX[ele ?? "Neutral"] ?? "#ffffff";

function canvasTex(S: number, draw: (g: CanvasRenderingContext2D, S: number) => void) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  draw(cv.getContext("2d")!, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** A white magic circle: two rings, a six-point star between them and tick marks (tinted per element). */
const circleTex = canvasTex(256, (g, S) => {
  const c = S / 2;
  g.strokeStyle = "rgba(255,255,255,0.95)"; g.lineWidth = 5;
  g.beginPath(); g.arc(c, c, S * 0.46, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3;
  g.beginPath(); g.arc(c, c, S * 0.36, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.beginPath(); g.moveTo(c + Math.cos(a) * S * 0.37, c + Math.sin(a) * S * 0.37); g.lineTo(c + Math.cos(a) * S * 0.45, c + Math.sin(a) * S * 0.45); g.stroke();
  }
  g.lineWidth = 2.5;
  for (const off of [0, Math.PI / 3]) {
    g.beginPath();
    for (let i = 0; i <= 3; i++) { const a = off + (i / 3) * Math.PI * 2 - Math.PI / 2; const x = c + Math.cos(a) * S * 0.35, y = c + Math.sin(a) * S * 0.35; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
});
const glowTex = canvasTex(128, (g, S) => {
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,0.7)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, S, S);
});
const ringTex = canvasTex(256, (g, S) => {
  const r = g.createRadialGradient(S / 2, S / 2, S * 0.28, S / 2, S / 2, S * 0.5);
  r.addColorStop(0, "rgba(255,255,255,0)"); r.addColorStop(0.6, "rgba(255,255,255,0.95)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, S, S);
});
/** A vertical streak (bolt / arrow body): bright core, soft edges, fading tail. */
const streakTex = canvasTex(64, (g, S) => {
  const lg = g.createLinearGradient(0, 0, 0, S);
  lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(0.7, "rgba(255,255,255,0.8)"); lg.addColorStop(1, "rgba(255,255,255,1)");
  g.fillStyle = lg;
  g.beginPath(); g.moveTo(S * 0.42, 0); g.lineTo(S * 0.58, 0); g.lineTo(S * 0.66, S); g.lineTo(S * 0.34, S); g.closePath(); g.fill();
});

type Burst = { group: THREE.Group; t0: number; life: number; anchor?: THREE.Vector3; update: (t: number) => void };
const add = (map: THREE.Texture, color: string, opacity = 1) => new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
const spr = (map: THREE.Texture, color: string) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.renderOrder = 9;
  return s;
};

export class SkillFx {
  private scene: THREE.Scene;
  private bursts: Burst[] = [];
  private circles = new Map<string, Burst>();
  constructor(scene: THREE.Scene) { this.scene = scene; }

  private push(b: Burst) { this.scene.add(b.group); this.bursts.push(b); return b; }

  /** The casting circle under a caster for `ms` (removed early by stopCast). `anchor` is followed (a walking caster). */
  cast(id: string, anchor: THREE.Vector3, ele: string | undefined, ms: number) {
    this.stopCast(id);
    const group = new THREE.Group();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2), add(circleTex, eleColor(ele), 0.9));
    m.position.y = 0.05;
    group.add(m);
    const b = this.push({ group, t0: performance.now(), life: Math.max(0.3, ms / 1000 + 0.15), anchor, update: (t) => {
      m.rotation.y = t * 1.2;
      const k = Math.min(1, t / 0.2);
      m.scale.setScalar(0.6 + 0.4 * k);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * k;
    } });
    this.circles.set(id, b);
  }
  stopCast(id: string) {
    const b = this.circles.get(id);
    if (b) { b.life = 0; this.circles.delete(id); }
  }

  /** `hits` bolts falling one after another onto the target (fire / frost / lightning / spirit). */
  bolts(at: THREE.Vector3, ele: string | undefined, hits: number) {
    const group = new THREE.Group(), color = eleColor(ele), n = Math.min(hits, 10), gap = 0.11;
    const items = Array.from({ length: n }, (_, i) => {
      const body = spr(streakTex, color), flash = spr(glowTex, color);
      body.scale.set(0.7, 2.2, 1); flash.scale.setScalar(0);
      const dx = (Math.random() - 0.5) * 0.5, dz = (Math.random() - 0.5) * 0.5;
      group.add(body, flash);
      return { body, flash, dx, dz, t0: i * gap };
    });
    this.push({ group, t0: performance.now(), life: n * gap + 0.6, anchor: at.clone(), update: (t) => {
      for (const it of items) {
        const k = (t - it.t0) / 0.22; // falls in 220 ms
        it.body.visible = k >= 0 && k < 1;
        if (it.body.visible) it.body.position.set(it.dx, 4.5 * (1 - k) + 0.6, it.dz);
        const f = (t - it.t0 - 0.22) / 0.3;
        it.flash.visible = f >= 0 && f < 1;
        if (it.flash.visible) { it.flash.position.set(it.dx, 0.6, it.dz); it.flash.scale.setScalar(0.9 + f * 1.3); (it.flash.material as THREE.SpriteMaterial).opacity = 1 - f; }
      }
    } });
  }

  /** A burst on the ground: a ring growing to `radius` cells (Flame Burst around the caster, Arrow Rain on its cell). */
  ground(at: THREE.Vector3, ele: string | undefined, radius: number, arrows = false) {
    const group = new THREE.Group(), color = eleColor(ele);
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), add(ringTex, color));
    ring.position.y = 0.06;
    const flash = spr(glowTex, color);
    group.add(ring, flash);
    const darts = arrows ? Array.from({ length: 12 }, () => {
      const s = spr(streakTex, "#fff6d8"); s.scale.set(0.18, 0.9, 1);
      group.add(s);
      return { s, x: (Math.random() * 2 - 1) * radius, z: (Math.random() * 2 - 1) * radius, d: Math.random() * 0.25 };
    }) : [];
    const sparks = arrows ? [] : Array.from({ length: 18 }, (_, i) => {
      const s = spr(glowTex, color); s.scale.setScalar(0.35); group.add(s);
      return { s, a: (i / 18) * Math.PI * 2, v: 0.8 + Math.random() * 0.6 };
    });
    this.push({ group, t0: performance.now(), life: 0.9, anchor: at.clone(), update: (t) => {
      const k = Math.min(1, t / 0.35), r = 0.3 + (radius + 0.5) * k;
      ring.scale.set(r, 1, r);
      (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t / 0.9);
      flash.position.y = 0.6; flash.scale.setScalar(1.6 * (1 - Math.min(1, t / 0.4)) + 0.01);
      for (const d of darts) {
        const f = (t - d.d) / 0.25;
        d.s.visible = f >= 0 && f < 1;
        if (d.s.visible) d.s.position.set(d.x, 3.5 * (1 - f), d.z);
      }
      for (const sp of sparks) {
        const rr = sp.v * (radius + 0.5) * k;
        sp.s.position.set(Math.cos(sp.a) * rr, 0.3 + Math.sin(t * 9 + sp.a) * 0.1 + t * 0.6, Math.sin(sp.a) * rr);
        (sp.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t / 0.9);
      }
    } });
  }

  /** Heal: a soft column of light with sparkles rising around the unit. */
  heal(anchor: THREE.Vector3) {
    const group = new THREE.Group();
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 2.4, 20, 1, true), add(streakTex, "#bfffd0", 0.7));
    col.position.y = 1.2;
    group.add(col);
    const motes = Array.from({ length: 14 }, (_, i) => { const s = spr(glowTex, "#d8ffe0"); s.scale.setScalar(0.18); group.add(s); return { s, a: (i / 14) * Math.PI * 2, o: Math.random() }; });
    this.push({ group, t0: performance.now(), life: 1.1, anchor, update: (t) => {
      (col.material as THREE.MeshBasicMaterial).opacity = 0.7 * Math.max(0, 1 - t / 1.1);
      col.scale.set(1, Math.min(1, t / 0.2), 1);
      for (const m of motes) { const h = ((t + m.o) * 1.6) % 2.2; m.s.position.set(Math.cos(m.a + t * 3) * 0.5, h, Math.sin(m.a + t * 3) * 0.5); }
    } });
  }

  /** A streak flying from the caster to the target (arrows), with a flash on arrival; `count` arrows 90 ms apart. */
  shot(from: THREE.Vector3, to: THREE.Vector3, ele: string | undefined, count = 1) {
    const group = new THREE.Group(), color = eleColor(ele === "Neutral" ? undefined : ele);
    const a = from.clone().setY(from.y + 0.8), b = to.clone().setY(to.y + 0.7);
    const items = Array.from({ length: count }, (_, i) => { const s = spr(streakTex, color === "#ffffff" ? "#fff2c8" : color); s.scale.set(0.16, 0.9, 1); group.add(s); return { s, d: i * 0.09 }; });
    const flash = spr(glowTex, color); flash.scale.setScalar(0); group.add(flash);
    const dir = b.clone().sub(a);
    this.push({ group, t0: performance.now(), life: 0.6 + count * 0.09, update: (t) => {
      for (const it of items) {
        const k = (t - it.d) / 0.18;
        it.s.visible = k >= 0 && k < 1;
        if (it.s.visible) { it.s.position.copy(a).addScaledVector(dir, k); (it.s.material as THREE.SpriteMaterial).rotation = Math.atan2(dir.x, dir.z); }
      }
      const f = (t - 0.18) / 0.3;
      flash.visible = f >= 0 && f < 1;
      if (flash.visible) { flash.position.copy(b); flash.scale.setScalar(0.4 + f); (flash.material as THREE.SpriteMaterial).opacity = 1 - f; }
    } });
  }

  /** A strike flash on the target (weapon skills: Crushing Blow, Coin Strike, Venom Edge). */
  strike(at: THREE.Vector3, ele: string | undefined, coin = false) {
    const group = new THREE.Group(), color = coin ? "#ffd75a" : eleColor(ele === "Neutral" ? undefined : ele);
    const core = spr(glowTex, color), ring = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4).rotateX(-Math.PI / 2), add(ringTex, color));
    ring.position.y = 0.05;
    const chips = Array.from({ length: coin ? 10 : 6 }, () => { const s = spr(glowTex, color); s.scale.setScalar(0.15); group.add(s); return { s, a: Math.random() * Math.PI * 2, v: 0.6 + Math.random() }; });
    group.add(core, ring);
    this.push({ group, t0: performance.now(), life: 0.55, anchor: at.clone(), update: (t) => {
      core.position.y = 0.75; core.scale.setScalar(1.3 * (1 - t / 0.55) + 0.2);
      (core.material as THREE.SpriteMaterial).opacity = 1 - t / 0.55;
      ring.scale.setScalar(0.5 + t * 2.5);
      (ring.material as THREE.MeshBasicMaterial).opacity = 1 - t / 0.55;
      for (const c of chips) c.s.position.set(Math.cos(c.a) * c.v * t * 2, 0.75 + c.v * t * 2.5 - t * t * 6, Math.sin(c.a) * c.v * t * 2);
    } });
  }

  update(now: number) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i], t = (now - b.t0) / 1000;
      if (t > b.life) {
        this.scene.remove(b.group);
        b.group.traverse((o) => {
          if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
          else if (o instanceof THREE.Sprite) (o.material as THREE.Material).dispose();
        });
        this.bursts.splice(i, 1);
        for (const [id, c] of this.circles) if (c === b) this.circles.delete(id);
        continue;
      }
      if (b.anchor) b.group.position.copy(b.anchor);
      b.update(t);
    }
  }
}

// ---------- DOM: cast bars and shouted skill names over units ----------
type Overlay = { el: HTMLDivElement; t0: number; ms: number };
const bars = new Map<string, Overlay>();
const shouts = new Map<string, Overlay>();
/** clif_skillcasting: a bar over the caster that fills in `ms`. */
export function castBar(layer: HTMLElement, id: string, ms: number) {
  endCastBar(id);
  if (ms <= 0) return;
  const el = document.createElement("div");
  el.className = "castbar";
  el.append(document.createElement("i"));
  layer.append(el);
  bars.set(id, { el, t0: performance.now(), ms });
}
export function endCastBar(id: string) { const b = bars.get(id); if (b) { b.el.remove(); bars.delete(id); } }
/** The skill's name over the caster as it goes off (the classic client shouts it). */
export function shout(layer: HTMLElement, id: string, text: string) {
  shouts.get(id)?.el.remove();
  const el = document.createElement("div");
  el.className = "skill-shout";
  el.textContent = `${text}!!`;
  layer.append(el);
  shouts.set(id, { el, t0: performance.now(), ms: 1300 });
}
/** Every frame: fill the bars, move bars and shouts with their unit. posOf = the point just over the unit's head; place(el,
 *  worldPos, dyPx) is main.ts's projector. */
export function updateSkillOverlays(now: number, posOf: (id: string) => THREE.Vector3 | undefined, place: (el: HTMLElement, v: THREE.Vector3, dy: number) => void) {
  for (const [id, b] of bars) {
    const p = posOf(id), k = (now - b.t0) / b.ms;
    if (!p || k >= 1) { endCastBar(id); continue; }
    place(b.el, p, -6);
    (b.el.firstChild as HTMLElement).style.transform = `scaleX(${k})`;
  }
  for (const [id, s] of shouts) {
    const p = posOf(id), k = (now - s.t0) / s.ms;
    if (!p || k >= 1) { s.el.remove(); shouts.delete(id); continue; }
    place(s.el, p, -22 - k * 14);
    s.el.style.opacity = String(k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25);
  }
}
export function clearSkillOverlays() {
  for (const id of [...bars.keys()]) endCastBar(id);
  for (const s of shouts.values()) s.el.remove();
  shouts.clear();
}
