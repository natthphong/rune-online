# Rune Online (Runebound Legacy)

A fan-made, educational, **non-commercial** 2.5D web MMORPG in the spirit of classic click-to-move MMOs.
It is **not affiliated with, endorsed by or connected to Gravity Co., Ltd.** or the Ragnarok Online franchise.
The repository ships **no Ragnarok assets**: every sprite, texture, icon, sound, map, name and story is original or
from a permissively licensed pack (see [assets/CREDITS.md](assets/CREDITS.md)). Combat formulas and data tables are
re-implemented from the open-source [rAthena](https://github.com/rathena/rathena) emulator (GPL-3.0), which is why this
project is licensed GPL-3.0 too. All monster, item, skill and place names are our own.

Stack: TypeScript, Three.js + Vite client, Colyseus authoritative server, PostgreSQL, Redis.

## What is in the game

- The Tower, floors 1 and 2: rest town, hunting fields, a dungeon with a boss, a floor guardian.
- Job tree: Novice, six first jobs, 2nd and transcendent jobs, with skills and stat/skill points.
- Quests with NPC scripted dialogs, a quest log and tracker with click-to-auto-walk.
- Auto mode (hunt, loot, return to town), parties, friends, chat.
- Pets, cards that slot into gear, refining and gear grades (common to legendary), shops and loot.
- Duel (player versus player), bosses with their own moves.
- English and Thai UI.

## Play

Download the latest `.dmg` (macOS) or `.exe` (Windows) from the
[GitHub Releases](https://github.com/natthphong/rune-online/releases) page. The builds are not code-signed, so
macOS Gatekeeper and Windows SmartScreen will warn on first launch: see [desktop/README.md](desktop/README.md)
for the exact steps to open them.

## Run from source

Requirements: **Node.js 22.18 or newer**, **pnpm 12** (via corepack), **PostgreSQL 14+** and **Redis 6+**.
The easiest way to get the two databases is Docker (install Docker Desktop, it works the same on Mac and Windows):

```bash
docker run -d --name rune-pg    -p 5432:5432 -e POSTGRES_USER=rune -e POSTGRES_PASSWORD=rune -e POSTGRES_DB=rune postgres:16-alpine
docker run -d --name rune-redis -p 6379:6379 redis:7-alpine
```

### macOS

```bash
brew install node@22            # or use nvm/fnm; check with: node -v  (>= 22.18)
corepack enable && corepack prepare pnpm@12.14.0 --activate
git clone https://github.com/natthphong/rune-online.git && cd rune-online
cp .env.example .env            # defaults already match the Docker one-liners above
pnpm install
pnpm dev                        # server :2567 + Vite client :5173
```

### Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS      # then open a NEW terminal; node -v must be >= 22.18
corepack enable
corepack prepare pnpm@12.14.0 --activate
git clone https://github.com/natthphong/rune-online.git
cd rune-online
Copy-Item .env.example .env
pnpm install
pnpm dev
```

Open <http://localhost:5173>, register an account, create a character and play. Database tables are created
automatically on first start (`server/migrations`). If you prefer not to use Docker, install PostgreSQL and
Redis natively and point `DATABASE_URL` / `REDIS_URL` in `.env` at them.

## Docker (one-command self-host)

```bash
docker compose up --build        # postgres + redis + game, then open http://localhost:2567
```

The root `Dockerfile` builds the client and serves it from the game server on one port; `compose.yml` adds Postgres
and Redis. Change the passwords in `compose.yml` before exposing it to the internet.

## Tests

```bash
pnpm -r typecheck                          # TypeScript, both packages
pnpm test                                  # golden tests of the rules (no database needed)
pnpm build                                 # production client build
pnpm --filter client smoke http://localhost:2567   # headless 2-bot multiplayer check against a running server
```

More end-to-end bots live in `client/scripts/` (`items`, `quest`, `dungeon`, `floor2`, `pets`, `cards`, `duel`, ...), each
runnable as `pnpm --filter client <name> [url]`. Each bot registers its own test accounts, and the server allows only a
few registrations per hour from one address: when you run many bots, start the server with `REGISTER_PER_HOUR=1000`.

## Layout

`shared/` rules, data and content used by both sides · `server/` authoritative simulation · `client/` Vite + Three.js ·
`desktop/` desktop wrapper (if present) · [DESIGN.md](DESIGN.md) design notes.

## License

GPL-3.0, see [LICENSE](LICENSE). Art and audio credits: [assets/CREDITS.md](assets/CREDITS.md).

---

## ภาษาไทย (สรุป)

โปรเจกต์แฟนเมดเพื่อการศึกษา ไม่แสวงหากำไร ไม่เกี่ยวข้องกับ Gravity และไม่มีไฟล์ใดของ Ragnarok Online อยู่ในรีโป
(ภาพ เสียง ชื่อ และเนื้อเรื่องเป็นของเราเองทั้งหมด สูตรและข้อมูลอิงจาก rAthena ซึ่งเป็น GPL-3.0)

- **เล่นเลย:** ดาวน์โหลด `.dmg` (Mac) หรือ `.exe` (Windows) จากหน้า Releases แล้วดู `desktop/README.md` สำหรับวิธีเปิดไฟล์ที่ยังไม่ได้เซ็น
- **รันจากซอร์ส:** ติดตั้ง Node 22.18+, pnpm (corepack), Postgres และ Redis (ใช้ Docker ตามคำสั่งด้านบนได้) แล้ว `cp .env.example .env`, `pnpm install`, `pnpm dev` เปิด http://localhost:5173
- **Docker:** `docker compose up --build` แล้วเปิด http://localhost:2567
