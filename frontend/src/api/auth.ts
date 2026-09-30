import type { Me, Token, UserRole } from "../types";
import { api } from "./client";

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

function roleFromToken(): UserRole | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    const role = payload.role;
    if (role === "architect" || role === "viewer") return role;
    return null;
  } catch {
    return null;
  }
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
