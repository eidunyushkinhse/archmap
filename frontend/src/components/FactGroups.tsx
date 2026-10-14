// Список записей секции фактов по группам: разделы таблиц базы (schema/database/
// keyspace) и группы каналов брокера (vhost/namespace/account). У обеих секций это
// была одна и та же разметка с раскрывашками (аудит F-13); классы обёрток остаются
// своими (dbs-*, bch-*) — сетки у секций разные, и CSS у них не общий намеренно.
import { useRef } from "react";
import type { ReactNode } from "react";
import { useCollapse } from "./useCollapse";
import { useFlipRows } from "./useFlipRows";
import { useToggleSet } from "./useFactRows";
import { ChevronDownIcon } from "../ui/icons";

interface Props<T> {
  items: T[];
  // Ключ записи — он же data-flip-id её карточки.
  idOf: (item: T) => string;
  groupOf: (item: T) => string;
  // Подпись группы без имени: «без раздела», «без группы».
  ungrouped: string;
  // Классы обёрток: группы, тела группы и плоского списка.
  groupClass: string;
  bodyClass: string;
  flatClass: string;
  // Что показать, когда записей нет.
  empty: ReactNode;
  // Удержание скролла секции: один якорь на секцию, общий с раскрывашками карточек.
  holdScroll: (el: HTMLElement | null) => void;
  render: (item: T) => ReactNode;
}

export default function FactGroups<T>({
  items, idOf, groupOf, ungrouped, groupClass, bodyClass, flatClass, empty, holdScroll, render,
}: Props<T>) {
  // Свёрнутые группы (по умолчанию раскрыты — иначе структура выглядит пустой).
  const [closed, toggle] = useToggleSet();
  // Переезд карточки между плоским списком и группой анимируем (FLIP): без этого она
  // мгновенно оказывается в другом месте и это читается как рывок.
  const listRef = useRef<HTMLDivElement>(null);

  // Пустая группа идёт первой: у большинства баз и у Kafka она единственная.
  const grouped: [string, T[]][] = [];
  for (const item of items) {
    const key = groupOf(item);
    const bucket = grouped.find(([k]) => k === key);
    if (bucket) bucket[1].push(item);
    else grouped.push([key, [item]]);
  }
  grouped.sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

  // Подпись перестройки для FLIP — только про ПЕРЕЕЗД карточек: свёртка группы позиций
  // не меняет (тело едет само), и включать её сюда незачем.
  const flipKey = items.map((item) => `${idOf(item)}:${groupOf(item)}`).join("|");
  useFlipRows(listRef, flipKey);

  return (
    <div ref={listRef}>
      {items.length === 0 ? (
        empty
      ) : grouped.length > 1 ? (
        // Группы показываем ТОЛЬКО когда они реально заданы: у баз и брокеров без такого
        // уровня (Redis, Kafka) лишняя вложенность была бы шумом.
        grouped.map(([group, list]) => {
          const open = !closed.has(group);
          return (
            <div key={group} className={`${groupClass} np-group`}>
              {/* Те же классы, что у групп доков на странице объекта: раскрывашка
                  должна выглядеть как соседние, а не как своя выдумка. */}
              <button
                type="button"
                className="np-doc-group-toggle"
                aria-expanded={open}
                onClick={(e) => {
                  // Придерживаем скролл ДО правки: свернуть — значит укоротить страницу.
                  if (open) holdScroll(e.currentTarget);
                  toggle(group);
                }}
              >
                <span className="np-doc-group-chev"
                  style={{ transform: open ? "none" : "rotate(-90deg)" }}>
                  <ChevronDownIcon />
                </span>
                {group || ungrouped}
              </button>
              <GroupBody open={open} className={bodyClass}>{list.map(render)}</GroupBody>
            </div>
          );
        })
      ) : (
        <div className={flatClass}>{items.map(render)}</div>
      )}
    </div>
  );
}

// Тело группы: высоту ведёт ОНО САМО, а список и карточка секции живут с auto и
// следуют за ним. Пробовали наоборот (анимировать высоту контейнера) — измерение
// врало, потому что дочерние блоки в этот момент зафиксированы своей анимацией, и
// кнопки под списком подпрыгивали на старте и на приземлении.
function GroupBody({ open, className, children }: {
  open: boolean;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const show = useCollapse(ref, open);
  if (!show) return null;
  // Анимируем ГОЛУЮ обёртку, вся косметика — на внутреннем блоке. Иначе высота
  // считалась бы неверно: у блока с padding/border ставить ему border-box-высоту
  // нельзя (он content-box), а его margin в height не входит вовсе — и то, и другое
  // давало прыжок соседей в начале и в конце анимации.
  return (
    <div ref={ref} className="anim-box">
      <div className={className}>{children}</div>
    </div>
  );
}
