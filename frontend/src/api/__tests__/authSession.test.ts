// Источник роли и сигнал блокировки: getUserRole() до ответа /auth/me берёт роль
// из JWT, после — из «кто я»; 401 «Учётная запись заблокирована» из любого запроса
// будит подписчиков onAccountBlocked (App выходит на экран входа).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearToken, fetchMe, getIsAdmin, getMe, getUserRole, saveToken, subscribeMe } from "../auth";
import { api, ApiError, BLOCKED_DETAIL, onAccountBlocked } from "../client";
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
