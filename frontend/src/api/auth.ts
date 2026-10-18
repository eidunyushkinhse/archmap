import type { AuthConfig, DemoLimits, Me, Token, UserRole } from "../types";
import { api } from "./client";
import { safeLocal } from "../lib/safeStorage";
import { createEmitter } from "../lib/emitter";

/** Вход. Отказ (неверный пароль, блокировка, перебор) — ApiError с текстом сервера;
 *  сигнала «сессия истекла» он не поднимает: запрос идёт мимо сессии. */
export function login(username: string, password: string): Promise<Token> {
  return api.anon.post<Token>("/auth/login", new URLSearchParams({ username, password }));
}

export function saveToken(token: string): void {
  safeLocal.setItem("access_token", token);
  // Новый токен — возможно, другой человек: прежний «кто я» больше не годится.
  setMe(null);
}

export function clearToken(): void {
  safeLocal.removeItem("access_token");
  setMe(null);
}

export function getToken(): string | null {
  return safeLocal.getItem("access_token");
}

// ── Кто я: роль и признак администратора из БД ───────────────────────────────
// Роль в JWT записана на момент входа: сменит её администратор — токен об этом не
// узнает до перелогина. Поэтому источник правды — GET /auth/me, загружаемый App
// при старте. Результат кэшируется здесь, чтобы синхронные getUserRole() на
// страницах остались синхронными; до ответа запасное значение — роль из JWT.
// Кэш — внешний стор для useSyncExternalStore: App перерисовывается, когда «кто я»
// пришёл, и страницы перечитывают роль.
let me: Me | null = null;
const meChanged = createEmitter();

function setMe(next: Me | null): void {
  if (next === me) return;
  me = next;
  meChanged.emit();
}

export const subscribeMe = meChanged.on;

export function getMe(): Me | null {
  return me;
}

/** Загрузить «кто я» и положить в кэш. Ответ на токен, который успели сменить
 *  (выход или вход другим пользователем, пока шёл запрос), в кэш не кладём. */
export async function fetchMe(): Promise<Me> {
  const token = getToken();
  const fresh = await api.get<Me>("/auth/me");
  if (getToken() === token) setMe(fresh);
  return fresh;
}

// Часть JWT — base64url (RFC 7515: «-» и «_» вместо «+» и «/», без «=»), а внутри —
// UTF-8. Голый atob падал на «-»/«_» и превращал кириллицу в sub в мусор (аудит R-25).
function decodeBase64Url(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Полезная нагрузка JWT без проверки подписи: только для отображения до ответа /auth/me.
function tokenClaims(): Record<string, unknown> | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload: unknown = JSON.parse(decodeBase64Url(token.split(".")[1] ?? ""));
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function roleFromToken(): UserRole | null {
  const role = tokenClaims()?.role;
  if (role === "architect" || role === "viewer") return role;
  return null;
}

export function getUserRole(): UserRole | null {
  if (!getToken()) return null;
  return me?.role ?? roleFromToken();
}

/** Администратор ли текущий пользователь. Признака нет в токене: до ответа
 *  /auth/me — false (пункт «Пользователи» появится, когда ответ придёт). */
export function getIsAdmin(): boolean {
  return me?.is_admin ?? false;
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await api.post<undefined>("/auth/password", {
    old_password: oldPassword,
    new_password: newPassword,
  });
}

// ── Гость демо-стенда (docs/tasks/demo-mode.md) ──────────────────────────────

/** Гость ли текущий пользователь. До ответа /auth/me — признак гостя из токена:
 *  шапка сразу рисует пилюлю «Обучение», а не мелькает аватаром. Права по нему не
 *  решаются (их решает сервер). */
export function getIsGuest(): boolean {
  if (!getToken()) return false;
  return me?.is_guest ?? tokenClaims()?.guest === true;
}

/** Можно ли создать ещё один проект (считает сервер: роль и предел гостя). До ответа
 *  /auth/me кнопку не гасим: отказ всё равно придёт от сервера. */
export function getCanCreateProject(): boolean {
  return me?.can_create_project ?? true;
}

// ── Публичные настройки входа: демо-режим и его пределы ──────────────────────
// Загружаются App до решения, какой экран входа показать. Кэш модуля: пределы
// нужны проверке файлов до загрузки, а та живёт глубоко в окнах импорта.
let authConfig: AuthConfig | null = null;

// Запасной ответ, если /auth/config недоступен: обычный вход, как до демо-режима.
const FALLBACK_CONFIG: AuthConfig = { demo_mode: false, demo_limits: null };

export async function fetchAuthConfig(): Promise<AuthConfig> {
  try {
    authConfig = await api.anon.get<AuthConfig>("/auth/config");
  } catch {
    authConfig = FALLBACK_CONFIG;
  }
  return authConfig;
}

export function getAuthConfig(): AuthConfig | null {
  return authConfig;
}

/** Пределы демо-стенда или null вне демо-режима. */
export function getDemoLimits(): DemoLimits | null {
  return authConfig?.demo_mode ? (authConfig.demo_limits ?? null) : null;
}

/** «Попробовать без регистрации»: сервер заводит гостя с песочницей и отдаёт токен.
 *  Отказ (429 «слишком много пользователей») — ApiError с текстом сервера. */
export function startDemo(): Promise<Token> {
  return api.anon.post<Token>("/demo/start");
}
