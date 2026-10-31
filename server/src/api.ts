// Account + character HTTP API (the "login/char server" half of rAthena, folded into the game server).
//   POST /api/register {username, password}        POST /api/login {username, password} -> {token}
//   POST /api/logout                               GET  /api/characters
//   POST /api/characters {slot, name, gender, hair, style?}
//   DELETE /api/characters/:id {confirmName}
// Auth: "Authorization: Bearer <token>" (Redis session, sliding 12 h). Game rooms take the same token in join options.
import express, { type Request, type Response, type NextFunction } from "express";
import { TOWN_SAVE, TOWN_START } from "../../shared/maps.ts";
import { GENDERS, HAIR_COLORS, HAIR_STYLES, MAX_SLOTS, NAME_RE, USERNAME_RE, outfitOf, visualsOf, type CharacterSummary, type Look } from "../../shared/look.ts";
import { ITEMS, gearOf } from "../../shared/rules/items.ts";
import { JOBS, type JobKey } from "../../shared/rules/data.ts";
import { playerStatus } from "../../shared/rules/status.ts";
import { allow, count, limitReached, createSession, dropSession, getSession, hashPassword, verifyPassword, type Session } from "./auth.ts";
import { db } from "./db.ts";
import { redis } from "./redis.ts";

type AuthedReq = Request & { session?: Session; token?: string };
const bad = (res: Response, status: number, error: string) => res.status(status).json({ error });
const ip = (req: Request) => (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.socket.remoteAddress || "?";

/** One worn inventory row (`inventory.equip IS NOT NULL`) as the character list reads it: item id + that stack's refine.
 *  A bare number is an item id worn at +0 (callers that only know ids, e.g. previews). */
export type WornRow = number | { item_id: number; refine?: number; card0?: number; card1?: number; card2?: number; card3?: number };

/** character row + the inventory rows it wears -> API summary (incl. the look with worn gear for previews).
 *
 *  HP / SP and their maximums are the in-game status: the same `gearOf` + `playerStatus` that MapRoom.refreshStatus runs
 *  (Inventory.gear), so worn VIT / INT, bMaxHP / bMaxSP and the max-HP/SP rates count, and the saved HP/SP is clamped to that
 *  maximum like MapRoom.onJoin does. rAthena's character list shows the saved status.hp / max_hp / sp / max_sp unchanged
 *  (char_mmo_char_tobuf, char.cpp:1795-1798): status_calc_pc_sub stores max_hp / max_sp from status_calc_maxhp_pc /
 *  status_calc_maxsp_pc (status.cpp:4353, 4366), i.e. with the worn equipment, and pc_makesavestatus saves battle_status.hp /
 *  sp (pc.cpp:1394-1395). We keep no max_hp column (it is derived), so the maximum is recomputed here from the same inputs. */
export function summarize(row: any, wornRows: readonly WornRow[] = []): CharacterSummary {
  const job = (row.job in JOBS ? row.job : "Novice") as JobKey;
  const stacks = wornRows.map((w) => (typeof w === "number" ? { id: w, refine: 0, cards: [] } : { id: w.item_id, refine: w.refine ?? 0, cards: [w.card0, w.card1, w.card2, w.card3].filter((c): c is number => !!c) }));
  // Inventory.gear() on DB rows; a row of an item no longer in the data is skipped, like Inventory.load does
  const gear = gearOf(stacks.flatMap((w) => { const item = ITEMS.get(w.id); return item ? [{ item, refine: w.refine, cards: w.cards }] : []; }));
  const s = playerStatus({ job, level: row.level, jobLevel: row.job_level, stats: { str: row.str, agi: row.agi, vit: row.vit, int: row.int, dex: row.dex, luk: row.luk }, ...gear });
  return {
    id: row.id, slot: row.slot, name: row.name, job, level: row.level, jobLevel: row.job_level, exp: row.exp, jobExp: row.job_exp,
    str: row.str, agi: row.agi, vit: row.vit, int: row.int, dex: row.dex, luk: row.luk,
    hp: Math.min(row.hp ?? s.maxHp, s.maxHp), maxHp: s.maxHp, sp: Math.min(row.sp ?? s.maxSp, s.maxSp), maxSp: s.maxSp,
    gender: row.gender === "F" ? "F" : "M", hair: row.hair_color % HAIR_COLORS.length, style: styleOf(row),
    look: lookOf(row, stacks.map((w) => w.id)),
    map: row.last_map ?? undefined,
  };
}

const styleOf = (row: { hairdo?: number }) => (row.hairdo ?? 0) % HAIR_STYLES.length;

export function lookOf(row: { gender: string; hair_color: number; hairdo?: number; job: string }, worn: number[]): Look {
  const v = visualsOf(worn.map((id) => ITEMS.get(id)).filter((i) => !!i).map((i) => ({ id: i!.id, type: i!.type, subType: i!.subType })));
  return { gender: row.gender === "F" ? "F" : "M", hair: row.hair_color % HAIR_COLORS.length, style: styleOf(row), outfit: outfitOf(row.job), ...v };
}

async function requireAuth(req: AuthedReq, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  const s = await getSession(token);
  if (!s) return bad(res, 401, "session expired — please log in again");
  req.session = s; req.token = token;
  next();
}

export function registerApi(app: express.Application) {
  const api = express.Router();
  // dev: Vite (:5173) calls the server (:2567) cross-origin; prod is same-origin
  api.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  api.use(express.json({ limit: "8kb" }));

  const REGISTER_PER_HOUR = Number(process.env.REGISTER_PER_HOUR ?? 10); // successful sign-ups per IP per hour
  api.post("/register", async (req, res) => {
    if (await limitReached(`register:${ip(req)}`, REGISTER_PER_HOUR)) return bad(res, 429, "too many new accounts from this address, try later");
    const username = String(req.body?.username ?? "").trim().toLowerCase(), password = String(req.body?.password ?? "");
    if (!USERNAME_RE.test(username)) return bad(res, 400, "username: 4–24 characters, a–z 0–9 _");
    if (password.length < 8 || password.length > 72) return bad(res, 400, "password: 8–72 characters");
    try {
      const { rows } = await db.query("INSERT INTO accounts (username, pass_hash, last_login) VALUES ($1, $2, now()) RETURNING id", [username, await hashPassword(password)]);
      await count(`register:${ip(req)}`, 3600);
      res.json({ token: await createSession({ accountId: rows[0].id, username }), username });
    } catch (e: any) {
      if (e.code === "23505") return bad(res, 409, "that username is taken");
      throw e;
    }
  });

  api.post("/login", async (req, res) => {
    const username = String(req.body?.username ?? "").trim().toLowerCase(), password = String(req.body?.password ?? "");
    if (!(await allow(`login:${ip(req)}:${username}`, 8, 300))) return bad(res, 429, "too many attempts, wait 5 minutes");
    const row = (await db.query("SELECT id, pass_hash FROM accounts WHERE username = $1", [username])).rows[0];
    if (!row || !(await verifyPassword(password, row.pass_hash))) return bad(res, 401, "wrong username or password");
    await db.query("UPDATE accounts SET last_login = now() WHERE id = $1", [row.id]);
    res.json({ token: await createSession({ accountId: row.id, username }), username });
  });

  api.post("/logout", requireAuth, async (req: AuthedReq, res) => {
    await dropSession(req.token!);
    res.json({ ok: true });
  });

  api.get("/characters", requireAuth, async (req: AuthedReq, res) => {
    const { rows } = await db.query("SELECT * FROM characters WHERE account_id = $1 ORDER BY slot", [req.session!.accountId]);
    // every character's worn stacks in one query (not one per character); item + refine feed the status, the item alone the look
    const { rows: worn } = await db.query(
      "SELECT char_id, item_id, refine, card0, card1, card2, card3 FROM inventory WHERE equip IS NOT NULL AND char_id = ANY($1)", [rows.map((r) => r.id)]);
    res.json(rows.map((r) => summarize(r, worn.filter((w) => w.char_id === r.id))));
  });

  api.post("/characters", requireAuth, async (req: AuthedReq, res) => {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim(), slot = Number(b.slot), gender = b.gender, hair = Number(b.hair), style = b.style === undefined ? 0 : Number(b.style);
    if (!NAME_RE.test(name)) return bad(res, 400, "name: 2–16 letters, numbers, spaces or _");
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return bad(res, 400, "invalid slot");
    if (!GENDERS.includes(gender)) return bad(res, 400, "invalid gender");
    if (!Number.isInteger(hair) || hair < 0 || hair >= HAIR_COLORS.length) return bad(res, 400, "invalid hair colour");
    if (!Number.isInteger(style) || style < 0 || style >= HAIR_STYLES.length) return bad(res, 400, "invalid hair style");
    try {
      // W01: new characters start in Hearthmoor's plaza, inside Guide Lio's greeting area, with the town's hearth as save point
      const { rows } = await db.query(
        `INSERT INTO characters (name, x, y, last_map, save_map, save_x, save_y, account_id, slot, gender, hair_color, hairdo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [name, TOWN_START.x, TOWN_START.y, TOWN_START.map, TOWN_SAVE.map, TOWN_SAVE.x, TOWN_SAVE.y, req.session!.accountId, slot, gender, hair, style]);
      res.json(summarize(rows[0]));
    } catch (e: any) {
      if (e.code === "23505") return bad(res, 409, e.constraint === "characters_account_slot" ? "that slot is already used" : "that name is taken");
      throw e;
    }
  });

  api.delete("/characters/:id", requireAuth, async (req: AuthedReq, res) => {
    const { rows } = await db.query("SELECT name FROM characters WHERE id = $1 AND account_id = $2", [Number(req.params.id), req.session!.accountId]);
    if (!rows[0]) return bad(res, 404, "character not found");
    if (await redis.sismember("online", rows[0].name)) return bad(res, 409, "that character is in game — log it out first");
    if (String(req.body?.confirmName ?? "") !== rows[0].name) return bad(res, 400, "type the character's exact name to delete it");
    await db.query("DELETE FROM characters WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  });

  // async route errors -> 500 instead of a hung request
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api]", err);
    bad(res, 500, "server error");
  });
  app.use("/api", api);
}
