import { play } from "../audio.ts";

// RO-style floating windows: drag by the title bar, positions remembered per browser,
// [data-close] hides, [data-min] (or a double-click on the title bar) toggles the window's mini view — the body collapses,
// or a window styles its own `.minimized` look (Basic Info). [data-expand] (a button anywhere in the window) toggles the
// window's `.expanded` class — the section the window's CSS reveals (Status "Details") — and remembers it per browser.
// Markup: <section class="win" id="w-x"><header class="win-title">…
const KEY = "ro.ui.pos.";
const MIN_KEY = "ro.ui.min.";
const EXP_KEY = "ro.ui.exp.";

function load(id: string): { x: number; y: number } | undefined {
  try { return JSON.parse(localStorage.getItem(KEY + id) ?? "null") ?? undefined; } catch { return undefined; }
}
function store(id: string, x: number, y: number) {
  try { localStorage.setItem(KEY + id, JSON.stringify({ x, y })); } catch { /* private mode */ }
}

function clamp(win: HTMLElement) {
  const r = win.getBoundingClientRect();
  const x = Math.min(Math.max(0, r.left), innerWidth - Math.min(r.width, 80));
  const y = Math.min(Math.max(0, r.top), innerHeight - 24);
  win.style.left = `${x}px`; win.style.top = `${y}px`;
  win.style.right = "auto"; win.style.bottom = "auto";
}

export function initWindows(root: HTMLElement) {
  for (const win of root.querySelectorAll<HTMLElement>(".win[id]")) {
    const saved = load(win.id);
    if (saved) {
      win.style.left = `${saved.x}px`; win.style.top = `${saved.y}px`;
      win.style.right = "auto"; win.style.bottom = "auto";
    }
    const bar = win.querySelector<HTMLElement>(".win-title");
    bar?.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      const r = win.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      raise(win);
      const move = (ev: PointerEvent) => {
        win.style.left = `${ev.clientX - ox}px`; win.style.top = `${ev.clientY - oy}px`;
        win.style.right = "auto"; win.style.bottom = "auto";
      };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        clamp(win);
        store(win.id, parseFloat(win.style.left), parseFloat(win.style.top));
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up, { once: true });
    });
    win.addEventListener("pointerdown", () => raise(win));
    win.querySelector("[data-close]")?.addEventListener("click", () => toggle(win, false));
    const min = win.querySelector("[data-min]");
    if (min) {
      try { win.classList.toggle("minimized", localStorage.getItem(MIN_KEY + win.id) === "1"); } catch { /* private mode */ }
      min.addEventListener("click", () => setMinimized(win));
      bar?.addEventListener("dblclick", (e) => { if (!(e.target as HTMLElement).closest("button")) setMinimized(win); });
    }
    const more = win.querySelector("[data-expand]");
    if (more) {
      let open = false;
      try { open = localStorage.getItem(EXP_KEY + win.id) === "1"; } catch { /* private mode */ }
      setExpanded(win, open, false);
      more.addEventListener("click", () => { setExpanded(win); play("sfx", "click", 0.35); });
    }
  }
  addEventListener("resize", () => root.querySelectorAll<HTMLElement>(".win[id]").forEach((w) => { if (w.style.left) clamp(w); }));
}

let z = 10;
function raise(win: HTMLElement) { win.style.zIndex = String(++z); }

export function toggle(win: HTMLElement, show = win.hidden) {
  if (win.hidden === !show) return;
  win.hidden = !show;
  if (show) raise(win);
  play("sfx", show ? "ui_open" : "ui_close", 0.6);
}

/** Toggle (or set) a window's mini view and remember it per browser. */
export function setMinimized(win: HTMLElement, on = !win.classList.contains("minimized")) {
  win.classList.toggle("minimized", on);
  try { localStorage.setItem(MIN_KEY + win.id, on ? "1" : "0"); } catch { /* private mode */ }
}

/** Toggle (or set) a window's expander and remember it per browser. `remember` is off for the initial restore. */
export function setExpanded(win: HTMLElement, on = !win.classList.contains("expanded"), remember = true) {
  win.classList.toggle("expanded", on);
  win.querySelector("[data-expand]")?.setAttribute("aria-expanded", String(on));
  if (remember) try { localStorage.setItem(EXP_KEY + win.id, on ? "1" : "0"); } catch { /* private mode */ }
}

export function resetWindowPositions(root: HTMLElement) {
  for (const win of root.querySelectorAll<HTMLElement>(".win[id]")) {
    try { localStorage.removeItem(KEY + win.id); localStorage.removeItem(MIN_KEY + win.id); localStorage.removeItem(EXP_KEY + win.id); } catch { /* ignore */ }
    win.style.left = win.style.top = win.style.right = win.style.bottom = "";
    win.classList.remove("minimized");
    if (win.querySelector("[data-expand]")) setExpanded(win, false, false);
  }
}
