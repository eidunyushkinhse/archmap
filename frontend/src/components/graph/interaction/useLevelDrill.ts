// Drill-навигация и инлайн-раскрытие контейнеров канваса уровня. Вынесено из
// LevelGraph.tsx (Фаза 3в-А): drillWithPath (вход в слой по полному пути),
// expand/collapse контейнеров (гостевых и ЛОКАЛЬНЫХ, R5), производное состояние
// expanded/localChildren/relevantCounts и догрузка детей. LevelGraphInner
// продолжает оркестровать хук; зависимости (commitLayout, анимационные ноты,
// последний применённый layout) передаются параметрами.
//
// Раскрытие — часть состояния ВИДА и персистится (payload.expanded в view_layout,
// архитектор); поверх сохранённого живут ЭФЕМЕРНЫЕ правки текущей сессии
// (overrides): у viewer'а персиста нет, а у архитектора override совпадает с
// зеркалом коммита. Такое производное решает и гонку инициализации: viewLayout
// приходит async, а expanded не нужно «переливать» в стейт — он вычисляется.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nodesApi } from "../../../api/nodes";
import type { Node as AppNode, GhostNode, Edge as AppEdge, AncestorRef, ViewLayout } from "../../../types";
import type { LayoutResult } from "../layout/pipeline";
import { relevantChildren, relevantChildCounts } from "../relevantChildren";
import type { LevelPersistence } from "./useLevelPersistence";

interface UseLevelDrillArgs {
  containerId: string | null;
  nodes: AppNode[];
  edges: AppEdge[];
  endpoints: GhostNode[];
  ancestorIds: string[];
  ancestorNames: string[];
  onDrillDown: (node: AppNode) => void;
  // войти к компонентам гостя/контейнера — открыть слой-схему узла по полному пути
  onEnterNode?: (path: AncestorRef[]) => void;
  // зеркало раскладки вида — база персистных раскрытий и own-on-expand
  viewLayout: ViewLayout;
  // стартовать свёрнутым: персистные раскрытия вида не применяются (страничные схемы)
  ignorePersistedExpanded: boolean;
  isReadOnly: boolean;
  // анимированное центрирование при раскрытии/сворачивании (взводит autoFitRef)
  fitOnExpand: boolean;
  // запрос центрирования (метка времени взведения; null — запроса нет). Владелец —
  // LevelGraphInner: там же эффект авто-центрирования, который его гасит, и второй
  // источник запроса («Переразложить»). Хук только взводит при раскрытии/сворачивании.
  autoFitRef: { current: number | null };
  // счётчик чтений уровня с сервера: растёт на каждую мутацию — сигнал «кэш детей
  // раскрытых рамок протух, перечитать» (см. эффект ниже)
  childrenRev: number;
  // единая запись раскладки (useLevelPersistence) — персист expanded + own-on-expand
  commitLayout: LevelPersistence["commitLayout"];
  // анимационные ноты раскрытия/сворачивания (useLayoutAnimation)
  noteExpand: (id: string) => void;
  noteCollapse: (id: string) => void;
  // последний применённый результат конвейера: own-on-expand берёт абсолют позиции
  layoutLatestRef: { current: LayoutResult | null };
}

export interface LevelDrill {
  /** drill из узла с восстановлением полного пути (breadcrumb + цепочка + узел) */
  drillWithPath: (n: AppNode) => void;
  /** раскрытие ГОСТЕВОГО контейнера (дети даёт проекция) */
  expandContainer: (id: string) => void;
  /** раскрытие ЛОКАЛЬНОГО контейнера (ленивая догрузка детей) */
  expandLocalContainer: (id: string) => void;
  /** сворачивание контейнера */
  collapseContainer: (id: string) => void;
  /** раскрытые инлайн контейнеры (персистные + эфемерные правки сессии) */
  expanded: Set<string>;
  /** read-only: релевантные схеме дети контейнеров (гейт лупы/бейджа без фетча) */
  relevantCounts: Map<string, number> | undefined;
  /** догруженные дети раскрытых ЛОКАЛЬНЫХ контейнеров (кэш до смены уровня) */
  localChildren: Record<string, AppNode[]>;
}

export function useLevelDrill({
  containerId,
  nodes,
  edges,
  endpoints,
  ancestorIds,
  ancestorNames,
  onDrillDown,
  onEnterNode,
  viewLayout,
  ignorePersistedExpanded,
  isReadOnly,
  fitOnExpand,
  autoFitRef,
  childrenRev,
  commitLayout,
  noteExpand,
  noteCollapse,
  layoutLatestRef,
}: UseLevelDrillArgs): LevelDrill {
  const [expandOverrides, setExpandOverrides] = useState<Map<string, boolean>>(new Map());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс эфемерных правок на смену уровня — осознанный reset-on-prop-change
    setExpandOverrides(new Map());
  }, [containerId]);
  const expanded = useMemo(() => {
    const s = new Set<string>();
    // Страничные схемы стартуют свёрнутыми: сохранённые раскрытия вида не
    // применяются (ignorePersistedExpanded), живут только клики этой сессии.
    if (!ignorePersistedExpanded) {
      for (const [id, p] of Object.entries(viewLayout)) if (p.expanded) s.add(id);
    }
    for (const [id, v] of expandOverrides) {
      if (v) s.add(id);
      else s.delete(id);
    }
    return s;
  }, [viewLayout, expandOverrides, ignorePersistedExpanded]);

  // read-only (страница): дети, релевантные схеме, — «отображаемое = связанное
  // рёбрами» (тот же принцип, что у гостей, X16 v2). counts гейтит лупу и бейдж
  // без фетча списков детей; фильтр собирает состав кэша при раскрытии.
  const countsRaw = useMemo(
    () => (isReadOnly ? relevantChildCounts(edges, endpoints, expanded) : undefined),
    [isReadOnly, edges, endpoints, expanded],
  );
  // Идентичность counts стабилизируем ПО ЗНАЧЕНИЮ (как stableAncestorIds в
  // LevelGraph). Входы пересоздаются от любого зеркала раскладки: хозяин страницы
  // на драг-стопе делает setGraph/setViewLayout, отчего меняются ссылки edges
  // (toLevelEdges нового graph) и expanded (Set пересчитывается от viewLayout) —
  // при НЕИЗМЕННОМ содержимом. А counts — зависимость ЭФФЕКТА-СБОРЩИКА RF, и
  // новая ссылка запускала его на СНИМКЕ старой раскладки: узел, только что
  // отпущенный драгом, откатывался на позицию до жеста и вставал на целевую лишь
  // по готовности конвейера (визуальный «откат-вперёд» страничных схем, 2026-08-02).
  // В редакторе-карте counts всегда undefined (isReadOnly=false) — там отката и не было.
  const countsKey = useMemo(
    () => (countsRaw ? `ro|${[...countsRaw].map(([id, n]) => `${id}:${n}`).sort().join(",")}` : "-"),
    [countsRaw],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- зависим от значения (countsKey), а не от ссылки Map
  const relevantCounts = useMemo(() => countsRaw, [countsKey]);

  // Догруженные дети раскрытых ЛОКАЛЬНЫХ контейнеров (R5): id → прямые дети.
  // Кэш живёт до смены уровня; сворачивание кэш не чистит (повторное раскрытие
  // мгновенно). Конвейер держит контейнер свёрнутым, пока детей нет в карте.
  const [localChildren, setLocalChildren] = useState<Record<string, AppNode[]>>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс кэша детей на смену уровня — осознанный reset-on-prop-change
    setLocalChildren({});
  }, [containerId]);
  const commitExpanded = useCallback(
    (id: string, value: boolean) => {
      // Раскрытие И сворачивание в режиме fitOnExpand — запрос на анимированное
      // центрирование после оседания раскладки (см. эффект авто-центрирования).
      // Обе операции меняют состав схемы — результат хочется видеть по центру.
      if (fitOnExpand) autoFitRef.current = performance.now();
      setExpandOverrides((prev) => new Map(prev).set(id, value));
      // персист (архитектор, не контекст — гейтит commitLayout): true — раскрыт,
      // null-поле — сброс (exclude_none выкинет его из payload строки).
      // OWN-ON-EXPAND: контейнер, не владевший позицией (чисто-ELK уровень —
      // типично сразу после импорта), при раскрытии закрепляет текущую. Иначе
      // сетке первого показа детей не от чего стартовать, и ребёнка без видимых
      // рёбер (все его связи ведут в сам раскрытый контейнер и дропнуты
      // проекцией) ELK уносил изолированной компонентой в угол канвы — рамка
      // «раскрывалась» вдали от места клика, под левой панелью.
      const p = viewLayout[id];
      const owned = p?.x != null && p?.y != null;
      const cur = value && !owned ? layoutLatestRef.current?.positions.get(id) : undefined;
      commitLayout({ [id]: { expanded: value ? true : null, ...(cur ? { x: cur.x, y: cur.y } : null) } });
    },
    [commitLayout, viewLayout, fitOnExpand, autoFitRef, layoutLatestRef],
  );
  // Раскрытие ГОСТЕВОГО контейнера: детей даёт проекция (реестр endpoints).
  const expandContainer = useCallback(
    (id: string) => { noteExpand(id); commitExpanded(id, true); },
    [commitExpanded, noteExpand],
  );
  // Раскрытие ЛОКАЛЬНОГО контейнера (R5): лениво догружаем его прямых детей —
  // по Д3 показываются ВСЕ дети, а /graph уровня их не отдаёт.
  // Ф2 плавности: expanded включается ПО ПРИХОДУ детей (одним батчем с
  // localChildren) — иначе между кликом и фетчем успевал стартовать прогон
  // «expanded есть, детей нет» (контейнер в нём всё равно свёрнут), который
  // только скипался по сигнатуре, съедая ~60мс латентности старта анимации.
  // С тёплым кэшем раскрываем сразу (повторное раскрытие мгновенно, как раньше).
  const expandLocalContainer = useCallback(
    (id: string) => {
      if (localChildren[id]) {
        noteExpand(id);
        commitExpanded(id, true);
        return;
      }
      void nodesApi.list(id).then((kids) => {
        // read-only (страница): только дети, релевантные текущей схеме, —
        // «отображаемое = связанное рёбрами» (как у гостей, X16 v2). Раскрываемый
        // контейнер — в наборе раскрытых: рёбра «в его рамку» границу не образуют.
        const fit = isReadOnly
          ? relevantChildren(kids, edges, endpoints, new Set([...expanded, id]))
          : kids;
        // Пустое раскрытие (все дети нерелевантны): не раскрываем; лупа у узла
        // уже погашена счётчиком relevantCounts.
        if (fit.length === 0) return;
        noteExpand(id);
        commitExpanded(id, true);
        setLocalChildren((cur) => (cur[id] ? cur : { ...cur, [id]: fit }));
      });
    },
    [localChildren, commitExpanded, noteExpand, isReadOnly, edges, endpoints, expanded],
  );
  const collapseContainer = useCallback(
    (id: string) => { noteCollapse(id); commitExpanded(id, false); },
    [commitExpanded, noteCollapse],
  );
  // Догрузка детей для ПЕРСИСТНЫХ раскрытий (R5): после перезахода expanded
  // приходит из view_layout, а кэш детей пуст — конвейер держал бы контейнер
  // свёрнутым вечно. Дозагружаем локалов уровня (и, по мере появления их детей
  // в кэше, — раскрытых потомков цепочкой). Гостевых в known нет — им детей
  // даёт проекция. Повторный сет во время полёта гасится guard'ом cur[id].
  useEffect(() => {
    if (isReadOnly) return;
    const known = new Set([
      ...nodes.map((n) => n.id),
      ...Object.values(localChildren).flat().map((n) => n.id),
    ]);
    for (const id of expanded) {
      if (!known.has(id) || localChildren[id]) continue;
      void nodesApi.list(id).then((kids) => {
        setLocalChildren((cur) => (cur[id] ? cur : { ...cur, [id]: kids }));
      });
    }
  }, [expanded, nodes, localChildren, isReadOnly]);

  // Протухание кэша детей рамок. Уровень перечитывается с сервера при КАЖДОЙ мутации
  // (создание/удаление, undo/redo, remote-sync), но ответ /graph несёт только прямых
  // детей контейнера — дети раскрытых рамок в него не входят и молча остаются
  // прежними. Поэтому владелец уровня бампает childrenRev на каждое чтение, а мы
  // перечитываем ВСЕ закэшированные рамки и ПЕРЕЗАПИСЫВАЕМ ключи (ленивая догрузка
  // выше заполненный ключ не трогает).
  //
  // Раньше здесь был таргетный канал «обнови рамку X», и дёргало его ровно одно место —
  // дроп нового узла в рамку. Удаление узла из рамки его не дёргало, и удалённый
  // объект оставался нарисованным внутри рамки до ухода с уровня (находка 2026-08-09).
  // Канал «перечитали уровень» забыть нельзя: он один на все мутации.
  //
  // Перечитываем и СВЁРНУТЫЕ рамки: кэш переживает сворачивание (повторное раскрытие
  // мгновенно), и без этого оно показало бы протухший состав.
  const childrenRevRef = useRef(0);
  useEffect(() => {
    if (isReadOnly) return;
    // Эффект перезапускается и на смену localChildren (свои же setState) — реальную
    // работу делает только рост childrenRev.
    if (childrenRev === childrenRevRef.current) return;
    childrenRevRef.current = childrenRev;
    for (const id of Object.keys(localChildren)) {
      void nodesApi.list(id).then((kids) => {
        setLocalChildren((cur) => ({ ...cur, [id]: kids }));
      });
    }
  }, [childrenRev, localChildren, isReadOnly]);

  // Drill из узла, раскрытого ИНЛАЙН глубже текущего уровня (R5): в breadcrumb входят
  // промежуточные контейнеры (фактическая архитектура: Контекст > HelixMon > ObsCore >
  // Zabbix Core), а не прыжок через слои. Цепочку восстанавливаем по parent_id из
  // локалов уровня + догруженных детей раскрытий; не восстановилась — прежнее поведение.
  const drillWithPath = useCallback(
    (n: AppNode) => {
      if (!onEnterNode || !n.parent_id || n.parent_id === containerId) { onDrillDown(n); return; }
      const pool = new Map<string, AppNode>();
      for (const x of nodes) pool.set(x.id, x);
      for (const kids of Object.values(localChildren)) for (const k of kids) pool.set(k.id, k);
      const chain: AppNode[] = [];
      let pid: string | null | undefined = n.parent_id;
      while (pid && pid !== containerId) {
        const p = pool.get(pid);
        if (!p) { onDrillDown(n); return; }
        chain.unshift(p);
        pid = p.parent_id;
      }
      const ref = (x: AppNode): AncestorRef => ({ id: x.id, name: x.name, is_external: x.is_external });
      const levelRefs: AncestorRef[] = ancestorIds.map((id, i) => ({
        id, name: ancestorNames[i] ?? id, is_external: false,
      }));
      onEnterNode([...levelRefs, ...chain.map(ref), ref(n)]);
    },
    [nodes, localChildren, containerId, ancestorIds, ancestorNames, onDrillDown, onEnterNode],
  );

  return {
    drillWithPath, expandContainer, expandLocalContainer, collapseContainer,
    expanded, relevantCounts, localChildren,
  };
}
