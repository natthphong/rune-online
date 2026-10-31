import * as THREE from "three";

// World-space effects: level-up light pillar, target/hover rings, click marker, hit sparks.

function gradientTexture(stops: [number, string][], w = 4, h = 128) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d")!;
  const grad = g.createLinearGradient(0, h, 0, 0);
  for (const [o, c] of stops) grad.addColorStop(o, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ringTexture(color: string) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 30, 64, 64, 62);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.7, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

/** A thin arc on the ground: white over a dark under-stroke, so it reads on pale dirt and dark grass alike. The classic
 *  client marks with a crisp white arc rather than a glow; gap = the opening of the "C" in degrees (0 = full ring). */
function arcTexture(alpha: number, gap: number) {
  const S = 256, cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  const a0 = ((gap / 2) * Math.PI) / 180;
  g.lineCap = "round";
  for (const [w, c] of [[S * 0.075, "rgba(8,10,18,0.5)"], [S * 0.034, `rgba(255,255,255,${alpha})`]] as const) {
    g.lineWidth = w;
    g.strokeStyle = c;
    g.beginPath();
    g.arc(S / 2, S / 2, S * 0.4, a0, Math.PI * 2 - a0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; // seen at a grazing angle
  return t;
}

const additive = (map: THREE.Texture, opacity = 1) => new THREE.MeshBasicMaterial({
  map, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});
const flat = (map: THREE.Texture, opacity = 1) => new THREE.MeshBasicMaterial({
  map, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
});

/** Our own hit-spark picture (procedural, white, tinted per use): sharp rays out of a soft round glow. `rays` = the
 *  length of each ray (0..1 of the radius), evenly spaced around the centre. */
function sparkTexture(rays: number[], glow: number, width: number) {
  const S = 128, c = S / 2, cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  const rg = g.createRadialGradient(c, c, 0, c, c, c * glow);
  rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.3, "rgba(255,255,255,0.8)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  g.translate(c, c);
  rays.forEach((len, i) => {
    g.save();
    g.rotate((i / rays.length) * Math.PI * 2);
    const lg = g.createLinearGradient(0, 0, c * len, 0);
    lg.addColorStop(0, "rgba(255,255,255,1)"); lg.addColorStop(0.7, "rgba(255,255,255,0.75)"); lg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = lg;
    g.beginPath(); g.moveTo(0, -c * width); g.lineTo(c * len, 0); g.lineTo(0, c * width); g.closePath(); g.fill();
    g.restore();
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** Impact colours: a blow on a monster (pink, like the classic hit burst), a critical (gold), a blow on a player (red-orange). */
const IMPACT = { hit: "#ff8ad2", crit: "#ffd04a", hurt: "#ff7a52" } as const;
export type ImpactKind = keyof typeof IMPACT;
const IMPACT_LIFE = 0.32; // s

type Burst = { group: THREE.Group; t0: number; anchor: THREE.Vector3; life: number; update: (t: number) => void };

export class Fx {
  private bursts: Burst[] = [];
  private pillarTex = gradientTexture([[0, "rgba(255,200,90,0.75)"], [0.5, "rgba(255,230,160,0.28)"], [1, "rgba(255,255,255,0)"]]);
  private goldRing = ringTexture("rgba(255,214,90,0.9)");
  private starTex = sparkTexture([1, 0.5, 0.92, 0.45, 1, 0.5, 0.92, 0.45], 0.42, 0.11);
  private twinkleTex = sparkTexture([0.95, 0.95, 0.95, 0.95], 0.32, 0.09);
  readonly target: THREE.Mesh;
  readonly hover: THREE.Mesh;
  readonly click: THREE.Mesh;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const ringGeo = new THREE.PlaneGeometry(1.2, 1.2).rotateX(-Math.PI / 2); // arc diameter ~0.96: one cell
    this.target = new THREE.Mesh(ringGeo, flat(arcTexture(1, 64)));
    this.hover = new THREE.Mesh(ringGeo, flat(arcTexture(0.85, 0), 0.6));
    this.click = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2), additive(ringTexture("rgba(120,220,255,1)")));
    for (const m of [this.target, this.hover, this.click]) { m.visible = false; m.renderOrder = 2; scene.add(m); }
  }

  /** anchor is read every frame, so the pillar follows a walking character */
  levelUp(anchor: THREE.Vector3) {
    const group = new THREE.Group();
    group.position.copy(anchor);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 7, 24, 1, true), additive(this.pillarTex));
    pillar.position.y = 3.5;
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 7, 16, 1, true), additive(this.pillarTex));
    inner.position.y = 3.5;
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(this.goldRing));
    ring.position.y = 0.05;
    const n = 40, pos = new Float32Array(n * 3), seeds = Array.from({ length: n }, () => [Math.random() * Math.PI * 2, 0.3 + Math.random() * 0.6, Math.random()]);
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: "#fff2b0", size: 0.12, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    group.add(pillar, inner, ring, sparks);
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor, life: 2.4,
      update: (t) => { // t: seconds since start, lives 2.4 s
        const grow = Math.min(1, t / 0.25), fade = t < 1.6 ? 1 : Math.max(0, 1 - (t - 1.6) / 0.8);
        pillar.scale.set(grow, grow, grow); inner.scale.set(grow, 1, grow);
        pillar.rotation.y += 0.04; inner.rotation.y -= 0.06;
        (pillar.material as THREE.MeshBasicMaterial).opacity = fade;
        (inner.material as THREE.MeshBasicMaterial).opacity = fade * 0.6;
        const r = 1 + t * 3;
        ring.scale.set(r, r, r);
        (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t / 1.2);
        seeds.forEach(([a, rad, off], i) => {
          const h = ((t * 1.6 + off * 3) % 3.5);
          pos[i * 3] = Math.cos(a + t * 2) * rad; pos[i * 3 + 1] = h; pos[i * 3 + 2] = Math.sin(a + t * 2) * rad;
        });
        sparkGeo.attributes.position.needsUpdate = true;
        (sparks.material as THREE.PointsMaterial).opacity = fade;
      },
    });
  }

  /** Our own big gold "MVP" lettering (drawn once), shown by mvp(). */
  private mvpTex?: THREE.CanvasTexture;
  private mvpWord() {
    if (this.mvpTex) return this.mvpTex;
    const c = document.createElement("canvas");
    c.width = 512; c.height = 192;
    const g = c.getContext("2d")!;
    g.font = "900 150px Georgia, 'Times New Roman', serif";
    g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
    g.lineWidth = 16; g.strokeStyle = "#3a1a00"; g.strokeText("MVP", 256, 100);
    const f = g.createLinearGradient(0, 30, 0, 170);
    f.addColorStop(0, "#fffbd0"); f.addColorStop(0.45, "#ffd23a"); f.addColorStop(1, "#d98a00");
    g.fillStyle = f; g.fillText("MVP", 256, 100);
    g.lineWidth = 3; g.strokeStyle = "#fff6c8"; g.strokeText("MVP", 256, 100);
    return (this.mvpTex = new THREE.CanvasTexture(c));
  }

  /** clif_mvp_effect: the winner of a boss gets a taller gold pillar, widening rings and a big "MVP" lettering floating up over
   *  the head (our own effect, not the original sprite). The anchor is read every frame like levelUp's. */
  mvp(anchor: THREE.Vector3) {
    const group = new THREE.Group();
    group.position.copy(anchor);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 10, 28, 1, true), additive(this.pillarTex));
    pillar.position.y = 5;
    const ringA = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(this.goldRing));
    const ringB = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(this.goldRing));
    ringA.position.y = ringB.position.y = 0.06;
    const word = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.mvpWord(), transparent: true, depthTest: false, depthWrite: false }));
    word.renderOrder = 20;
    const n = 70, pos = new Float32Array(n * 3), seeds = Array.from({ length: n }, () => [Math.random() * Math.PI * 2, 0.4 + Math.random() * 1.1, Math.random()]);
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: "#ffe680", size: 0.16, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    group.add(pillar, ringA, ringB, sparks, word);
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor, life: 3.4,
      update: (t) => {
        const grow = Math.min(1, t / 0.3), fade = t < 2.4 ? 1 : Math.max(0, 1 - (t - 2.4) / 1);
        pillar.scale.set(grow, grow, grow); pillar.rotation.y += 0.05;
        (pillar.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
        for (const [r, k, d] of [[ringA, 3.2, 0], [ringB, 3.2, 0.5]] as const) {
          const u = Math.max(0, t - d), sc = 0.5 + u * k;
          r.scale.set(sc, sc, sc);
          (r.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - u / 1.6);
        }
        seeds.forEach(([a, rad, off], i) => {
          const h = (t * 2.2 + off * 5) % 5;
          pos[i * 3] = Math.cos(a + t * 1.5) * rad; pos[i * 3 + 1] = h; pos[i * 3 + 2] = Math.sin(a + t * 1.5) * rad;
        });
        sparkGeo.attributes.position.needsUpdate = true;
        (sparks.material as THREE.PointsMaterial).opacity = fade;
        // the word pops in (overshoot), floats up and out
        const pop = t < 0.35 ? 0.4 + (t / 0.35) * 0.8 : t < 0.5 ? 1.2 - ((t - 0.35) / 0.15) * 0.2 : 1;
        word.scale.set(3.4 * pop, 1.28 * pop, 1);
        word.position.y = 3.1 + Math.min(t, 1.2) * 0.5 + Math.sin(t * 3) * 0.05;
        (word.material as THREE.SpriteMaterial).opacity = fade;
      },
    });
  }

  /**
   * Hit spark where a blow lands, shown on the blow frame. The classic client plays its hit burst on the target at the
   * damage tick: a few star sparks around the body centre for 300 ms, fading in and out. We studied this through roBrowser
   * Engine/MapEngine/Entity.js (EF_HIT1 at tick + attackMT) and DB/Effects/EffectTable.js entry 0; the textures are our own.
   * The spark is a white-hot core in a tinted star, and four twinkles fly out in the screen plane. It draws over the
   * scenery, like the damage number that comes with it.
   * `at` = contact point (world); `camera` gives the screen plane for the twinkles.
   */
  impact(at: THREE.Vector3, camera: THREE.Camera, kind: ImpactKind) {
    const group = new THREE.Group();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const sprite = (map: THREE.Texture, color: string) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, depthTest: false, depthWrite: false }));
      s.renderOrder = 10;
      group.add(s);
      return s;
    };
    const star = sprite(this.starTex, IMPACT[kind]), core = sprite(this.twinkleTex, "#ffffff");
    (star.material as THREE.SpriteMaterial).rotation = Math.random() * Math.PI;
    const twinkles = Array.from({ length: 4 }, (_, i) => {
      const a = (i / 4) * Math.PI * 2 + Math.random() * 1.2, d = 0.28 + Math.random() * 0.22;
      return { s: sprite(this.twinkleTex, IMPACT[kind]), dir: right.clone().multiplyScalar(Math.cos(a) * d).addScaledVector(up, Math.sin(a) * d) };
    });
    const anchor = at.clone();
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor, life: IMPACT_LIFE,
      update: (t) => {
        const pop = 1 - (1 - Math.min(1, t / 0.07)) ** 2; // flashes open in 70 ms
        const s = 0.95 * (0.45 + 0.55 * pop);
        star.scale.set(s, s, 1);
        (star.material as THREE.SpriteMaterial).opacity = t < 0.07 ? 0.95 : Math.max(0, 0.95 * (1 - (t - 0.07) / (IMPACT_LIFE - 0.07)));
        core.scale.set(s * 0.5, s * 0.5, 1);
        (core.material as THREE.SpriteMaterial).opacity = t < 0.05 ? 1 : Math.max(0, 1 - (t - 0.05) / 0.15);
        const out = 1 - (1 - t / IMPACT_LIFE) ** 2;
        for (const w of twinkles) {
          w.s.position.copy(w.dir).multiplyScalar(out);
          const ws = 0.3 * (1 - 0.5 * t / IMPACT_LIFE);
          w.s.scale.set(ws, ws, 1);
          (w.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t / IMPACT_LIFE);
        }
      },
    });
  }

  /** A slime glob (our own, procedural): a jelly blob texture drawn once, tinted per use. */
  private globTex?: THREE.CanvasTexture;
  private glob() {
    if (this.globTex) return this.globTex;
    const S = 64, c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    const rg = g.createRadialGradient(S * 0.4, S * 0.38, 2, S / 2, S / 2, S / 2);
    rg.addColorStop(0, "rgba(235,255,220,1)"); rg.addColorStop(0.25, "rgba(150,235,90,1)"); rg.addColorStop(0.8, "rgba(60,160,40,0.95)"); rg.addColorStop(1, "rgba(40,110,30,0)");
    g.fillStyle = rg;
    g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return (this.globTex = t);
  }
  private globSprite(size: number) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glob(), transparent: true, depthWrite: false }));
    s.scale.set(size, size, 1);
    s.renderOrder = 9;
    return s;
  }

  /** A boss's slime spit (Msg.bossSpit): a wobbling green glob arcs from `from` to `to` (both read every frame) in `ms`, with a
   *  few droplets trailing, then splats on the target. */
  spit(from: THREE.Vector3, to: THREE.Vector3, ms: number) {
    const group = new THREE.Group(), flight = Math.max(0.15, ms / 1000);
    const blob = this.globSprite(0.55), trail = [0.32, 0.22, 0.14].map((k) => this.globSprite(k));
    group.add(blob, ...trail);
    this.scene.add(group);
    const start = from.clone(), at = (u: number, out: THREE.Vector3) => { // the arc: start height 1.6, end 0.8, apex +1.8
      out.lerpVectors(start, to, u);
      out.y += 1.6 + (0.8 - 1.6) * u + Math.sin(Math.PI * u) * (1.2 + 0.08 * start.distanceTo(to));
      return out;
    };
    let splatted = false;
    this.bursts.push({
      group, t0: performance.now(), anchor: new THREE.Vector3(), life: flight + 0.02,
      update: (t) => {
        const u = Math.min(1, t / flight);
        at(u, blob.position);
        const w = 1 + Math.sin(t * 30) * 0.12;
        blob.scale.set(0.55 * w, 0.55 / w, 1);
        trail.forEach((d, i) => at(Math.max(0, u - 0.07 * (i + 1)), d.position));
        if (u >= 1 && !splatted) { splatted = true; this.splat(to.clone()); }
      },
    });
  }

  /** Where a glob lands: a flat green puddle spreading out and fading, and droplets thrown up and falling. */
  splat(at: THREE.Vector3) {
    const group = new THREE.Group();
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.glob(), transparent: true, depthWrite: false }));
    puddle.position.y = 0.05;
    const drops = Array.from({ length: 7 }, () => {
      const a = Math.random() * Math.PI * 2, v = 1 + Math.random() * 1.4;
      return { s: this.globSprite(0.12 + Math.random() * 0.1), vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 2.5 + Math.random() * 2 };
    });
    group.add(puddle, ...drops.map((d) => d.s));
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor: at, life: 0.9,
      update: (t) => {
        const sc = 0.6 + Math.min(1, t / 0.15) * 0.9;
        puddle.scale.set(sc, 1, sc);
        (puddle.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t / 0.9);
        for (const d of drops) {
          d.s.position.set(d.vx * t, Math.max(0, 0.6 + d.vy * t - 9.8 * t * t / 1.5), d.vz * t);
          (d.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t / 0.8);
        }
      },
    });
  }

  /** A boss splitting (Msg.bossSplit): a green shock ring, a jelly burst thrown out on all sides and a pale flash over the body. */
  split(anchor: THREE.Vector3) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(ringTexture("rgba(140,255,110,0.95)")));
    ring.position.y = 0.06;
    const flash = this.globSprite(2.6);
    flash.position.y = 1.4;
    const drops = Array.from({ length: 14 }, (_, i) => {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3, v = 2 + Math.random() * 1.5;
      return { s: this.globSprite(0.2 + Math.random() * 0.15), vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 3 + Math.random() * 2.5 };
    });
    group.add(ring, flash, ...drops.map((d) => d.s));
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor, life: 1.2,
      update: (t) => {
        const r = 0.5 + t * 6;
        ring.scale.set(r, r, r);
        (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t / 1.0);
        const sq = 1 + Math.sin(Math.min(1, t / 0.4) * Math.PI) * 0.5; // squash: wide and low, then gone
        flash.scale.set(2.6 * sq, 2.6 / sq, 1);
        (flash.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.7 * (1 - t / 0.5));
        for (const d of drops) {
          d.s.position.set(d.vx * t, Math.max(0, 1.2 + d.vy * t - 9.8 * t * t), d.vz * t);
          (d.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t / 1.1);
        }
      },
    });
  }

  /** Dust and lane pictures of the goat boss's moves (our own, procedural). */
  private dustTex?: THREE.CanvasTexture;
  private dust() {
    if (this.dustTex) return this.dustTex;
    const S = 64, c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    const rg = g.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    rg.addColorStop(0, "rgba(235,215,175,0.95)"); rg.addColorStop(0.6, "rgba(190,160,115,0.6)"); rg.addColorStop(1, "rgba(160,130,90,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return (this.dustTex = t);
  }
  private dustSprite(size: number) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dust(), transparent: true, depthWrite: false }));
    s.scale.set(size, size, 1);
    s.renderOrder = 9;
    return s;
  }
  private laneTex?: THREE.CanvasTexture;
  private lane() {
    if (this.laneTex) return this.laneTex;
    const c = document.createElement("canvas");
    c.width = 8; c.height = 64;
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, "rgba(255,70,40,0)"); gr.addColorStop(0.2, "rgba(255,90,50,0.9)"); gr.addColorStop(0.8, "rgba(255,90,50,0.9)"); gr.addColorStop(1, "rgba(255,70,40,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 8, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return (this.laneTex = t);
  }

  /** A boss's charge (Msg.bossCharge): a red lane from `from` to `to` pulses for `windMs` while dust kicks up at the boss's feet
   *  (the telegraph: step out of it), then it fades as the boss dashes the lane in `dashMs` leaving a dust streak. `from` is read live. */
  charge(from: THREE.Vector3, to: THREE.Vector3, windMs: number, dashMs: number) {
    const group = new THREE.Group(), wind = windMs / 1000, dash = Math.max(0.05, dashMs / 1000);
    const a = from.clone(), d = new THREE.Vector3().subVectors(to, a).setY(0), len = Math.max(0.5, d.length());
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(this.lane(), 0));
    lane.position.copy(d).multiplyScalar(0.5).setY(0.07);
    lane.rotation.y = -Math.atan2(d.z, d.x);
    lane.scale.set(len, 1, 1.7); // the plane's X runs along the lane, the texture's gradient across V (width): turn it
    (lane.material as THREE.MeshBasicMaterial).map!.center.set(0.5, 0.5);
    (lane.material as THREE.MeshBasicMaterial).map!.rotation = Math.PI / 2;
    const puffs = Array.from({ length: 8 }, () => this.dustSprite(0.9));
    group.add(lane, ...puffs);
    this.scene.add(group);
    const dir = d.clone().normalize();
    this.bursts.push({
      group, t0: performance.now(), anchor: a, life: wind + dash + 0.7,
      update: (t) => {
        const m = lane.material as THREE.MeshBasicMaterial;
        if (t < wind) m.opacity = Math.min(1, (0.45 + 0.55 * t / wind) * (0.8 + 0.2 * Math.sin(t * 28)));
        else m.opacity = Math.max(0, 0.6 * (1 - (t - wind) / 0.25));
        puffs.forEach((p, i) => {
          const k = (i + 1) / puffs.length;
          let at: THREE.Vector3, o: number, sz: number;
          if (t < wind) { // scraping hooves: puffs pop up behind the boss and drift off
            const ph = (t * 3 + k) % 1;
            at = new THREE.Vector3(-dir.x * (0.3 + ph * 0.8) + Math.sin(i * 2.1) * 0.5, 0.2 + ph * 0.5, -dir.z * (0.3 + ph * 0.8) + Math.cos(i * 2.1) * 0.5);
            o = 0.7 * (1 - ph); sz = 0.5 + ph * 0.9;
          } else { // a streak along the dash
            const u = Math.min(1, (t - wind) / dash), back = k * 0.35;
            const pu = Math.max(0, u - back * 0.4), age = Math.max(0, t - wind - pu * dash);
            at = new THREE.Vector3(d.x * pu, 0.25 + age * 0.8, d.z * pu);
            o = Math.max(0, 0.75 - age * 1.3); sz = 0.7 + age * 1.6;
          }
          p.position.copy(at);
          p.scale.set(sz, sz, 1);
          (p.material as THREE.SpriteMaterial).opacity = o;
        });
      },
    });
  }

  /** A headbutt's wind-up (Msg.bossCharge kind "head"): a small ring closing in on the boss. */
  rear(anchor: THREE.Vector3, windMs: number) {
    const group = new THREE.Group(), wind = Math.max(0.1, windMs / 1000);
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(ringTexture("rgba(255,120,70,0.95)")));
    ring.position.y = 0.06;
    group.add(ring);
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor: anchor.clone(), life: wind + 0.1,
      update: (t) => {
        const r = 3.2 - 2.2 * Math.min(1, t / wind);
        ring.scale.set(r, r, r);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.6 * Math.min(1, t / wind);
      },
    });
  }

  /** The impact of a charge / headbutt (Msg.bossSlam): a shock ring and dust thrown out along (dx, dz), the victim's side. */
  slam(at: THREE.Vector3, dx: number, dz: number) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(ringTexture("rgba(255,170,90,0.95)")));
    ring.position.y = 0.06;
    const flash = this.dustSprite(2.2);
    flash.position.y = 1.0;
    const puffs = Array.from({ length: 10 }, (_, i) => {
      const a = Math.atan2(dz, dx) + (Math.random() - 0.5) * 2.4 + (i % 3 === 0 ? Math.PI : 0), v = 1.5 + Math.random() * 2.2;
      return { s: this.dustSprite(0.4 + Math.random() * 0.4), vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 1 + Math.random() * 2 };
    });
    group.add(ring, flash, ...puffs.map((p) => p.s));
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor: at.clone(), life: 0.9,
      update: (t) => {
        const r = 0.6 + t * 5;
        ring.scale.set(r, r, r);
        (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t / 0.6);
        (flash.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.9 * (1 - t / 0.25));
        for (const p of puffs) {
          p.s.position.set(p.vx * t, Math.max(0.05, 0.4 + p.vy * t - 6 * t * t), p.vz * t);
          (p.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.9 - t / 0.9);
        }
      },
    });
  }

  /** A boss cue that is not the jelly burst (Msg.bossSplit kind): "stomp" = a ring of dust (the kids arrive), "roar" = a red double ring. */
  cue(anchor: THREE.Vector3, kind: "stomp" | "roar") {
    const group = new THREE.Group(), col = kind === "roar" ? "rgba(255,60,40,0.95)" : "rgba(230,190,120,0.95)";
    const rings = [0, 0.18].map(() => {
      const r = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), additive(ringTexture(col)));
      r.position.y = 0.06;
      return r;
    });
    const puffs = Array.from({ length: 12 }, (_, i) => ({ s: this.dustSprite(0.6), a: (i / 12) * Math.PI * 2, v: 2.5 + Math.random() * 1.5 }));
    group.add(...rings, ...puffs.map((p) => p.s));
    this.scene.add(group);
    this.bursts.push({
      group, t0: performance.now(), anchor: anchor.clone(), life: 1.3,
      update: (t) => {
        rings.forEach((r, i) => {
          const tt = Math.max(0, t - i * 0.18), sz = 0.5 + tt * (kind === "roar" ? 9 : 6);
          r.scale.set(sz, sz, sz);
          (r.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - tt / 1.0);
        });
        for (const p of puffs) {
          p.s.position.set(Math.cos(p.a) * p.v * t, 0.3 + t * 0.9, Math.sin(p.a) * p.v * t);
          (p.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 0.8 - t / 1.1);
          p.s.scale.setScalar(0.6 + t * 1.4);
        }
      },
    });
  }

  markClick(at: THREE.Vector3) {
    this.click.position.copy(at).setY(at.y + 0.04);
    this.click.visible = true;
    this.click.userData.t0 = performance.now();
  }

  update(now: number) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i], t = (now - b.t0) / 1000;
      if (t > b.life) {
        this.scene.remove(b.group);
        b.group.traverse((o) => {
          if (o instanceof THREE.Mesh || o instanceof THREE.Points) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
          else if (o instanceof THREE.Sprite) (o.material as THREE.Material).dispose(); // sprites share three's quad: keep it
        });
        this.bursts.splice(i, 1);
        continue;
      }
      b.group.position.copy(b.anchor);
      b.update(t);
    }
    if (this.click.visible) {
      const t = (now - this.click.userData.t0) / 600;
      const s = 0.6 + t * 0.8;
      this.click.scale.set(s, s, s);
      (this.click.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      if (t >= 1) this.click.visible = false;
    }
    this.target.rotation.y = -now / 700; // the opening of the arc turns slowly
  }
}
