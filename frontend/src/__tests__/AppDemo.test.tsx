// App на демо-стенде (docs/tasks/demo-mode.md): экран входа выбирается по /auth/config,
// удалённая песочница выводит на демо-вход с жёлтой плашкой, истёкший токен гостя —
// на демо-вход без плашки, экран «Пользователи» гостю недоступен. Страницы проекта —
// заглушки; настоящие api/auth и client работают поверх подменённого fetch.
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import App from "../App";
import { clearToken, saveToken } from "../api/auth";

vi.mock("../pages/ProjectsPage", () => ({ default: () => <div data-testid="projects" /> }));
vi.mock("../pages/UsersPage", () => ({ default: () => <div data-testid="users-page" /> }));
vi.mock("../pages/ProjectShell", () => ({ default: () => <div data-testid="shell" /> }));
vi.mock("../pages/MapEditorPage", () => ({ default: () => <div data-testid="map" /> }));
vi.mock("../components/login/LoginScenePreview", () => ({ default: () => <svg /> }));

const DEMO_CONFIG = {
  allow_signup: false,
  demo_mode: true,
  demo_limits: { nodes: 100, edges: 120, docs: 75, processes: 10, text_bytes: 256000, file_bytes: 256000 },
};
const PLAIN_CONFIG = { allow_signup: true, demo_mode: false, demo_limits: null };
const GONE = "Ваша песочница удалена: прошли сутки бездействия. Начните заново, это займёт пару секунд.";
const GUEST_ME = {
  id: "g1", username: "guest-1a2b3c4d", role: "architect", is_admin: false, is_guest: true, can_create_project: true,
};

function guestJwt(): string {
  return `h.${btoa(JSON.stringify({ sub: "guest-1a2b3c4d", role: "architect", guest: true }))}.s`;
}

// Ответы по пути запроса: конфиг входа отдельно от прочих ручек.
function stubRoutes(config: unknown, other: { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const [status, body] = url.endsWith("/auth/config") ? [200, config] : [other.status, other.body];
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

beforeEach(() => {
  clearToken();
  window.location.hash = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App на демо-стенде", () => {
  it("без сессии — демо-вход вместо формы логина", async () => {
    stubRoutes(DEMO_CONFIG, { status: 401, body: { detail: "Not authenticated" } });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Попробуйте ArchMap" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Войти" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("вне демо — обычный вход", async () => {
    stubRoutes(PLAIN_CONFIG, { status: 401, body: { detail: "Not authenticated" } });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Войти" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Попробуйте ArchMap" })).toBeNull();
  });

  it("песочницу убрали: демо-вход с жёлтой плашкой, сессия сброшена", async () => {
    saveToken(guestJwt());
    stubRoutes(DEMO_CONFIG, { status: 401, body: { detail: GONE } });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(GONE);
    expect(alert).toHaveClass("login-msg--notice");
    expect(screen.getByRole("button", { name: "Попробовать без регистрации" })).toBeInTheDocument();
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("токен гостя истёк: демо-вход без плашки", async () => {
    saveToken(guestJwt());
    stubRoutes(DEMO_CONFIG, { status: 401, body: { detail: "Недействительный токен" } });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Попробуйте ArchMap" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("гостю экран «Пользователи» недоступен: открываются «Все проекты»", async () => {
    saveToken(guestJwt());
    stubRoutes(DEMO_CONFIG, { status: 200, body: GUEST_ME });
    window.location.hash = "/admin/users";
    render(<App />);
    expect(await screen.findByTestId("projects")).toBeInTheDocument();
    expect(screen.queryByTestId("users-page")).toBeNull();
  });
});
