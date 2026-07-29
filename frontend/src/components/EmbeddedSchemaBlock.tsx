// EmbeddedSchemaBlock — встроенный read-only блок схемы на странице объекта.
// Поведение (ТЗ, прототип): блок инертен до клика-активации; после — колесо=зум,
// драг=пан (жесты ReactFlow), рамка подсвечена акцентом; Esc/клик-мимо деактивирует.
// Одинарный клик по узлу — выделение + индиго-подсветка инцидентных связей.
// Двойной клик по узлу — переход на его страницу (onNavigateNode).
import { useCallback, useEffect, useRef, useState } from "react";
import type { GhostNode, Node, ViewLayout, Edge } from "../types";
import LevelGraph from "./LevelGraph";
import { SchemaViewFilter } from "./SchemaViewFilter";
import type { SchemaView } from "./schemaView";
import "./EmbeddedSchemaBlock.css";

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
}

export default function EmbeddedSchemaBlock({
  nodes, endpoints, edges, viewLayout, containerId,
  ancestorNames, ancestorIds, depth, isArchitect,
  schemaView, onSchemaViewChange, onNavigateNode, onEdit,
  height, toolbarHint, showViewFilter, empty, mode = "level",
}: Props) {
  const [active, setActive] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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
        style={{ height }}
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
                readOnly
                mode={mode}
                schemaView={schemaView}
                onDrillDown={handleNavigate}
                onEditNode={handleNavigate}
                onInspectGhost={handleGhostNavigate}
                onEdgesChoice={() => {}}
              />
            </div>
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
