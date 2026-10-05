// EmbeddedSchemaBlock — встроенный read-only блок схемы на странице объекта.
// Поведение (ТЗ, прототип): блок инертен до клика-активации; после — колесо=зум,
// драг=пан (жесты ReactFlow), рамка подсвечена акцентом; Esc/клик-мимо деактивирует.
// Одинарный клик по узлу — выделение + индиго-подсветка инцидентных связей.
// Двойной клик по узлу — переход на его страницу (onNavigateNode).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GhostNode, Node, ViewLayout, Edge, LevelEdge } from "../types";
import LevelGraph from "./LevelGraph";
import type {
  LevelModeFlags, LevelDrillCallbacks, LevelEdgeCallbacks, LevelPersistenceProps,
} from "./graph/types";
import { useEdgeChoice } from "./graph/interaction/useEdgeChoice";
import { SchemaViewFilter } from "./SchemaViewFilter";
import SchemaLegend from "./SchemaLegend";
import type { SchemaView } from "./schemaView";
import { responsiveCanvasHeight } from "./pageSchema";
import "./EmbeddedSchemaBlock.css";

interface Props {
  nodes: Node[];
  endpoints: GhostNode[];
  // Рёбра уровня. Тип базовый Edge: useLevelSchema (ProjectHomePage) отдаёт
  // EdgeResponse без original_* имён, а SchemaSection — LevelEdge (с именами концов
  // для модалки выбора). Хук useEdgeChoice приводит к LevelEdge и терпит
  // отсутствующие original_* (подписи концов фолбэчатся на labelOf).
  edges: Edge[];
  viewLayout: ViewLayout;
  containerId: string | null;
  // Ключ ВИДА для персиста раскладки (страница объекта: node.id — вид фокуса),
  // если отличается от структурного containerId. Пробрасывается в LevelGraph.
  layoutViewId?: string;
  // Персист раскладки (архитектор на странице объекта). Передан → включается
  // arrangeOnly (драг + запись вида фокуса); не передан → блок чисто read-only.
  persistence?: LevelPersistenceProps;
  ancestorNames: string[];
  ancestorIds: string[];
  depth: number;
  isArchitect: boolean;
  // Вид схемы (as-is/переход/to-be) — общий клиентский ключ localStorage
  schemaView: SchemaView;
  onSchemaViewChange: (v: SchemaView) => void;
  // Двойной клик по узлу → его страница
  onNavigateNode: (nodeId: string) => void;
  // «Редактировать» → редактор-карта (архитектор)
  onEdit?: () => void;
  // «Переразложить» → сброс раскладки вида фокуса (архитектор, только с персистом)
  onRelayout?: () => void;
  // Токен свершившейся переразкладки (инкрементит хозяин после сброса): приход
  // свежей раскладки анимируется чистым переездом узлов.
  relayoutToken?: number;
  // Токен мутации страницы (правка/создание/удаление связей и узлов): стрелки с
  // изменившейся геометрией перерисовываются анимированно, новые рисуются (AN28а).
  mutationToken?: number;
  // Высота блока
  height: number;
  // Заголовок тулбара (счётчик компонентов и т.п.)
  toolbarHint?: string;
  // Показывать ли SchemaViewFilter (условие собирает showStatusControls: ведёт ли
  // переход ПРОЕКТ — состава одного уровня для этого мало)
  showViewFilter: boolean;
  // Пустое состояние (вместо схемы)
  empty?: React.ReactNode;
}

export default function EmbeddedSchemaBlock({
  nodes, endpoints, edges, viewLayout, containerId, layoutViewId, persistence,
  ancestorNames, ancestorIds, depth, isArchitect,
  schemaView, onSchemaViewChange, onNavigateNode, onEdit, onRelayout, relayoutToken, mutationToken,
  height, toolbarHint, showViewFilter, empty,
}: Props) {
  const [active, setActive] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Ширина блока → пропорциональная высота схемы (страница во всю ширину,
  // схемы масштабируются вместе с доступным пространством).
  const [measuredWidth, setMeasuredWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setMeasuredWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Высота = ширина × коэффициент, с ограничениями. До первого замера — height из пропсов.
  const responsiveHeight = useMemo(() => {
    if (measuredWidth <= 0) return height;
    return responsiveCanvasHeight(measuredWidth);
  }, [measuredWidth, height]);

  // Esc — деактивация
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Клик мимо блока — деактивация
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as HTMLElement)) {
        setActive(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [active]);

  const handleNavigate = useCallback((node: Node) => {
    onNavigateNode(node.id);
  }, [onNavigateNode]);

  const handleGhostNavigate = useCallback((ghost: GhostNode) => {
    onNavigateNode(ghost.id);
  }, [onNavigateNode]);

  // Выбор связи в окне просмотра (переиспользование логики редактора): двойной
  // клик по стрелке/общему плечу → подсветка полного пути (linkedHighlight),
  // несколько связей на плече → модалка выбора. Выделение живёт здесь (не в
  // LevelGraph); onPick его ставит, onClearSelection (дабл-клик по пустому) — снимает.
  const [selectedEdge, setSelectedEdge] = useState<LevelEdge | null>(null);
  const resolveEdge = useCallback(
    (id: string): LevelEdge | null =>
      (edges.find((e) => e.id === id) as LevelEdge | undefined) ?? null,
    [edges],
  );
  const labelOf = useCallback(
    (id: string): string =>
      nodes.find((n) => n.id === id)?.name ?? endpoints.find((ep) => ep.id === id)?.name ?? id,
    [nodes, endpoints],
  );
  const linkedHighlight = useMemo(
    (): { kind: "node" | "edge"; id: string } | null =>
      selectedEdge ? { kind: "edge", id: selectedEdge.id } : null,
    [selectedEdge],
  );
  const { onEdgesChoice, onTrunkChoice, choiceModal } = useEdgeChoice({
    resolveEdge, labelOf, onPick: setSelectedEdge,
  });

  // Бандлы пропсов LevelGraph (Фаза 3д): мемоизированы, чтобы не создавать новый
  // объект-литерал на каждый рендер. Структура всегда read-only (создание/удаление/
  // связи — в редакторе-карте); расстановка — только у архитектора с персистом.
  const mode = useMemo<LevelModeFlags>(() => ({
    // Структурная правка выключена всегда; arrangeOnly включает драг+персист,
    // не трогая canStructure (нет хэндлов/создания/удаления/quick-connect).
    readOnly: true,
    // Персист передан (архитектор) → драг и запись вида фокуса доступны.
    arrangeOnly: !!persistence,
    // С персистом инлайн-раскрытия вида фокуса восстанавливаются при перезаходе
    // (раскрытия — часть раскладки страницы); без персиста (наблюдатель) стартуем
    // свёрнутыми. Авто-центрирование — по оседании раскладки + при раскрытии лупой.
    ignorePersistedExpanded: !persistence,
    fitOnLoad: true,
    fitOnExpand: true,
    // Инспекция связей в read-only просмотре (двойной клик по стрелке): подсветка
    // полного пути + модалка выбора при общем плече.
    edgesInspectable: true,
    schemaView,
  }), [schemaView, persistence]);

  const drill = useMemo<LevelDrillCallbacks>(() => ({
    onDrillDown: handleNavigate,
    onEditNode: handleNavigate,
    onInspectGhost: handleGhostNavigate,
    onClearSelection: () => setSelectedEdge(null),
  }), [handleNavigate, handleGhostNavigate]);

  const edgeCallbacks = useMemo<LevelEdgeCallbacks>(() => ({
    onEdgesChoice,
    onTrunkChoice,
  }), [onEdgesChoice, onTrunkChoice]);

  return (
    <div>
      {/* Тулбар секции */}
      <div className="esb-toolbar">
        {toolbarHint && <span className="esb-hint">{toolbarHint}</span>}
        <span style={{ flex: 1 }} />
        {showViewFilter && (
          <SchemaViewFilter view={schemaView} onChange={onSchemaViewChange} variant="inline" />
        )}
        {/* «Переразложить» переехало на холст (canvas-кнопка LevelGraph, правый
            верхний угол) — единообразно с редактором-картой. Здесь осталась только
            «Редактировать» (переход в редактор-карту). */}
        {isArchitect && onEdit && (
          <button className="esb-edit" data-tour="schema-edit" onClick={onEdit}>Редактировать</button>
        )}
      </div>

      {/* Блок схемы */}
      <div
        ref={wrapRef}
        data-tour="schema-block"
        className={"esb-wrap" + (active ? " esb-wrap--active" : "")}
        style={{ height: responsiveHeight }}
      >
        {empty ? (
          <div className="esb-empty">{empty}</div>
        ) : (
          <>
            {/* Оверлей активации: инертен до клика */}
            {!active && (
              <button
                className="esb-activate"
                onClick={() => setActive(true)}
                title="Кликните, чтобы взаимодействовать со схемой"
              >
                <span className="esb-activate-pill">кликните, чтобы взаимодействовать</span>
              </button>
            )}
            <div className="esb-canvas">
              <LevelGraph
                nodes={nodes}
                endpoints={endpoints}
                edges={edges}
                viewLayout={viewLayout}
                containerId={containerId}
                layoutViewId={layoutViewId}
                persistence={persistence}
                ancestorNames={ancestorNames}
                ancestorIds={ancestorIds}
                depth={depth}
                isArchitect={isArchitect}
                linkedHighlight={linkedHighlight}
                mode={mode}
                drill={drill}
                edgeCallbacks={edgeCallbacks}
                onRelayout={onRelayout}
                relayoutToken={relayoutToken}
                mutationToken={mutationToken}
              />
            </div>
            {/* Легенда — правый нижний угол, доступна всегда (в т.ч. неактивный блок) */}
            <SchemaLegend />
          </>
        )}
      </div>

      {/* Модалка выбора связи (общее плечо / несколько связей) */}
      {choiceModal}
    </div>
  );
}
