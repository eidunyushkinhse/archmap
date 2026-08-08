// Оркестратор правой панели (Вариант A · «Тихий бар»): мета выбранного объекта
// (узел/связь) либо пустое состояние. Всё, что относится к СТАТУСАМ схемы —
// переключатель вида и легенда цветов, — живёт в шапке редактора: держать это в
// двух местах значило путать, какой из переключателей главный (находка проверки
// 2026-08-08). Одна область меты для наблюдателя и
// архитектора: роли различает сам NodeInspector/EdgeInspector.
import type { Edge, EdgeUpdate, DeletionSnapshot, GhostNode, Node, LevelEdge } from "../../types";
import NodeInspector from "./NodeInspector";
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
  selected: Selected;
  isArchitect: boolean;
  onNodeSaved: (saved: Node, isCreate: boolean, before?: Node) => void;
  onNodeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  onEdgeSaved: (edge: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void;
  onEdgeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  onGhostGoToSource: (ghost: GhostNode) => void;
  // Переход на страницу узла (раздел «Документация» инспектора)
  onNavigateNode: (nodeId: string) => void;
}

export default function ObjectInspector({
  selected, isArchitect,
  onNodeSaved, onNodeDeleted, onEdgeSaved, onEdgeDeleted, onGhostGoToSource,
  onNavigateNode,
}: Props) {
  return (
    <div className="insp">
      {!selected ? (
        <InspectorEmpty />
      ) : selected.kind === "node" ? (
        <NodeInspector
          key={selected.node.id}
          node={selected.node}
          isArchitect={isArchitect}
          onNodeSaved={onNodeSaved}
          onNodeDeleted={onNodeDeleted}
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
