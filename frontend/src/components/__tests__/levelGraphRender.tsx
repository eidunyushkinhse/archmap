// Рендер-обёртка для оркестрационных тестов LevelGraph: собирает базовые пропсы
// «архитектор на корневом уровне», рендерит настоящий LevelGraph (зависимости
// замоканы в тест-файлах) и ждёт оседания async-раскладки, чтобы assembleRfGraph
// перехватил getCb (доступ к живым колбэкам оркестрации).
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import type { ComponentProps } from "react";
import LevelGraph from "../LevelGraph";
import type { Node as AppNode, GhostNode, Edge as AppEdge, ViewLayout } from "../../types";
import { captured, settle, type TestCb } from "./levelGraphHarness";

export type LevelGraphProps = ComponentProps<typeof LevelGraph>;

// Базовый набор колбэк-пропсов редактора (vi.fn — тесты ассертят вызовы).
// onEnterNode/onPersistConflict/retryPatch/history НЕ заданы по умолчанию: их
// наличие меняет поведение (drillNav, канал 409, своя/чужая история) — тест
// добавляет их осознанно.
export function baseProps(): LevelGraphProps {
  return {
    nodes: [] as AppNode[],
    endpoints: [] as GhostNode[],
    edges: [] as AppEdge[],
    viewLayout: {} as ViewLayout,
    depth: 0,
    containerId: null,
    ancestorNames: [],
    ancestorIds: [],
    isArchitect: true,
    onDrillDown: vi.fn<(n: AppNode) => void>(),
    onEditNode: vi.fn<(n: AppNode) => void>(),
    onEdgesChoice: vi.fn<(e: AppEdge[]) => void>(),
    onInspectGhost: vi.fn<(g: GhostNode) => void>(),
    onClearSelection: vi.fn<() => void>(),
    onLayoutChanged: vi.fn<(items: Record<string, unknown>) => void>(),
    onPersistError: vi.fn<(e: unknown) => void>(),
    onCreateEdge: vi.fn<
      (s: string, t: string, sh: string | null, th: string | null, sn?: string, tn?: string) => void
    >(),
    onConnectInto: vi.fn<
      (s: string, cid: string, cname: string, sh: string | null, sn?: string) => void
    >(),
    onExitUp: vi.fn<(s: string, sh: string | null, sn?: string) => void>(),
  };
}

export interface RenderGraphResult extends RenderResult {
  props: LevelGraphProps;
}

// Рендер + оседание раскладки. `over` сливается поверх базовых пропсов.
export async function renderGraph(over: Partial<LevelGraphProps> = {}): Promise<RenderGraphResult> {
  const props: LevelGraphProps = { ...baseProps(), ...over };
  const utils = render(<LevelGraph {...props} />);
  await settle();
  return { ...utils, props };
}

// Доступ к перехваченным оркестрационным колбэкам (после renderGraph).
export function getCb(): TestCb {
  if (!captured.getCb) throw new Error("getCb не перехвачен — assembleRfGraph не собрался");
  return captured.getCb();
}
