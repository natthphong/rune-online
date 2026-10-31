// Runebound Legacy desktop launcher (Electron main process).
// Starts the bundled game server inside this process on a free localhost port, then opens the game in a window.
//   simple  (default): RO_STORE=pglite, embedded Postgres in <userData>/pgdata, sessions in memory. Zero setup.
//   install          : RO_STORE=postgres, your own Postgres + Redis (DATABASE_URL, REDIS_URL) from runebound.env.
// runebound.env (KEY=VALUE lines) is read from the folder next to the app, then from <userData>; real env vars win.
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TITLE = "Runebound Legacy";
app.setName(TITLE);
if (!app.requestSingleInstanceLock()) app.quit(); // one server per data folder: PGlite allows a single writer

if (process.env.RO_USER_DATA) app.setPath("userData", path.resolve(process.env.RO_USER_DATA)); // tests / a second profile
const userData = app.getPath("userData");
mkdirSync(userData, { recursive: true });
const logFile = path.join(userData, "server.log");
for (const level of ["log", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    orig(...a);
    try { appendFileSync(logFile, `${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`); } catch {}
  };
}

// Folder that holds the app: Foo.app's parent on macOS, the .exe's folder on Windows (portable exe: where the user put it).
function appFolder() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  const exe = app.getPath("exe");
  return process.platform === "darwin" ? path.resolve(exe, "../../../..") : path.dirname(exe);
}

function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const portFree = (port, host) => new Promise((resolve) => {
  const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
  s.listen(port, host);
});
async function pickPort(host) {
  for (let p = 2680; p <= 2689; p++) if (await portFree(p, host)) return p;
  return await new Promise((resolve) => { const s = net.createServer().listen(0, host, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

let serverUrl = "";
let win = null;

async function startServer() {
  const game = app.isPackaged ? path.join(process.resourcesPath, "game") : path.join(import.meta.dirname, "stage", "game");
  const fileCfg = { ...readEnvFile(path.join(userData, "runebound.env")), ...readEnvFile(path.join(appFolder(), "runebound.env")) };
  const cfg = { ...fileCfg, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k in fileCfg || ["RO_STORE", "DATABASE_URL", "REDIS_URL", "PORT", "HOST"].includes(k))) };
  const store = cfg.RO_STORE || (cfg.DATABASE_URL ? "postgres" : "pglite");
  const host = cfg.HOST || (store === "pglite" ? "127.0.0.1" : "0.0.0.0");
  const port = cfg.PORT ? Number(cfg.PORT) : await pickPort(host === "0.0.0.0" ? undefined : host);
  Object.assign(process.env, cfg, {
    NODE_ENV: "production",
    GAME_NAME: cfg.GAME_NAME || "ro",
    RO_STORE: store,
    PGLITE_DIR: cfg.PGLITE_DIR || path.join(userData, "pgdata"),
    PUBLIC_DIR: path.join(game, "public"),
    PORT: String(port),
    HOST: host,
  });
  console.log(`[desktop] ${TITLE} ${app.getVersion()} store=${store} port=${port} data=${store === "pglite" ? process.env.PGLITE_DIR : "(external)"}`);
  await import(pathToFileURL(path.join(game, "server", "src", "index.mjs")).href);
  serverUrl = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(serverUrl + "health")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the game server did not answer /health");
}

function openWindow() {
  win = new BrowserWindow({ width: 1366, height: 820, minWidth: 960, minHeight: 600, title: TITLE, backgroundColor: "#101418", autoHideMenuBar: true });
  win.loadURL(serverUrl);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.on("closed", () => { win = null; });
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
  { label: "Game", submenu: [
    { label: "Open in Browser", click: () => serverUrl && shell.openExternal(serverUrl) },
    { label: "Open Data Folder", click: () => shell.openPath(userData) },
    { type: "separator" },
    { role: "reload" }, { role: "toggleDevTools" }, { role: "togglefullscreen" },
    { type: "separator" },
    { role: "quit" },
  ] },
  { role: "editMenu" },
]));

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
// Quit = the server's own graceful shutdown (Colyseus listens for SIGTERM: rooms save their players, the DB closes cleanly),
// which ends with process.exit; the timer is a fallback if it hangs.
let quitting = false;
app.on("before-quit", (e) => {
  if (!serverUrl || quitting) return;
  quitting = true;
  e.preventDefault();
  setTimeout(() => app.exit(0), 8000).unref();
  process.emit("SIGTERM");
});
app.on("activate", () => { if (!win && serverUrl) openWindow(); });

app.whenReady().then(async () => {
  try {
    await startServer();
    openWindow();
  } catch (e) {
    console.error("[desktop] start failed", e);
    dialog.showErrorBox(TITLE, `The game server could not start:\n\n${e?.stack || e}\n\nLog: ${logFile}`);
    app.exit(1);
  }
});
