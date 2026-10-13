// Границы ошибок в App: исключение рендера страницы даёт карточку «Что-то сломалось»
// вместо белого экрана; соседний слой (обучающий тур) при этом живёт отдельно.
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import App from "../App";
import { clearToken, saveToken } from "../api/auth";

vi.mock("../pages/ProjectsPage", () => ({
  default: () => {
    throw new Error("лендинг упал");
  },
}));
vi.mock("../pages/UsersPage", () => ({ default: () => <div data-testid="users-page" /> }));
vi.mock("../pages/ProjectShell", () => ({ default: () => <div data-testid="shell" /> }));
vi.mock("../pages/MapEditorPage", () => ({ default: () => <div data-testid="map" /> }));

function jwt(role: string): string {
  return `h.${btoa(JSON.stringify({ sub: "ivan", role }))}.s`;
}

beforeEach(() => {
  clearToken();
  window.location.hash = "";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: "u1", username: "ivan", role: "architect", is_admin: false }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App: границы ошибок", () => {
  it("упавшая страница → карточка с текстом и кнопками, а не пустой экран", async () => {
    saveToken(jwt("architect"));
    render(<App />);
    const card = await screen.findByRole("alert");
    expect(card).toHaveTextContent("Что-то сломалось");
    expect(card).toHaveTextContent("лендинг упал");
    expect(screen.getByRole("button", { name: "Обновить страницу" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "К проектам" })).toBeInTheDocument();
  });

  it("переход на другой маршрут сбрасывает ошибку: экран «Пользователи» рисуется", async () => {
    saveToken(jwt("architect"));
    render(<App />);
    await screen.findByRole("alert");
    window.location.hash = "/admin/users";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByTestId("users-page")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
