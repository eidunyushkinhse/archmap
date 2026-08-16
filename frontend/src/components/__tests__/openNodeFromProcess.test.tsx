// Переход «процесс → страница объекта».
//
// П6 челленджа дизайна (2026-08-16): обратный переход есть (NodePage, секция
// «Участвует в процессах»), прямого не было вовсе — стоя в процессе, человек не мог
// провалиться в объект, который видит на диаграмме. Переход зеркальный и минимальный:
// стрелка на шапке линии жизни, id УЗЛА наружу, дальше оболочка сама переключает
// режим на «Объекты». У непривязанного участника узла нет — перехода у него быть
// не должно.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessWorkspace from "../processes/ProcessWorkspace";
import SequenceDiagram from "../processes/SequenceDiagram";
import { processesApi } from "../../api/processes";
import type { ProcessDetail, ProcessListItem } from "../../types";
import type { SeqParticipant } from "../processes/sequence/layout";

vi.mock("../MessageComposer", () => ({ default: () => null }));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
vi.mock("../processes/ProcessImportModal", () => ({ default: () => null }));
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../../api/processes", () => ({
  processesApi: { list: vi.fn(), get: vi.fn(), directions: vi.fn() },
}));
vi.mock("../../api/nodes", () => ({ nodesApi: { get: vi.fn() }, edgesApi: { update: vi.fn() } }));

// Привязанный участник: узел есть. Непривязанный: узла нет, открывать нечего.
const bound = (id: string, name: string): SeqParticipant => ({
  id, nodeId: "node-" + id, name, role: "сервис",
  shape: "service", external: false, status: "existing",
});
const unbound = (id: string, name: string): SeqParticipant => ({
  id, nodeId: null, name, role: null, shape: null, external: false, status: null,
});

const openBtns = () => screen.queryAllByRole("button", { name: /^Открыть страницу/ });

describe("линия жизни ведёт на страницу объекта", () => {
  it("у привязанного участника на шапке есть переход", () => {
    render(
      <SequenceDiagram
        participants={[bound("a", "Клиент"), unbound("u", "Биллинг")]}
        messages={[]}
        onOpenNode={vi.fn()}
      />,
    );
    expect(openBtns()).toHaveLength(1); // у непривязанного узла нет — перехода тоже
  });

  it("без обработчика перехода нет вовсе", () => {
    render(<SequenceDiagram participants={[bound("a", "Клиент")]} messages={[]} />);
    expect(openBtns()).toHaveLength(0);
  });

  it("наружу уходит id УЗЛА, а не участника", async () => {
    // Оболочке нужен узел: страница объекта адресуется node_id, а id участника
    // за пределами процесса не значит ничего.
    const onOpenNode = vi.fn();
    render(<SequenceDiagram participants={[bound("a", "Клиент")]} messages={[]} onOpenNode={onOpenNode} />);

    await userEvent.click(openBtns()[0]);

    expect(onOpenNode).toHaveBeenCalledWith("node-a");
  });

});

// Проводка «воркспейс → канвас → диаграмма»: без неё кнопка на шапке есть, а наружу
// ничего не доходит.
describe("переход доезжает от диаграммы до оболочки", () => {
  const DETAIL = {
    id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
    participants: [
      { id: "pa", node_id: "na", name: "Покупатель", role: null, shape: "service",
        is_external: false, status: "existing", order: 0 },
    ],
    messages: [],
    fragments: [],
  } as unknown as ProcessDetail;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processesApi.list).mockResolvedValue([
      {
        id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
        message_count: 0, participant_count: 1, statuses: [],
      } as unknown as ProcessListItem,
    ]);
    vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
    vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  });

  it("клик по шапке участника отдаёт узел наружу воркспейсом", async () => {
    const onOpenNode = vi.fn();
    render(<ProcessWorkspace isArchitect onOpenNode={onOpenNode} />);
    await screen.findByText("Покупатель");

    await userEvent.click(await screen.findByRole("button", { name: "Открыть страницу «Покупатель»" }));

    expect(onOpenNode).toHaveBeenCalledWith("na");
  });

  it("наблюдателю переход тоже доступен — навигация не правка", async () => {
    const onOpenNode = vi.fn();
    render(<ProcessWorkspace isArchitect={false} onOpenNode={onOpenNode} />);
    await screen.findByText("Покупатель");

    await userEvent.click(await screen.findByRole("button", { name: "Открыть страницу «Покупатель»" }));

    expect(onOpenNode).toHaveBeenCalledWith("na");
  });
});
