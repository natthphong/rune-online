import * as THREE from "three";

// Status looks on units (B14): what the server publishes as a unit's `opt` word (shared/rules/status_change.ts scOption: "stun", "poison
// silence" ...) drawn on its sprite. Our own simple effects, in the style of fx.ts: a tint on the billboard (poison green, freeze ice,
// stone grey, curse violet, blind dim), orbiting stars for stun, rising Z's for sleep, a "..." bubble for silence, bubbles for poison,
// drops for bleeding, ice glints for freeze, a golden ring for Angelus. Everything is built from canvas textures drawn once.

type Tex = THREE.CanvasTexture;
const canvas = (w: number, h: number) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; return [cv, cv.getContext("2d")!] as const; };
const finish = (cv: HTMLCanvasElement): Tex => { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; };

function glow(color: string): Tex {
  const [cv, g] = canvas(64, 64);
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.35, color); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  return finish(cv);
}
function star(color: string): Tex {
  const [cv, g] = canvas(64, 64);
  g.translate(32, 33);
  g.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 11 : 26; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath();
  g.fillStyle = color; g.fill(); g.lineWidth = 3; g.strokeStyle = "#6a4a00"; g.lineJoin = "round"; g.stroke();
  return finish(cv);
}
function word(text: string, fill: string, edge: string, size = 44): Tex {
  const [cv, g] = canvas(128, 64);
  g.font = `900 ${size}px Arial Black, Arial, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  g.lineWidth = 7; g.strokeStyle = edge; g.strokeText(text, 64, 34); g.fillStyle = fill; g.fillText(text, 64, 34);
  return finish(cv);
}
function ring(color: string): Tex {
  const [cv, g] = canvas(128, 128);
  const rg = g.createRadialGradient(64, 64, 34, 64, 64, 62);
  rg.addColorStop(0, "rgba(0,0,0,0)"); rg.addColorStop(0.7, color); rg.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  return finish(cv);
}
function drop(color: string, edge: string): Tex {
  const [cv, g] = canvas(32, 48);
  g.beginPath(); g.moveTo(16, 3); g.bezierCurveTo(30, 22, 28, 40, 16, 44); g.bezierCurveTo(4, 40, 2, 22, 16, 3); g.closePath();
  g.fillStyle = color; g.fill(); g.lineWidth = 3; g.strokeStyle = edge; g.stroke();
  return finish(cv);
}

/** The sprite colour multiplier of each option word (white = untouched). */
const TINT: Record<string, number> = {
  poison: 0xa8f0a0, freeze: 0x93d2ff, stone: 0x8c8c8c, stonewait: 0xc6c6c6, curse: 0xb79bd8, blind: 0x7d7d96, sleep: 0xb8c4e8, stun: 0xfff2c0,
};
export function tintOf(words: Iterable<string>): number {
  let r = 1, g = 1, b = 1;
  for (const w of words) { const c = TINT[w]; if (c === undefined) continue; r *= ((c >> 16) & 255) / 255; g *= ((c >> 8) & 255) / 255; b *= (c & 255) / 255; }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/** What the loop needs to know of a unit: where its head and feet are, the sprite to tint, and whether to show anything. */
export type FxUnit = { sprite: THREE.Sprite; at: THREE.Vector3; top: number; hidden: boolean };
type Part = { s: THREE.Sprite; kind: string; i: number };
type Unit = { words: Set<string>; group: THREE.Group; parts: Part[]; tint: number };

export class StatusFx {
  private units = new Map<string, Unit>();
  private scene: THREE.Scene;
  private tex = {
    star: star("#ffe14a"), z: word("Z", "#dfe9ff", "#27407a"), dots: word("...", "#ffffff", "#3a3a48", 52), bubble: glow("rgba(120,235,110,0.9)"),
    ice: glow("rgba(190,235,255,0.95)"), curse: glow("rgba(150,70,210,0.9)"), blood: drop("#d8202a", "#5a0a10"), halo: ring("rgba(255,224,120,0.95)"),
  };

  constructor(scene: THREE.Scene) { this.scene = scene; }

  /** The unit's `opt` word changed (synced state). */
  set(id: string, opt: string) {
    const words = new Set(opt ? opt.split(" ") : []);
    let u = this.units.get(id);
    if (!u) {
      if (!words.size) return;
      u = { words, group: new THREE.Group(), parts: [], tint: 0xffffff };
      this.scene.add(u.group);
      this.units.set(id, u);
    } else if (words.size === u.words.size && [...words].every((w) => u!.words.has(w))) return;
    u.words = words;
    for (const p of u.parts) { u.group.remove(p.s); p.s.material.dispose(); }
    u.parts = [];
    const add = (kind: string, tex: Tex, n: number, blend = true) => {
      for (let i = 0; i < n; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, blending: blend ? THREE.AdditiveBlending : THREE.NormalBlending }));
        s.renderOrder = 15;
        u!.group.add(s);
        u!.parts.push({ s, kind, i });
      }
    };
    if (words.has("stun")) add("stun", this.tex.star, 3, false);
    if (words.has("sleep")) add("sleep", this.tex.z, 3, false);
    if (words.has("silence")) add("silence", this.tex.dots, 1, false);
    if (words.has("poison")) add("poison", this.tex.bubble, 4);
    if (words.has("freeze")) add("freeze", this.tex.ice, 4);
    if (words.has("curse")) add("curse", this.tex.curse, 3);
    if (words.has("bleeding")) add("bleeding", this.tex.blood, 3, false);
    if (words.has("angelus")) add("angelus", this.tex.halo, 1);
    if (!words.size) this.drop(id);
  }

  drop(id: string) {
    const u = this.units.get(id);
    if (!u) return;
    this.scene.remove(u.group);
    for (const p of u.parts) p.s.material.dispose();
    this.units.delete(id);
  }

  /** Every frame: tint the sprite and animate the parts. `get` finds a unit's drawing (undefined = gone). */
  update(now: number, get: (id: string) => FxUnit | undefined) {
    const t = now / 1000;
    for (const [id, u] of this.units) {
      const f = get(id);
      if (!f) { this.drop(id); continue; }
      const tint = f.hidden ? 0xffffff : tintOf(u.words);
      const mat = f.sprite.material as THREE.SpriteMaterial;
      if (u.tint !== tint || mat.color.getHex() !== tint) { mat.color.setHex(tint); u.tint = tint; }
      u.group.visible = !f.hidden;
      if (f.hidden) continue;
      u.group.position.copy(f.at);
      const top = f.top;
      for (const p of u.parts) {
        const s = p.s, m = s.material as THREE.SpriteMaterial;
        switch (p.kind) {
          case "stun": { // three stars orbiting over the head
            const a = t * 3.2 + (p.i * Math.PI * 2) / 3;
            s.position.set(Math.cos(a) * 0.34, top + 0.12 + Math.sin(a * 2) * 0.02, Math.sin(a) * 0.34);
            s.scale.set(0.2, 0.2, 1); m.opacity = 1; break;
          }
          case "sleep": { // Z's drift up and fade, staggered
            const k = ((t * 0.5 + p.i / 3) % 1);
            s.position.set(0.18 + k * 0.28, top + 0.05 + k * 0.5, 0);
            const sc = 0.2 + k * 0.22; s.scale.set(sc * 1.6, sc * 0.8, 1); m.opacity = k < 0.2 ? k * 5 : 1 - (k - 0.2) / 0.8; break;
          }
          case "silence":
            s.position.set(0, top + 0.28 + Math.sin(t * 2.4) * 0.03, 0); s.scale.set(0.55, 0.275, 1); m.opacity = 1; break;
          case "poison": { // green bubbles rising off the body
            const k = ((t * 0.7 + p.i / 4) % 1), a = p.i * 2.1 + t;
            s.position.set(Math.cos(a) * 0.22, 0.1 + k * (top * 0.9), Math.sin(a) * 0.18);
            const sc = 0.1 + 0.07 * Math.sin(k * Math.PI); s.scale.set(sc, sc, 1); m.opacity = Math.sin(k * Math.PI) * 0.9; break;
          }
          case "freeze": { // ice glints twinkling around the body
            const a = p.i * 1.6 + 0.7, tw = 0.5 + 0.5 * Math.sin(t * 5 + p.i * 1.9);
            s.position.set(Math.cos(a) * 0.3, top * (0.25 + 0.2 * p.i), Math.sin(a) * 0.2);
            const sc = 0.1 + 0.12 * tw; s.scale.set(sc, sc, 1); m.opacity = 0.4 + 0.6 * tw; break;
          }
          case "curse": { // dark wisps slowly circling
            const a = -t * 1.3 + (p.i * Math.PI * 2) / 3;
            s.position.set(Math.cos(a) * 0.32, top * 0.5 + 0.1 * Math.sin(t * 2 + p.i), Math.sin(a) * 0.32);
            s.scale.set(0.22, 0.22, 1); m.opacity = 0.8; break;
          }
          case "bleeding": { // red drops falling off the body
            const k = ((t * 0.9 + p.i / 3) % 1);
            s.position.set((p.i - 1) * 0.16, top * 0.6 - k * top * 0.5, 0.05);
            s.scale.set(0.07, 0.1, 1); m.opacity = 1 - k * 0.8; break;
          }
          case "angelus": { // a golden ring pulsing round the feet (always facing the camera: a billboard)
            const pulse = 1 + 0.12 * Math.sin(t * 3);
            s.position.set(0, 0.06, 0); s.scale.set(1.1 * pulse, 1.1 * pulse, 1); m.opacity = 0.55; break;
          }
        }
      }
    }
  }
}
