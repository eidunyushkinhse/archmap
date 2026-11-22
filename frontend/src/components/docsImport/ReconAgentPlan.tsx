// Отчёт превью и применения окна «Составить список операций с помощью ИИ-агента» на новом
// языке (редизайн, фаза 6г): те же слова, что в прежнем отчёте, вид общий с окнами
// дозаливки (agentParts.css: apl-*). Сводка, под ней тихой подписью объект, которому уедет
// список (раньше хвостом сводки «· объект «путь»»), разделы по действию: заголовок с числом
// тихим цветом, примечание раздела, строки «имя, вид». Раздел длиннее OPEN_LIMIT стартует
// свёрнутым: двести строк «создадим» человек не читает, он смотрит на число и разворачивает.
// Состояние — useReconAgent.
import { useState } from "react";
import type { ReconItem } from "../../types";
import { NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import type { ReconAgent, ReconGroupRows } from "./useReconAgent";
import { KIND_LABEL, OPEN_LIMIT } from "../docsList";
import { ChevronDownIcon } from "../../ui/icons";
import "../../ui/ds.css";
import "./agentParts.css";
import "./reconAgent.css";

export default function ReconAgentPlan({ agent }: { agent: ReconAgent }) {
  const { report, checking, willWrite } = agent;
  const idle = !checking;
  return (
    <div className="apl">
      {checking && <p className="apl-line apl-quiet">Проверяем список</p>}
      {/* Вход тот же, что в прошлый заход: замечание над сводкой. */}
      {agent.repeatedInput && <UnchangedInputNote ds />}
      {idle && report !== null && report.applied && (
        <p className="apl-summary is-ok">Применено: неописанных схем создано {report.created}.</p>
      )}
      {idle && report !== null && !report.applied && report.errors.length === 0 && (
        <div>
          <p className={"apl-summary" + (willWrite ? " is-ok" : "")}>
            Операций и воркеров в списке: {agent.listedCount} (новых {agent.createCount})
          </p>
          {/* Объект, которому уедет список: адрес мог прийти из самого файла. */}
          {report.node_path && <p className="apl-path rcn-path">{report.node_path}</p>}
        </div>
      )}
      {idle && report !== null && report.errors.length > 0 && (
        <NoteList ds danger title="Список не применить:" items={report.errors} />
      )}
      {idle && agent.groups.map((g) => <ReconGroup key={g.action} group={g} />)}
      {idle && report !== null && report.warnings.length > 0 && (
        <NoteList ds title="Проверьте:" items={report.warnings} />
      )}
      {idle && agent.remarks.length > 0 && (
        <button type="button" className="ds-btn apl-remarks" onClick={agent.copyRemarks}>
          {agent.remarksCopied ? "Скопировано" : "Скопировать замечания для агента"}
        </button>
      )}
      {agent.askStale && <StaleFilesConfirm ds onKeep={agent.keepStale} onClear={agent.clearPackage} />}
    </div>
  );
}

// Раздел: заголовок-кнопка с числом, примечание, строки. Объявлен НА ВЕРХНЕМ УРОВНЕ
// модуля: объявленный внутри другого он ремаунтился бы каждый рендер (ловушка проекта).
function ReconGroup({ group }: { group: ReconGroupRows }) {
  const [open, setOpen] = useState(group.items.length <= OPEN_LIMIT);
  return (
    <div className="rcn-group">
      <button type="button" className="rcn-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={"ds-chev" + (open ? "" : " is-closed")} aria-hidden="true"><ChevronDownIcon /></span>
        {group.title}
        <span className="rcn-count">{group.items.length}</span>
      </button>
      {open && (
        <>
          {group.note && <p className="rcn-note">{group.note}</p>}
          <div className="rcn-rows">
            {group.items.map((it) => <ReconRow key={`${it.kind}:${it.name}`} item={it} />)}
          </div>
        </>
      )}
    </div>
  );
}

// Строка: имя и вид тихим цветом справа. Моноширинным — только сама операция
// («POST /orders»): у строки «нет в коде» имя — это имя схемы, словами. doc_name приходит,
// только когда имя УЖЕ существующей схемы отличается от строки перечня («POST /messages»
// описан схемой «Отправка сообщения»). Человек должен видеть, ЧТО закрыло операцию.
function ReconRow({ item }: { item: ReconItem }) {
  const op = item.kind === "operation" && item.operation === item.name;
  return (
    <div className="rcn-row">
      <div className="rcn-name">
        <span className={op ? "ds-mono rcn-op" : undefined}>{item.name}</span>
        {item.doc_name && <span className="rcn-doc">→ {item.doc_name}</span>}
      </div>
      <span className="rcn-kind">{KIND_LABEL[item.kind]}</span>
    </div>
  );
}
