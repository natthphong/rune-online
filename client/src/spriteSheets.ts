// Generated sprite sheets (tools/art/build_ro.py -> public/sprites): horizontal strips of views, one cell each.
// Monsters / NPCs: 3 views (front, side, back). (Players are 3D avatars: avatar.ts.)

export type Sheet = { canvas: HTMLCanvasElement; views: number; cellW: number; cellH: number };

const index: Promise<Set<string>> = fetch("/sprites/index.json").then((r) => r.json()).then((a: string[]) => new Set(a)).catch(() => new Set());
const raw = new Map<string, Promise<{ img: HTMLImageElement; meta: { views: number; cellW: number; cellH: number }; hair?: HTMLImageElement } | null>>();
const built = new Map<string, Promise<Sheet | null>>();

const loadImg = (url: string) => new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });

function loadRaw(key: string, withHair: boolean) {
  if (!raw.has(key)) {
    raw.set(key, (async () => {
      if (!(await index).has(key)) return null;
      const [img, meta, hair] = await Promise.all([
        loadImg(`/sprites/${key}.png`), fetch(`/sprites/${key}.json`).then((r) => r.json()),
        withHair ? loadImg(`/sprites/${key}_hair.png`).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      return { img, meta, hair };
    })().catch(() => null));
  }
  return raw.get(key)!;
}

/** Monster / NPC sheet (no recolouring). */
export function plainSheet(key: string): Promise<Sheet | null> {
  if (!built.has(key)) {
    built.set(key, loadRaw(key, false).then((r) => {
      if (!r) return null;
      const cv = document.createElement("canvas");
      cv.width = r.img.width; cv.height = r.img.height;
      cv.getContext("2d")!.drawImage(r.img, 0, 0);
      return { canvas: cv, ...r.meta };
    }));
  }
  return built.get(key)!;
}

/** Draw one view of a sheet into a 2D canvas (character select / make character previews). */
export function drawSheetView(g: CanvasRenderingContext2D, s: Sheet, view: number, mirror: boolean, w: number, h: number) {
  const k = Math.min(w / s.cellW, (h - 6) / s.cellH);
  const dw = s.cellW * k, dh = s.cellH * k;
  g.save();
  g.translate(w / 2, h - 3 - dh);
  if (mirror) g.scale(-1, 1);
  g.drawImage(s.canvas, view * s.cellW, 0, s.cellW, s.cellH, -dw / 2, 0, dw, dh);
  g.restore();
}
