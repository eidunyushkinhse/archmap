// useDeploymentGraph — граф холста «Развёртывание» уровня (docs/tasks/deployment-view.md)
// по образцу useLevelSchema: первичная загрузка с заглушкой и отказом (LoadError у
// хозяина), фоновое перечитывание без моргания, курсоры для поллинга (viewMetaRef) и
// зеркало записанной раскладки (mergeLayout) для персиста холста.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeploymentGraph, ViewLayout, ViewLayoutPayload } from "../types";
import { deploymentApi } from "../api/deployment";
import type { ViewMetaState } from "../components/graph/types";
import { mergeViewLayout } from "../components/pageSchema";

export function useDeploymentGraph(level: string | null) {
  const [graph, setGraph] = useState<DeploymentGraph | null>(null);
  // Уровень, чей граф сейчас в graph: после смены уровня до прихода нового графа он
  // отстаёт — хозяин так отличает граф нового уровня от прежнего (отложенное выделение).
  const [graphLevel, setGraphLevel] = useState<string | null | undefined>(undefined);
  // Раскладка — отдельным состоянием: зеркало записей холста меняет только её, а
  // проекция графа (состав холста) от раскладки не зависит и не пересчитывается.
  const [layout, setLayout] = useState<ViewLayout>({});
  const [loading, setLoading] = useState(true);
  // Отказ ПЕРВИЧНОЙ загрузки (смена уровня) — хозяин показывает причину и повтор.
  // Фоновые отказы молчат: остаётся последняя удачная версия, поллинг догонит.
  const [error, setError] = useState<unknown>(null);

  // Курсоры для поллинга и fence записей раскладки (version — вид уровня).
  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0 });
  const gestureActiveRef = useRef(false);
  // Применяется только последний ответ; фон во время первичной загрузки не начинается.
  const loadSeqRef = useRef(0);
  const awaitingRef = useRef(false);

  // Отдаёт применённый граф (null — ответ не применён: отказ, перегнан более свежим или
  // фон во время первичной загрузки).
  const load = useCallback(async (lvl: string | null, opts?: { foreground?: boolean }): Promise<DeploymentGraph | null> => {
    if (!opts?.foreground && awaitingRef.current) return null;
    const seq = ++loadSeqRef.current;
    if (opts?.foreground) {
      awaitingRef.current = true;
      setLoading(true);
      setError(null);
    }
    let next: DeploymentGraph;
    try {
      next = await deploymentApi.graph(lvl);
    } catch (e) {
      if (seq !== loadSeqRef.current) return null;
      if (opts?.foreground) {
        awaitingRef.current = false;
        setLoading(false);
        setError(e);
      }
      return null;
    }
    if (seq !== loadSeqRef.current) return null;
    viewMetaRef.current = { version: next.version, graphRev: next.graph_rev, metaRev: next.meta_rev };
    setGraph(next);
    setGraphLevel(lvl);
    setLayout(next.layout);
    if (opts?.foreground) {
      awaitingRef.current = false;
      setLoading(false);
    }
    return next;
  }, []);

  // Первичная загрузка и смена уровня (foreground — заглушка «Загрузка…»).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных уровня
  useEffect(() => { void load(level, { foreground: true }); }, [level, load]);

  // Зеркало записанной раскладки (архитектор): холст шлёт сохранённые батчи.
  const mergeLayout = useCallback((items: Record<string, ViewLayoutPayload | null>) => {
    setLayout((prev) => mergeViewLayout(prev, items));
  }, []);

  // Фоновое перечитывание (без заглушки). Не отклоняется: фоновый отказ оставляет
  // последнюю удачную версию. Отдаёт применённый граф (null — не применён).
  const reload = useCallback((): Promise<DeploymentGraph | null> => load(level), [load, level]);
  const retry = useCallback((): void => { void load(level, { foreground: true }); }, [load, level]);

  return { graph, graphLevel, layout, loading, error, viewMetaRef, gestureActiveRef, mergeLayout, reload, retry };
}
