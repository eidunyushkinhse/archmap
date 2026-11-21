// Блок «Не описано» — бэклог документирования объекта: заглушки разведки (строки
// перечня точек входа без тела, docs/plan-recon.md). Живёт ВНУТРИ раздела «Логика»
// под чертой-разделителем, а не отдельным разделом наравне с «Конфигурацией» и
// «OpenAPI» (решение пользователя 2026-09-03), и стартует свёрнутым: витрина
// объекта — описанные схемы, а перечень «за что браться» человек раскрывает сам.
// Внутри — тот же список подгрупп по видам, что и в «Логике»; строка открывает окно
// схемы, а «Описать» (вручную или через ИИ-агента) — уже в нём (вьюер v2).
// Заголовок — кликабельный текст с шевроном (как макрос Expand в Confluence), а не
// рамка раздела: блок — бэклог, а не ещё одна группа схем (решение 2026-09-29;
// кнопка «Описать все» убрана тем же решением). С редизайна — тихий текст подписи
// подгруппы (направление А).
//
// Компоненты объявлены на верхнем уровне модуля (ловушка проекта: объявленный
// внутри другого ремаунтится каждый рендер).
import { useState } from "react";
import type { NodeDocMeta, NodeDocUsage } from "../types";
import { ChevronDownIcon } from "../ui/icons";
import NodeDocsList from "./NodeDocsList";
import { useShrinkAnchor } from "./useShrinkAnchor";
import "../ui/ds.css";

interface Props {
  // Только заглушки (described=false) — делит владелец, здесь не фильтруем.
  docs: NodeDocMeta[];
  onOpen: (docId: string) => void;
  usage?: NodeDocUsage[];
  onOpenProcess?: (processId: string) => void;
}

export default function UndescribedDocs({ docs, onOpen, usage, onOpenProcess }: Props) {
  // Поза на время просмотра, никуда не сохраняется — как у групп видов.
  const [open, setOpen] = useState(false);
  const holdScroll = useShrinkAnchor();
  return (
    <div className="ds-expand-block">
      <button
        type="button"
        className="ds-expand"
        onClick={(e) => { if (open) holdScroll(e.currentTarget); setOpen((o) => !o); }}
        aria-expanded={open}
      >
        <span className={"ds-chev" + (open ? "" : " is-closed")}><ChevronDownIcon /></span>
        Не описано
        {/* Счётчик в скобках сразу за заголовком (замечание приёмки: «215 точек
            входа» смущало): свёрнутый бэклог иначе не говорит, велик ли он. */}
        <span className="ds-expand-count">({docs.length})</span>
      </button>
      {open && (
        <div className="ds-expand-body">
          <NodeDocsList
            docs={docs}
            onOpen={onOpen}
            usage={usage}
            onOpenProcess={onOpenProcess}
          />
        </div>
      )}
    </div>
  );
}
