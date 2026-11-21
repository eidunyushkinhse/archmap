// Объединение документации потомков контейнера по его непосредственным детям (аудит
// F-5: одна структура для схем логики и спецификаций вместо двух копий). С редизайна
// (направление А «Документ») каждая группа — подгруппа раздела: тихая подпись с именем
// ребёнка (ведёт на его страницу), под ней строки его записей и записей более глубоких
// потомков. Группы всегда раскрыты, без рамок и счётчиков; у записи глубокого потомка
// владелец назван тихой ссылкой справа.
import type { ReactNode } from "react";
import type { Node, NodeDocMeta } from "../../types";
import { DocRowLabel, OwnerSplitRow } from "../docRow";
import { ChevronDownIcon } from "../../ui/icons";
import type { DocTarget } from "./docTarget";
import "../../ui/ds.css";

export function DescendantGroups<G extends { child: Node }, D>({ groups, own, deep, renderDeep, onNavigateNode }: {
  groups: G[];
  // Записи самого ребёнка — строки (null/false — записей нет).
  own: (group: G) => ReactNode;
  // Записи глубоких потомков и строка каждой (с ключом).
  deep: (group: G) => D[];
  renderDeep: (item: D) => ReactNode;
  // Подпись подгруппы ведёт на страницу ребёнка.
  onNavigateNode: (id: string) => void;
}) {
  return (
    <div>
      {groups.map((group) => {
        const ownRows = own(group);
        const hasOwn = Array.isArray(ownRows) ? ownRows.length > 0 : Boolean(ownRows);
        const items = deep(group);
        if (!hasOwn && items.length === 0) return null;
        return (
          <div key={group.child.id} className="ds-subgroup">
            <button
              type="button"
              className="ds-sub"
              onClick={() => onNavigateNode(group.child.id)}
              title={`Перейти к объекту «${group.child.name}»`}
            >
              {group.child.name}
            </button>
            <div className="ds-rows">
              {ownRows}
              {items.map(renderDeep)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Схема потомка: открывается напрямую в контексте владельца. deep — владелец глубже
// подгруппы: он назван тихой ссылкой справа.
export function DocSplitRow({ doc, child, deep = false, onOpen, onNavigateNode }: {
  doc: NodeDocMeta;
  child: Node;
  deep?: boolean;
  onOpen: (target: DocTarget) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <OwnerSplitRow
      openTitle={`Открыть схему «${doc.name}»`}
      onOpen={() => onOpen({ mode: "flowchart", docId: doc.id, child })}
      owner={deep ? child : null}
      onNavigateNode={onNavigateNode}
    >
      <DocRowLabel name={doc.name} kind={doc.kind} operation={doc.operation} />
    </OwnerSplitRow>
  );
}

// Спецификация потомка: открывается напрямую (CAS-контекст владельца). deep — владелец
// глубже подгруппы: он назван тихой ссылкой справа.
export function SpecSplitRow({ child, deep = false, onOpen, onNavigateNode }: {
  child: Node;
  deep?: boolean;
  onOpen: (child: Node) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <OwnerSplitRow
      openTitle={`Открыть спецификацию «${child.name}»`}
      onOpen={() => onOpen(child)}
      owner={deep ? child : null}
      onNavigateNode={onNavigateNode}
    >
      <DocRowLabel name="Спецификация" />
    </OwnerSplitRow>
  );
}

// Шеврон сворачиваемого заголовка: смотрит вниз, когда раскрыто, и вправо — когда
// свёрнуто. Им сворачивается карточка «Связи» (EdgesSection).
export function GroupChevron({ open }: { open: boolean }) {
  return (
    <span className="np-doc-group-chev" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
      <ChevronDownIcon />
    </span>
  );
}
