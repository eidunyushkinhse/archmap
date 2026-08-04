// Оркестратор правой панели (Вариант A · «Тихий бар»): сверху — переключатель «Вид
// схемы» + легенда статусов (когда есть не-existing узлы), ниже — мета выбранного
// объекта (узел/связь) либо пустое состояние. Одна область меты для наблюдателя и
// архитектора: роли различает сам NodeInspector/EdgeInspector.
import type { Edge, EdgeUpdate, DeletionSnapshot, GhostNode, Node, NodeStatus, LevelEdge } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { SchemaViewFilter } from "../SchemaViewFilter";
import { viewShows, type SchemaView } from "../schemaView";
import NodeInspector from "./NodeInspector";
import type { NodeDocEvent } from "./FlowchartDocs";
import EdgeInspector from "./EdgeInspector";
import GhostInspector from "./GhostInspector";
import "./inspector.css";

// Что показано в панели: узел-локал, связь, ГОСТЬ (проекция чужого узла, read-only) или
// ничего. Источник правды — MapEditorPage (двойной клик по объекту наполняет панель).
export type Selected =
  | { kind: "node"; node: Node }
  | { kind: "edge"; edge: LevelEdge }
  | { kind: "ghost"; ghost: GhostNode }
  | null;

interface Props {
  hasStatusInfo: boolean;
  view: SchemaView;
  onViewChange: (v: SchemaView) => void;
  counts: Record<NodeStatus, number>;
  selected: Selected;
  isArchitect: boolean;
  onNodeSaved: (saved: Node, isCreate: boolean, before?: Node) => void;
  onNodeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  onDocEvent: (evt: NodeDocEvent) => void;
  // Дозаливка BYOA применилась: освежить узел в стейте уровня (без undo)
  onNodeRefreshed: (fresh: Node) => void;
  onEdgeSaved: (edge: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void;
  onEdgeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  onGhostGoToSource: (ghost: GhostNode) => void;
  // Переход на страницу узла (из split-строк «от <ребёнок>» у контейнера)
  onNavigateNode: (nodeId: string) => void;
}

export default function ObjectInspector({
  hasStatusInfo, view, onViewChange, counts, selected, isArchitect,
  onNodeSaved, onNodeDeleted, onDocEvent, onNodeRefreshed, onEdgeSaved, onEdgeDeleted, onGhostGoToSource,
  onNavigateNode,
}: Props) {
  return (
    <div className="insp">
      {hasStatusInfo && (
        <section>
          <SchemaViewFilter view={view} onChange={onViewChange} />
          <StatusLegend view={view} counts={counts} />
          <div className="insp-rule" />
        </section>
      )}

      {!selected ? (
        <InspectorEmpty />
      ) : selected.kind === "node" ? (
        <NodeInspector
          key={selected.node.id}
          node={selected.node}
          isArchitect={isArchitect}
          onNodeSaved={onNodeSaved}
          onNodeDeleted={onNodeDeleted}
          onDocEvent={onDocEvent}
          onNodeRefreshed={onNodeRefreshed}
          onNavigateNode={onNavigateNode}
        />
      ) : selected.kind === "ghost" ? (
        <GhostInspector
          key={selected.ghost.id}
          ghost={selected.ghost}
          onGoToSource={onGhostGoToSource}
        />
      ) : (
        <EdgeInspector
          key={selected.edge.id}
          edge={selected.edge}
          isArchitect={isArchitect}
          onEdgeSaved={onEdgeSaved}
          onEdgeDeleted={onEdgeDeleted}
        />
      )}
    </div>
  );
}

function InspectorEmpty() {
  return (
    <div className="insp-empty">
      <div className="insp-empty-title">Объект не выбран</div>
      <div className="insp-empty-hint">Дважды кликните узел или связь на схеме, чтобы увидеть и изменить их свойства.</div>
    </div>
  );
}

// Легенда статусов в панели (свотч + подпись + счётчик). Строки статусов, скрытых
// текущим видом, гасим и показываем «—» вместо счётчика. Переехала с холста сюда (B4).
function StatusLegend({ view, counts }: { view: SchemaView; counts: Record<NodeStatus, number> }) {
  const order: NodeStatus[] = ["existing", "planned", "deprecated"];
  return (
    <div className="insp-legend">
      <div className="insp-legend-head">Цвет = статус узла</div>
      {order.map((st) => {
        const visible = viewShows(view, st);
        const swatch = getNodeColors(false, 0, st);
        return (
          <div key={st} className="insp-legend-row" style={{ opacity: visible ? 1 : 0.32 }}>
            <span className="insp-swatch" style={{ background: swatch.bg, borderColor: swatch.border }} />
            <span className="insp-legend-label">{STATUS_META[st].label}</span>
            <span className="insp-legend-count">{visible ? counts[st] : "—"}</span>
          </div>
        );
      })}
    </div>
  );
}
