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
  // Отказ ПЕРВИЧНОЙ загрузки (смена контейнера): хозяин показывает причину и повтор
  // (аудит R-10 — раньше ошибка глоталась, и страница видела «проект пуст»). Фоновые
  // отказы молчат: остаётся последняя удачная версия, поллинг догонит.
  const [error, setError] = useState<unknown>(null);
  // Ведёт ли ПРОЕКТ переход (есть planned/deprecated) — приходит с сервера, потому
  // что по составу одного уровня этого не видно: статусы обычно лежат глубже.
  const [hasStatusInfo, setHasStatusInfo] = useState(false);

  // Курсор изменений для remote-sync (version/graph_rev из ответа getGraph).
  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0 });
  const gestureActiveRef = useRef(false);
  // Номер последнего начатого чтения и «идёт первичная загрузка» — как в MapEditorPage.load:
  // применяется только последний ответ, фон во время первичной загрузки не начинается.
  const loadSeqRef = useRef(0);
  const awaitingRef = useRef(false);

  // Загрузка уровня. По умолчанию — фоновое обновление (loading не трогаем, холст
  // не размонтируется, данные подменяются инкрементально — без моргания на
  // remote-sync); foreground: true — заглушка «Загрузка…» (первичная загрузка /
  // смена контейнера).
  const load = useCallback(async (parentId: string | null, opts?: { foreground?: boolean }): Promise<void> => {
    if (!opts?.foreground && awaitingRef.current) return;
    const seq = ++loadSeqRef.current;
    if (opts?.foreground) {
      awaitingRef.current = true;
      setLoading(true);
      setError(null);
    }
    let graph: Awaited<ReturnType<typeof nodesApi.getGraph>>;
    try {
      graph = await nodesApi.getGraph(parentId);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      if (opts?.foreground) {
        awaitingRef.current = false;
        setLoading(false);
        setError(e);
      }
      return;
    }
    if (seq !== loadSeqRef.current) return;
    viewMetaRef.current = { version: graph.version, graphRev: graph.graph_rev };
    setNodes(graph.nodes);
    setEndpoints(graph.endpoints);
    setViewLayout(graph.layout ?? {});
    setEdges(toLevelEdges(graph));
    setHasStatusInfo(graph.has_status_info);
    if (opts?.foreground) {
      awaitingRef.current = false;
      setLoading(false);
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
    nodes, endpoints, edges, viewLayout, loading, error, hasStatusInfo,
    viewMetaRef, gestureActiveRef, mergeLayout,
    // Перезагрузка уровня (фон, без заглушки). Возвращает промис — ресинк персиста
    // (409 retry-after-resync) ждёт свежих данных перед переигровкой патча. Не
    // отклоняется: фоновый отказ оставляет на экране последнюю удачную версию.
    reload: (): Promise<void> => load(containerId),
    // Повтор первичной загрузки после отказа (кнопка «Повторить»).
    retry: (): void => { void load(containerId, { foreground: true }); },
  };
}
