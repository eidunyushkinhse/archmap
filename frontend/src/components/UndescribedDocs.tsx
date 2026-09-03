// Блок «Не описано» — бэклог документирования объекта: заглушки разведки (строки
// перечня точек входа без тела, docs/plan-recon.md). Живёт ВНУТРИ карточки «Логика»
// под чертой-разделителем, а не отдельной карточкой наравне с «Конфигурацией» и
// «OpenAPI» (решение пользователя 2026-09-03), и стартует свёрнутым: витрина
// объекта — описанные схемы, а перечень «за что браться» человек раскрывает сам.
// Внутри — тот же список групп по видам, что и в «Логике» (двести строк после
// разведки монолита сворачиваются по своему порогу); у строки — «Описать» (окно
// доков «по одной» с адресом) и «открыть →» (оверлей, писать руками); «Описать
// все» в шапке — окно доков «пакетом», оно само знает перечень заглушек.
//
// Компоненты объявлены на верхнем уровне модуля (ловушка проекта: объявленный
// внутри другого ремаунтится каждый рендер).
import { useState } from "react";
import type { CSSProperties } from "react";
import type { NodeDocMeta, NodeDocUsage } from "../types";
import { ChevronDownIcon } from "../ui/icons";
import NodeDocsList from "./NodeDocsList";

interface Props {
  // Только заглушки (described=false) — делит владелец, здесь не фильтруем.
  docs: NodeDocMeta[];
  onOpen: (docId: string) => void;
  onDescribe?: (doc: NodeDocMeta) => void;
  // «Описать все» в шапке. Не передан (читатель, чужая форма объекта) — кнопки нет.
  onDescribeAll?: () => void;
  usage?: NodeDocUsage[];
  onOpenProcess?: (processId: string) => void;
}

export default function UndescribedDocs({ docs, onOpen, onDescribe, onDescribeAll, usage, onOpenProcess }: Props) {
  // Поза на время просмотра, никуда не сохраняется — как у групп видов.
  const [open, setOpen] = useState(false);
  return (
    <div className="np-undescribed">
      <div className="np-undescribed-head">
        {/* «Описать все» — СОСЕД кнопки-заголовка, а не вложенная кнопка: <button>
            внутри <button> невалиден, и клик по вложенной раскрывал бы заодно список. */}
        <button
          type="button"
          className="np-doc-group-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="np-doc-group-chev" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
            <ChevronDownIcon />
          </span>
          Не описано
          {/* Счётчик в скобках сразу за заголовком — как у групп «Операции (N)»
              (замечание приёмки: «215 точек входа» смущало). */}
          <span style={headCount}>({docs.length})</span>
        </button>
        {onDescribeAll && (
          <button type="button" className="np-undescribed-all" onClick={onDescribeAll}>
            Описать все
          </button>
        )}
      </div>
      {open && (
        <div className="np-undescribed-body">
          <NodeDocsList
            docs={docs}
            onOpen={onOpen}
            onDescribe={onDescribe}
            usage={usage}
            onOpenProcess={onOpenProcess}
          />
        </div>
      )}
    </div>
  );
}

// Тот же стиль, что у счётчика групп в NodeDocsList (groupCount).
const headCount: CSSProperties = { fontSize: 12, fontWeight: 400, color: "#94a3b8" };
