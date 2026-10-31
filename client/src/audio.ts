// Tiny SFX bus: files live in client/public/audio/sfx/<name>.mp3 (added with tools/audio/sfx.py).
// Browsers block audio until the first user gesture; the login click counts, so call unlock() from it.
const cache = new Map<string, HTMLAudioElement>();
let unlocked = false;
let master = 0.5;
try { master = Number(localStorage.getItem("ro.volume") ?? 0.5); } catch { /* ignore */ }

export function unlock() { unlocked = true; }
export function getVolume() { return master; }
export function setVolume(v: number) {
  master = v;
  try { localStorage.setItem("ro.volume", String(v)); } catch { /* ignore */ }
}

export function play(_kind: "sfx", name: string, volume = 1) {
  if (!unlocked || master <= 0) return;
  const url = `/audio/sfx/${name}.mp3`;
  let base = cache.get(url);
  if (!base) { base = new Audio(url); base.preload = "auto"; cache.set(url, base); }
  const a = base.cloneNode() as HTMLAudioElement; // overlapping hits need separate elements
  a.volume = Math.min(1, master * volume);
  a.play().catch(() => {}); // missing file: stay silent
}

// ---- Music channel (separate from the SFX bus): client/public/audio/music/<scene>.mp3, looped, crossfaded ----
// Scene = login/select screens -> "login"; in game -> the current map's track (shared/maps.ts MAP_INFO[map].music: town, field,
// forest, highland, ruins; W01). Starts after the first gesture.
export type MusicScene = string;
const MUSIC_GAIN = 0.7; // tracks are mastered to about -18 LUFS; the slider's top end stays comfortable
const FADE_MS = 1500;
let musicVol = 0.4;
let musicMuted = false;
try {
  musicVol = Number(localStorage.getItem("ro.music") ?? 0.4);
  musicMuted = localStorage.getItem("ro.musicMute") === "1";
} catch { /* ignore */ }
let gestured = false;
let mapScene: MusicScene = "login";
let cur: { scene: MusicScene; el: HTMLAudioElement } | undefined;

const musicLevel = () => (musicMuted ? 0 : Math.min(1, musicVol * MUSIC_GAIN));
export function getMusicVolume() { return musicVol; }
export function isMusicMuted() { return musicMuted; }
export function setMusicVolume(v: number) {
  musicVol = v;
  try { localStorage.setItem("ro.music", String(v)); } catch { /* ignore */ }
  applyMusicLevel();
}
export function setMusicMuted(m: boolean) {
  musicMuted = m;
  try { localStorage.setItem("ro.musicMute", m ? "1" : "0"); } catch { /* ignore */ }
  applyMusicLevel();
}
function applyMusicLevel() { if (cur) cur.el.volume = musicLevel(); }

function fade(el: HTMLAudioElement, to: number, done?: () => void) {
  const from = el.volume, t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / FADE_MS);
    el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
    if (k < 1) setTimeout(step, 50); else done?.();
  };
  step();
}

function wantedScene(): MusicScene {
  return document.body.dataset.screen === "game" ? mapScene : "login";
}

// Tracks are 1.5-2 MB each: wait a moment after a scene change so sprites/props get the browser's few connections first.
// Rapid changes (warp chains) collapse into one start for the scene that is wanted when the timer fires.
const MUSIC_DELAY_MS = 1500;
let musicTimer: ReturnType<typeof setTimeout> | undefined;
function syncMusic() {
  if (!gestured || musicTimer !== undefined) return;
  if (cur?.scene === wantedScene()) return;
  musicTimer = setTimeout(() => { musicTimer = undefined; startMusic(); }, MUSIC_DELAY_MS);
}

function startMusic() {
  const want = wantedScene();
  if (cur?.scene === want) return;
  const old = cur;
  if (old) fade(old.el, 0, () => { old.el.pause(); old.el.src = ""; });
  const el = new Audio(`/audio/music/${want}.mp3`);
  el.loop = true;
  el.volume = 0;
  cur = { scene: want, el };
  el.play().then(() => fade(el, musicLevel())).catch(() => { if (cur?.el === el) cur = undefined; }); // missing file / blocked: stay silent
}

/** The map the character is on changed (main.ts loadMap): play its track (client/public/audio/music/<track>.mp3). */
export function setMusicMap(track: string) { mapScene = track; syncMusic(); }

function firstGesture() {
  gestured = true;
  removeEventListener("pointerdown", firstGesture, true);
  removeEventListener("keydown", firstGesture, true);
  syncMusic();
}
if (typeof window !== "undefined") {
  addEventListener("pointerdown", firstGesture, true);
  addEventListener("keydown", firstGesture, true);
  // screen changes (login -> select -> game) flip body[data-screen]
  new MutationObserver(syncMusic).observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });
}
