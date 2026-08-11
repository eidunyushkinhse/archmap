// Общий harness для characterization-тестов ОРКЕСТРАЦИИ LevelGraphInner.
//
// Идея: LevelGraph.tsx — god-компонент, чья ценность — в СКЛЕЙКЕ (оркестрации):
// какие колбэк-пропсы и с какими аргументами зовутся при каких условиях. Чтобы
// тестировать именно склейку, а не тяжёлый конвейер раскладки и не внутренности
// React Flow, harness подменяет:
//   • @xyflow/react         — контролируемый RF-стейт + vi.fn для useReactFlow;
//   • конвейер раскладки     — детерминированный результат (pipelineClient/layoutSig);
//   • assembleRfGraph        — захват getCb (доступ к оркестрационным колбэкам);
//   • тяжёлые interaction-хуки — заглушки (snap/animation/liveDrag/frameFollow/…);
//   • реестры узлов/рёбер и оверлеи — null-компоненты (рендер RF всё равно null).
//
// Продакшн-код при этом НЕ меняется: тестируются настоящие commitLayout,
// persistFenced, commitExpanded, drillWithPath, quickConnectHandlers, эффекты
// locate/linked-highlight — они живут в LevelGraphInner и идут через cbRef/getCb.
//
// vi.mock-регистрации живут в самих тест-файлах (hoisting); фабрики через
// `await import("./levelGraphHarness")` берут реализации отсюда. Модуль — синглтон,
// поэтому состояние (vi.fn, captured, handles) общее у фабрик и у тестов.
//
// Это тестовый harness, а не модуль приложения: смешанный экспорт (mock-компоненты
// + vi.fn + хелперы) — fast-refresh неприменим.
/* eslint-disable react-refresh/only-export-components */
import { vi } from "vitest";
import { act } from "@testing-library/react";
import { useEffect, useState, useCallback, type ReactNode } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { Node as AppNode, AncestorRef, ViewLayoutPayload } from "../../types";
import type { QuickConnectHandlers } from "../graph/types";
import type { CommitOrigin } from "../graph/interaction/persistGuard";
import type { PipelineOutput } from "../graph/layout/pipeline";

// ---------------------------------------------------------------------------
// useReactFlow: общие vi.fn (тесты ассертят центрирование/фит).
// ---------------------------------------------------------------------------
export const rf = {
  setCenter: vi.fn(),
  fitBounds: vi.fn(),
  fitView: vi.fn(),
  // По умолчанию узел без «внутренностей» → rectOf в locate берёт n.position/NODE_W.
  getInternalNode: vi.fn((_id: string) => undefined),
  getNodes: vi.fn((): RFNode[] => []),
  getEdges: vi.fn((): RFEdge[] => []),
  screenToFlowPosition: vi.fn((p: { x: number; y: number }) => p),
};

// Ручки управления контролируемым RF-стейтом (rfNodes/rfEdges) из тестов.
export const rfHandles: {
  setNodes?: (n: RFNode[]) => void;
  setEdges?: (e: RFEdge[]) => void;
} = {};

// ---------------------------------------------------------------------------
// Перехват getCb из assembleRfGraph — единственный внешний доступ к живым
// оркестрационным колбэкам LevelGraphInner (cbRef.current).
// ---------------------------------------------------------------------------
export interface TestCb {
  onDrillDown: (n: AppNode) => void;
  drillWithPath: (n: AppNode) => void;
  onEnterNode?: (path: AncestorRef[]) => void;
  onEditNode: (n: AppNode) => void;
  onInspectGhost?: (g: AppNode) => void;
  onClearSelection?: () => void;
  expandContainer: (id: string) => void;
  expandLocalContainer: (id: string) => void;
  collapseContainer: (id: string) => void;
  openEdgeMembers: (ids: string[]) => void;
  openTrunkMembers: (kind: "out" | "in", ids: string[]) => boolean;
  commitLayout: (
    patch: Record<string, Partial<ViewLayoutPayload> | null>,
    origin?: CommitOrigin,
    isRetry?: boolean,
  ) => boolean;
  quickConnect: QuickConnectHandlers;
}

export const captured: { getCb?: () => TestCb } = {};

// ---------------------------------------------------------------------------
// Управляемый результат конвейера раскладки (по умолчанию — пустой уровень без
// побочных интентов). Тесты мутируют pipeline.result ПЕРЕД render.
// ---------------------------------------------------------------------------
export const pipeline: { result: PipelineOutput } = {
  result: {
    layout: {
      nodes: [],
      entities: [],
      positions: new Map(),
      edgeHandles: new Map(),
      guestFrames: [],
    frameEnds: [],
      groupArr: [],
      spacers: [],
    },
    liveInputs: { layoutEdges: [], nodeIds: [], localIds: new Set<string>() },
    intents: [],
    routeSig: "",
  },
};

// Счётчик сигнатур: каждый прогон «применяется» (sig уникален → нет skip).
let sigCounter = 0;

// ---------------------------------------------------------------------------
// Сброс общего состояния между тестами (зовётся в beforeEach).
// ---------------------------------------------------------------------------
export function resetHarness(): void {
  sigCounter = 0;
  captured.getCb = undefined;
  rfProps.current = {};
  rfHandles.setNodes = undefined;
  rfHandles.setEdges = undefined;
  pipeline.result = {
    layout: {
      nodes: [],
      entities: [],
      positions: new Map(),
      edgeHandles: new Map(),
      guestFrames: [],
    frameEnds: [],
      groupArr: [],
      spacers: [],
    },
    liveInputs: { layoutEdges: [], nodeIds: [], localIds: new Set<string>() },
    intents: [],
    routeSig: "",
  };
  rf.setCenter.mockReset();
  rf.fitBounds.mockReset();
  rf.fitView.mockReset();
  rf.getInternalNode.mockReset().mockReturnValue(undefined);
  rf.getNodes.mockReset().mockReturnValue([]);
  rf.getEdges.mockReset().mockReturnValue([]);
  rf.screenToFlowPosition.mockReset().mockImplementation((p) => p);
  for (const m of ALL_MOCK_FNS) m.mockReset();
  // Дефолты, от которых зависит поведение (возвраты заглушек).
  snapMock.handleNodeDragStop.mockReturnValue(false);
  snapMock.handleSelectionDragStop.mockReturnValue(false);
  historyMock.undo.mockReturnValue(true);
  historyMock.redo.mockReturnValue(true);
  historyMock.canUndo.mockReturnValue(false);
  historyMock.canRedo.mockReturnValue(false);
  edgeConnectMock.isValidNewConnection.mockReturnValue(true);
  apiNodesMock.viewsApi.saveLayout.mockResolvedValue({ version: 2, graph_rev: 2 });
  apiNodesMock.viewsApi.state.mockResolvedValue({ version: 0, graph_rev: 0, meta_rev: 0 });
  apiNodesMock.nodesApi.list.mockResolvedValue([]);
  pipelineClientMock.computeViewLayoutOffThread.mockImplementation(() =>
    Promise.resolve(pipeline.result),
  );
}

// ---------------------------------------------------------------------------
// МОК @xyflow/react
// ---------------------------------------------------------------------------
// Пропсы, отданные в <ReactFlow>: единственный доступ к жестам самого холста
// (onReconnect и т.п.) — они не проходят через getCb.
export const rfProps: { current: Record<string, unknown> } = { current: {} };

function MockReactFlow(props: Record<string, unknown>): null {
  // Дети (Background/Controls/ViewportPortal/…) не монтируются — оркестрация
  // тестируется через колбэки, а не через DOM React Flow.
  useEffect(() => { rfProps.current = props; });
  return null;
}
function MockProvider({ children }: { children?: ReactNode }): ReactNode {
  return <>{children}</>;
}
function MockPortal({ children }: { children?: ReactNode }): ReactNode {
  return <>{children}</>;
}
function MockNull(): null {
  return null;
}

function useNodesStateMock(initial: RFNode[]) {
  const [nodes, setNodes] = useState<RFNode[]>(initial);
  // setter из useState стабилен — публикуем ручку один раз (тесты рулят rfNodes).
  useEffect(() => {
    rfHandles.setNodes = setNodes;
  }, [setNodes]);
  const onNodesChange = useCallback(() => {}, []);
  return [nodes, setNodes, onNodesChange] as const;
}
function useEdgesStateMock(initial: RFEdge[]) {
  const [edges, setEdges] = useState<RFEdge[]>(initial);
  useEffect(() => {
    rfHandles.setEdges = setEdges;
  }, [setEdges]);
  const onEdgesChange = useCallback(() => {}, []);
  return [edges, setEdges, onEdgesChange] as const;
}

export const xyflowMock = {
  ReactFlow: MockReactFlow,
  ReactFlowProvider: MockProvider,
  Background: MockNull,
  Controls: MockNull,
  ViewportPortal: MockPortal,
  Handle: MockNull,
  BackgroundVariant: { Dots: "dots", Lines: "lines", Cross: "cross" },
  ConnectionMode: { Loose: "loose", Strict: "strict" },
  SelectionMode: { Partial: "partial", Full: "full" },
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  MarkerType: { Arrow: "arrow", ArrowClosed: "arrowclosed" },
  getSmoothStepPath: () => [[], 0, 0, 0],
  useNodesState: useNodesStateMock,
  useEdgesState: useEdgesStateMock,
  useReactFlow: () => rf,
};

// ---------------------------------------------------------------------------
// МОК API (nodesApi/viewsApi). saveLayout по умолчанию успешен; тесты переигрывают
// его на reject(ApiError(409)) для проверки политики конфликтов.
// ---------------------------------------------------------------------------
export const apiNodesMock = {
  nodesApi: {
    list: vi.fn((_parentId?: string | null): Promise<AppNode[]> => Promise.resolve([])),
    getGraph: vi.fn(),
    getAll: vi.fn(),
    get: vi.fn(),
    getChildren: vi.fn(),
    getDescendants: vi.fn(),
  },
  viewsApi: {
    saveLayout: vi.fn(
      (
        _viewId: string | null,
        _items: Record<string, ViewLayoutPayload | null>,
        _baseVersion?: number,
      ): Promise<{ version: number; graph_rev: number }> =>
        Promise.resolve({ version: 2, graph_rev: 2 }),
    ),
    state: vi.fn((): Promise<{ version: number; graph_rev: number; meta_rev: number }> =>
      Promise.resolve({ version: 0, graph_rev: 0, meta_rev: 0 }),
    ),
  },
};

// ---------------------------------------------------------------------------
// МОК конвейера раскладки и сигнатуры.
// ---------------------------------------------------------------------------
export const pipelineClientMock = {
  computeViewLayoutOffThread: vi.fn((_input: unknown): Promise<PipelineOutput> =>
    Promise.resolve(pipeline.result),
  ),
};
export const layoutSigMock = {
  layoutSig: (_layout: unknown): string => `sig-${sigCounter++}`,
};

// ---------------------------------------------------------------------------
// МОК assembleRfGraph: захват getCb, пустая сборка (RF-стейт контролирует тест).
// ---------------------------------------------------------------------------
export const assembleRfMock = {
  assembleRfGraph: (args: { getCb: () => TestCb }): { nextNodes: RFNode[]; nextEdges: RFEdge[] } => {
    captured.getCb = args.getCb;
    return { nextNodes: [], nextEdges: [] };
  },
};

// ---------------------------------------------------------------------------
// МОК тяжёлых interaction-хуков (изоляции оркестрации от драга/анимации/снапов).
// ---------------------------------------------------------------------------
export const layoutAnimMock = {
  apply: vi.fn(),
  noteExpand: vi.fn(),
  noteCollapse: vi.fn(),
  noteRelayout: vi.fn(),
  noteGesture: vi.fn(),
  noteMutation: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
};
export const useLayoutAnimationMock = {
  useLayoutAnimation: () => ({ ...layoutAnimMock, active: false, jumpsPaused: false }),
};

export const snapMock = {
  handleNodesChange: vi.fn(),
  handleNodeDragStop: vi.fn((): boolean => false),
  handleSelectionDragStop: vi.fn((): boolean => false),
  noteDragStart: vi.fn(),
};
export const useSnapAlignmentMock = { useSnapAlignment: () => snapMock };

export const liveDragMock = { begin: vi.fn(), move: vi.fn(), end: vi.fn(), restore: vi.fn() };
export const useLiveDragHandlesMock = { useLiveDragHandles: () => liveDragMock };

export const frameFollowMock = {
  snapshotPads: vi.fn(),
  begin: vi.fn(),
  follow: vi.fn(),
  finalize: vi.fn(),
  overlay: null as ReactNode,
};
export const useFrameFollowOverlayMock = { useFrameFollowOverlay: () => frameFollowMock };

export const canvasDeleteMock = { handleKeyDown: vi.fn() };
export const useCanvasDeleteMock = { useCanvasDelete: () => canvasDeleteMock };

export const templateDropMock = {
  dropPreview: null,
  dropTargetFrame: null,
  handleDragOver: vi.fn(),
  handleDragLeave: vi.fn(),
  handleDrop: vi.fn(),
};
export const useTemplateDropMock = { useTemplateDrop: () => templateDropMock };

export const alignmentGuidesMock = {
  guides: { x: null, y: null, spacing: [] as never[] },
  setGuides: vi.fn(),
  clearGuides: vi.fn(),
};
export const useAlignmentGuidesMock = { useAlignmentGuides: () => alignmentGuidesMock };

export const historyMock = {
  push: vi.fn(),
  undo: vi.fn((): boolean => true),
  redo: vi.fn((): boolean => true),
  peekUndo: vi.fn(() => undefined),
  peekRedo: vi.fn(() => undefined),
  canUndo: vi.fn((): boolean => false),
  canRedo: vi.fn((): boolean => false),
  beginGroup: vi.fn(),
  commitGroup: vi.fn(),
  clear: vi.fn(),
};
export const useHistoryMock = { useHistory: () => historyMock };

// useEdgeConnect: возвращает заглушку, но ЗАХВАТЫВАЕТ параметры (onCreate/onInto/
// onExitUp) — так тестируется проводка «жест связи → колбэк-пропс».
export interface EdgeConnectParams {
  isArchitect: boolean;
  disabled: boolean;
  resolveTarget: (nodeId: string) => { kind: "direct" } | { kind: "into"; name: string } | null;
  onCreate?: (s: string, t: string, sh: string | null, th: string | null) => void;
  onInto?: (s: string, cid: string, cname: string, sh: string | null) => void;
  onExitUp?: (s: string, sh: string | null) => void;
}
export const edgeConnectMock = {
  connecting: false,
  handleConnectStart: vi.fn(),
  handleConnect: vi.fn(),
  handleConnectEnd: vi.fn(),
  isValidNewConnection: vi.fn((): boolean => true),
};
export const edgeConnectParams: { current?: EdgeConnectParams } = {};
export const useEdgeConnectMock = {
  useEdgeConnect: (params: EdgeConnectParams) => {
    edgeConnectParams.current = params;
    return edgeConnectMock;
  },
};

// ---------------------------------------------------------------------------
// МОК реестров узлов/рёбер и оверлеев (рендер RF = null, они не монтируются, но
// импорт тяжёлый — глушим).
// ---------------------------------------------------------------------------
export const nodesRegistryMock = { nodeTypes: {} };
export const edgesRegistryMock = { edgeTypes: {} };
export const shapesMock = { NodeShapeSvg: MockNull };
export const connectionLineMock = { default: MockNull };
export const boundariesMock = { LevelBoundary: MockNull, AlignmentGuides: MockNull };
export const quickConnectPreviewMock = { default: MockNull };
export const edgeJumpMock = {
  EdgeJumpProvider: ({ children }: { children?: ReactNode }): ReactNode => <>{children}</>,
};

// ---------------------------------------------------------------------------
// Оседание async-раскладки: конвейер (pipelineClient) резолвится микрозадачей,
// эффект сборки ловит getCb. При fake timers микрозадачи + таймеры двигаем явно.
// ---------------------------------------------------------------------------
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    // Последовательные (не параллельные) прогоны effect-цикла React.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

// Прогнать requestAnimationFrame + короткий setTimeout (flash-подсветка locate/
// linked-highlight вешаются через rAF). sinon fake-timers считает rAF за ~16мс.
export async function flushRaf(ms = 60): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Реестр всех vi.fn для сброса в resetHarness (единый список).
const ALL_MOCK_FNS = [
  layoutAnimMock.apply, layoutAnimMock.noteExpand, layoutAnimMock.noteCollapse,
  layoutAnimMock.noteGesture, layoutAnimMock.cancel, layoutAnimMock.reset,
  snapMock.handleNodesChange, snapMock.handleNodeDragStop,
  snapMock.handleSelectionDragStop, snapMock.noteDragStart,
  liveDragMock.begin, liveDragMock.move, liveDragMock.end, liveDragMock.restore,
  frameFollowMock.snapshotPads, frameFollowMock.begin, frameFollowMock.follow,
  frameFollowMock.finalize,
  canvasDeleteMock.handleKeyDown,
  templateDropMock.handleDragOver, templateDropMock.handleDragLeave, templateDropMock.handleDrop,
  alignmentGuidesMock.setGuides, alignmentGuidesMock.clearGuides,
  historyMock.push, historyMock.undo, historyMock.redo, historyMock.peekUndo,
  historyMock.peekRedo, historyMock.canUndo, historyMock.canRedo,
  historyMock.beginGroup, historyMock.commitGroup, historyMock.clear,
  edgeConnectMock.handleConnectStart, edgeConnectMock.handleConnect,
  edgeConnectMock.handleConnectEnd, edgeConnectMock.isValidNewConnection,
  apiNodesMock.nodesApi.getGraph, apiNodesMock.nodesApi.getAll, apiNodesMock.nodesApi.get,
  apiNodesMock.nodesApi.getChildren, apiNodesMock.nodesApi.getDescendants,
  apiNodesMock.viewsApi.saveLayout, apiNodesMock.viewsApi.state,
];
