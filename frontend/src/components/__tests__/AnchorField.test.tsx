// Поле «Источник» (components/anchor/AnchorField.tsx) — видимость и управляемость
// того, что до Ф1 было скрытой метаданной прогона агента. Поле одно на строку «Источник»
// страницы объекта и панели редактора-карты (общие строки nodePage/PropRows).
//
// Закрепляем ровно то, ради чего поле заведено: значение читается одной строкой (пустое —
// «не задан»); нормализация приходит С СЕРВЕРА (форма не считает её сама и потому не может
// обещать не то, что сохранится); отказ сервера остаётся в панели правки, а не уводит её со
// сцены; наблюдатель не видит ни одной кнопки правки.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AnchorField from "../anchor/AnchorField";
import { nodesApi } from "../../api/nodes";
import type { NodeSource } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { anchorPreview: vi.fn() },
}));

const preview = vi.mocked(nodesApi.anchorPreview);

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue({ source: { repo: "github.com/org/repo", path: null, host: null }, kind: "code", key: "git:github.com/org/repo" });
});

// Строка свойств (редизайн): значение одной строкой без приставок «код:» и «путь»;
// значение целиком открывает панель поверх страницы под ним. В панели — вкладки вида,
// поля, «Сохранить», «Отмена» и «Очистить»; ⓘ и абзаца-подсказки нет; «будет сохранено
// как» — только когда сервер приведёт ввод к другому виду; Escape и клик мимо закрывают
// без сохранения. Пустой источник — «не задан». Прежний вид поля в инспекторе редактора
// («код:», «Изменить · Очистить», ⓘ «Что такое источник») удалён вместе с инспектором.
describe("AnchorField — строка свойств", () => {
  function наСтранице(source: NodeSource | null, isArchitect = true) {
    const onSave = vi.fn<(s: NodeSource | null) => Promise<string | null>>(() => Promise.resolve(null));
    render(<AnchorField source={source} isArchitect={isArchitect} onSave={onSave} />);
    return onSave;
  }
  const панель = () => screen.queryByRole("group", { name: "Источник" });

  it("код — «репозиторий / путь» одной строкой, без приставок и без «Изменить · Очистить»", () => {
    наСтранице({ repo: "github.com/org/mono", path: "services/orders" });
    const value = screen.getByRole("button", { name: "Источник: github.com/org/mono / services/orders" });
    expect(value).toHaveTextContent("github.com/org/mono / services/orders");
    expect(screen.queryByText("код:")).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Очистить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Что такое источник" })).toBeNull();
  });

  it("имя зависимости — само имя", () => {
    наСтранице({ host: "payments" });
    expect(screen.getByRole("button", { name: "Источник: payments" })).toHaveTextContent("payments");
  });

  it("пустой источник: у редактора тихое «не задан» кнопкой, у читателя — текстом", () => {
    наСтранице(null);
    expect(screen.getByRole("button", { name: "Задать источник" })).toHaveTextContent("не задан");
    expect(screen.queryByText("нет, объект опознаётся по имени")).toBeNull();
  });

  it("читатель видит значение текстом, кнопок нет", () => {
    наСтранице({ repo: "github.com/org/mono", path: null }, false);
    expect(screen.getByText("github.com/org/mono")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("клик по значению открывает панель на языке ds; ⓘ и абзаца-подсказки нет; «Очистить» в ней", async () => {
    const onSave = наСтранице({ host: "payments" });
    const value = screen.getByRole("button", { name: "Источник: payments" });
    await userEvent.click(value);
    expect(value).toHaveAttribute("aria-expanded", "true");
    expect(панель()).toHaveClass("anchor-pop");
    expect(screen.getByRole("radiogroup", { name: "Вид источника" })).toHaveClass("ds-tabs");
    expect(screen.getByRole("radio", { name: "Имя зависимости" })).toHaveClass("ds-tab", "is-active");
    expect(screen.getByLabelText("Имя")).toHaveValue("payments");
    expect(screen.getByLabelText("Имя")).toHaveClass("ds-input");
    expect(screen.getByLabelText("Имя")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Сохранить" })).toHaveClass("ds-btn", "ds-btn--primary");
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveClass("ds-btn");
    expect(screen.queryByRole("button", { name: "Что такое источник" })).toBeNull();
    expect(screen.queryByText(/Можно вставить адрес клона/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(onSave).toHaveBeenCalledWith(null);
    expect(панель()).toBeNull();
  });

  it("Escape закрывает панель без сохранения, фокус возвращается на значение", async () => {
    const onSave = наСтранице({ host: "payments" });
    await userEvent.click(screen.getByRole("button", { name: "Источник: payments" }));
    await userEvent.clear(screen.getByLabelText("Имя"));
    await userEvent.type(screen.getByLabelText("Имя"), "kafka");
    await userEvent.keyboard("{Escape}");
    expect(панель()).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Источник: payments" })).toHaveFocus();
  });

  it("клик мимо панели закрывает её без сохранения", async () => {
    const onSave = наСтранице(null);
    await userEvent.click(screen.getByRole("button", { name: "Задать источник" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "github.com/org/repo");
    await userEvent.click(document.querySelector(".anchor-pop-backdrop") as HTMLElement);
    expect(панель()).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Enter в поле сохраняет сырой ввод и закрывает панель", async () => {
    const onSave = наСтранице(null);
    await userEvent.click(screen.getByRole("button", { name: "Задать источник" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "github.com/org/repo{Enter}");
    expect(onSave).toHaveBeenCalledWith({ repo: "github.com/org/repo", path: null });
    await waitFor(() => expect(панель()).toBeNull());
  });

  it("«будет сохранено как» — только когда сервер приведёт ввод к другому виду", async () => {
    наСтранице(null);
    await userEvent.click(screen.getByRole("button", { name: "Задать источник" }));
    // Ввод уже в том виде, в каком его запишет сервер: подсказка ничего не добавляет.
    await userEvent.type(screen.getByLabelText("Репозиторий"), "github.com/org/repo");
    await waitFor(() => expect(preview).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/будет сохранено как/)).toBeNull();
    // Адрес клона сервер приведёт к другому виду — подсказка нужна.
    await userEvent.clear(screen.getByLabelText("Репозиторий"));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "https://github.com/Org/Repo.git");
    expect(await screen.findByText("будет сохранено как: github.com/org/repo")).toBeInTheDocument();
  });

  it("на сервер уходит сырой ввод: нормализует его сервер, не форма", async () => {
    const onSave = наСтранице(null);
    await userEvent.click(screen.getByRole("button", { name: "Задать источник" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "https://github.com/Org/Repo.git");
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ repo: "https://github.com/Org/Repo.git", path: null }));
    expect(await screen.findByText("будет сохранено как: github.com/org/repo")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSave).toHaveBeenCalledWith({ repo: "https://github.com/Org/Repo.git", path: null });
  });

  it("переключение вида сохраняет источник другого вида", async () => {
    const onSave = наСтранице(null);
    await userEvent.click(screen.getByRole("button", { name: "Задать источник" }));
    await userEvent.click(screen.getByRole("radio", { name: "Имя зависимости" }));
    await userEvent.type(screen.getByLabelText("Имя"), "kafka");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSave).toHaveBeenCalledWith({ host: "kafka" });
  });

  it("«Отмена» закрывает панель, ничего не сохранив", async () => {
    const onSave = наСтранице({ host: "payments" });
    await userEvent.click(screen.getByRole("button", { name: "Источник: payments" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(панель()).toBeNull();
    expect(screen.getByRole("button", { name: "Источник: payments" })).toBeInTheDocument();
  });

  it("опустошённая форма обещает очистку и сервер не тревожит", async () => {
    наСтранице({ host: "payments" });
    await userEvent.click(screen.getByRole("button", { name: "Источник: payments" }));
    await userEvent.clear(screen.getByLabelText("Имя"));
    expect(screen.getByText("Если источника не будет, то объект будет опознаваться по имени")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 350));
    expect(preview).not.toHaveBeenCalled();
  });

  it("отказ сервера остаётся в панели, панель не закрывается", async () => {
    const onSave = vi.fn<(s: NodeSource | null) => Promise<string | null>>(() =>
      Promise.resolve("localhost, 127.0.0.1 и адреса конкретных серверов принадлежат среде"),
    );
    render(<AnchorField source={null} isArchitect onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Задать источник" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/принадлежат среде/);
    expect(панель()).not.toBeNull();
  });
});
