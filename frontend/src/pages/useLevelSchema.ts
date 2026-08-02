// useLevelSchema — read-only граф уровня для встроенных схем (pages_pivot).
// Загрузка графа уровня (getGraph), fence-курсор для remote-sync, фоновая
// перезагрузка. Страничные схемы view-only (как «Схема» страницы объекта):
// драг/undo/перераскладка убраны — редактирование расстановки живёт в редакторе-карте.
import { useCallback, useEffect, useRef, useState } from "react";
import type { GhostNode, Node, Edge, ViewLayout } from "../types";
import { nodesApi } from "../api/nodes";
import type { ViewMetaState } from "../components/graph/types";
import { toLevelEdges } from "../components/pageSchema";

interface Args {
  containerId: string | null;
}

export function useLevelSchema({ containerId }: Args) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [endpoints, setEndpoints] = useState<GhostNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [viewLayout, setViewLayout] = useState<ViewLayout>({});
  const [loading, setLoading] = useState(true);

  // Курсор изменений для remote-sync (version/graph_rev из ответа getGraph).
  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0 });
  const gestureActiveRef = useRef(false);

  // Загрузка уровня. По умолчанию — фоновое обновление (loading не трогаем, холст
  // не размонтируется, данные подменяются инкрементально — без моргания на
  // remote-sync); foreground: true — заглушка «Загрузка…» (первичная загрузка /
  // смена контейнера).
  const load = useCallback(async (parentId: string | null, opts?: { foreground?: boolean }) => {
    if (opts?.foreground) setLoading(true);
    try {
      const graph = await nodesApi.getGraph(parentId);
      viewMetaRef.current = { version: graph.version, graphRev: graph.graph_rev };
      setNodes(graph.nodes);
      setEndpoints(graph.endpoints);
      setViewLayout(graph.layout ?? {});
      setEdges(toLevelEdges(graph));
    } finally {
      if (opts?.foreground) setLoading(false);
    }
  }, []);

  // Первичная загрузка + перезагрузка при смене контейнера (foreground — заглушка).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных уровня
  useEffect(() => { void load(containerId, { foreground: true }); }, [containerId, load]);

  return {
    nodes, endpoints, edges, viewLayout, loading,
    viewMetaRef, gestureActiveRef,
    reload: () => { void load(containerId); },
  };
}
