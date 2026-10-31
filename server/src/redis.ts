import { Redis } from "ioredis";
import { config } from "./config.ts";

// In-process stand-in for the few Redis commands the server uses (RO_STORE=pglite, desktop "simple" mode: one process, so
// sessions, the online set and rate-limit counters can live in memory; they reset when the app restarts, like a Redis flush).
// Same call shapes and results as ioredis for: connect, ping, disconnect, get, set(k, v, "EX", s), del, incr, expire, sadd,
// srem, sismember. Keys are not prefixed (nothing else shares this store).
class MemoryRedis {
  private vals = new Map<string, string | Set<string>>();
  private ttl = new Map<string, number>(); // key -> expiry (ms epoch)

  private live(k: string) {
    const t = this.ttl.get(k);
    if (t !== undefined && t <= Date.now()) { this.vals.delete(k); this.ttl.delete(k); }
    return this.vals.get(k);
  }
  private set_(k: string) {
    const v = this.live(k);
    if (v instanceof Set) return v;
    if (v !== undefined) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    const s = new Set<string>();
    this.vals.set(k, s);
    return s;
  }
  async connect() {}
  async ping() { return "PONG"; }
  disconnect() {}
  async get(k: string) {
    const v = this.live(k);
    if (v instanceof Set) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    return v ?? null;
  }
  async set(k: string, v: string | number, mode?: string, sec?: number) {
    this.vals.set(k, String(v));
    if (mode && mode.toUpperCase() === "EX" && sec !== undefined) this.ttl.set(k, Date.now() + sec * 1000);
    else this.ttl.delete(k);
    return "OK" as const;
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.live(k) !== undefined) { this.vals.delete(k); this.ttl.delete(k); n++; }
    return n;
  }
  async incr(k: string) {
    const v = await this.get(k);
    const n = (v === null ? 0 : Number(v)) + 1;
    if (!Number.isInteger(n)) throw new Error("ERR value is not an integer or out of range");
    this.vals.set(k, String(n)); // keeps an existing TTL, like Redis INCR
    return n;
  }
  async expire(k: string, sec: number) {
    if (this.live(k) === undefined) return 0;
    this.ttl.set(k, Date.now() + sec * 1000);
    return 1;
  }
  async sadd(k: string, ...members: (string | number)[]) {
    const s = this.set_(k);
    let n = 0;
    for (const m of members) if (!s.has(String(m))) { s.add(String(m)); n++; }
    return n;
  }
  async srem(k: string, ...members: (string | number)[]) {
    const v = this.live(k);
    if (!(v instanceof Set)) return 0;
    let n = 0;
    for (const m of members) if (v.delete(String(m))) n++;
    if (!v.size) this.vals.delete(k);
    return n;
  }
  async sismember(k: string, m: string | number) {
    const v = this.live(k);
    return v instanceof Set && v.has(String(m)) ? 1 : 0;
  }
}

// Shared Redis instance: every key is namespaced with REDIS_PREFIX (default "<game>:").
export const redis: Redis = config.store === "pglite"
  ? (new MemoryRedis() as unknown as Redis)
  : new Redis(config.redisUrl, { keyPrefix: config.redisPrefix, lazyConnect: true });
