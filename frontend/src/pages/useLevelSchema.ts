// useLevelSchema — read-only граф уровня для встроенных схем (pages_pivot).
// Загрузка графа уровня (getGraph), fence-курсор для remote-sync, фоновая
// перезагрузка. По умолчанию страничные схемы view-only; архитектору расстановка
// доступна, когда хозяин страницы собирает бандл персиста (mirror mergeLayout +
// fence-курсор viewMetaRef + gestureActiveRef — по образу SchemaSection/NodePage).
import { useCallback, useEffect, useRef, useState } from "react";
import type { GhostNode, Node, Edge, ViewLayout, ViewLayoutPayload } from "../types";
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

  // Зеркало записанной раскладки (архитектор, персист): канвас шлёт сохранённые
  // батчи, кладём их в viewLayout — база дедупа/merge остаётся истиной (иначе «драг
  // назад в исходную» гасился бы дедупом о протухшее зеркало). null-патч — удалить
  // строку (сброс объекта в авто-геометрию). По образу SchemaSection (NodePage).
  const mergeLayout = useCallback((items: Record<string, ViewLayoutPayload | null>) => {
    setViewLayout((prev) => {
      const merged = Object.entries({ ...prev, ...items })
        .filter((e): e is [string, ViewLayoutPayload] => e[1] !== null);
      return Object.fromEntries(merged);
    });
  }, []);

  return {
    nodes, endpoints, edges, viewLayout, loading,
    viewMetaRef, gestureActiveRef, mergeLayout,
    // Перезагрузка уровня (фон, без заглушки). Возвращает промис — ресинк персиста
    // (409 retry-after-resync) ждёт свежих данных перед переигровкой патча.
    reload: (): Promise<void> => load(containerId),
  };
}
