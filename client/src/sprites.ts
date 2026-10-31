import * as THREE from "three";
import { plainSheet, type Sheet } from "./spriteSheets.ts";

// Placeholder billboard characters, drawn procedurally so the template runs with zero art.
// Replace makeAtlas() with a real sprite sheet (same layout) from common/assets when ready:
// columns = view (front, side, back), rows = frame (idle, walk A, walk B). Side faces right;
// left-facing views are the same column mirrored via texture repeat.
const CW = 64, CH = 96;

const relAngle = (dir: number, camYaw: number) => {
  // angle of the facing direction relative to "toward the camera", -PI..PI (positive = facing screen-right)
  const rel = (dir * Math.PI) / 4 - camYaw;
  return Math.atan2(Math.sin(rel), Math.cos(rel));
};

/** Swap a sprite onto a generated sheet once it has loaded; sized so its height is `height` world units. */
function useSheet(sprite: THREE.Sprite, s: Sheet, height: number) {
  const tex = new THREE.CanvasTexture(s.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.repeat.set(1 / s.views, 1);
  const mat = sprite.material as THREE.SpriteMaterial;
  mat.map?.dispose();
  mat.map = tex;
  mat.alphaTest = 0.35;
  mat.needsUpdate = true;
  sprite.scale.set((height * s.cellW) / s.cellH, height, 1);
  return tex;
}

// Placeholder monsters: one procedural sheet per kind, 2 frames (idle squash / stretch).
function makeMonsterAtlas(kind: string, color: string) {
  const cv = document.createElement("canvas");
  cv.width = CW * 2; cv.height = CH;
  const g = cv.getContext("2d")!;
  for (let f = 0; f < 2; f++) {
    g.save();
    g.translate(f * CW + CW / 2, CH);
    const sq = f ? 1.08 : 0.94;
    g.fillStyle = color;
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.lineWidth = 2;
    if (kind === "stingwing") {
      g.fillStyle = "rgba(220,240,255,0.8)"; // wings
      g.beginPath(); g.ellipse(-14, -66 - f * 4, 12, 7, -0.5, 0, Math.PI * 2); g.ellipse(14, -66 - f * 4, 12, 7, 0.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = color;
      g.beginPath(); g.ellipse(0, -48, 16, 20, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = "#2b2b2b";
      for (const y of [-52, -42]) g.fillRect(-15, y, 30, 4);
    } else if (kind === "sprout") { // Plant: bulb body + leaf crown
      g.fillStyle = "#4f9a3a";
      g.beginPath(); g.ellipse(-9, -46 * sq, 6, 14, -0.6, 0, Math.PI * 2); g.ellipse(9, -46 * sq, 6, 14, 0.6, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = color;
      g.beginPath(); g.ellipse(0, -20 * sq, 21 / sq, 20 * sq, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    } else if (kind === "fish") { // Fish: hopping round fish on its tail
      g.beginPath(); g.moveTo(-6, -4); g.lineTo(6, -4); g.lineTo(0, -16); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.ellipse(0, -36 * sq, 16, 22 * sq, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.beginPath(); g.ellipse(6, -30 * sq, 6, 10, 0, 0, Math.PI * 2); g.fill();
    } else if (kind === "fluffbun") {
      g.beginPath(); g.ellipse(-8, -62 * sq, 6, 16, -0.2, 0, Math.PI * 2); g.ellipse(8, -62 * sq, 6, 16, 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.ellipse(0, -24 * sq, 22, 24 * sq, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    } else {
      g.beginPath(); g.ellipse(0, -20 * sq, 24 / sq, 20 * sq, 0, Math.PI, 0); g.lineTo(24 / sq, 0); g.lineTo(-24 / sq, 0); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "rgba(255,255,255,0.6)";
      g.beginPath(); g.ellipse(-9, -28 * sq, 5, 3, -0.6, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = "#222"; // eyes
    const ey = kind === "stingwing" ? -56 : kind === "fluffbun" ? -30 * sq : kind === "fish" ? -42 * sq : -18 * sq;
    g.fillRect(-8, ey, 4, 6); g.fillRect(4, ey, 4, 6);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Placeholder look per rAthena race until generated sprites land (PLAN MVP4/5); colour comes from the element.
export const RACE_SHAPE: Record<string, string> = { Plant: "sprout", Brute: "fluffbun", Insect: "stingwing", Fish: "fish", Formless: "bloblet" };
export const ELEMENT_COLOR: Record<string, string> = {
  Neutral: "#f2efe6", Water: "#7cc4f5", Earth: "#c9a26b", Fire: "#ff8f5e", Wind: "#a8e28a",
  Poison: "#b98be0", Holy: "#fff2a8", Dark: "#6e6a8f", Ghost: "#d6e4ff", Undead: "#9aa38c",
};

/** Monsters and NPCs: a generated 3-view sheet (front, side, back) when available, else the procedural blob. */
export class MonsterSprite {
  sprite: THREE.Sprite;
  private tex: THREE.Texture;
  private sheet: Sheet | null = null;
  private phase = Math.random() * 10;
  private height: number;
  private hop: boolean;
  private disposed = false;

  constructor(kind: string, color: string, sheetKey?: string, height = 1.2, hop = false) {
    this.height = height;
    this.hop = hop;
    this.tex = makeMonsterAtlas(kind, color);
    this.tex.repeat.set(0.5, 1);
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, alphaTest: 0.5, transparent: true }));
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set(0.9, 1.35, 1);
    if (sheetKey) plainSheet(sheetKey).then((sh) => {
      if (!sh || this.disposed) return;
      this.sheet = sh;
      this.tex = useSheet(this.sprite, sh, this.height);
    });
  }

  update(dir: number, camYaw: number, moving: boolean, t: number) {
    if (this.sheet) {
      const rel = relAngle(dir, camYaw), a = Math.abs(rel);
      const view = a <= Math.PI / 3 ? 0 : a >= (Math.PI * 2) / 3 ? 2 : 1;
      const mirror = view === 1 && rel < 0;
      this.tex.repeat.x = (mirror ? -1 : 1) / this.sheet.views;
      this.tex.offset.x = (view + (mirror ? 1 : 0)) / this.sheet.views;
      const tt = t + this.phase;
      // slimes/fish hop when moving, everything squashes gently while idle
      const hop = moving && this.hop ? Math.abs(Math.sin(tt * 7)) * 0.25 : moving ? Math.abs(Math.sin(tt * 9)) * 0.05 : 0;
      const squash = 1 + Math.sin(tt * (moving ? 14 : 3)) * (moving && this.hop ? 0.06 : 0.025);
      this.sprite.scale.y = this.height * squash;
      this.sprite.scale.x = (this.height * this.sheet.cellW) / this.sheet.cellH / squash;
      this.sprite.center.y = -hop / this.height;
      return;
    }
    this.tex.offset.x = Math.floor((t + this.phase) * (moving ? 6 : 2)) % 2 ? 0.5 : 0;
  }

  dispose() {
    this.disposed = true;
    this.tex.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
}
