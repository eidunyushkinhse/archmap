// App: источник роли (/auth/me при старте перерисовывает страницы свежей ролью),
// выход на экран входа при блокировке и маршрут экрана «Пользователи».
// Страницы — заглушки: проверяем оркестрацию App, настоящие api/auth и client
// работают поверх подменённого fetch.
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import App from "../App";
import { clearToken, getIsAdmin, getUserRole, saveToken } from "../api/auth";

vi.mock("../pages/ProjectsPage", () => ({
  default: () => <div data-testid="projects">{`${getUserRole()}:${getIsAdmin() ? "admin" : "user"}`}</div>,
}));
vi.mock("../pages/UsersPage", () => ({ default: () => <div data-testid="users-page" /> }));
vi.mock("../pages/ProjectShell", () => ({ default: () => <div data-testid="shell" /> }));
vi.mock("../pages/MapEditorPage", () => ({ default: () => <div data-testid="map" /> }));

function jwt(role: string): string {
  return `h.${btoa(JSON.stringify({ sub: "ivan", role }))}.s`;
}

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

beforeEach(() => {
  clearToken();
  window.location.hash = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("роль и админ — из /auth/me: страница перерисовывается, когда ответ пришёл", async () => {
    saveToken(jwt("architect")); // в токене — архитектор (роль на момент входа)
    stubFetch(200, { id: "u1", username: "ivan", role: "viewer", is_admin: true });
    render(<App />);
    // до ответа — запасное значение из токена, после — из БД
    expect(await screen.findByText("viewer:admin")).toBeInTheDocument();
  });

  it("учётку заблокировали: экран входа с причиной", async () => {
    saveToken(jwt("architect"));
    stubFetch(401, { detail: "Учётная запись заблокирована" });
    render(<App />);
    expect(await screen.findByText("Учётная запись заблокирована")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Войти" })).toBeInTheDocument();
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("прочий отказ /auth/me не выкидывает: остаётся роль из токена", async () => {
    saveToken(jwt("architect"));
    stubFetch(500, { detail: "сбой" });
    render(<App />);
    expect(await screen.findByText("architect:user")).toBeInTheDocument();
  });

  it("#/admin/users открывает экран «Пользователи»", async () => {
    saveToken(jwt("architect"));
    stubFetch(200, { id: "u1", username: "ivan", role: "architect", is_admin: true });
    window.location.hash = "/admin/users";
    render(<App />);
    expect(await screen.findByTestId("users-page")).toBeInTheDocument();
  });
});
