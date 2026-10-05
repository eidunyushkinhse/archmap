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

// Базовый набор колбэк-пропсов редактора (vi.fn — тесты ассертят вызовы). Пропсы
// сгруппированы в бандлы (Фаза 3д): drill/edgeCallbacks/persistence. Члены, чьё
// наличие меняет поведение (onEnterNode → drillNav; onPersistConflict/retryPatch →
// канал 409; history → чужая история), НЕ заданы по умолчанию — тест добавляет их
// осознанно, сливая поверх базового бандла ({ ...baseProps().drill, onEnterNode }).
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
    drill: {
      onDrillDown: vi.fn<(n: AppNode) => void>(),
      onEditNode: vi.fn<(n: AppNode) => void>(),
      onInspectGhost: vi.fn<(g: GhostNode) => void>(),
      onInspectNodeId: vi.fn<(id: string) => void>(),
      onClearSelection: vi.fn<() => void>(),
    },
    edgeCallbacks: {
      onEdgesChoice: vi.fn<(e: AppEdge[]) => void>(),
      onCreateEdge: vi.fn<
        (s: string, t: string, sh: string | null, th: string | null, sn?: string, tn?: string) => void
      >(),
      onConnectInto: vi.fn<
        (s: string, cid: string, cname: string, sh: string | null, sn?: string) => void
      >(),
      onExitUp: vi.fn<(s: string, sh: string | null, sn?: string) => void>(),
    },
    persistence: {
      onLayoutChanged: vi.fn<(items: Record<string, unknown>) => void>(),
      onPersistError: vi.fn<(e: unknown) => void>(),
    },
  };
}

export interface RenderGraphResult extends RenderResult {
  props: LevelGraphProps;
  /** Перерисовать с изменёнными пропсами (смена данных уровня «снаружи»). */
  rerenderWith: (over: Partial<LevelGraphProps>) => void;
}

// Рендер + оседание раскладки. `over` сливается поверх базовых пропсов.
export async function renderGraph(over: Partial<LevelGraphProps> = {}): Promise<RenderGraphResult> {
  const props: LevelGraphProps = { ...baseProps(), ...over };
  const utils = render(<LevelGraph {...props} />);
  await settle();
  return {
    ...utils,
    props,
    rerenderWith: (next) => utils.rerender(<LevelGraph {...props} {...next} />),
  };
}

// Доступ к перехваченным оркестрационным колбэкам (после renderGraph).
export function getCb(): TestCb {
  if (!captured.getCb) throw new Error("getCb не перехвачен — assembleRfGraph не собрался");
  return captured.getCb();
}
