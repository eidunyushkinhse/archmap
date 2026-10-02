import { getCurrentProjectId } from "./projectScope";

const BASE_URL = "/api/v1";

// Ошибка API с HTTP-статусом: клиент различает 409 (конфликт версий — этап 0
// конкурентности: fence вида / CAS сущности) от прочих отказов. message — detail бэка,
// code — машинный признак отказа, если бэк его дал (например, предел демо-стенда).
export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Признак отказа по пределу демо-стенда в теле 409 (DEMO_LIMIT_CODE бэка,
// app/demo_limits.py): запись вывела бы проект за предел (docs/tasks/demo-mode.md).
export const DEMO_LIMIT_CODE = "demo_limit";

export function isDemoLimit(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 409 && e.code === DEMO_LIMIT_CODE;
}

// Конфликт конкурентных сессий (409 от путей ЗАПИСИ). NB: 409 отдаёт и архивный
// проект (deps.py), но тот блокирует любые запросы скоупа целиком — до записи
// раскладки/PATCH дело не доходит, ретрай-ветки не путаются. Отказ по пределу
// демо-стенда — тоже 409, но не конфликт: перечитывание его не лечит.
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && !isDemoLimit(e);
}

// Текст отказа заблокированному (BLOCKED_DETAIL бэка, app/auth.py): им сервер
// отвечает 401 и на вход, и на любой запрос с уже выданным токеном.
export const BLOCKED_DETAIL = "Учётная запись заблокирована";

// Текст отказа гостю демо-стенда, чью песочницу уже убрали (SANDBOX_GONE_DETAIL бэка,
// app/auth.py): токен жив, а учётки нет. Им же App подписывает жёлтую плашку на
// экране демо-входа (docs/tasks/demo-mode.md).
export const SANDBOX_GONE_DETAIL =
  "Ваша песочница удалена: прошли сутки бездействия. Начните заново, это займёт пару секунд.";

// Подписчики «сессию закрыли с причиной» (учётку заблокировали, песочницу удалили):
// App выходит на экран входа с этим текстом. Сигнал из общего клиента, а не из
// каждой страницы: это застаёт человека на любом экране, в любом запросе.
type BlockedListener = (message: string) => void;
const blockedListeners = new Set<BlockedListener>();

export function onAccountBlocked(listener: BlockedListener): () => void {
  blockedListeners.add(listener);
  return () => { blockedListeners.delete(listener); };
}

// Подписчики прочего 401 (токен истёк или испорчен). Слушает только App демо-стенда:
// выйти гостю иначе нечем, меню профиля у него нет. Вне демо поведение прежнее.
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

function reportIfBlocked(status: number, detail: unknown): void {
  if (status !== 401) return;
  if (detail === BLOCKED_DETAIL || detail === SANDBOX_GONE_DETAIL) {
    for (const listener of blockedListeners) listener(detail);
    return;
  }
  for (const listener of unauthorizedListeners) listener();
}

// Тело отказа: detail бэка и необязательный машинный признак.
interface ErrorBody {
  detail?: unknown;
  code?: unknown;
}

async function readError(res: Response): Promise<ApiError> {
  const error = (await res.json().catch(() => ({ detail: res.statusText }))) as ErrorBody;
  reportIfBlocked(res.status, error.detail);
  // String() — как прежде: нестроковый detail (422 с перечнем) Error и раньше приводил к строке.
  const message = String(error.detail ?? "Неизвестная ошибка");
  return new ApiError(res.status, message, typeof error.code === "string" ? error.code : null);
}

function getToken(): string | null {
  return localStorage.getItem("access_token");
}

// Запросы к управлению проектами, авторизации, админке и списку пользователей
// скоупом проекта не оборачиваются (они оперируют самими проектами / логином /
// пользователями); все доменные — оборачиваются.
function needsProjectScope(path: string): boolean {
  return (
    !path.startsWith("/projects") && !path.startsWith("/auth") && !path.startsWith("/admin")
    && !path.startsWith("/users")
  );
}

function buildHeaders(path: string, options: RequestInit): HeadersInit {
  const token = getToken();
  const projectId = needsProjectScope(path) ? getCurrentProjectId() : null;
  return {
    // FormData ставит Content-Type сам (с boundary) — руками его задавать нельзя.
    ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(projectId ? { "X-Project-Id": projectId } : {}),
    ...options.headers,
  };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: buildHeaders(path, options),
  });

  if (!res.ok) throw await readError(res);

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Бинарная выгрузка (zip-архив проекта): тот же auth/scope, но ответ — Blob.
async function requestBlob(path: string): Promise<Blob> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: buildHeaders(path, {}) });
  if (!res.ok) throw await readError(res);
  return res.blob();
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
  // Мультипарт-загрузка файла (импорт архива проекта).
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form }),
  download: (path: string) => requestBlob(path),
};
