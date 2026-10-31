// Account / character HTTP API client (server/src/api.ts). The session token lives in localStorage so a
// refresh goes straight back to character select.
import type { CharacterSummary, LoginResponse } from "../../shared/look.ts";
import { SERVER } from "./config.ts";

const TOKEN = "rl.token", USER = "rl.username";
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const session = {
  get token() { return store.get(TOKEN); },
  get username() { return store.get(USER) ?? ""; },
  save(r: LoginResponse) { store.set(TOKEN, r.token); store.set(USER, r.username); },
  clear() { store.set(TOKEN, null); },
};

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  register: (username: string, password: string) => call<LoginResponse>("POST", "/register", { username, password }),
  login: (username: string, password: string) => call<LoginResponse>("POST", "/login", { username, password }),
  logout: () => call<{ ok: true }>("POST", "/logout").catch(() => ({ ok: true })),
  characters: () => call<CharacterSummary[]>("GET", "/characters"),
  create: (c: { slot: number; name: string; gender: string; hair: number; style?: number }) => call<CharacterSummary>("POST", "/characters", c),
  remove: (id: number, confirmName: string) => call<{ ok: true }>("DELETE", `/characters/${id}`, { confirmName }),
};
