// RO-style PAPER DOLL (ro/docs/DESIGN-paperdoll.md). A character is separate sprites pinned to per-frame anchors:
//   headless BODY per outfit (sheets `walk` 8 frames, `act` = stand, sit, hurt, dead, swing x4; rows = 5 facings)
//   HEAD per hair style x gender (face + hair, 5 views; row 1 = hair that hangs behind the shoulders in the front views)
//   headgear / garment strips (5 views, origin = skull centre), WEAPON (profile + toward-viewer view, origin = grip), shield.
// Every body cell carries its anchors (tools/art/pd_build.py measured them from the art; the pose itself is code:
// tools/art/pd_rig.py): [headX, headY, r, rot, handRx, handRy, wdeg, wlen, wfront, handLx, handLy, handLfront, handRfront].
// A part is drawn at `body.anchor - part.origin` and nothing else: no per-item offsets, no per-style constants.
// tools/art/pd_compose.py is the Python twin of drawPd (the QA gate composites with it): keep the two in step.
import { HAIR_COLORS, HAIR_STYLES, pdBodyOf, type Look } from "../../shared/look.ts";

export type PdStrip = { views: number; cellW: number; cellH: number; ox: number; oy: number; r: number };
type WeaponView = { x: number; y: number; w: number; h: number; gx: number; gy: number };
export type PdIndex = {
  unit: number;
  bodies: Record<string, { rows: number; facings: string[] }>;
  heads: Record<string, PdStrip>;
  weapons: Record<string, { views: WeaponView[]; swing: number }>;
  gear: Record<string, PdStrip | { w: number; h: number }>;
};
export type PdMeta = { rows: number; cols: number; cellW: number; cellH: number; unit: number; gx: number; gy: number; a: number[][]; stride?: number };
type Img = CanvasImageSource & { width: number; height: number };
export type PdSheet = { img: Img; meta: PdMeta };
export type PdLook = {
  walk: PdSheet; act: PdSheet;
  head: { img: Img; m: PdStrip };
  weapon?: { img: Img; views: WeaponView[]; swing: number };
  top?: { img: Img; m: PdStrip }; garment?: { img: Img; m: PdStrip }; shield?: { img: Img };
};

/** decode() moves the PNG decode off the first frame that draws it (an undecoded image makes drawImage block on it) */
export const loadImg = (url: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const i = new Image(); i.onerror = fail; i.src = url;
  i.decode().then(() => ok(i), () => { i.onload = () => ok(i); if (i.complete) ok(i); });
});
const jsonCache = new Map<string, Promise<any>>();
export const getJson = (url: string) => { if (!jsonCache.has(url)) jsonCache.set(url, fetch(url).then((r) => r.json())); return jsonCache.get(url)!; };

/** Hair dye, the ONE path every hair in the game goes through: `overlay` of the colour on the grey hair pixels (the mask), which
 *  keeps the painted shading; everything else is untouched. pd_build.py gives every head's grey ramp the same mean, so one dye
 *  is one colour on every style. */
export function dye(base: Img, mask: Img, color: string) {
  const out = document.createElement("canvas");
  out.width = base.width; out.height = base.height;
  const o = out.getContext("2d")!;
  o.drawImage(base, 0, 0);
  const h = document.createElement("canvas");
  h.width = base.width; h.height = base.height;
  const g = h.getContext("2d")!;
  g.drawImage(base, 0, 0);
  g.globalCompositeOperation = "destination-in"; g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = "overlay"; g.fillStyle = color; g.fillRect(0, 0, h.width, h.height);
  g.globalCompositeOperation = "destination-in"; g.drawImage(mask, 0, 0);
  o.drawImage(h, 0, 0);
  return out;
}

/** A 2nd / transcendent job wears its first job's body with the CLOTH turned by `hue` degrees (brighter for a transcendent job)
 *  until it has art of its own. The body is headless, so no face can be recoloured; hands keep their skin tone (warm, light). */
export function tintBody(base: Img, hue: number, bright: boolean) {
  const out = document.createElement("canvas");
  out.width = base.width; out.height = base.height;
  const o = out.getContext("2d", { willReadFrequently: true })!;
  o.drawImage(base, 0, 0);
  const px = o.getImageData(0, 0, out.width, out.height), d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dl = mx - mn;
    if (dl < 0.08) continue; // greys, black outlines, white
    const sat = dl / (1 - Math.abs(2 * l - 1));
    let h = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
    h *= 60; if (h < 0) h += 360;
    if (h >= 10 && h <= 40 && l > 0.62 && sat < 0.85) continue; // skin
    h = (h + hue) % 360;
    const s2 = bright ? Math.min(1, sat * 1.2) : sat, l2 = bright ? Math.min(0.92, l * 1.12) : l;
    const c = (1 - Math.abs(2 * l2 - 1)) * s2, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m0 = l2 - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    d[i] = (r1 + m0) * 255; d[i + 1] = (g1 + m0) * 255; d[i + 2] = (b1 + m0) * 255;
  }
  o.putImageData(px, 0, 0);
  return out;
}

const DIR = "/sprites/pd/";
export const pdIndex: Promise<PdIndex | null> = fetch(`${DIR}index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const cache = new Map<string, Promise<any>>();
const once = <T>(key: string, make: () => Promise<T>): Promise<T> => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key)!; };

/** Hair style index -> head id, per gender (characters.hairdo maps 1:1; a style without art falls back to Classic). */
export const headKey = (ix: PdIndex, gender: string, style: number) => {
  const k = `head_${gender}_${HAIR_STYLES[style]?.key || "classic"}`;
  return ix.heads[k] ? k : ix.heads[`head_${gender}_classic`] ? `head_${gender}_classic` : null;
};
/** The body sheets key of a look (`body_F_swordman`). A body counts only when ALL of its art exists (both sheets, 5 facings); a job
 *  whose body is missing wears the Fledgling's (shared/rules/paperdoll.test.ts keeps every starting job complete). */
export function bodyKey(ix: PdIndex, look: Look) {
  const ok = (key: string) => ix.bodies[`${key}_walk`]?.rows === 5 && ix.bodies[`${key}_act`]?.rows === 5;
  const key = `body_${look.gender}_${pdBodyOf(look.job ?? "Novice").body}`;
  return ok(key) ? key : ok(`body_${look.gender}_novice`) ? `body_${look.gender}_novice` : null;
}

function head(key: string, color: string): Promise<Img> {
  return once(`${key}|${color}`, async () => {
    const [img, mask] = await Promise.all([loadImg(`${DIR}${key}.png`), loadImg(`${DIR}${key}_hair.png`)]);
    return dye(img, mask, color);
  });
}
function body(key: string, hue: number, bright: boolean): Promise<PdSheet> {
  return once(`${key}@${hue}${bright}`, async () => {
    const [img, meta] = await Promise.all([loadImg(`${DIR}${key}.png`), getJson(`${DIR}${key}.json`) as Promise<PdMeta>]);
    return { img: hue || bright ? tintBody(img, hue, bright) : img, meta };
  });
}
const plain = (key: string): Promise<Img> => once(key, () => loadImg(`${DIR}${key}.png`));

/** Every part of a look, loaded; null when this look has no (complete) paper-doll art. Nothing is returned half loaded. */
export async function loadPd(look: Look): Promise<PdLook | null> {
  const ix = await pdIndex;
  if (!ix) return null;
  const bk = bodyKey(ix, look), hk = headKey(ix, look.gender, look.style ?? 0);
  if (!bk || !hk) return null;
  const { hue, bright } = pdBodyOf(look.job ?? "Novice");
  const wk = look.weapon && ix.weapons[`weapon_${look.weapon}`] ? `weapon_${look.weapon}` : look.weapon && ix.weapons.weapon_sword ? "weapon_sword" : null;
  const gk = (slot: string, k?: string | null) => (k && ix.gear[`${slot}_${k}`] ? `${slot}_${k}` : null);
  const tk = gk("top", look.headgear), ck = gk("garment", look.garment), sk = gk("shield", look.shield);
  try {
    const [walk, act, himg, wimg, timg, cimg, simg] = await Promise.all([body(`${bk}_walk`, hue, bright), body(`${bk}_act`, hue, bright),
      head(hk, HAIR_COLORS[look.hair] ?? HAIR_COLORS[0]), wk ? plain(wk) : null, tk ? plain(tk) : null, ck ? plain(ck) : null, sk ? plain(sk) : null]);
    return {
      walk, act, head: { img: himg, m: ix.heads[hk] },
      weapon: wk && wimg ? { img: wimg, ...ix.weapons[wk] } : undefined,
      top: tk && timg ? { img: timg, m: ix.gear[tk] as PdStrip } : undefined,
      garment: ck && cimg ? { img: cimg, m: ix.gear[ck] as PdStrip } : undefined,
      shield: sk && simg ? { img: simg } : undefined,
    };
  } catch { return null; }
}

/** Which layers to draw (the dev page's exploded view turns them off one by one). */
export type PdParts = { body?: boolean; head?: boolean; weapon?: boolean; gear?: boolean };
/** Layer names in the order they were drawn (dev page / tests). */
export const lastOrder: string[] = [];

/** One frame of a paper doll: ground point at (cx, feetY), `scale` = canvas px per sheet px. */
export function drawPd(g: CanvasRenderingContext2D, pd: PdLook, sheet: "walk" | "act", col: number, row: number, mirror: boolean, scale: number,
  cx: number, feetY: number, parts: PdParts = {}) {
  const s = pd[sheet], m = s.meta, an = m.a[Math.min(row, m.rows - 1) * m.cols + Math.min(col, m.cols - 1)];
  const [hx, hy, , rot, rx, ry, wdeg, wlen, wfront, lx, ly, lfront] = an;
  lastOrder.length = 0;
  g.save();
  g.translate(cx, feetY);
  if (mirror) g.scale(-1, 1);
  g.scale(scale, scale);
  g.translate(-m.gx, -m.gy); // cell coordinates from here on
  const put = (img: Img, sx: number, sy: number, sw: number, sh: number, ox: number, oy: number, x: number, y: number, deg: number) => {
    g.save(); g.translate(x, y); if (deg) g.rotate((deg * Math.PI) / 180);
    g.drawImage(img, sx, sy, sw, sh, -ox, -oy, sw, sh); g.restore();
  };
  const strip = (name: string, p: { img: Img; m: PdStrip } | undefined, srow = 0) => {
    if (!p) return;
    put(p.img, row * p.m.cellW, srow * p.m.cellH, p.m.cellW, p.m.cellH, p.m.ox, p.m.oy, hx, hy, rot); lastOrder.push(name);
  };
  const weapon = () => {
    const w = pd.weapon;
    if (!w || parts.weapon === false || rot) return; // a body lying down (dead) holds nothing: a rigid weapon would stick up
    const v = w.views[wlen < 0.5 && w.views.length > 1 ? 1 : 0];
    const deg = -90 + ((((wdeg + 90 + 180) % 360) + 360) % 360 - 180) * w.swing + 90; // the sprite points up: turn it to the rig's angle
    put(w.img, v.x, v.y, v.w, v.h, v.gx, v.gy, rx, ry, deg + rot); lastOrder.push("weapon");
  };
  const shield = () => {
    const sh = pd.shield;
    if (!sh || parts.gear === false) return;
    put(sh.img, 0, 0, sh.img.width, sh.img.height, sh.img.width / 2, sh.img.height / 2, lx, ly, rot); lastOrder.push("shield");
  };
  const gear = parts.gear !== false, headOn = parts.head !== false;
  if (row < 2) {
    if (gear) strip("garment", pd.garment);
    if (headOn) strip("hair_back", pd.head, 1);
  }
  if (!wfront) weapon();
  if (!lfront) shield();
  if (parts.body !== false) { g.drawImage(s.img, col * m.cellW, row * m.cellH, m.cellW, m.cellH, 0, 0, m.cellW, m.cellH); lastOrder.push("body"); }
  if (row >= 2 && gear) strip("garment", pd.garment);
  // a weapon HELD low (hand under the chin: stand, walk, sit) goes under the head, so a long staff never crosses the face; a raised
  // hand (the swing) carries it over the head
  const held = ry > hy + an[2];
  if (wfront && held) weapon();
  if (headOn) strip("head", pd.head);
  if (gear) strip("top", pd.top);
  if (wfront && !held) weapon();
  if (lfront) shield();
  g.restore();
}

/** A head alone (Make Character's hair tiles: the sprite itself, no crop of a composite). Skull centre at (cx, cy). */
export async function drawHead(cv: HTMLCanvasElement, gender: string, style: number, hair: number, view = 0, scale = 1) {
  const ix = await pdIndex, hk = ix && headKey(ix, gender, style);
  if (!ix || !hk) return false;
  const img = await head(hk, HAIR_COLORS[hair] ?? HAIR_COLORS[0]), m = ix.heads[hk], g = cv.getContext("2d")!;
  g.clearRect(0, 0, cv.width, cv.height);
  g.imageSmoothingQuality = "high";
  for (const srow of [1, 0])
    g.drawImage(img, view * m.cellW, srow * m.cellH, m.cellW, m.cellH, cv.width / 2 - m.ox * scale, cv.height * 0.42 - m.oy * scale, m.cellW * scale, m.cellH * scale);
  return true;
}
