// Правая панель редактора-карты (редизайн, направление А «Документ»): объект, связь или
// объект с другого уровня (гость, проекция чужого узла, только просмотр). Панели нет,
// пока ничего не выбрано: MapEditorPage рисует её только при выборе. Открывают её
// двойной клик по объекту, гостю или связи и клик по листу в дереве; закрывают крестик в
// заголовке, Escape, двойной клик по пустому холсту, смена уровня и удаление. Панель
// входит в раскладку экрана, но объекты на холсте при её появлении не сдвигаются: вид
// React Flow при смене ширины холста не пересчитывается.
//
// Всё, что относится к СТАТУСАМ схемы — переключатель вида и «Принять переход», — живёт в
// шапке редактора (находка проверки 2026-08-08).
import type { AncestorRef, Edge, EdgeUpdate, DeletionSnapshot, GhostNode, Node, LevelEdge } from "../../types";
import NodeInspector from "./NodeInspector";
import EdgeInspector from "./EdgeInspector";
import GhostInspector from "./GhostInspector";
import "./panel.css";

// Что показано в панели: узел-локал, связь, ГОСТЬ (проекция чужого узла, read-only) или
// ничего. Источник правды — MapEditorPage (двойной клик по объекту наполняет панель).
export type Selected =
  | { kind: "node"; node: Node }
  | { kind: "edge"; edge: LevelEdge }
  | { kind: "ghost"; ghost: GhostNode }
  | null;

interface Props {
  selected: NonNullable<Selected>;
  // Предки выбранного узла от корня (у гостя путь свой — ghost.ancestors): строка «Тип»
  // решает по ним, какие типы возможны.
  nodeAncestors: readonly AncestorRef[];
  isArchitect: boolean;
  onNodeSaved: (saved: Node, isCreate: boolean, before?: Node) => void;
  onNodeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  onEdgeSaved: (edge: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void;
  onEdgeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  // «Показать на схеме» у гостя: уровень, где объект живёт, и подсветка объекта.
  onShowGhost: (ghost: GhostNode) => void;
  // «Открыть страницу объекта» в заголовке панели объекта и гостя.
  onNavigateNode: (nodeId: string) => void;
  // Крестик в заголовке.
  onClose: () => void;
}

export default function ObjectInspector({
  selected, nodeAncestors, isArchitect,
  onNodeSaved, onNodeDeleted, onEdgeSaved, onEdgeDeleted, onShowGhost, onNavigateNode, onClose,
}: Props) {
  return (
    <aside className="ip-panel" aria-label={selected.kind === "edge" ? "Связь" : "Объект"}>
      {selected.kind === "node" ? (
        <NodeInspector
          key={selected.node.id}
          node={selected.node}
          ancestors={nodeAncestors}
          isArchitect={isArchitect}
          onNodeSaved={onNodeSaved}
          onNodeDeleted={onNodeDeleted}
          onNavigateNode={onNavigateNode}
          onClose={onClose}
        />
      ) : selected.kind === "ghost" ? (
        <GhostInspector
          key={selected.ghost.id}
          ghost={selected.ghost}
          onShowOnMap={onShowGhost}
          onNavigateNode={onNavigateNode}
          onClose={onClose}
        />
      ) : (
        <EdgeInspector
          key={selected.edge.id}
          edge={selected.edge}
          isArchitect={isArchitect}
          onEdgeSaved={onEdgeSaved}
          onEdgeDeleted={onEdgeDeleted}
          onClose={onClose}
        />
      )}
    </aside>
  );
}
