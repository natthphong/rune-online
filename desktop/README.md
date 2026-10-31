# Runebound Legacy — desktop builds

One app that contains the game server and the game client. Start it and the game window opens; no browser, Node,
Postgres or Redis needed in the default mode.

| File | For |
|---|---|
| `RuneboundLegacy-<ver>-mac-arm64.dmg` | Mac with Apple Silicon (M1 and newer) |
| `RuneboundLegacy-<ver>-mac-x64.dmg` | Intel Mac |
| `RuneboundLegacy-<ver>-win-x64.exe` | Windows 10/11 installer |
| `RuneboundLegacy-<ver>-portable.exe` | Windows, no install (run it from any folder) |

## Install

The builds are **not code-signed**, so the OS warns the first time.

**macOS**
1. Open the `.dmg` and drag **Runebound Legacy** into **Applications**.
2. In Applications, **right-click** (or Control-click) the app → **Open** → **Open**.
   On macOS 15 (Sequoia) and newer, if there is no Open button: try to open it once, then go to
   **System Settings → Privacy & Security**, scroll down to *"Runebound Legacy was blocked"* and click **Open Anyway**.
3. If macOS says the app *"is damaged and can't be opened"* (quarantine flag on unsigned downloads), run once in Terminal:
   `xattr -dr com.apple.quarantine "/Applications/Runebound Legacy.app"`

**Windows**
1. Run `RuneboundLegacy-<ver>-win-x64.exe` (or the portable `.exe`).
2. SmartScreen shows *"Windows protected your PC"* → click **More info** → **Run anyway**.
3. The installer lets you pick the folder; it adds a Start-menu shortcut.

## Modes

**Simple (default)** — nothing to set up. The app runs an embedded PostgreSQL ([PGlite](https://pglite.dev), real
Postgres compiled to WebAssembly) with its files in your data folder, and keeps login sessions in memory. The server
listens on `127.0.0.1` only (this computer), on the first free port in 2680–2689. Create an account on the login screen
and play. Restarting the app keeps your accounts and characters; you just log in again.

**Install** — the app connects to an existing PostgreSQL + Redis (e.g. a home server for friends). Create a file named
`runebound.env` next to the app (the folder that contains `Runebound Legacy.app`, or the folder of the `.exe`) or in the
data folder, based on [`runebound.env.example`](runebound.env.example):

```
RO_STORE=postgres
DATABASE_URL=postgres://user:password@host:5432/home
REDIS_URL=redis://host:6379
PORT=2680
```

In install mode the server listens on all interfaces (`HOST=0.0.0.0`), so others on your network can play at
`http://<your-ip>:<PORT>/` in a browser. Tables go in the schema `DB_SCHEMA` (default `ro`), created and migrated on start.
Real environment variables override the file.

Menu **Game → Open in Browser** opens the same game in your browser; **Game → Open Data Folder** shows where data lives.

## Where data is stored

| OS | Data folder |
|---|---|
| macOS | `~/Library/Application Support/Runebound Legacy/` |
| Windows | `%APPDATA%\Runebound Legacy\` |

Inside: `pgdata/` (the simple-mode database: accounts, characters, items, quests), `server.log` (server output, read this
when something fails), browser caches and settings (window layout, language).

**Reset** (start over with no accounts): quit the app and delete the `pgdata` folder (or the whole data folder to also
reset settings). Uninstalling does not delete the data folder. Back up by copying `pgdata` while the app is closed.
Only one copy of the app runs at a time (a second launch focuses the first window).

## เริ่มเล่นแบบเร็ว (ภาษาไทย)

ไฟล์ที่ต้องโหลด: Mac ชิป Apple (M1 ขึ้นไป) ใช้ `…-mac-arm64.dmg`, Mac Intel ใช้ `…-mac-x64.dmg`,
Windows ใช้ `…-win-x64.exe` (ตัวติดตั้ง) หรือ `…-portable.exe` (ไม่ต้องติดตั้ง เปิดจากโฟลเดอร์ไหนก็ได้)

**ติดตั้งบน Mac**
1. เปิดไฟล์ `.dmg` แล้วลาก **Runebound Legacy** ไปไว้ใน **Applications**
2. แอปนี้ไม่ได้เซ็นรับรองกับ Apple (unsigned) ครั้งแรก macOS (Gatekeeper) จะเตือน ให้ **คลิกขวา** ที่แอป → **Open** → **Open**
3. macOS 15 (Sequoia) ขึ้นไป ถ้าไม่มีปุ่ม Open: ลองเปิดแอปหนึ่งครั้ง แล้วไปที่ **System Settings → Privacy & Security**
   เลื่อนลงหา *"Runebound Legacy was blocked"* แล้วกด **Open Anyway**
4. ถ้าขึ้นว่าแอป *"is damaged and can't be opened"* ให้เปิด Terminal แล้วรันครั้งเดียว:
   `xattr -dr com.apple.quarantine "/Applications/Runebound Legacy.app"`

**ติดตั้งบน Windows**
1. ดับเบิลคลิก `…-win-x64.exe` (หรือ `…-portable.exe`)
2. Windows SmartScreen จะขึ้น *"Windows protected your PC"* ให้กด **More info** → **Run anyway**
   (เตือนเพราะไฟล์ไม่ได้เซ็นรับรอง ไม่ใช่ไวรัส)
3. ตัวติดตั้งให้เลือกโฟลเดอร์ได้ และจะสร้างทางลัดใน Start menu

**เล่น**: เปิดแอปแล้วหน้าเกมขึ้นเอง กด *Create account* สร้างบัญชี แล้วสร้างตัวละครได้เลย ไม่ต้องลงฐานข้อมูลอะไรเพิ่ม
(โหมด simple: ฐานข้อมูลฝังอยู่ในแอป เล่นได้เฉพาะเครื่องนี้) ปิดแอปแล้วเปิดใหม่ ตัวละครยังอยู่ แค่ต้องล็อกอินใหม่
ถ้าอยากต่อ PostgreSQL + Redis ของตัวเองให้เพื่อนในวง LAN เข้ามาเล่นด้วย ดูหัวข้อ *Modes → Install* ด้านบน

**ข้อมูลเก็บที่ไหน**
- Mac: `~/Library/Application Support/Runebound Legacy/`
- Windows: `%APPDATA%\Runebound Legacy\`
- หรือเปิดจากเมนู **Game → Open Data Folder** ในแอป
- ในนั้นมี `pgdata/` (บัญชี ตัวละคร ไอเท็ม เควสต์) และ `server.log` (ดูเมื่อแอปเปิดไม่ขึ้น)

**รีเซ็ต (เริ่มใหม่หมด)**: ปิดแอปก่อน แล้วลบโฟลเดอร์ `pgdata` (ถ้าลบทั้งโฟลเดอร์ข้อมูล การตั้งค่าหน้าจอ/ภาษาจะหายด้วย)
การถอนการติดตั้งไม่ลบโฟลเดอร์ข้อมูล อยากสำรองข้อมูลให้ปิดแอปแล้วก๊อปโฟลเดอร์ `pgdata` เก็บไว้

## Building (developers)

From `ro/desktop` on macOS (Node ≥ 22, pnpm 12):

```bash
pnpm install                    # electron, electron-builder, esbuild (standalone workspace, not part of ro/)
node build.mjs                  # pnpm build (client) + esbuild server bundle + migrations/data/PGlite -> stage/game
pnpm start                      # run the staged app in Electron (needs node node_modules/electron/install.js once)
npx electron-builder --mac dmg --arm64   # -> dist/*.dmg   (also --x64)
npx electron-builder --win nsis portable --x64   # -> dist/*.exe (cross-builds on macOS, no Wine needed)
```

The version is `version` in `../package.json` (the only place to change it; `build.mjs` copies it into this package).
CI: `.github/workflows/desktop.yml` builds the `.dmg` (arm64 + x64) and `.exe` (NSIS + portable) on a tag push (`v*`, `2.*`)
and attaches them to the GitHub Release, after a `windows-smoke` job (also manual) that runs the bundled server with plain
`node` in simple mode on Windows and plays the smoke + quest bots against it.

`build.mjs --skip-client` reuses an existing `../client/dist`. `RO_USER_DATA=<dir>` makes the app use another data folder
(tests, a second profile). The same server code runs everywhere: `RO_STORE=pglite` (desktop simple mode) swaps
`pg.Pool` for PGlite's node-postgres connection and Redis for an in-memory stand-in (`server/src/db.ts`, `server/src/redis.ts`);
the default `RO_STORE=postgres` is the dev/production path.
