// useEditableLevel — редактируемый уровень схемы для встроенных блоков (pages_pivot).
// Инкапсулирует загрузку графа, fence-версии вида, undo/redo перемещений узлов,
// персист раскладки (с обработкой 409) и перераскладку. Используется секциями
// «Схема компонентов» (NodePage) и «Схема системы» (ProjectHomePage), чтобы дать
// пользователю контролы undo/redo + «переразложить» прямо в окне схемы.
import { useCallback, useEffect, useRef, useState } from "react";
import type { GhostNode, Node, Edge, ViewLayout, ViewLayoutPayload } from "../types";
import { nodesApi } from "../api/nodes";
import { useHistory } from "../components/graph/interaction/useHistory";
import type { ViewMetaState } from "../components/LevelGraph";

interface Args {
  containerId: string | null;
  isArchitect: boolean;
}

export function useEditableLevel({ containerId, isArchitect }: Args) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [endpoints, setEndpoints] = useState<GhostNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [viewLayout, setViewLayout] = useState<ViewLayout>({});
  const [loading, setLoading] = useState(true);

  const history = useHistory();
  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0 });
  const gestureActiveRef = useRef(false);
  const layoutRetrySeq = useRef(0);
  const [layoutRetry, setLayoutRetry] = useState<{
    patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number;
  } | null>(null);
  const resyncingRef = useRef<Promise<void> | null>(null);

  const load = useCallback(async (parentId: string | null) => {
    setLoading(true);
    setLayoutRetry(null);
    try {
      const graph = await nodesApi.getGraph(parentId);
      viewMetaRef.current = { version: graph.version, graphRev: graph.graph_rev };
      setNodes(graph.nodes);
      setEndpoints(graph.endpoints);
      setViewLayout(graph.layout ?? {});
      const nameById = new Map<string, string>([
        ...graph.nodes.map((n) => [n.id, n.name] as const),
        ...graph.endpoints.map((ep) => [ep.id, ep.name] as const),
      ]);
      setEdges(graph.edges.map((ge) => ({
        id: ge.id, label: ge.label, technology: ge.technology,
        source_id: ge.source_id, target_id: ge.target_id,
        original_source_id: ge.source_id, original_target_id: ge.target_id,
        original_source_name: nameById.get(ge.source_id) ?? "",
        original_target_name: nameById.get(ge.target_id) ?? "",
        version: ge.version, created_at: "",
      })));
    } finally {
      setLoading(false);
    }
  }, []);

  // Первичная загрузка + перезагрузка при смене контейнера
  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных уровня
  useEffect(() => { void load(containerId); }, [containerId, load]);

  // Ресинк уровня при ошибке персиста (409/сеть)
  const resyncOnPersistError = useCallback((): Promise<void> => {
    if (resyncingRef.current) return resyncingRef.current;
    const p = load(containerId).finally(() => { resyncingRef.current = null; });
    resyncingRef.current = p;
    return p;
  }, [containerId, load]);

  // Конфликт версии вида: ресинк + переигровка исходного патча
  const onPersistConflict = useCallback((patch: Record<string, Partial<ViewLayoutPayload> | null>) => {
    void resyncOnPersistError().then(() => {
      setLayoutRetry({ patch, token: ++layoutRetrySeq.current });
    });
  }, [resyncOnPersistError]);

  // Зеркалирование сохранённой раскладки в локальный стейт
  const handleLayoutChanged = useCallback((items: Record<string, ViewLayoutPayload | null>) => {
    setViewLayout((prev) => {
      const next = { ...prev };
      for (const [k, p] of Object.entries(items)) {
        if (p === null) delete next[k]; else next[k] = p;
      }
      return next;
    });
  }, []);

  // Undo/redo (уровень в блоке один — редирект между уровнями не нужен)
  const undo = useCallback(() => { history.undo(); }, [history]);
  const redo = useCallback(() => { history.redo(); }, [history]);

  // Перераскладка уровня: сброс координат на сервере + перезагрузка + очистка истории
  const relayout = useCallback(async () => {
    if (!isArchitect) return;
    await nodesApi.relayoutLevel(containerId);
    history.clear();
    await load(containerId);
  }, [isArchitect, containerId, history, load]);

  return {
    nodes, endpoints, edges, viewLayout, loading,
    history, canUndo: history.canUndo(), canRedo: history.canRedo(), undo, redo,
    handleLayoutChanged, viewMetaRef, gestureActiveRef,
    onPersistError: resyncOnPersistError, onPersistConflict, retryPatch: layoutRetry,
    relayout, reload: () => { void load(containerId); },
  };
}
