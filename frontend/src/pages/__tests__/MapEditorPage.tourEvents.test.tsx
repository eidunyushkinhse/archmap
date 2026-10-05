// Шина тура (docs/tasks/demo-tour.md) из редактора-карты: показан слой (после
// загрузки — и при входе внутрь, и при возврате наверх), создана связь, конец связи
// перевешен с рамки и сохранён; в обратную сторону — тур просит открыть слой
// (возврат из паузы, docs/tasks/demo-tour-pause.md). Холст, окна и поллинг — заглушки.
import { render as rtlRender, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import MapEditorPage from "../MapEditorPage";
import { edgesApi, nodesApi } from "../../api/nodes";
import { ProjectRoleContext } from "../projectRole";
import { onTourEvent, requestTourLevel, type TourBusEvent } from "../../components/tour/tourBus";
import type { Edge, Node } from "../../types";

function render(ui: ReactElement) {
  return rtlRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ProjectRoleContext.Provider value="owner">{children}</ProjectRoleContext.Provider>
    ),
  });
}
vi.mock("../../api/nodes", () => ({
  nodesApi: {
    getGraph: vi.fn(), getAll: vi.fn(), deletionSnapshot: vi.fn(), moveSnapshot: vi.fn(),
    delete: vi.fn(), restore: vi.fn(), update: vi.fn(), getDescendants: vi.fn(),
  },
  nodeDocsApi: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  edgesApi: { update: vi.fn(), delete: vi.fn(), deletionSnapshot: vi.fn() },
}));
vi.mock("../../components/graph/interaction/useHistory", () => ({
  useHistory: () => ({
    canUndo: () => false, canRedo: () => false, peekUndo: () => undefined, peekRedo: () => undefined,
    undo: vi.fn(), redo: vi.fn(), push: vi.fn(), clear: vi.fn(),
  }),
}));
vi.mock("../useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../useSchemaAlerts", () => ({
  useSchemaAlerts: () => ({
    alerts: { disconnected_nodes: [], intermediate_edges: [], isolated_groups: [], container_own_docs: [] },
    loaded: true,
    reload: vi.fn(),
  }),
  resolveAlertLocate: vi.fn(),
  PENDING_ALERT_LOCATE_KEY: "archmap.pendingAlertLocate",
  PENDING_PROCESS_KEY: "archmap.pendingProcess",
}));
vi.mock("../../components/graph/interaction/useEdgeChoice", () => ({
  useEdgeChoice: () => ({ onEdgesChoice: vi.fn(), onTrunkChoice: vi.fn(), choiceModal: null }),
}));
const levelGraphProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../components/LevelGraph", () => ({
  default: (props: Record<string, unknown>) => {
    levelGraphProps.current = props;
    return <div data-testid="level-graph" />;
  },
}));
vi.mock("../../components/NodeTreePanel", () => ({ default: () => <div /> }));
vi.mock("../../components/inspector/ObjectInspector", () => ({ default: () => <div /> }));
vi.mock("../../components/CrossLevelEdgePicker", () => ({ default: () => null }));
// Окно связи: кнопка «создано» отдаёт готовую связь, как настоящий onCreated.
const CREATED: Edge = {
  id: "e1", label: "Покупает", technology: null, source_id: "p1", target_id: "s1", version: 1, created_at: "",
};
vi.mock("../../components/EdgeQuickCreate", () => ({
  default: ({ onCreated }: { onCreated: (e: Edge) => void }) => (
    <button onClick={() => onCreated(CREATED)}>создано</button>
  ),
}));
vi.mock("../../components/NodeModal", () => ({ default: () => null }));
vi.mock("../../components/NodeDeleteConfirm", () => ({ default: () => null }));
vi.mock("../../components/NodesDeleteConfirm", () => ({ default: () => null }));
vi.mock("../../components/RelayoutConfirm", () => ({ default: () => null }));
vi.mock("../../components/SchemaAlerts", () => ({ default: () => null }));
vi.mock("../../components/SchemaViewFilter", () => ({ SchemaViewFilter: () => null }));

const graph = () => ({ nodes: [], endpoints: [], edges: [], layout: {}, version: 1, graph_rev: 1, meta_rev: 1 });
const props = { projectId: "p1", nodeId: null, onDone: vi.fn(), onAllProjects: vi.fn(), onNavigateNode: vi.fn() };
const sys = { id: "s1", name: "Касса", parent_id: null, is_external: false } as Node;

type Cb = Record<string, (...a: unknown[]) => void>;
const cb = (bundle: string) => (levelGraphProps.current?.[bundle] ?? {}) as Cb;

const events: TourBusEvent[] = [];
let off: () => void = () => {};

describe("MapEditorPage — события тура", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    levelGraphProps.current = null;
    events.length = 0;
    off = onTourEvent((e) => { events.push(e); });
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
    vi.mocked(edgesApi.update).mockResolvedValue(CREATED as never);
  });
  afterEach(() => off());

  it("слой: корень после загрузки, вход внутрь системы, возврат по «Проект»", async () => {
    render(<MapEditorPage {...props} />);
    await waitFor(() => expect(events).toContainEqual({ type: "level", levelId: null }));
    events.length = 0;
    act(() => cb("drill").onDrillDown(sys));
    await waitFor(() => expect(events).toContainEqual({ type: "level", levelId: "s1" }));
    events.length = 0;
    fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
    await waitFor(() => expect(events).toContainEqual({ type: "level", levelId: null }));
  });

  it("тур просит слой (продолжение после паузы) — редактор открывает его и обратно корень", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([sys]);
    render(<MapEditorPage {...props} />);
    await waitFor(() => expect(events).toContainEqual({ type: "level", levelId: null }));
    events.length = 0;
    act(() => requestTourLevel("s1"));
    await waitFor(() => expect(events).toContainEqual({ type: "level", levelId: "s1" }));
    expect(nodesApi.getGraph).toHaveBeenLastCalledWith("s1");
    expect(await screen.findByRole("button", { name: "Касса" })).toBeInTheDocument(); // крошка слоя
    events.length = 0;
    act(() => requestTourLevel(null));
    await waitFor(() => expect(events).toContainEqual({ type: "level", levelId: null }));
  });

  it("создана связь — «edge-created» с её концами", async () => {
    render(<MapEditorPage {...props} />);
    await screen.findByTestId("level-graph");
    act(() => cb("edgeCallbacks").onCreateEdge("p1", "s1", null, null));
    fireEvent.click(await screen.findByRole("button", { name: "создано" }));
    expect(events).toContainEqual({ type: "edge-created", id: "e1", sourceId: "p1", targetId: "s1" });
  });

  it("конец связи перевешен с рамки и сохранён — «edge-reconnected»", async () => {
    render(<MapEditorPage {...props} />);
    await screen.findByTestId("level-graph");
    act(() => cb("edgeCallbacks").onReconnectFrameEnd(["e1"], "target", "s1", "c1"));
    await waitFor(() => expect(events).toContainEqual({ type: "edge-reconnected", fromId: "s1", toId: "c1" }));
    expect(edgesApi.update).toHaveBeenCalledWith("e1", { target_id: "c1" });
  });
});
