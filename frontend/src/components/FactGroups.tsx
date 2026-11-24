// Список записей раздела фактов по группам: разделы таблиц базы (schema/database/
// keyspace) и группы каналов брокера (vhost/namespace/account). У обоих разделов это
// была одна и та же разметка с раскрывашками (аудит F-13). С редизайна (направление А
// «Документ») подпись группы — тихий текст с шевроном, без рамки; группа по-прежнему
// сворачивается: разделов у базы бывает много, а таблиц в каждом — десятки.
import { useRef } from "react";
import type { ReactNode } from "react";
import { useCollapse } from "./useCollapse";
import { useFlipRows } from "./useFlipRows";
import { useToggleSet } from "./useFactRows";
import { ChevronDownIcon } from "../ui/icons";
import "./factRows.css";
import "../ui/ds.css";

interface Props<T> {
  items: T[];
  // Ключ записи — он же data-flip-id её строки.
  idOf: (item: T) => string;
  groupOf: (item: T) => string;
  // Подпись группы без имени: «без раздела», «без группы».
  ungrouped: string;
  // Удержание скролла раздела: один якорь на раздел, общий с раскрывашками записей.
  holdScroll: (el: HTMLElement | null) => void;
  render: (item: T) => ReactNode;
}

export default function FactGroups<T>({
  items, idOf, groupOf, ungrouped, holdScroll, render,
}: Props<T>) {
  // Свёрнутые группы (по умолчанию раскрыты — иначе структура выглядит пустой).
  const [closed, toggle] = useToggleSet();
  // Переезд записи между плоским списком и группой анимируем (FLIP): без этого она
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

  // Подпись перестройки для FLIP — только про ПЕРЕЕЗД записей: свёртка группы позиций
  // не меняет (тело едет само), и включать её сюда незачем.
  const flipKey = items.map((item) => `${idOf(item)}:${groupOf(item)}`).join("|");
  useFlipRows(listRef, flipKey);

  return (
    <div ref={listRef}>
      {grouped.length > 1 ? (
        // Группы показываем ТОЛЬКО когда они реально заданы: у баз и брокеров без такого
        // уровня (Redis, Kafka) лишняя вложенность была бы шумом.
        grouped.map(([group, list]) => {
          const open = !closed.has(group);
          return (
            <div key={group} className="fact-group">
              <button
                type="button"
                className="fact-group-toggle"
                aria-expanded={open}
                onClick={(e) => {
                  // Придерживаем скролл ДО правки: свернуть — значит укоротить страницу.
                  if (open) holdScroll(e.currentTarget);
                  toggle(group);
                }}
              >
                <span className={"ds-chev" + (open ? "" : " is-closed")}><ChevronDownIcon /></span>
                {group || ungrouped}
              </button>
              <GroupBody open={open}>{list.map(render)}</GroupBody>
            </div>
          );
        })
      ) : (
        <div>{items.map(render)}</div>
      )}
    </div>
  );
}

// Тело группы: высоту ведёт ОНО САМО, а список и раздел живут с auto и следуют за ним.
// Пробовали наоборот (анимировать высоту контейнера) — измерение врало, потому что
// дочерние блоки в этот момент зафиксированы своей анимацией, и кнопки под списком
// подпрыгивали на старте и на приземлении.
function GroupBody({ open, children }: {
  open: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const show = useCollapse(ref, open);
  if (!show) return null;
  // Анимируем ГОЛУЮ обёртку, косметика — на внутреннем блоке: у блока с padding/border
  // border-box-высоту ставить нельзя, а его margin в height не входит вовсе — и то, и
  // другое давало прыжок соседей в начале и в конце анимации.
  return (
    <div ref={ref} className="anim-box">
      <div>{children}</div>
    </div>
  );
}
