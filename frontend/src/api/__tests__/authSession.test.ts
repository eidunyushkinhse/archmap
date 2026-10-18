// Источник роли и сигнал блокировки: getUserRole() до ответа /auth/me берёт роль
// из JWT, после — из «кто я»; 401 «Учётная запись заблокирована» из любого запроса
// будит подписчиков onAccountBlocked (App выходит на экран входа).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearToken, fetchAuthConfig, fetchMe, getIsAdmin, getMe, getUserRole, login, saveToken, startDemo, subscribeMe } from "../auth";
import { api, ApiError, BLOCKED_DETAIL, onAccountBlocked, onUnauthorized } from "../client";
import { setCurrentProjectId } from "../projectScope";

// JWT с нужной ролью в полезной нагрузке (подпись фронту не нужна).
function jwt(role: string): string {
  return `h.${btoa(JSON.stringify({ sub: "ivan", role }))}.s`;
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  clearToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getUserRole / getIsAdmin", () => {
  // Аудит R-25: часть JWT — base64url с UTF-8 внутри; atob падал на «-»/«_», и роль из
  // токена до ответа /auth/me пропадала. Эта полезная нагрузка (sub «Иван Петров»)
  // в base64url содержит «-» и требует добивки «=».
  it("роль из токена с кириллицей и base64url-символами читается", () => {
    const part = "eyJzdWIiOiLQmNCy0LDQvSDQn9C10YLRgNC-0LIiLCJyb2xlIjoiYXJjaGl0ZWN0In0";
    expect(part).toMatch(/[-_]/);
    saveToken(`h.${part}.s`);
    expect(getUserRole()).toBe("architect");
  });

  it("без токена — null и не админ", () => {
    expect(getUserRole()).toBeNull();
    expect(getIsAdmin()).toBe(false);
  });

  it("до ответа /auth/me — роль из токена, после — из БД", async () => {
    saveToken(jwt("architect"));
    expect(getUserRole()).toBe("architect");
    expect(getIsAdmin()).toBe(false);

    vi.stubGlobal("fetch", respond(200, { id: "u1", username: "ivan", role: "viewer", is_admin: true }));
    await fetchMe();
    expect(getUserRole()).toBe("viewer");
    expect(getIsAdmin()).toBe(true);
  });

  it("выход и новый вход сбрасывают «кто я»", async () => {
    saveToken(jwt("architect"));
    vi.stubGlobal("fetch", respond(200, { id: "u1", username: "ivan", role: "viewer", is_admin: true }));
    await fetchMe();
    saveToken(jwt("architect"));
    expect(getMe()).toBeNull();
    expect(getUserRole()).toBe("architect");
    clearToken();
    expect(getUserRole()).toBeNull();
  });

  it("ответ на сменённый токен в кэш не попадает", async () => {
    saveToken(jwt("architect"));
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const pending = fetchMe();
    clearToken(); // вышли, пока шёл запрос
    release(new Response(JSON.stringify({ id: "u1", username: "ivan", role: "viewer", is_admin: true }), { status: 200 }));
    await pending;
    expect(getMe()).toBeNull();
  });

  it("подписчики узнают о новом «кто я»", async () => {
    saveToken(jwt("architect"));
    const listener = vi.fn();
    const unsubscribe = subscribeMe(listener);
    vi.stubGlobal("fetch", respond(200, { id: "u1", username: "ivan", role: "viewer", is_admin: false }));
    await fetchMe();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    clearToken();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("onAccountBlocked", () => {
  it("401 с текстом блокировки будит подписчика и всё равно бросает ApiError", async () => {
    const listener = vi.fn();
    const unsubscribe = onAccountBlocked(listener);
    vi.stubGlobal("fetch", respond(401, { detail: BLOCKED_DETAIL }));
    await expect(api.get("/projects")).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledWith("Учётная запись заблокирована");
    unsubscribe();
  });

  it("прочие 401 и 403 подписчика не будят", async () => {
    const listener = vi.fn();
    const unsubscribe = onAccountBlocked(listener);
    vi.stubGlobal("fetch", respond(401, { detail: "Недействительный токен" }));
    await expect(api.get("/projects")).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal("fetch", respond(403, { detail: "Требуются права администратора" }));
    await expect(api.get("/admin/users")).rejects.toBeInstanceOf(ApiError);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("запросы админки уходят без заголовка проекта", async () => {
    setCurrentProjectId("p1"); // открыт проект — доменные запросы несут его id
    const fetchMock = respond(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/admin/users");
    await api.get("/nodes");
    const headers = (i: number) => (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].headers;
    expect(headers(0)).not.toHaveProperty("X-Project-Id");
    expect(headers(1)).toHaveProperty("X-Project-Id", "p1");
    setCurrentProjectId(null);
  });
});

// Аудит F-33: вход, старт демо и публичные настройки ходили сырым fetch со своими
// разборами ошибки. Теперь — общим клиентом мимо сессии: без токена и скоупа, а 401
// на входе — отказ формы, не «сессия истекла».
describe("запросы мимо сессии", () => {
  const init = (mock: ReturnType<typeof respond>) =>
    (mock.mock.calls[0] as unknown as [string, RequestInit])[1];

  it("вход — форма urlencoded, без токена и заголовка проекта", async () => {
    saveToken(jwt("viewer")); // прежний токен в хранилище не должен уехать на вход
    setCurrentProjectId("p1");
    const fetchMock = respond(200, { access_token: "t", token_type: "bearer" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(login("ivan", "секрет")).resolves.toEqual({ access_token: "t", token_type: "bearer" });
    const req = init(fetchMock);
    expect(req.method).toBe("POST");
    expect(req.body).toBe("username=ivan&password=%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82");
    expect(req.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    setCurrentProjectId(null);
  });

  it("неверный пароль и блокировка на входе — ApiError с текстом, без сигналов App", async () => {
    const expired = vi.fn();
    const blocked = vi.fn();
    const offExpired = onUnauthorized(expired);
    const offBlocked = onAccountBlocked(blocked);
    vi.stubGlobal("fetch", respond(401, { detail: "Неверный логин или пароль" }));
    await expect(login("ivan", "x")).rejects.toThrow("Неверный логин или пароль");
    vi.stubGlobal("fetch", respond(401, { detail: BLOCKED_DETAIL }));
    await expect(login("ivan", "x")).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();
    offExpired();
    offBlocked();
  });

  it("старт демо: отказ — ApiError со статусом и текстом сервера", async () => {
    vi.stubGlobal("fetch", respond(429, { detail: "Слишком много пользователей" }));
    const err: unknown = await startDemo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).message).toBe("Слишком много пользователей");
  });

  it("публичные настройки: отказ или обрыв — обычный вход", async () => {
    const fallback = { demo_mode: false, demo_limits: null };
    vi.stubGlobal("fetch", respond(500, { detail: "сбой" }));
    await expect(fetchAuthConfig()).resolves.toEqual(fallback);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(fetchAuthConfig()).resolves.toEqual(fallback);
    const cfg = { demo_mode: true, demo_limits: null };
    vi.stubGlobal("fetch", respond(200, cfg));
    await expect(fetchAuthConfig()).resolves.toEqual(cfg);
  });
});
