// EmbeddedSchemaBlock — встроенный read-only блок схемы на странице объекта.
// Поведение (ТЗ, прототип): блок инертен до клика-активации; после — колесо=зум,
// драг=пан (жесты ReactFlow), рамка подсвечена акцентом; Esc/клик-мимо деактивирует.
// Одинарный клик по узлу — выделение + индиго-подсветка инцидентных связей.
// Двойной клик по узлу — переход на его страницу (onNavigateNode).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GhostNode, Node, ViewLayout, Edge, ViewLayoutPayload } from "../types";
import LevelGraph from "./LevelGraph";
import type { ViewMetaState } from "./LevelGraph";
import type { History } from "./graph/interaction/useHistory";
import { SchemaViewFilter } from "./SchemaViewFilter";
import type { SchemaView } from "./schemaView";
import "./EmbeddedSchemaBlock.css";

// Инфраструктура редактирования раскладки (из useEditableLevel) — передаётся
// в LevelGraph для персиста перемещений и undo/redo.
export interface SchemaEditing {
  history: History;
  onLayoutChanged: (items: Record<string, ViewLayoutPayload | null>) => void;
  viewMeta: { current: ViewMetaState };
  gestureActiveRef: { current: boolean };
  onPersistError: (e: unknown) => void | Promise<void>;
  onPersistConflict: (patch: Record<string, Partial<ViewLayoutPayload> | null>) => void;
  retryPatch: { patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number } | null;
}

interface Props {
  nodes: Node[];
  endpoints: GhostNode[];
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
  // Режим LevelGraph: "level" (по умолчанию) или "context" (звёздная раскладка)
  mode?: "level" | "context";
  // Драг узлов (по умолчанию false для readOnly-блоков)
  nodesDraggable?: boolean;
  // Контролы расстановки (undo/redo перемещений + перераскладка) — рисуются
  // поверх холста: undo/redo слева вверху, перераскладка справа вверху.
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onRelayout?: () => void;
  // Инфраструктура персиста/undo (из useEditableLevel). Без неё блок view-only.
  editing?: SchemaEditing;
}

export default function EmbeddedSchemaBlock({
  nodes, endpoints, edges, viewLayout, containerId,
  ancestorNames, ancestorIds, depth, isArchitect,
  schemaView, onSchemaViewChange, onNavigateNode, onEdit,
  height, toolbarHint, showViewFilter, empty, mode = "level",
  nodesDraggable = false,
  onUndo, onRedo, canUndo = false, canRedo = false, onRelayout,
  editing,
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
    return Math.max(320, Math.min(680, Math.round(measuredWidth * 0.52)));
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
                readOnly={!editing}
                arrangeOnly={!!editing}
                nodesDraggable={nodesDraggable}
                mode={mode}
                schemaView={schemaView}
                onDrillDown={handleNavigate}
                onEditNode={handleNavigate}
                onInspectGhost={handleGhostNavigate}
                onEdgesChoice={() => {}}
                history={editing?.history}
                onUndo={onUndo}
                onRedo={onRedo}
                onLayoutChanged={editing?.onLayoutChanged}
                viewMeta={editing?.viewMeta}
                gestureActiveRef={editing?.gestureActiveRef}
                onPersistError={editing?.onPersistError}
                onPersistConflict={editing?.onPersistConflict}
                retryPatch={editing?.retryPatch}
              />
            </div>
            {/* Контролы расстановки: undo/redo слева, перераскладка справа */}
            {active && editing && (onUndo || onRelayout) && (
              <div className="esb-controls">
                <div className="esb-controls-left">
                  <button
                    className="esb-ctl"
                    onClick={onUndo}
                    disabled={!canUndo}
                    title="Отменить перемещение · Ctrl+Z"
                  >
                    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 10h13a4 4 0 0 1 0 8H7" /><path d="M3 10 7 6" /><path d="M3 10 7 14" /></svg>
                  </button>
                  <button
                    className="esb-ctl"
                    onClick={onRedo}
                    disabled={!canRedo}
                    title="Повторить перемещение · Ctrl+Shift+Z"
                  >
                    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 10H8a4 4 0 0 0 0 8h9" /><path d="m21 10-4-4" /><path d="m21 10-4 4" /></svg>
                  </button>
                </div>
                {isArchitect && onRelayout && (
                  <button
                    className="esb-ctl"
                    onClick={onRelayout}
                    title="Переразложить уровень (сбросить расстановку)"
                  >
                    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /></svg>
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Подпись */}
      {!empty && (
        <p className="esb-caption">
          Гости с других уровней — пунктиром. Двойной клик по объекту — его страница.
        </p>
      )}
    </div>
  );
}
