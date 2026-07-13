// Мета ГОСТЯ (проекция чужого узла) в правой панели — только просмотр. Гость несёт
// лишь GhostNode: имя, роль, технология, статус, путь предков; description/flowchart/
// openapi у проекции нет, править её нельзя (реальный узел живёт в другой ветке дерева).
// Кнопка «Перейти к источнику» уводит на уровень, где узел показан как локал.
import type { GhostNode } from "../../types";
import { canHaveChildren } from "../../types";
import { STATUS_META } from "../graph/colors";
import { ShapeGlyph } from "../nodeTree.shared";
import "./inspector.css";

interface Props {
  ghost: GhostNode;
  // Навигация к источнику: TreePage грузит уровень-родитель, где гость — видимый узел.
  onGoToSource: (ghost: GhostNode) => void;
}

export default function GhostInspector({ ghost, onGoToSource }: Props) {
  const container = canHaveChildren(ghost.shape) && ghost.has_children;
  const path = ghost.ancestors.map((a) => a.name).join(" / ");

  return (
    <div>
      <div className="insp-block-label">
        {ghost.is_external ? "Внешний объект" : "Объект"} · проекция
      </div>
      <div className="insp-ghost-head">
        <ShapeGlyph container={container} shape={ghost.shape} />
        <span className="insp-endname">{ghost.name}</span>
      </div>
      <dl className="insp-meta">
        {ghost.role && (
          <div className="insp-row">
            <dt className="insp-term">Роль</dt>
            <dd className="insp-value" style={{ margin: 0 }}>{ghost.role}</dd>
          </div>
        )}
        {ghost.technology && (
          <div className="insp-row">
            <dt className="insp-term">Технология</dt>
            <dd className="insp-value" style={{ margin: 0 }}>{ghost.technology}</dd>
          </div>
        )}
        {path && (
          <div className="insp-row">
            <dt className="insp-term">Расположение</dt>
            <dd className="insp-value" style={{ margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{path}</dd>
          </div>
        )}
        <div className="insp-row">
          <dt className="insp-term">Статус</dt>
          <dd className="insp-value" style={{ margin: 0 }}>{STATUS_META[ghost.status].label}</dd>
        </div>
      </dl>
      <p className="insp-ghost-note">Проекция узла из другой части схемы — только просмотр.</p>
      <button type="button" className="insp-goto" onClick={() => onGoToSource(ghost)}>
        Перейти к источнику
      </button>
    </div>
  );
}
