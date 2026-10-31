import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { config } from "./config.ts";

// Every game shares one Postgres database ("home") and owns exactly one schema in it.
// search_path is pinned per connection, so SQL below never needs schema-qualified names.
const schemaIdent = `"${config.dbSchema.replace(/"/g, "")}"`;

// RO_STORE=pglite (desktop "simple" mode): real Postgres compiled to WASM, one embedded backend with its files in PGLITE_DIR.
// It is wrapped in the same pg.Pool through PGlite's node-postgres connection, so every query parses exactly like the server
// path (bigint -> string, multi-statement migrations, BEGIN/COMMIT). PGlite has ONE session: max 1 client serializes all
// queries (a transaction holds the only client), the search_path is set once on that session, and the client never idles out.
// PGlite is a server devDependency: the desktop build bundles it (desktop/build.mjs); the Docker image (--prod) doesn't ship it.
async function openPool(): Promise<pg.Pool> {
  if (config.store !== "pglite") return new pg.Pool({ connectionString: config.databaseUrl, max: 10, options: `-c search_path=${schemaIdent}` });
  const { PGlite } = await import("@electric-sql/pglite");
  const { createPgConfig } = await import("@electric-sql/pglite/node-postgres");
  const lite = await PGlite.create(config.pgliteDir);
  await lite.exec(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent}; SET search_path TO ${schemaIdent}`);
  const pool = new pg.Pool({ ...createPgConfig(lite), max: 1, idleTimeoutMillis: 0 } as unknown as pg.PoolConfig);
  const end = pool.end.bind(pool);
  pool.end = (async () => { await end(); await lite.close(); }) as typeof pool.end;
  return pool;
}

export const db = await openPool();

// Applies migrations/NNN_name.sql in order, once each. Forward-only.
export async function migrate() {
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent}`);
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(new URL(f, dir), "utf8");
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      console.log(`[db] applied ${f}`);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}
