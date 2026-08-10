// Привязка непривязанного участника к узлу схемы: оркестрация ProcessCanvas.
//
// Два обещания пользователю, которые здесь и закреплены: расхождение имён показывается
// ДО записи (иначе имя из диаграммы исчезло бы молча) и итог подхвата каналов виден
// строкой (молча подхватить и промолчать значит скрыть, что часть шагов осталась
// сломанной). Сама диаграмма и пикер подменены — тестируем проводку.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import { nodesApi } from "../../api/nodes";
import type { ProcessDetail } from "../../types";

vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: { onBindParticipant?: (id: string) => void }) => (
    <button onClick={() => props.onBindParticipant?.("u")}>bind-u</button>
  ),
}));
vi.mock("../processes/ParticipantPicker", () => ({
  default: (props: { onAdd: (ids: string[]) => void }) => (
    <button onClick={() => props.onAdd(["node-x"])}>pick-node</button>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({
  processesApi: { get: vi.fn(), bindParticipant: vi.fn(), directions: vi.fn() },
}));
vi.mock("../../api/nodes", () => ({ nodesApi: { get: vi.fn() } }));

const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "u", node_id: null, name: "Биллинг", role: null, shape: null,
      is_external: null, status: null, order: 0 },
  ],
  messages: [],
  fragments: [],
} as unknown as ProcessDetail;

function renderCanvas() {
  return render(
    <ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />,
  );
}

beforeEach(() => {
  // vitest не чистит историю вызовов между тестами сам — иначе «отмена ничего не
  // записывает» проходил бы на вызовах предыдущего теста.
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([]);
  vi.mocked(processesApi.bindParticipant).mockResolvedValue({
    participant: DETAIL.participants[0], attached: 2, dangling: 1,
  });
});

async function openPicker() {
  renderCanvas();
  await screen.findByText("bind-u");
  await userEvent.click(screen.getByText("bind-u"));
  await userEvent.click(await screen.findByText("pick-node"));
}

describe("привязка участника: расхождение имён", () => {
  it("другое имя узла — сперва спрашиваем, ничего не записывая", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue({ name: "Платёжный сервис" } as never);

    await openPicker();

    await screen.findByText("Имена расходятся");
    expect(screen.getByText(/Биллинг/)).toBeTruthy();
    expect(screen.getByText(/Платёжный сервис/)).toBeTruthy();
    expect(processesApi.bindParticipant).not.toHaveBeenCalled();
  });

  it("подтверждение записывает привязку", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue({ name: "Платёжный сервис" } as never);
    await openPicker();
    await screen.findByText("Имена расходятся");

    await userEvent.click(screen.getByRole("button", { name: "Привязать" }));

    await waitFor(() =>
      expect(processesApi.bindParticipant).toHaveBeenCalledWith("p1", "u", "node-x"),
    );
  });

  it("отмена не записывает ничего", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue({ name: "Платёжный сервис" } as never);
    await openPicker();
    await screen.findByText("Имена расходятся");

    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(processesApi.bindParticipant).not.toHaveBeenCalled();
  });

  it("имена совпадают — привязываем сразу, без лишнего вопроса", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue({ name: "Биллинг" } as never);

    await openPicker();

    await waitFor(() =>
      expect(processesApi.bindParticipant).toHaveBeenCalledWith("p1", "u", "node-x"),
    );
    expect(screen.queryByText("Имена расходятся")).toBeNull();
  });
});

describe("привязка участника: итог подхвата каналов", () => {
  it("сводка показывает и подхваченное, и оставшееся сломанным", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue({ name: "Биллинг" } as never);

    await openPicker();

    await screen.findByText("Подхвачено каналов: 2, осталось без связи: 1");
  });

  it("когда всё подхватилось — про остаток не пишем", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue({ name: "Биллинг" } as never);
    vi.mocked(processesApi.bindParticipant).mockResolvedValue({
      participant: DETAIL.participants[0], attached: 3, dangling: 0,
    });

    await openPicker();

    await screen.findByText("Подхвачено каналов: 3");
  });

  it("подхватывать было нечего — сводки нет вовсе", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue({ name: "Биллинг" } as never);
    vi.mocked(processesApi.bindParticipant).mockResolvedValue({
      participant: DETAIL.participants[0], attached: 0, dangling: 0,
    });

    await openPicker();

    await waitFor(() => expect(processesApi.bindParticipant).toHaveBeenCalled());
    expect(screen.queryByText(/Подхвачено каналов/)).toBeNull();
  });
});
