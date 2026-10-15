// Порядок чтений процесса (аудит F-49): применяется ответ ПОСЛЕДНЕГО начатого чтения —
// поздний ответ раннего не перетирает свежее; значение счётчика чужих правок на маунте
// не вызывает второго чтения (его покрывает первичная загрузка).
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import type { ProcessDetail } from "../../types";

// Диаграмма подменена пультом: кнопки открывают ровно те оверлеи, что и настоящая.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: {
    onMessageClick?: (id: string) => void;
    onFragmentClick?: (id: string) => void;
    onEditBranch?: (id: string, index: number | null) => void;
    onSelfConnect?: (id: string) => void;
  }) => (
    <div>
      <button onClick={() => props.onMessageClick?.("m1")}>click-m1</button>
      <button onClick={() => props.onFragmentClick?.("f1")}>click-f1</button>
      <button onClick={() => props.onEditBranch?.("f1", null)}>click-branch</button>
      <button onClick={() => props.onSelfConnect?.("pa")}>click-self</button>
    </div>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
const histUndo = vi.fn();
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: vi.fn(), undo: histUndo, redo: vi.fn(),
    canUndo: true, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(), addMessage: vi.fn(), updateMessage: vi.fn(),
    removeMessage: vi.fn(), removeParticipant: vi.fn(), reattach: vi.fn(), detachMessages: vi.fn(),
    removeFragment: vi.fn(), updateFragment: vi.fn(),
    // Карточка шага лениво тянет каталог схем для привязки — без заглушки её эффект
    // падает, и Escape тестировать не на чем.
    messageDocs: vi.fn().mockResolvedValue({ default_node_id: null, docs: [] }),
  },
}));
vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn() },
  edgesApi: { update: vi.fn() },
}));

const MSG = {
  edge_id: "e1", leg: "forward", kind: "forward", technology: null, valid: true,
  edge_synchronous: true, from_participant_id: "pa", to_participant_id: "pb",
};
const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "pa", node_id: "na", name: "Покупатель", role: null, shape: "service",
      is_external: false, status: "existing", order: 0 },
    { id: "pb", node_id: "nb", name: "Заказы", role: null, shape: "service",
      is_external: false, status: "existing", order: 1 },
  ],
  messages: [
    { ...MSG, id: "m1", order: 0, caption: "создать заказ" },
    { ...MSG, id: "m2", order: 1, caption: null },
  ],
  fragments: [{ id: "f1", kind: "alt", from_order: 0, to_order: 1, guard: "оплата прошла", branches: [] }],
} as unknown as ProcessDetail;

function canvas(syncRev: number) {
  return <ProcessCanvas id="p1" isArchitect editing={false} onToggleEditing={vi.fn()} onChanged={vi.fn()} syncRev={syncRev} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
});

describe("чтения процесса по порядку", () => {
  it("поздний ответ раннего чтения не перетирает свежий процесс", async () => {
    const { rerender } = render(canvas(0));
    expect(await screen.findByText("Оплата")).toBeInTheDocument();

    let ответРаннего: (d: ProcessDetail) => void = () => {};
    let ответПозднего: (d: ProcessDetail) => void = () => {};
    vi.mocked(processesApi.get)
      .mockImplementationOnce(() => new Promise((r) => { ответРаннего = r; }))
      .mockImplementationOnce(() => new Promise((r) => { ответПозднего = r; }));
    // Две чужие правки подряд — два чтения в полёте.
    rerender(canvas(1));
    rerender(canvas(2));

    await act(async () => { ответПозднего({ ...DETAIL, name: "Оплата v3" }); });
    expect(await screen.findByText("Оплата v3")).toBeInTheDocument();
    await act(async () => { ответРаннего({ ...DETAIL, name: "Оплата v2" }); });

    expect(screen.getByText("Оплата v3")).toBeInTheDocument();
    expect(screen.queryByText("Оплата v2")).toBeNull();
  });

  it("счётчик чужих правок на маунте второго чтения не вызывает", async () => {
    render(canvas(5));
    expect(await screen.findByText("Оплата")).toBeInTheDocument();
    expect(processesApi.get).toHaveBeenCalledTimes(1);
  });
});
