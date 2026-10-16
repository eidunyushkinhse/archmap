// Авторизация автора: один пароль (scrypt-хэш), подписанная сессия в cookie, лимит попыток.
// Кнопки входа на сайте нет — автор сам открывает /login; читателям вход не нужен.
//   DOCS_AUTHOR_PASSWORD_HASH — хэш пароля (npm run password), на сервере;
//   DOCS_AUTHOR_PASSWORD      — пароль открытым текстом, для локальной разработки;
//   DOCS_SESSION_SECRET       — ключ подписи сессий; иначе создаётся и хранится в <data>/session-secret.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_TTL_S = 90 * 24 * 3600; // автор входит с каждого устройства раз в три месяца
export const SESSION_COOKIE = "docs_session";
export const AUTHOR_COOKIE = "docs_author"; // маркер для docs.js (не httpOnly): показать кнопки правки

export interface AuthConfig {
  passwordHash: string | null; // null — вход не настроен
  secret: Buffer;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, saltHex, hashHex] = stored.split(":");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: Buffer, payload: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

// Токен сессии: «<истекает>.<случайность>.<подпись>»
export function issueToken(secret: Buffer, now = Date.now()): string {
  const payload = `${Math.floor(now / 1000) + SESSION_TTL_S}.${b64url(randomBytes(12))}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyToken(secret: Buffer, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
  const expected = sign(secret, `${exp}.${nonce}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Счётчик неудачных попыток по ключу (адрес): limit за окно windowMs
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  // true — попытка допустима (и засчитана), false — лимит исчерпан
  hit(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function loadAuthConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): AuthConfig {
  let passwordHash: string | null = env.DOCS_AUTHOR_PASSWORD_HASH?.trim() || null;
  if (!passwordHash && env.DOCS_AUTHOR_PASSWORD) passwordHash = hashPassword(env.DOCS_AUTHOR_PASSWORD);
  let secret: Buffer;
  if (env.DOCS_SESSION_SECRET) {
    secret = Buffer.from(env.DOCS_SESSION_SECRET, "utf8");
  } else {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, "session-secret");
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    secret = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  }
  return { passwordHash, secret };
}
