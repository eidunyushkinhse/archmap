// Поллинг курсора процессов (Ф6 эпика «процессы → доки шага», Д9): чужая сессия
// правит процесс — воркспейс замечает рост process_rev, перечитывает список и дёргает
// холст (syncRev). Курсор СВОЙ: meta_rev дал бы ложный тост странице объекта,
// graph_rev — ложный рефетч уровня канвасу. Эхо своей правки не подавляется
// сознательно: цена — один лишний идемпотентный GET, не рефетч тяжёлого уровня.
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import ProcessWorkspace from "../processes/ProcessWorkspace";
import { processesApi } from "../../api/processes";
import { viewsApi } from "../../api/nodes";
import { POLL_MS } from "../../pages/useRemoteSync";

// Холст подменён индикатором syncRev: тестируем поллинг, а не диаграмму.
vi.mock("../processes/ProcessCanvas", () => ({
  default: (props: { syncRev?: number }) => <div data-testid="canvas">{props.syncRev}</div>,
}));
vi.mock("../processes/ProcessRail", () => ({ default: () => null }));
vi.mock("../processes/ProcessImportModal", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({ processesApi: { list: vi.fn() } }));
vi.mock("../../api/nodes", () => ({ viewsApi: { state: vi.fn() } }));

const состояние = (rev: number) =>
  ({ version: 0, graph_rev: 0, meta_rev: 0, process_rev: rev });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(processesApi.list).mockResolvedValue(
    [{ id: "p1", name: "Оплата", participants: 1, messages: 1 }] as never);
  vi.mocked(viewsApi.state).mockResolvedValue(состояние(5) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("поллинг процессов (process_rev)", () => {
  it("рост курсора перечитывает список и дёргает холст, тишина — нет", async () => {
    render(<ProcessWorkspace isArchitect />);
    // Маунт: загрузка списка + немедленный тик запоминает стартовый курсор.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(processesApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("canvas").textContent).toBe("0");

    // Тихий тик: курсор не вырос — рефетча нет.
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(processesApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("canvas").textContent).toBe("0");

    // Чужая правка: курсор вырос → список перечитан, холсту дёрнут syncRev.
    vi.mocked(viewsApi.state).mockResolvedValue(состояние(6) as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(processesApi.list).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("canvas").textContent).toBe("1");
  });

  it("первый тик только запоминает курсор — стартовое значение не считается чужой правкой", async () => {
    render(<ProcessWorkspace isArchitect />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Курсор уже был 5 на маунте — рефетчей сверх первичной загрузки нет.
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2); });
    expect(processesApi.list).toHaveBeenCalledTimes(1);
  });
});
