import type { AuthConfig, DemoLimits, Me, Token, UserRole } from "../types";
import { api, ApiError } from "./client";

const BASE_URL = "/api/v1";

export async function login(username: string, password: string): Promise<Token> {
  const body = new URLSearchParams({ username, password });
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Ошибка входа");
  }
  return res.json() as Promise<Token>;
}

export function saveToken(token: string): void {
  localStorage.setItem("access_token", token);
  // Новый токен — возможно, другой человек: прежний «кто я» больше не годится.
  setMe(null);
}

export function clearToken(): void {
  localStorage.removeItem("access_token");
  setMe(null);
}

export function getToken(): string | null {
  return localStorage.getItem("access_token");
}

// ── Кто я: роль и признак администратора из БД ───────────────────────────────
// Роль в JWT записана на момент входа: сменит её администратор — токен об этом не
// узнает до перелогина. Поэтому источник правды — GET /auth/me, загружаемый App
// при старте. Результат кэшируется здесь, чтобы синхронные getUserRole() на
// страницах остались синхронными; до ответа запасное значение — роль из JWT.
// Кэш — внешний стор для useSyncExternalStore: App перерисовывается, когда «кто я»
// пришёл, и страницы перечитывают роль.
let me: Me | null = null;
const meListeners = new Set<() => void>();

function setMe(next: Me | null): void {
  if (next === me) return;
  me = next;
  for (const listener of meListeners) listener();
}

export function subscribeMe(listener: () => void): () => void {
  meListeners.add(listener);
  return () => { meListeners.delete(listener); };
}

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

// Полезная нагрузка JWT без проверки подписи: только для отображения до ответа /auth/me.
function tokenClaims(): Record<string, unknown> | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload: unknown = JSON.parse(atob(token.split(".")[1]));
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
const FALLBACK_CONFIG: AuthConfig = { allow_signup: true, demo_mode: false, demo_limits: null };

export async function fetchAuthConfig(): Promise<AuthConfig> {
  try {
    const res = await fetch(`${BASE_URL}/auth/config`);
    authConfig = res.ok ? ((await res.json()) as AuthConfig) : FALLBACK_CONFIG;
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
export async function startDemo(): Promise<Token> {
  const res = await fetch(`${BASE_URL}/demo/start`, { method: "POST" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ detail: res.statusText }))) as { detail?: unknown };
    throw new ApiError(res.status, String(err.detail ?? "Не удалось начать"));
  }
  return res.json() as Promise<Token>;
}
