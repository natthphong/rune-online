// All runtime config comes from env (see ../../.env.example at repo root and the game's .env).
const env = process.env;

function req(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// RO_STORE=postgres (default: dev + deployed server) uses DATABASE_URL + REDIS_URL; RO_STORE=pglite (desktop "simple" mode)
// embeds Postgres (PGlite, files in PGLITE_DIR) and keeps the Redis keys in memory, so neither URL is needed.
const store = env.RO_STORE === "pglite" ? "pglite" : "postgres";

export const config = {
  game: req("GAME_NAME"),
  store,
  pgliteDir: env.PGLITE_DIR || "./.pglite",
  port: Number(env.PORT ?? 2567),
  host: env.HOST || "0.0.0.0", // the desktop launcher binds 127.0.0.1
  publicDir: env.PUBLIC_DIR ?? "", // built client (client/dist); empty in dev, Vite serves it
  databaseUrl: store === "pglite" ? "" : req("DATABASE_URL"),
  dbSchema: env.DB_SCHEMA || req("GAME_NAME"),
  redisUrl: store === "pglite" ? "" : req("REDIS_URL"),
  redisPrefix: env.REDIS_PREFIX || `${req("GAME_NAME")}:`,
  mapSeed: Number(env.MAP_SEED ?? 1337),
  mapName: env.MAP_NAME || "f1_field01", // the map this room runs: picks its lines in shared/data/spawns.txt
};
