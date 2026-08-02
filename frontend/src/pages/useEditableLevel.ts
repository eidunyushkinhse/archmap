// useEditableLevel — редактируемый уровень схемы для встроенных блоков (pages_pivot).
// Инкапсулирует загрузку графа, fence-версии вида, undo/redo перемещений узлов,
// персист раскладки (с обработкой 409) и перераскладку. Используется секциями
// «Схема компонентов» (NodePage) и «Схема системы» (ProjectHomePage), чтобы дать
// пользователю контролы undo/redo + «переразложить» прямо в окне схемы.
import { useCallback, useEffect, useRef, useState } from "react";
import type { GhostNode, Node, Edge, ViewLayout, ViewLayoutPayload } from "../types";
import { nodesApi } from "../api/nodes";
import { useHistory } from "../components/graph/interaction/useHistory";
import type { ViewMetaState } from "../components/graph/types";
import { toLevelEdges } from "../components/pageSchema";

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

  // Загрузка уровня. По умолчанию — ФОНОВОЕ обновление: loading не трогаем, страница
  // и холст НЕ размонтируются, данные подменяются по готовности и пересчитываются
  // инкрементально — без моргания на «Переразложить», remote-sync и ресинке 409.
  // foreground: true — заглушка «Загрузка…» (первичная загрузка / смена контейнера).
  const load = useCallback(async (parentId: string | null, opts?: { foreground?: boolean }) => {
    if (opts?.foreground) setLoading(true);
    setLayoutRetry(null);
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

  // Первичная загрузка + перезагрузка при смене контейнера (foreground — заглушка)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных уровня
  useEffect(() => { void load(containerId, { foreground: true }); }, [containerId, load]);

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
      // Пересобираем объект без оператора delete: сначала фильтруем удаляемые
      // ключи (null в items), затем применяем ненулевые обновления
      const removed = new Set(
        Object.entries(items).filter(([, p]) => p === null).map(([k]) => k),
      );
      const next: ViewLayout = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!removed.has(k)) next[k] = v;
      }
      for (const [k, p] of Object.entries(items)) {
        if (p !== null) next[k] = p;
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
