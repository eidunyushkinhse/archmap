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

  // Страховка вида карточки перед переводом на новый язык (редизайн, фаза 13б): заголовок,
  // пояснение, строка с текстом ошибки (у ошибки без текста — её имя) и порядок кнопок.
  it("карточка: заголовок, пояснение, текст ошибки строкой кода, кнопки по порядку", () => {
    function Nameless(): never {
      const e = new Error("");
      e.name = "SyntaxError";
      throw e;
    }
    render(<ErrorBoundary><Nameless /></ErrorBoundary>);
    const card = screen.getByRole("alert");
    expect(screen.getByRole("heading", { level: 2, name: "Что-то сломалось" })).toBeInTheDocument();
    expect(card).toHaveTextContent(
      "Страницу не удалось показать. Обновите её, а если не поможет, вернитесь к списку проектов и откройте страницу заново.",
    );
    expect(card.querySelector("code")).toHaveTextContent("SyntaxError");
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Обновить страницу", "К проектам"]);
    for (const b of card.querySelectorAll("button")) expect(b).toHaveAttribute("type", "button");
  });

  // Вид нового языка (фаза 13б): примитив ds-crash, корень сам несёт ds, колонка без
  // коробки, кнопки языка («Обновить страницу» главная), ни одного инлайн-стиля.
  it("вид: область ds-crash с корнем ds, колонка, строка кода, кнопки языка", () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    const card = screen.getByRole("alert");
    expect(card).toHaveClass("ds", "ds-crash");
    expect(card.firstElementChild).toHaveClass("ds-crash-col");
    expect(screen.getByRole("heading", { level: 2, name: "Что-то сломалось" })).toHaveClass("ds-crash-title");
    expect(card.querySelector("code")).toHaveClass("ds-crash-code");
    expect(screen.getByRole("button", { name: "Обновить страницу" })).toHaveClass("ds-btn", "ds-btn--primary");
    expect(screen.getByRole("button", { name: "К проектам" })).toHaveClass("ds-btn");
    expect(screen.getByRole("button", { name: "К проектам" })).not.toHaveClass("ds-btn--primary");
    expect(card).not.toHaveAttribute("style");
    expect(card.querySelector("[style]")).toBeNull();
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
