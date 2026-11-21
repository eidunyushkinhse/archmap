// Список СОБСТВЕННЫХ схем логики объекта — подгруппами по видам («Операции»,
// «Воркеры»).
//
// С редизайна (направление А «Документ») группы всегда раскрыты, без рамок и счётчиков:
// подпись подгруппы — тихий текст, строка — имя схемы и операция моноширинным, «в N
// процессах» — отдельная тихая часть строки справа.
//
// Список НЕ различает описанные схемы и заглушки: делит их владелец. «Логика»
// отдаёт сюда только описанные, блок «Не описано» (UndescribedDocs) — только
// заглушки, поэтому ни счётчика «описано N», ни метки «не описана» у строк нет
// (решение пользователя 2026-09-03: витрина не смешивается с бэклогом).
//
// Списки «схемы потомков» у контейнера сюда НЕ ходят: там своя группировка по
// объектам, и вторая вложенность сделала бы кашу.
//
// Компоненты объявлены НА ВЕРХНЕМ УРОВНЕ МОДУЛЯ: объявленный внутри другого
// ремаунтится каждый рендер (ловушка проекта — так ломался drag палитры).
import { useMemo, useState } from "react";
import type { NodeDocKind, NodeDocMeta, NodeDocUsage } from "../types";
import { plural } from "../ui/plural";
import { DocRowLabel } from "./docRow";
import "../ui/ds.css";

// Порядок групп — тот же, что у вида схемы во всём проекте: операция → воркер.
// Внутри группы порядок приходит с бэка (по имени) и фильтром сохраняется —
// сортировать заново незачем.
const GROUPS: { kind: NodeDocKind; title: string }[] = [
  { kind: "operation", title: "Операции" },
  { kind: "worker", title: "Воркеры" },
];

interface Props {
  docs: NodeDocMeta[];
  // Клик по строке открывает схему в оверлее документации. У неописанной строки
  // своей кнопки «Описать» нет (вьюер v2): «Описать» стоит в самом окне схемы.
  onOpen: (docId: string) => void;
  // Обратный индекс «используется в процессах» (Ф8, У10): строки для ВСЕХ схем узла
  // разом, фильтруются по doc_id здесь. Отвечает про КОНКРЕТНУЮ схему — узловой
  // вопрос закрывает раздел «Процессы», и дублировать его нельзя, поэтому подсписок
  // процессов раскрывается ПО ЗАПРОСУ, а не висит на экране.
  usage?: NodeDocUsage[];
  // Переход в процесс из подсписка. Не передан — подсписок некликабельный.
  onOpenProcess?: (processId: string) => void;
}

export default function NodeDocsList({ docs, onOpen, usage, onOpenProcess }: Props) {
  // Группы — ПРОИЗВОДНОЕ в рендере (эффект с setState тут запрещён линтом и
  // рассинхронился бы с метой). Пустая группа не рисуется вовсе.
  const groups = useMemo(
    () => GROUPS
      .map((g) => ({ ...g, items: docs.filter((d) => d.kind === g.kind) }))
      .filter((g) => g.items.length > 0),
    [docs],
  );

  // Индекс по схеме — картой один раз, а не фильтром в каждой строке: у монолита
  // двести строк, и O(строки × привязки) на каждый рендер незачем.
  const usageByDoc = useMemo(() => {
    const map = new Map<string, NodeDocUsage[]>();
    for (const u of usage ?? []) {
      const list = map.get(u.doc_id) ?? [];
      list.push(u);
      map.set(u.doc_id, list);
    }
    return map;
  }, [usage]);

  return (
    <div>
      {groups.map((g) => (
        <div key={g.kind} className="ds-subgroup">
          <div className="ds-sub">{g.title}</div>
          <div className="ds-rows">
            {g.items.map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                onOpen={onOpen}
                usage={usageByDoc.get(d.id)}
                onOpenProcess={onOpenProcess}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Строка схемы. «В N процессах» — СОСЕД главной кнопки строки, а не вложенная кнопка:
// <button> внутри <button> невалиден, и клик по вложенной открывал бы заодно схему.
function DocRow({ doc, onOpen, usage, onOpenProcess }: {
  doc: NodeDocMeta;
  onOpen: (docId: string) => void;
  usage?: NodeDocUsage[];
  onOpenProcess?: (processId: string) => void;
}) {
  // Подсписок «используется в процессах» раскрыт/свёрнут — поза на время просмотра: на
  // экране по умолчанию нет второго списка процессов рядом с разделом «Процессы» (У10).
  const [usageOpen, setUsageOpen] = useState(false);
  const used = usage ?? [];
  return (
    <>
      <div className="ds-row">
        <button
          type="button"
          className="ds-row-main"
          onClick={() => onOpen(doc.id)}
          title={`Открыть схему «${doc.name}»`}
        >
          <DocRowLabel name={doc.name} operation={doc.operation} />
        </button>
        {used.length > 0 && (
          <button
            type="button"
            className="ds-row-side"
            onClick={() => setUsageOpen((o) => !o)}
            aria-expanded={usageOpen}
            title="Шаги каких процессов задокументированы этой схемой"
          >
            в {used.length} {plural(used.length, ["процессе", "процессах", "процессах"])}
          </button>
        )}
      </div>
      {usageOpen && used.length > 0 && (
        <div className="ds-nested">
          {used.map((u) => (
            <button
              key={u.process_id}
              type="button"
              className="ds-nested-row"
              onClick={onOpenProcess ? () => onOpenProcess(u.process_id) : undefined}
              disabled={!onOpenProcess}
            >
              {u.process_name}
              <span className="ds-nested-note">
                {u.steps} {plural(u.steps, ["шаг", "шага", "шагов"])}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
