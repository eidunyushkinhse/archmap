// EmbeddedSchemaBlock — встроенный read-only блок схемы на странице объекта.
// Поведение (ТЗ, прототип): блок инертен до клика-активации; после — колесо=зум,
// драг=пан (жесты ReactFlow), рамка подсвечена акцентом; Esc/клик-мимо деактивирует.
// Одинарный клик по узлу — выделение + индиго-подсветка инцидентных связей.
// Двойной клик по узлу — переход на его страницу (onNavigateNode).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GhostNode, Node, ViewLayout, Edge, LevelEdge } from "../types";
import LevelGraph from "./LevelGraph";
import type {
  LevelModeFlags, LevelDrillCallbacks, LevelEdgeCallbacks,
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
  // Высота блока
  height: number;
  // Заголовок тулбара (счётчик компонентов и т.п.)
  toolbarHint?: string;
  // Показывать ли SchemaViewFilter (только если на уровне есть не-existing узлы)
  showViewFilter: boolean;
  // Пустое состояние (вместо схемы)
  empty?: React.ReactNode;
  // Подпись-легенда под холстом («Гости — пунктиром…»). Секция «Схема» страницы
  // объекта (single-schema) рисуется без неё (ТЗ §3.1).
  showCaption?: boolean;
}

export default function EmbeddedSchemaBlock({
  nodes, endpoints, edges, viewLayout, containerId,
  ancestorNames, ancestorIds, depth, isArchitect,
  schemaView, onSchemaViewChange, onNavigateNode, onEdit,
  height, toolbarHint, showViewFilter, empty,
  showCaption = true,
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
  // объект-литерал на каждый рендер. Блок всегда view-only (драг/undo/перераскладка
  // убраны — редактирование расстановки живёт в редакторе-карте).
  const mode = useMemo<LevelModeFlags>(() => ({
    readOnly: true,
    arrangeOnly: false,
    // Страничные схемы стартуют СВЁРНУТЫМИ (персистные раскрытия не применяются) и
    // авто-центрируются (по оседании раскладки + при раскрытии узла лупой).
    ignorePersistedExpanded: true,
    fitOnLoad: true,
    fitOnExpand: true,
    // Инспекция связей в read-only просмотре (двойной клик по стрелке): подсветка
    // полного пути + модалка выбора при общем плече.
    edgesInspectable: true,
    schemaView,
  }), [schemaView]);

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
          <SchemaViewFilter view={schemaView} onChange={onSchemaViewChange} />
        )}
        {isArchitect && onEdit && (
          <button className="esb-edit" onClick={onEdit}>Редактировать</button>
        )}
      </div>

      {/* Блок схемы */}
      <div
        ref={wrapRef}
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
                ancestorNames={ancestorNames}
                ancestorIds={ancestorIds}
                depth={depth}
                isArchitect={isArchitect}
                linkedHighlight={linkedHighlight}
                mode={mode}
                drill={drill}
                edgeCallbacks={edgeCallbacks}
              />
            </div>
            {/* Легенда — правый нижний угол, доступна всегда (в т.ч. неактивный блок) */}
            <SchemaLegend />
          </>
        )}
      </div>

      {/* Подпись */}
      {!empty && showCaption && (
        <p className="esb-caption">
          Гости с других уровней — пунктиром. Двойной клик по объекту — его страница.
        </p>
      )}

      {/* Модалка выбора связи (общее плечо / несколько связей) */}
      {choiceModal}
    </div>
  );
}
