// Объединение документации потомков контейнера по его непосредственным детям (аудит
// F-5: одна структура для схем логики и спек вместо двух копий): записи самого ребёнка
// — плоско, записи более глубоких потомков — в раскрываемой группе под ним (кнопка с
// шевроном и числом). Раскрытые группы — состояние списка; сворачивание группы у низа
// страницы держит скролл (useShrinkAnchor). Сбрасывается перемонтированием страницы
// при смене узла.
import { Fragment, useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { Node, NodeDocMeta } from "../../types";
import { ChevronDownIcon } from "../../ui/icons";
import { plural } from "../../ui/plural";
import { DocRowLabel, OwnerSplitRow } from "../docRow";
import { useShrinkAnchor } from "../useShrinkAnchor";
import type { DocTarget } from "./docTarget";

export function DescendantGroups<G extends { child: Node }, D>({ groups, words, own, deep, renderDeep }: {
  groups: G[];
  // Склонения подписи числа в группе: «1 схема», «2 схемы», «5 схем».
  words: [string, string, string];
  // Записи самого ребёнка — плоские строки.
  own: (group: G) => ReactNode;
  // Записи глубоких потомков и строка каждой (с ключом).
  deep: (group: G) => D[];
  renderDeep: (item: D) => ReactNode;
}) {
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const holdScroll = useShrinkAnchor();
  const toggle = useCallback((id: string, el: HTMLElement) => {
    if (openGroups.has(id)) holdScroll(el);
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [openGroups, holdScroll]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {groups.map((group) => {
        const open = openGroups.has(group.child.id);
        const items = deep(group);
        return (
          <Fragment key={group.child.id}>
            {own(group)}
            {items.length > 0 && (
              <div className="np-group">
                <button
                  type="button"
                  className="np-doc-group-toggle"
                  onClick={(e) => toggle(group.child.id, e.currentTarget)}
                  aria-expanded={open}
                >
                  <GroupChevron open={open} />
                  {group.child.name}
                  <span className="np-doc-group-count">
                    {items.length} {plural(items.length, words)}
                  </span>
                </button>
                {open && <div className="np-doc-group-body">{items.map(renderDeep)}</div>}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// Схема потомка: открывается напрямую в контексте владельца, правая часть ведёт на
// его страницу.
export function DocSplitRow({ doc, child, onOpen, onNavigateNode }: {
  doc: NodeDocMeta;
  child: Node;
  onOpen: (target: DocTarget) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <OwnerSplitRow
      openTitle={`Открыть схему «${doc.name}»`}
      onOpen={() => onOpen({ mode: "flowchart", docId: doc.id, child })}
      owner={child}
      onNavigateNode={onNavigateNode}
    >
      <DocRowLabel name={doc.name} kind={doc.kind} operation={doc.operation} />
    </OwnerSplitRow>
  );
}

// Спека потомка: открывается напрямую (CAS-контекст владельца), правая часть ведёт на
// его страницу.
export function SpecSplitRow({ child, onOpen, onNavigateNode }: {
  child: Node;
  onOpen: (child: Node) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <OwnerSplitRow
      openTitle={`Открыть спецификацию «${child.name}»`}
      onOpen={() => onOpen(child)}
      owner={child}
      onNavigateNode={onNavigateNode}
    >
      <DocRowLabel name="Спецификация" />
    </OwnerSplitRow>
  );
}

// Шеврон кнопки-группы: смотрит вниз, когда группа раскрыта, и вправо — когда свёрнута.
function GroupChevron({ open }: { open: boolean }) {
  return (
    <span className="np-doc-group-chev" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
      <ChevronDownIcon />
    </span>
  );
}
