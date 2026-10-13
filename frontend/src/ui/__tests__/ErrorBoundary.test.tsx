// Граница ошибок рендера: вместо белого экрана — карточка с текстом ошибки и выходами
// «Обновить страницу» / «К проектам»; смена resetKey и «К проектам» дают поддереву
// второй шанс; fallback={null} гасит упавший слой молча.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ErrorBoundary from "../ErrorBoundary";

// Падает, пока флаг взведён; после сброса флага рисует текст.
let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error("взрыв при рендере");
  return <div>жив</div>;
}

beforeEach(() => {
  shouldThrow = true;
  window.location.hash = "";
  // React пишет пойманную ошибку в консоль — в тесте это ожидаемый шум.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("исключение рендера → карточка с текстом ошибки и двумя кнопками", () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("Что-то сломалось");
    expect(card).toHaveTextContent("взрыв при рендере");
    expect(screen.getByRole("button", { name: "Обновить страницу" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "К проектам" })).toBeInTheDocument();
  });

  it("«К проектам» ведёт на #/projects и даёт поддереву второй шанс", async () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    shouldThrow = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "К проектам" }));
    expect(window.location.hash).toBe("#/projects");
    expect(screen.getByText("жив")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("смена resetKey (другой маршрут) сбрасывает ошибку без перемонтирования границы", () => {
    const { rerender } = render(<ErrorBoundary resetKey="a"><Bomb /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    shouldThrow = false;
    rerender(<ErrorBoundary resetKey="b"><Bomb /></ErrorBoundary>);
    expect(screen.getByText("жив")).toBeInTheDocument();
  });

  it("тот же resetKey ошибку не сбрасывает", () => {
    const { rerender } = render(<ErrorBoundary resetKey="a"><Bomb /></ErrorBoundary>);
    shouldThrow = false;
    rerender(<ErrorBoundary resetKey="a"><Bomb /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("fallback={null} гасит упавший слой молча", () => {
    const { container } = render(<ErrorBoundary fallback={null}><Bomb /></ErrorBoundary>);
    expect(container).toBeEmptyDOMElement();
  });

  it("fallback-функция получает ошибку и сброс", async () => {
    render(
      <ErrorBoundary fallback={(e, reset) => <button onClick={reset}>{`снова: ${e.message}`}</button>}>
        <Bomb />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "снова: взрыв при рендере" }));
    expect(screen.getByText("жив")).toBeInTheDocument();
  });
});
