// Панель объекта с другого уровня (гость — проекция чужого узла) в редакторе-карте:
// только просмотр. Гость несёт лишь GhostNode: имя, роль, технология, статус, путь
// предков; описания и документации у проекции нет, править её нельзя (настоящий объект
// живёт в другой ветке дерева). Заголовок — значок, название, «Открыть страницу
// объекта» (у «Пользователя» её нет, как у своего объекта) и «Закрыть»; строки только со
// значением: «Тип», «Роль», «Технология», «Расположение», «Статус». Действие одно —
// «Показать на схеме»: редактор переходит на уровень, где объект живёт, выбирает и
// подсвечивает его. Строка «Тип» — тем же вычислением, что у своего объекта (typeView,
// Р40), текстом.
import type { GhostNode } from "../../types";
import { treeNesting } from "../../types";
import { ShapeGlyph } from "../nodeTree.shared";
import { typeView } from "../element/elementView";
import { Prop, StatusLabel } from "../nodePage/PropRows";
import PanelHead from "./PanelHead";
import "../../ui/ds.css";
import "./panel.css";

interface Props {
  ghost: GhostNode;
  // «Показать на схеме»: MapEditorPage переходит на уровень родителя объекта.
  onShowOnMap: (ghost: GhostNode) => void;
  // «Открыть страницу объекта» в заголовке.
  onNavigateNode: (nodeId: string) => void;
  onClose: () => void;
}

export default function GhostInspector({ ghost, onShowOnMap, onNavigateNode, onClose }: Props) {
  const path = ghost.ancestors.map((a) => a.name).join(" / ");
  return (
    <>
      <PanelHead
        glyph={<ShapeGlyph nesting={treeNesting(ghost)} shape={ghost.shape} />}
        title={<h2 className="ip-title">{ghost.name}</h2>}
        onOpenPage={ghost.shape !== "person" ? () => onNavigateNode(ghost.id) : undefined}
        onClose={onClose}
      />
      <dl className="ip-props">
        <Prop term="Тип">{typeView(ghost, ghost.ancestors).label}</Prop>
        {ghost.role && <Prop term="Роль">{ghost.role}</Prop>}
        {ghost.technology && <Prop term="Технология">{ghost.technology}</Prop>}
        {path && <Prop term="Расположение">{path}</Prop>}
        <Prop term="Статус"><StatusLabel status={ghost.status} isExternal={ghost.is_external} /></Prop>
      </dl>
      <button type="button" className="ds-btn ip-show" onClick={() => onShowOnMap(ghost)}>
        Показать на схеме
      </button>
    </>
  );
}
