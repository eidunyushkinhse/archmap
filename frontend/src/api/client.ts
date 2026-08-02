import { getCurrentProjectId } from "./projectScope";

const BASE_URL = "/api/v1";

// Ошибка API с HTTP-статусом: клиент различает 409 (конфликт версий — этап 0
// конкурентности: fence вида / CAS сущности) от прочих отказов. message — detail бэка.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Конфликт конкурентных сессий (409 от путей ЗАПИСИ). NB: 409 отдаёт и архивный
// проект (deps.py), но тот блокирует любые запросы скоупа целиком — до записи
// раскладки/PATCH дело не доходит, ретрай-ветки не путаются.
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}

function getToken(): string | null {
  return localStorage.getItem("access_token");
}

// Запросы к управлению проектами и авторизации скоупом проекта не оборачиваются
// (они оперируют самими проектами / логином); все доменные — оборачиваются.
function needsProjectScope(path: string): boolean {
  return !path.startsWith("/projects") && !path.startsWith("/auth");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const projectId = needsProjectScope(path) ? getCurrentProjectId() : null;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(projectId ? { "X-Project-Id": projectId } : {}),
    ...options.headers,
  };

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, error.detail ?? "Неизвестная ошибка");
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  // undefined (не void): void как type-parameter нарушает no-invalid-void-type;
  // request возвращает undefined при 204 — тип совпадает с фактическим значением
  delete: (path: string) => request<undefined>(path, { method: "DELETE" }),
};
