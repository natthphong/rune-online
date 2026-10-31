import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import compression from "compression";
import express from "express";
import { MAP_NAMES, roomOf } from "../../shared/maps.ts";
import { config } from "./config.ts";
import { db, migrate } from "./db.ts";
import { redis } from "./redis.ts";
import { MapRoom } from "./rooms/MapRoom.ts";
import { registerApi } from "./api.ts";

await redis.connect();
await migrate();

const server = new Server({
  greet: false,
  transport: new WebSocketTransport(),
  express: (app) => {
    app.get("/health", async (_req, res) => {
      try {
        await db.query("SELECT 1");
        await redis.ping();
        res.json({ ok: true, game: config.game, store: config.store }); // store: desktop test bots skip direct DB reads on "pglite"
      } catch (e) {
        res.status(503).json({ ok: false, error: String(e) });
      }
    });
    registerApi(app);
    // gzip/brotli for text assets only (compression's default filter skips PNG/JPG/MP3: already compressed); brotli (default q4) keeps the
    // on-the-fly CPU low, and conditional GETs are answered 304 by static below before any body is compressed
    if (config.publicDir) app.use(compression());
    if (config.publicDir) app.use(express.static(config.publicDir, {
      // Vite's hashed /assets are immutable; game art (sprites, models, audio...) keeps its name across rebuilds: a day of
      // caching, then a cheap ETag revalidation; the page itself is always revalidated
      setHeaders: (res, file) => {
        if (/[\\/]assets[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else if (/\.html?$/.test(file)) res.setHeader("Cache-Control", "no-cache");
        else res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      },
    }));
  },
});
// one room per map (rAthena: one map-server holding every map); the field keeps ROOM_NAME ("map")
for (const m of MAP_NAMES) server.define(roomOf(m), MapRoom, { map: m });
server.onShutdown(async () => {
  await db.end();
  redis.disconnect();
});

await server.listen(config.port, config.host);
console.log(`[${config.game}] listening on :${config.port} (store=${config.store}, schema=${config.dbSchema}, redis prefix=${config.redisPrefix})`);
