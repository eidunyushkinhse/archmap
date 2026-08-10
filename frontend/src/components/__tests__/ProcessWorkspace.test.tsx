// Воркспейс процессов: сигнал о мутации доходит ДО ОБОЛОЧКИ, а не только до рейла.
//
// Находка 2026-08-10: удалённое повисшее сообщение оставалось в знаке
// «Незавершённость схемы». Класс «Сообщения без связи» считается по сообщениям, а
// живут они здесь; знак же — отдельный экземпляр useSchemaAlerts в ProjectShell,
// который грузится один раз на маунте. Мутация канваса обновляла только список
// процессов в рейле и наверх не всплывала.
import { render, screen, waitFor } from "@testing-library/react";
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
