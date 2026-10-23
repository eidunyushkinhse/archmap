// App: источник роли (/auth/me при старте перерисовывает страницы свежей ролью),
// выход на экран входа при блокировке, маршрут экрана «Пользователи» и маршрут режима
// «Развёртывание» (#/p/<pid>/deploy/<уровень?>, перенаправление по запомненному режиму).
// Страницы — заглушки: проверяем оркестрацию App, настоящие api/auth и client
// работают поверх подменённого fetch.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import App, { SESSION_EXPIRED_NOTICE } from "../App";
import { clearToken, getIsAdmin, getUserRole, saveToken } from "../api/auth";

vi.mock("../pages/ProjectsPage", () => ({
  default: () => <div data-testid="projects">{`${getUserRole()}:${getIsAdmin() ? "admin" : "user"}`}</div>,
}));
vi.mock("../pages/UsersPage", () => ({ default: () => <div data-testid="users-page" /> }));
// Оболочка — маркер с тем, что App отдал ей из адреса: уровень развёртывания и узел.
vi.mock("../pages/ProjectShell", () => ({
  default: ({ deploy, nodeId }: { deploy?: { level: string | null }; nodeId: string | null }) => (
    <div data-testid="shell" data-deploy={deploy ? (deploy.level ?? "root") : "none"} data-node={nodeId ?? ""} />
  ),
}));
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
  localStorage.removeItem("archmap_mode");
  sessionStorage.clear();
  window.location.hash = "";
});

const PID = "11111111-1111-1111-1111-111111111111";
const LEVEL = "22222222-2222-2222-2222-222222222222";
// /auth/me и карточка проекта (my_role для гейта маршрутов) — одним телом ответа.
const ME_AND_PROJECT = { id: "u1", username: "ivan", role: "architect", is_admin: false, my_role: "owner" };
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

  it("токен истёк вне демо: экран входа с плашкой, адрес страницы сохранён (аудит R-15)", async () => {
    saveToken(jwt("architect"));
    window.location.hash = "/p/11111111-1111-1111-1111-111111111111";
    stubFetch(401, { detail: "Недействительный токен" });
    render(<App />);
    expect(await screen.findByText(SESSION_EXPIRED_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Войти" })).toBeInTheDocument();
    expect(localStorage.getItem("access_token")).toBeNull();
    // После входа человек вернётся туда, где был.
    expect(window.location.hash).toBe("#/p/11111111-1111-1111-1111-111111111111");
  });

  it("прочий отказ /auth/me не выкидывает: остаётся роль из токена", async () => {
    saveToken(jwt("architect"));
    stubFetch(500, { detail: "сбой" });
    render(<App />);
    expect(await screen.findByText("architect:user")).toBeInTheDocument();
  });

  it("#/p/<pid>/deploy/<уровень> — оболочка в «Развёртывании» на уровне из адреса", async () => {
    saveToken(jwt("architect"));
    stubFetch(200, ME_AND_PROJECT);
    window.location.hash = `/p/${PID}/deploy/${LEVEL}`;
    render(<App />);
    expect(await screen.findByTestId("shell")).toHaveAttribute("data-deploy", LEVEL);
    // смена адреса (в т.ч. «назад» браузера) — другой уровень той же оболочки
    window.location.hash = `/p/${PID}/deploy`;
    await waitFor(() => expect(screen.getByTestId("shell")).toHaveAttribute("data-deploy", "root"));
    window.location.hash = `/p/${PID}`;
    await waitFor(() => expect(screen.getByTestId("shell")).toHaveAttribute("data-deploy", "none"));
  });

  it("запомненное «Развёртывание»: открытие #/p/<pid> ведёт на #/p/<pid>/deploy (замена адреса)", async () => {
    saveToken(jwt("architect"));
    stubFetch(200, ME_AND_PROJECT);
    localStorage.setItem("archmap_mode", "deploy");
    window.location.hash = `/p/${PID}`;
    const before = window.history.length;
    render(<App />);
    expect(await screen.findByTestId("shell")).toHaveAttribute("data-deploy", "root");
    expect(window.location.hash).toBe(`#/p/${PID}/deploy`);
    expect(window.history.length).toBe(before);
    // внутри открытой оболочки #/p/<pid> — «Объекты»/«Процессы» («назад» из «Развёртывания»)
    window.location.hash = `/p/${PID}`;
    await waitFor(() => expect(screen.getByTestId("shell")).toHaveAttribute("data-deploy", "none"));
    expect(window.location.hash).toBe(`#/p/${PID}`);
    // страница объекта по прямому адресу — не перенаправляется
    window.location.hash = `/p/${PID}/nodes/${LEVEL}`;
    await waitFor(() => expect(screen.getByTestId("shell")).toHaveAttribute("data-node", LEVEL));
    expect(screen.getByTestId("shell")).toHaveAttribute("data-deploy", "none");
    // новое открытие проекта (из списка) — снова в «Развёртывание»
    window.location.hash = "/projects";
    await screen.findByTestId("projects");
    window.location.hash = `/p/${PID}`;
    await waitFor(() => expect(screen.getByTestId("shell")).toHaveAttribute("data-deploy", "root"));
    expect(window.location.hash).toBe(`#/p/${PID}/deploy`);
  });

  it("запомненное «Развёртывание», но из редактора пришли с процессом — страница проекта", async () => {
    saveToken(jwt("architect"));
    stubFetch(200, ME_AND_PROJECT);
    localStorage.setItem("archmap_mode", "deploy");
    sessionStorage.setItem("archmap.pendingProcess", "p9");
    window.location.hash = `/p/${PID}`;
    render(<App />);
    expect(await screen.findByTestId("shell")).toHaveAttribute("data-deploy", "none");
    expect(window.location.hash).toBe(`#/p/${PID}`);
  });

  it("#/admin/users открывает экран «Пользователи»", async () => {
    saveToken(jwt("architect"));
    stubFetch(200, { id: "u1", username: "ivan", role: "architect", is_admin: true });
    window.location.hash = "/admin/users";
    render(<App />);
    expect(await screen.findByTestId("users-page")).toBeInTheDocument();
  });
});
