// Страховка экрана отказа загрузки (ui/LoadError) перед переводом на новый язык (редизайн,
// фаза 13б, меняется только вид): что не загрузилось, причина человеческим текстом, роль
// alert и кнопки по пропам («Повторить» первой, выход назад второй) с их колбэками.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import LoadError from "../LoadError";
import { ApiError } from "../../api/client";

describe("LoadError", () => {
  it("заголовок «Не удалось загрузить …» и причина текстом, роль alert", () => {
    render(<LoadError what="площадки" error={new ApiError(500, "Внутренняя ошибка сервера")} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить площадки");
    expect(alert).toHaveTextContent("Внутренняя ошибка сервера");
    // Причина — своим абзацем под заголовком.
    expect(screen.getByText("Не удалось загрузить площадки")).not.toBe(screen.getByText("Внутренняя ошибка сервера"));
  });

  it("причина переводится для человека: 404, 403, нет связи, неизвестное", () => {
    const { rerender } = render(<LoadError what="объект" error={new ApiError(404, "Not Found")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Не найдено. Возможно, объект удалили или ссылка устарела.");
    rerender(<LoadError what="объект" error={new ApiError(403, "Forbidden")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Нет доступа к этому проекту.");
    rerender(<LoadError what="объект" error={new TypeError("Failed to fetch")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Нет связи с сервером. Проверьте сеть и повторите.");
    rerender(<LoadError what="объект" error={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Неизвестная ошибка.");
  });

  it("без колбэков кнопок нет", () => {
    render(<LoadError what="токены" error={new Error("сбой")} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("только onRetry: одна «Повторить», нажатие зовёт повтор", async () => {
    const onRetry = vi.fn();
    render(<LoadError what="версии" error={new Error("сбой")} onRetry={onRetry} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Повторить"]);
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("onRetry и onBack: «Повторить» первой, выход назад «К проекту» второй", async () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    render(<LoadError what="объект" error={new Error("сбой")} onRetry={onRetry} onBack={onBack} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Повторить", "К проекту"]);
    await userEvent.click(screen.getByRole("button", { name: "К проекту" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("своя подпись выхода (backLabel) и только выход без повтора", async () => {
    const onBack = vi.fn();
    render(<LoadError what="уровень схемы" error={new Error("сбой")} onBack={onBack} backLabel="Закрыть редактор" />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Закрыть редактор"]);
    await userEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("кнопки — type=button: в форме окна они ничего не отправляют", () => {
    render(<LoadError what="объект" error={new Error("сбой")} onRetry={vi.fn()} onBack={vi.fn()} />);
    for (const b of screen.getAllByRole("button")) expect(b).toHaveAttribute("type", "button");
  });

  // Вид нового языка (фаза 13б): примитив ds-fail, корень сам несёт ds (метрики текста
  // одинаковы на странице, в области холста и в окне), кнопки языка, без инлайн-стилей.
  it("вид: блок ds-fail с корнем ds, «Повторить» главной кнопкой, выход вторичной", () => {
    render(<LoadError what="объект" error={new Error("сбой")} onRetry={vi.fn()} onBack={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("ds", "ds-fail");
    expect(screen.getByText("Не удалось загрузить объект")).toHaveClass("ds-fail-title");
    expect(screen.getByText("Не удалось загрузить объект").nextElementSibling).toHaveClass("ds-fail-why");
    expect(screen.getByRole("button", { name: "Повторить" })).toHaveClass("ds-btn", "ds-btn--primary");
    expect(screen.getByRole("button", { name: "К проекту" })).toHaveClass("ds-btn");
    expect(screen.getByRole("button", { name: "К проекту" })).not.toHaveClass("ds-btn--primary");
    expect(screen.getByRole("button", { name: "Повторить" }).parentElement).toHaveClass("ds-fail-acts");
    expect(alert.querySelector("[style]")).toBeNull();
    expect(alert).not.toHaveAttribute("style");
  });
});
