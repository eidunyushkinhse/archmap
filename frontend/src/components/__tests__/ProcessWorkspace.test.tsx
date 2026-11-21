// Воркспейс процессов: сигнал о мутации доходит ДО ОБОЛОЧКИ, а не только до рейла.
//
// Находка 2026-08-10: удалённое повисшее сообщение оставалось в знаке
// «Незавершённость схемы». Класс «Незадокументированные сообщения» считается по сообщениям, а
// живут они здесь; знак же — отдельный экземпляр useSchemaAlerts в ProjectShell,
// который грузится один раз на маунте. Мутация канваса обновляла только список
// процессов в рейле и наверх не всплывала.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ProcessWorkspace from "../processes/ProcessWorkspace";
import { processesApi } from "../../api/processes";
import type { ProcessListItem } from "../../types";

// Канвас подменяем кнопкой, дёргающей его onChanged: тестируем проводку, а не
// диаграмму (её механика — в других тестах и в pytest бэка).
const canvasChanged = vi.hoisted(() => ({ fire: null as null | (() => void) }));
vi.mock("../processes/ProcessCanvas", () => ({
  default: (props: { onChanged: () => void }) => {
    canvasChanged.fire = props.onChanged;
    return <div data-testid="canvas" />;
  },
}));
vi.mock("../../api/processes", () => ({
  processesApi: { list: vi.fn(), get: vi.fn(), remove: vi.fn(), duplicate: vi.fn(), create: vi.fn() },
}));

const PROCESS: ProcessListItem = {
  id: "p1",
  name: "Оформление заказа",
  scope_node_id: null,
  scope_name: null,
  message_count: 3,
  participant_count: 2,
  statuses: [],
} as unknown as ProcessListItem;

describe("ProcessWorkspace: сигнал мутации наверх", () => {
  it("мутация канваса и перечитывает список, и уведомляет оболочку", async () => {
    vi.mocked(processesApi.list).mockResolvedValue([PROCESS]);
    const onChanged = vi.fn();
    render(<ProcessWorkspace isArchitect onChanged={onChanged} />);
    await screen.findByTestId("canvas");
    const listCalls = vi.mocked(processesApi.list).mock.calls.length;

    canvasChanged.fire?.();

    // Рейл перечитывается (счётчик сообщений мог измениться)…
    await waitFor(() =>
      expect(vi.mocked(processesApi.list).mock.calls.length).toBe(listCalls + 1),
    );
    // …и оболочка узнаёт, что в проекте что-то изменилось (знак алертов протух).
    expect(onChanged).toHaveBeenCalled();
  });

  it("без обработчика от родителя не падает", async () => {
    vi.mocked(processesApi.list).mockResolvedValue([PROCESS]);
    render(<ProcessWorkspace isArchitect />);
    await screen.findByTestId("canvas");

    expect(() => canvasChanged.fire?.()).not.toThrow();
  });
});

// Редизайн, фаза 3а: «Новый процесс» больше не создаёт запись сразу. В рейле появляется
// строка с полем имени; до Enter в базе ничего нет.
describe("ProcessWorkspace: новый процесс — только после ввода имени", () => {
  async function startCreate() {
    vi.mocked(processesApi.list).mockResolvedValue([PROCESS]);
    vi.mocked(processesApi.create).mockReset();
    vi.mocked(processesApi.create).mockResolvedValue({ id: "p2", name: "Возврат" } as never);
    render(<ProcessWorkspace isArchitect />);
    await screen.findByTestId("canvas");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    // «Импорт из Mermaid» — первым: главный путь процесса — черновик от агента.
    expect(items).toEqual(["Импорт из Mermaid", "Новый процесс"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Новый процесс" }));
    return screen.getByRole("textbox", { name: "Имя нового процесса" });
  }

  it("Enter с именем создаёт процесс с этим именем", async () => {
    const field = await startCreate();
    expect(processesApi.create).not.toHaveBeenCalled();
    await userEvent.type(field, "  Возврат {Enter}");
    await waitFor(() => expect(processesApi.create).toHaveBeenCalledWith({ name: "Возврат" }));
    expect(screen.queryByRole("textbox", { name: "Имя нового процесса" })).toBeNull();
  });

  it("Escape отменяет: ничего не создано, строки нет", async () => {
    const field = await startCreate();
    await userEvent.type(field, "Возв");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Имя нового процесса" })).toBeNull();
    expect(processesApi.create).not.toHaveBeenCalled();
  });

  it("уход с пустым полем отменяет", async () => {
    const field = await startCreate();
    fireEvent.blur(field);
    expect(screen.queryByRole("textbox", { name: "Имя нового процесса" })).toBeNull();
    expect(processesApi.create).not.toHaveBeenCalled();
  });
});

describe("ProcessWorkspace: читатель", () => {
  it("в рейле нет «Добавить» и меню строки; пустой проект — одна строка", async () => {
    vi.mocked(processesApi.list).mockResolvedValue([PROCESS]);
    const { unmount } = render(<ProcessWorkspace isArchitect={false} />);
    await screen.findByTestId("canvas");
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
    expect(screen.queryByTitle("Действия")).toBeNull();
    // Строка процесса — одно название, полное имя в подсказке.
    expect(screen.getByTitle("Оформление заказа").textContent).toBe("Оформление заказа");
    unmount();

    vi.mocked(processesApi.list).mockResolvedValue([]);
    render(<ProcessWorkspace isArchitect={false} />);
    expect(await screen.findByText("Процессов пока нет.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("редактору пустой проект предлагает «Добавить»", async () => {
    vi.mocked(processesApi.list).mockResolvedValue([]);
    render(<ProcessWorkspace isArchitect />);
    expect(await screen.findByText("Процессов пока нет.")).toBeInTheDocument();
    // Две «Добавить»: сверху рейла и в строке пустого экрана.
    expect(screen.getAllByRole("button", { name: "Добавить" })).toHaveLength(2);
  });
});
