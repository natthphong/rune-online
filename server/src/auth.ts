import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { redis } from "./redis.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, LEN = 64;
const SESSION_TTL = 12 * 3600; // seconds

/** scrypt$N$r$p$salt$hash — parameters travel with the hash so they can be raised later. */
export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(got, want);
}

export type Session = { accountId: number; username: string };

export async function createSession(s: Session) {
  const token = randomBytes(32).toString("base64url");
  await redis.set(`session:${token}`, JSON.stringify(s), "EX", SESSION_TTL);
  return token;
}

export async function getSession(token: unknown): Promise<Session | null> {
  if (typeof token !== "string" || token.length > 100) return null;
  const v = await redis.get(`session:${token}`);
  if (!v) return null;
  await redis.expire(`session:${token}`, SESSION_TTL); // sliding expiry while playing
  return JSON.parse(v);
}

export const dropSession = (token: string) => redis.del(`session:${token}`);

/** Fixed-window limiter: true while `key` has been hit fewer than `max` times in the last `windowSec`. */
export async function allow(key: string, max: number, windowSec: number) {
  const k = `rate:${key}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  return n <= max;
}

/** Counter-style limiter for things that should only count when they succeed (e.g. account creation). */
export const limitReached = async (key: string, max: number) => Number(await redis.get(`rate:${key}`)) >= max;
export async function count(key: string, windowSec: number) {
  const k = `rate:${key}`;
  if ((await redis.incr(k)) === 1) await redis.expire(k, windowSec);
}
