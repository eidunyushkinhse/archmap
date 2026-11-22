// Окно «Принять переход» на каркасе окна нового языка: шапка с крестиком, абзац о
// необратимости, блоки «Станут существующими», «Будут удалены», «Удалятся вместе с ними»
// с тихим числом без склейки «·», попутные потери — фразой-предупреждением без коробки,
// подвал «Принять переход» первой и «Отмена» за ней. Механика прежняя: превью при открытии,
// запись по кнопке с версией схемы, отказ 409 — своим текстом.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TransitionConfirm from "../TransitionConfirm";
import { transitionApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { TransitionPreview } from "../../types";

vi.mock("../../api/nodes", () => ({ transitionApi: { preview: vi.fn(), apply: vi.fn() } }));

const item = (i: number, path: string) => ({ id: `id-${i}`, name: path.split(" / ").pop() ?? path, path });

function preview(over: Partial<TransitionPreview> = {}): TransitionPreview {
  return {
    graph_rev: 7, is_noop: false,
    promote: [item(1, "Ярмарка / Рекомендации"), item(2, "Ярмарка / Заказы / Биллинг"), item(3, "Ярмарка / Поиск / Подсказки")],
    delete: [item(4, "Ярмарка / Уведомления / SMS"), item(5, "Ярмарка / Склад")],
    collateral: [item(6, "Ярмарка / Склад / API склада")],
    delete_total: 3, delete_edges: 2, delete_docs: 0, delete_specs: 1,
    ...over,
  };
}

function show() {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(<TransitionConfirm onClose={onClose} onApplied={onApplied} />);
  return { onClose, onApplied };
}
const win = () => document.querySelector(".ds-win") as HTMLElement;
const foot = () => win().querySelector(".ds-win-foot") as HTMLElement;
const block = (title: string) => screen.getByRole("heading", { level: 3, name: new RegExp(`^${title}`) }).closest("section") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TransitionConfirm", () => {
  it("каркас окна: заголовок h2, абзац о необратимости, ожидание тихой строкой", async () => {
    vi.mocked(transitionApi.preview).mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Принять переход" })).toBeInTheDocument();
    expect(win()).toHaveClass("ds");
    expect(screen.getByText(
      "Проектируемые объекты станут существующими, а выводимые исчезнут из схемы. "
      + "Действие затрагивает весь проект и отменить его нельзя.",
    )).toHaveClass("ds-confirm-lead");
    expect(screen.getByText("Считаем, что изменится")).toHaveClass("ds-confirm-muted");
    // Пока превью нет, принимать нечего.
    expect(screen.getByRole("button", { name: "Принять переход" })).toBeDisabled();
    // Ни одного инлайн-стиля внутри окна: вид задают классы.
    expect(win().querySelectorAll("[style]")).toHaveLength(0);
  });

  it("блоки с тихим числом без «·», пути перечнем с подсказкой, итог обычным текстом", async () => {
    vi.mocked(transitionApi.preview).mockResolvedValue(preview());
    show();
    const promote = await waitFor(() => block("Станут существующими"));
    expect(within(promote).getByText("3")).toHaveClass("ds-confirm-count");
    // Между названием и числом настоящий пробел: имя заголовка не склеивается.
    expect(screen.getByRole("heading", { level: 3, name: "Станут существующими 3" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Будут удалены 2" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Удалятся вместе с ними 1" })).toBeInTheDocument();
    const list = within(promote).getByRole("list");
    expect(list).toHaveClass("ds-confirm-list");
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("title")))
      .toEqual(["Ярмарка / Рекомендации", "Ярмарка / Заказы / Биллинг", "Ярмарка / Поиск / Подсказки"]);
    expect(within(block("Будут удалены")).getByText("2")).toHaveClass("ds-confirm-count");
    const collateral = block("Удалятся вместе с ними");
    expect(within(collateral).getByText("1")).toHaveClass("ds-confirm-count");
    expect(within(collateral).getByText("Эти объекты не помечены выводимыми, но лежат внутри удаляемых."))
      .toHaveClass("ds-warn");
    expect(within(collateral).getByText("Ярмарка / Склад / API склада")).toBeInTheDocument();
    expect(screen.getByText("Всего исчезнет 3 объекта, 2 связи, 1 спецификация.")).toHaveClass("ds-confirm-note");
    expect(win().textContent).not.toContain("·");
    expect(win().querySelectorAll("[style]")).toHaveLength(0);
  });

  it("подвал: «Принять переход» первой и красной, когда есть удаляемые; «Отмена» за ней в фокусе", async () => {
    vi.mocked(transitionApi.preview).mockResolvedValue(preview());
    show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Принять переход" })).toBeEnabled());
    const buttons = within(foot()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Принять переход", "Отмена"]);
    expect(buttons[0].className).toBe("ds-btn ds-btn--danger");
    expect(buttons[1].className).toBe("ds-btn");
    expect(buttons[1]).toHaveAttribute("data-autofocus");
  });

  it("без удаляемых главная кнопка синяя", async () => {
    vi.mocked(transitionApi.preview).mockResolvedValue(preview({ delete: [], collateral: [], delete_total: 0 }));
    show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Принять переход" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Принять переход" }).className).toBe("ds-btn ds-btn--primary");
    expect(screen.queryByRole("heading", { name: /^Будут удалены/ })).toBeNull();
    expect(screen.queryByText(/^Всего исчезнет/)).toBeNull();
  });

  it("принимать нечего: текст обычным цветом, кнопка заперта", async () => {
    vi.mocked(transitionApi.preview).mockResolvedValue(preview({
      is_noop: true, promote: [], delete: [], collateral: [], delete_total: 0,
    }));
    show();
    expect(await screen.findByText(
      "Принимать нечего, потому что в схеме нет ни проектируемых, ни выводимых объектов.",
    )).toHaveClass("ds-confirm-note");
    expect(screen.getByRole("button", { name: "Принять переход" })).toBeDisabled();
  });

  it("превью не посчиталось: отказ цветом опасности, кнопка заперта", async () => {
    vi.mocked(transitionApi.preview).mockRejectedValue(new Error("сеть"));
    show();
    expect(await screen.findByText("Не удалось посчитать, что изменится. Закройте окно и попробуйте снова."))
      .toHaveClass("ds-danger");
    expect(screen.getByRole("button", { name: "Принять переход" })).toBeDisabled();
  });

  it("запись: версия схемы из превью, итог словами, окно закрывается", async () => {
    vi.mocked(transitionApi.preview).mockResolvedValue(preview());
    vi.mocked(transitionApi.apply).mockResolvedValue({ promoted_nodes: 3, deleted_nodes: 2 } as Awaited<ReturnType<typeof transitionApi.apply>>);
    const { onClose, onApplied } = show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Принять переход" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Принять переход" }));
    expect(transitionApi.apply).toHaveBeenCalledWith(7);
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("Переход принят: 3 объекта переведено в существующие, 2 удалено"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("отказ 409: текст над кнопками подвала, окно остаётся", async () => {
    vi.mocked(transitionApi.preview).mockResolvedValue(preview());
    vi.mocked(transitionApi.apply).mockRejectedValue(new ApiError(409, "stale"));
    const { onClose, onApplied } = show();
    await waitFor(() => expect(screen.getByRole("button", { name: "Принять переход" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Принять переход" }));
    const err = await within(foot()).findByText(
      "Схему только что изменили в другом окне, и список ниже устарел. Закройте это окно и откройте снова.",
    );
    expect(err).toHaveClass("ds-danger", "ds-win-err");
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("крестик шапки закрывает окно", async () => {
    vi.mocked(transitionApi.preview).mockReturnValue(new Promise(() => {}));
    const { onClose } = show();
    const close = screen.getByRole("button", { name: "Закрыть" });
    expect(close).toHaveClass("ds-icon-btn", "ds-win-close");
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
