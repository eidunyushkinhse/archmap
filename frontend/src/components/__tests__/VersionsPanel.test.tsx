// Панель «Версии документации» (docs/tasks/doc-versions.md §7, прототип — вкладка «2 ·
// Версии документации»).
//
// Что закрепляем: один экран за раз — список (строка «Есть изменения с vN: …» с кнопкой
// фиксации у редактора, у читателя её нет), версия (дельта с prev, тихий селект «с vM /
// с текущим состоянием» перезапрашивает с live), элемент (три сегмента одним запросом,
// формы lines / rows / text и пустая сторона); окно фиксации (пустой комментарий не
// шлёт запрос, успех перечитывает список, отказ виден под полем); удаление — только
// владельцу и через подтверждение; Escape закрывает панель. Modal — настоящий (диалог
// открывается полифилом из test-setup), API версий замокан.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VersionsPanel from "../nodePage/versions/VersionsPanel";
import { versionsApi } from "../../api/versions";
import { ApiError, DEMO_LIMIT_CODE } from "../../api/client";
import type { VersionDiff, VersionItem, VersionItemDetail, VersionList, VersionOut } from "../../types";

vi.mock("../../api/versions", () => ({
  versionsApi: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), diff: vi.fn(), item: vi.fn() },
}));

function version(n: number, over: Partial<VersionOut> = {}): VersionOut {
  return {
    number: n,
    comment: `orders 2.${n}`,
    kind: "manual",
    restored_from: null,
    created_at: "2026-10-19T10:00:00Z",
    author: "petrova",
    stats: { nodes: 1, edges: 0, docs: 0, tables: 0, channels: 0, params: 0, processes: 0, changed: [] },
    ...over,
  };
}

function item(over: Partial<VersionItem> = {}): VersionItem {
  return {
    item_id: "doc:d1",
    category: "doc",
    node_path: "",
    name: "Создать заказ",
    status: "changed",
    summary: "+3 −2",
    ...over,
  };
}

function list(versions: VersionOut[], pending: Partial<VersionList["pending"]> = {}): VersionList {
  return { versions, pending: { changed: false, items: [], ...pending } };
}

function diff(items: VersionItem[], base: number | null, target: number | null): VersionDiff {
  const ref = (n: number | null) => (n === null ? null : { number: n, comment: `orders 2.${n}`, created_at: "" });
  return {
    base: ref(base),
    target: ref(target) ?? { number: null, comment: null, created_at: null },
    items,
  };
}

const absent = { text: null, lines: null, columns: null, rows: null };

function renderPanel(props: Partial<Parameters<typeof VersionsPanel>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <VersionsPanel nodeId="n1" title="Сервис заказов" canEdit canDelete={false} onClose={onClose} {...props} />,
  );
  return { ...utils, onClose };
}

// Три версии и незафиксированные изменения: схема, конфигурация корня, связь, процесс.
const pendingItems = [
  item(),
  item({ item_id: "config:n1", category: "config", name: "3 параметра", summary: "+1" }),
  item({ item_id: "edge:e1", category: "edges", name: "Сервис заказов → Kafka заказов", status: "added", summary: "" }),
  item({ item_id: "process:p1", category: "process", name: "Оформление заказа" }),
];
const three = [version(3), version(2), version(1, { author: null })];

describe("VersionsPanel: список", () => {
  beforeEach(() => vi.clearAllMocks());

  it("редактор: перечень изменений с последней версии (три и «и ещё»), кнопка фиксации активна", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list(three, { changed: true, items: pendingItems }));
    renderPanel();

    expect(await screen.findByText(
      "Есть изменения с v3: схема логики «Создать заказ», конфигурация, связь «Сервис заказов → Kafka заказов» и ещё 1",
    )).toBeInTheDocument();
    expect(screen.getByText("Версии · Сервис заказов")).toBeInTheDocument();
    expect(screen.getByText("3 версии")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Зафиксировать версию" })).toBeEnabled();
    expect(versionsApi.list).toHaveBeenCalledWith("n1");

    // Строки версий: номер, комментарий, «дата · автор»; автора удалили — прочерк.
    const v1 = screen.getByRole("button", { name: /^v1/ });
    expect(v1).toHaveTextContent("orders 2.1");
    expect(v1).toHaveTextContent(/· —$/);
    expect(screen.getByRole("button", { name: /^v3/ })).toHaveTextContent(/· petrova$/);
  });

  it("изменений нет: «Изменений с vN нет», кнопка неактивна", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list(three));
    renderPanel();
    expect(await screen.findByText("Изменений с v3 нет")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Зафиксировать версию" })).toBeDisabled();
  });

  it("версий нет у редактора: «Версий ещё нет» одной строкой, фиксировать можно", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list([], { changed: true }));
    renderPanel();
    expect(await screen.findByText("Версий ещё нет")).toBeInTheDocument();
    expect(screen.getAllByText("Версий ещё нет")).toHaveLength(1);
    expect(screen.queryByText(/0 версий/)).toBeNull();
    expect(screen.getByRole("button", { name: "Зафиксировать версию" })).toBeEnabled();
  });

  it("читатель: строки фиксации нет вовсе", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list(three, { changed: true, items: pendingItems }));
    renderPanel({ canEdit: false });
    expect(await screen.findByText("orders 2.3")).toBeInTheDocument();
    expect(screen.queryByText(/Есть изменения/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Зафиксировать версию" })).toBeNull();
  });

  it("читатель без версий: «Версий ещё нет»", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list([], { changed: true }));
    renderPanel({ canEdit: false });
    expect(await screen.findByText("Версий ещё нет")).toBeInTheDocument();
  });

  it("автоматическая версия — обычным весом, без пометок", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list([version(4, { kind: "pre_restore", comment: "Перед откатом к v2" }), ...three]));
    renderPanel();
    const comment = await screen.findByText("Перед откатом к v2");
    expect(comment.className).toContain("vp-row-c--auto");
    expect(screen.getByText("orders 2.3").className).not.toContain("vp-row-c--auto");
  });

  it("список не загрузился: причина и «Повторить»", async () => {
    vi.mocked(versionsApi.list)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(list(three));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить версии");
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("orders 2.3")).toBeInTheDocument();
  });

  it("Escape закрывает панель", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list(three));
    const { onClose } = renderPanel();
    await screen.findByText("orders 2.3");
    const dialog = screen.getByRole("dialog");
    dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("VersionsPanel: версия и элемент", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(versionsApi.list).mockResolvedValue(list(three));
  });

  it("версия: дельта с предыдущей, смена селекта перезапрашивает с текущим состоянием", async () => {
    vi.mocked(versionsApi.diff).mockImplementation(async (_n, num, base) => (base === "prev"
      ? diff([
        item(),
        item({ item_id: "props:c", category: "props", node_path: "Заказы / Сервис оплат", name: "Сервис оплат", status: "added", summary: "объект" }),
      ], 2, num)
      : diff([], num, null)));
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /^v3/ }));
    expect(versionsApi.diff).toHaveBeenLastCalledWith("n1", 3, "prev");
    expect(screen.getByText("v3 · orders 2.3")).toBeInTheDocument();

    const select = screen.getByRole("combobox", { name: "С чем сравнивать" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["с v2", "с текущим состоянием"]);

    // Строка элемента: категория, путь объекта тихо перед именем, статус словами.
    const doc = await screen.findByRole("button", { name: /^Схема логики/ });
    expect(doc).toHaveTextContent("Создать заказ");
    expect(doc).toHaveTextContent("изменена · +3 −2");
    const props = screen.getByRole("button", { name: /^Свойства/ });
    expect(within(props).getByText("Заказы /", { exact: false }).className).toBe("vp-irow-path");
    expect(props).toHaveTextContent("новый · объект");

    await userEvent.selectOptions(select, "live");
    expect(versionsApi.diff).toHaveBeenLastCalledWith("n1", 3, "live");
    expect(await screen.findByText("Изменений с v3 нет")).toBeInTheDocument();

    // Назад — к списку.
    await userEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText("Версии · Сервис заказов")).toBeInTheDocument();
  });

  it("первая версия: сравнение «с начала», пустая дельта — фраза о первой версии", async () => {
    vi.mocked(versionsApi.diff).mockResolvedValue(diff([], null, 1));
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: /^v1/ }));
    expect(await screen.findByText("Первая версия: вся документация объекта добавлена")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "С чем сравнивать" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["с начала", "с текущим состоянием"]);
  });

  it("элемент: три сегмента одним запросом — построчная дельта, таблица, текст", async () => {
    vi.mocked(versionsApi.diff).mockResolvedValue(diff([item()], 2, 3));
    const detail: VersionItemDetail = {
      item: item(),
      changes: {
        text: null,
        columns: null,
        rows: null,
        lines: [
          { mark: "mod", text: "@@ -1,3 +1,3 @@" },
          { mark: "", text: "flowchart TD" },
          { mark: "del", text: "  C[проверить остаток]" },
          { mark: "add", text: "  C[зарезервировать остаток]" },
        ],
      },
      before: {
        text: null,
        lines: null,
        columns: ["Параметр", "Тип"],
        rows: [{ mark: "", cells: ["ORDER_TTL_H", "int"] }],
      },
      after: { text: "flowchart TD\n  C[зарезервировать остаток]", lines: null, columns: null, rows: null },
    };
    vi.mocked(versionsApi.item).mockResolvedValue(detail);
    const { container } = renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /^v3/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Схема логики/ }));
    expect(versionsApi.item).toHaveBeenCalledWith("n1", 3, "doc:d1", "prev");
    expect(screen.getByText("Схема логики · Создать заказ")).toBeInTheDocument();

    const segs = within(screen.getByRole("group", { name: "Что показать" })).getAllByRole("button");
    expect(segs.map((b) => b.textContent)).toEqual(["Изменения", "Было · v2", "Стало · v3"]);
    expect(segs[0]).toHaveAttribute("aria-pressed", "true");

    // Изменения — построчная дельта: строки с классами по метке и знаком слева.
    // (Пробелы значимы — читаем textContent, а не нормализующий поиск по тексту.)
    await screen.findByText("@@ -1,3 +1,3 @@");
    const lines = [...container.ownerDocument.querySelectorAll(".vp-l")].map((el) => [el.className, el.textContent]);
    expect(lines).toEqual([
      ["vp-l vp-l--hunk", "@@ -1,3 +1,3 @@"],
      ["vp-l vp-l--ctx", " flowchart TD"],
      ["vp-l vp-l--del", "-  C[проверить остаток]"],
      ["vp-l vp-l--add", "+  C[зарезервировать остаток]"],
    ]);

    // Было — таблица; меток в ней нет, и колонки под них тоже нет.
    await userEvent.click(segs[1]);
    expect(screen.getByRole("columnheader", { name: "Параметр" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "ORDER_TTL_H" })).toBeInTheDocument();
    expect(container.ownerDocument.querySelector(".vp-tag")).toBeNull();

    // Стало — полный текст.
    await userEvent.click(segs[2]);
    expect(container.ownerDocument.querySelector("pre.vp-code")?.textContent).toBe("flowchart TD\n  C[зарезервировать остаток]");
    expect(versionsApi.item).toHaveBeenCalledTimes(1);

    // Назад — к версии с тем же сравнением.
    await userEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByText("v3 · orders 2.3")).toBeInTheDocument();
  });

  it("элемент «с текущим состоянием»: «Было · vN / Стало · сейчас», пустая сторона, метки строк", async () => {
    vi.mocked(versionsApi.diff).mockResolvedValue(diff([item({ status: "added", category: "config", item_id: "config:n1", name: "1 параметр", summary: "+1" })], 3, null));
    vi.mocked(versionsApi.item).mockResolvedValue({
      item: item(),
      changes: {
        text: null,
        lines: null,
        columns: ["Параметр", "Тип"],
        rows: [
          { mark: "add", cells: ["ORDER_CANCEL_WINDOW_MIN", "int"] },
          { mark: "move", cells: ["ORDER_TTL_H", "int"] },
        ],
      },
      before: absent,
      after: absent,
    });
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /^v3/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "С чем сравнивать" }), "live");
    // У конфигурации добавление — тоже «изменена», и без зелёного цвета.
    const row = await screen.findByRole("button", { name: /^Конфигурация/ });
    expect(within(row).getByText("изменена · +1").className).toBe("vp-irow-st");
    await userEvent.click(row);
    expect(versionsApi.item).toHaveBeenCalledWith("n1", 3, "config:n1", "live");

    const segs = within(screen.getByRole("group", { name: "Что показать" })).getAllByRole("button");
    expect(segs.map((b) => b.textContent)).toEqual(["Изменения", "Было · v3", "Стало · сейчас"]);
    expect(await screen.findByText("+")).toHaveClass("vp-tag--add");
    expect(screen.getByText("порядок")).toHaveClass("vp-tag--mod");

    await userEvent.click(segs[1]);
    expect(screen.getByText("На этой стороне элемента нет")).toBeInTheDocument();
  });
});

describe("VersionsPanel: фиксация", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(versionsApi.list).mockResolvedValue(list(three, { changed: true, items: [item()] }));
  });

  async function openFix() {
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Зафиксировать версию" }));
    return screen.getByLabelText("Комментарий — номер версии, релиза или задачи");
  }

  it("окно: строка «объект · изменения с vN: …», пустой комментарий не отправляется", async () => {
    const field = await openFix();
    expect(screen.getByText("Сервис заказов · изменения с v3: схема логики «Создать заказ»")).toBeInTheDocument();
    expect(field).toHaveAttribute("placeholder", "orders 2.4 · ORD-430");
    const ok = screen.getByRole("button", { name: "Зафиксировать" });
    expect(ok).toBeDisabled();
    await userEvent.type(field, "   ");
    expect(ok).toBeDisabled();
    // Enter в поле — то же, что кнопка: с пустым комментарием запроса нет.
    await userEvent.type(field, "{Enter}");
    expect(versionsApi.create).not.toHaveBeenCalled();
  });

  it("первая версия: в окне «объект · первая версия»", async () => {
    vi.mocked(versionsApi.list).mockResolvedValue(list([], { changed: true }));
    await openFix();
    expect(screen.getByText("Сервис заказов · первая версия")).toBeInTheDocument();
  });

  it("успех: запрос с комментарием, окно закрывается, список перечитан", async () => {
    vi.mocked(versionsApi.create).mockResolvedValue(version(4));
    const field = await openFix();
    vi.mocked(versionsApi.list).mockResolvedValue(list([version(4), ...three]));
    await userEvent.type(field, " orders 2.4 · ORD-430 ");
    await userEvent.click(screen.getByRole("button", { name: "Зафиксировать" }));

    expect(versionsApi.create).toHaveBeenCalledWith("n1", "orders 2.4 · ORD-430");
    expect(await screen.findByText("Изменений с v4 нет")).toBeInTheDocument();
    expect(screen.queryByLabelText("Комментарий — номер версии, релиза или задачи")).toBeNull();
    expect(versionsApi.list).toHaveBeenCalledTimes(2);
  });

  it("Enter в поле подтверждает окно (поле однострочное, как в прототипе)", async () => {
    vi.mocked(versionsApi.create).mockResolvedValue(version(4));
    const field = await openFix();
    await userEvent.type(field, "ORD-430{Enter}");
    expect(versionsApi.create).toHaveBeenCalledWith("n1", "ORD-430");
  });

  it("отказ сервера (422) — текстом под полем, окно открыто", async () => {
    vi.mocked(versionsApi.create).mockRejectedValue(new ApiError(422, "Комментарий версии не может быть пустым"));
    const field = await openFix();
    await userEvent.type(field, "x");
    await userEvent.click(screen.getByRole("button", { name: "Зафиксировать" }));
    expect(await screen.findByText("Комментарий версии не может быть пустым")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Зафиксировать" })).toBeEnabled();
  });

  it("предел демо — как в прочих окнах: жирное начало и текст сервера", async () => {
    vi.mocked(versionsApi.create).mockRejectedValue(new ApiError(
      409, "Демо-проект поддерживает до 30 версий документации. Удалите ненужные, чтобы зафиксировать новые.", DEMO_LIMIT_CODE,
    ));
    const field = await openFix();
    await userEvent.type(field, "x");
    await userEvent.click(screen.getByRole("button", { name: "Зафиксировать" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Не сохранилось.").tagName).toBe("B");
    expect(alert).toHaveTextContent("Демо-проект поддерживает до 30 версий документации");
  });
});

describe("VersionsPanel: удаление версии", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(versionsApi.list).mockResolvedValue(list(three));
    vi.mocked(versionsApi.diff).mockResolvedValue(diff([item()], 1, 2));
  });

  it("не владельцу кнопки нет", async () => {
    renderPanel({ canDelete: false });
    await userEvent.click(await screen.findByRole("button", { name: /^v2/ }));
    await screen.findByRole("button", { name: /^Схема логики/ });
    expect(screen.queryByRole("button", { name: "Удалить версию" })).toBeNull();
  });

  it("владелец: подтверждение, «Отмена» ничего не удаляет, «Удалить» — удаляет и ведёт к списку", async () => {
    vi.mocked(versionsApi.remove).mockResolvedValue(undefined);
    renderPanel({ canDelete: true });
    await userEvent.click(await screen.findByRole("button", { name: /^v2/ }));

    await userEvent.click(await screen.findByRole("button", { name: "Удалить версию" }));
    expect(screen.getByText("Удалить версию 2?")).toBeInTheDocument();
    expect(screen.getByText("Остальные номера не меняются")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByText("Удалить версию 2?")).toBeNull();
    expect(versionsApi.remove).not.toHaveBeenCalled();

    vi.mocked(versionsApi.list).mockResolvedValue(list([version(3), version(1)]));
    await userEvent.click(screen.getByRole("button", { name: "Удалить версию" }));
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(versionsApi.remove).toHaveBeenCalledWith("n1", 2);
    await waitFor(() => expect(screen.getByText("2 версии")).toBeInTheDocument());
    expect(screen.queryByText("Удалить версию 2?")).toBeNull();
  });
});
