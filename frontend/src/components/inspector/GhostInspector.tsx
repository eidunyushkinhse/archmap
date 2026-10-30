// Мета ГОСТЯ (проекция чужого узла) в правой панели — только просмотр. Гость несёт
// лишь GhostNode: имя, роль, технология, статус, путь предков; description/flowchart/
// openapi у проекции нет, править её нельзя (реальный узел живёт в другой ветке дерева).
// Кнопка «Перейти к оригиналу» уводит на уровень, где узел показан как локал; раздел
// «Документация → Открыть» — на страницу узла, как у своего узла (двойной клик по узлу
// сам на страницу не уводит). Строка «Тип» — тем же вычислением, что у своего узла
// (typeView, Р40), только текстом: у компонента контейнер — ссылкой на его страницу,
// контейнер ищется в пути гостя.
import type { GhostNode } from "../../types";
import { treeNesting } from "../../types";
import { STATUS_META } from "../graph/colors";
import { ShapeGlyph } from "../nodeTree.shared";
import { typeView } from "../element/elementView";
import { TypeValue } from "../element/ElementParts";
import "./inspector.css";

interface Props {
  ghost: GhostNode;
  // Навигация к источнику: MapEditorPage грузит уровень-родитель, где гость — видимый узел.
  onGoToSource: (ghost: GhostNode) => void;
  // Переход на страницу узла (раздел «Документация» → «Открыть»).
  onNavigateNode: (nodeId: string) => void;
}

export default function GhostInspector({ ghost, onGoToSource, onNavigateNode }: Props) {
  const path = ghost.ancestors.map((a) => a.name).join(" / ");

  return (
    <div>
      <div className="insp-block-label">
        {ghost.is_external ? "Внешний объект" : "Объект"} · проекция
      </div>
      <div className="insp-ghost-head">
        <ShapeGlyph nesting={treeNesting(ghost)} shape={ghost.shape} />
        <span className="insp-endname">{ghost.name}</span>
      </div>
      <dl className="insp-meta insp-meta--stacked">
        <div className="insp-row">
          <dt className="insp-term">Тип</dt>
          <dd className="insp-value" style={{ margin: 0 }}>
            <TypeValue view={typeView(ghost, ghost.ancestors)} options={null} onNavigateNode={onNavigateNode} />
          </dd>
        </div>
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
        Перейти к оригиналу
      </button>
      {/* Документация — на странице узла, как у своего узла (у пользователя её нет). */}
      {ghost.shape !== "person" && (
        <>
          <div className="insp-block-label">Документация</div>
          <button type="button" className="insp-doc-item" onClick={() => onNavigateNode(ghost.id)}>
            <span className="insp-doc-name">Открыть</span>
          </button>
        </>
      )}
    </div>
  );
}
