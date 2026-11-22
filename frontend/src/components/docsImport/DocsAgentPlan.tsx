// Отчёт превью и применения в окне «Описать схемы логики с помощью ИИ-агента» на новом
// языке (редизайн, фаза 6в): те же строки и слова, что в прежнем отчёте (DocsAgentReport),
// на токенах нового языка. Схемы плана — строками «имя, вид, что будет»: значения каждой
// колонки начинаются с одного x (общая сетка на все строки), адрес объекта — подписью над
// его строками, а не в каждой строке. Состояние — useDocsAgent.
import { Fragment } from "react";
import type { KeyboardEvent } from "react";
import type { NodeDocKind } from "../../types";
import { ACTION_LABEL, countAction } from "./agentModalShared";
import { NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import type { DocsAgent, DocsPlanRow } from "./useDocsAgent";
import { ChevronDownIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import { DOC_KIND_LABEL, DOC_KIND_ORDER } from "../nodeTerms";
import "../../ui/ds.css";
import "./agentParts.css";
import "./docsAgent.css";

// Сколько строк плана видно; остальные — строкой «и ещё N», как в прежнем отчёте.
const SHOWN_ROWS = 8;

// Части сводки в порядке прежнего отчёта; слова прежние.
const SUMMARY_PARTS: [string, string][] = [
  ["новых", "create"],
  ["заполнение неописанных", "fill"],
  ["перезапись", "overwrite"],
  ["пропуск", "skip"],
  ["без изменений", "unchanged"],
];

/** «Схем: 5 (новых 5)»: в скобках только ненулевые счётчики, без них — без скобок. */
function summaryLine(rows: DocsPlanRow[]): string {
  const parts = SUMMARY_PARTS
    .map(([word, action]) => [word, countAction(rows, action)] as const)
    .filter(([, n]) => n > 0)
    .map(([word, n]) => `${word} ${n}`);
  return `Схем: ${rows.length}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

export default function DocsAgentPlan({ agent }: { agent: DocsAgent }) {
  const { report, checking, mmdBroken, willWrite, remarks } = agent;
  const idle = !checking;
  return (
    <div className="dap">
      {checking && <p className="dap-line dap-quiet">Проверяем файлы</p>}
      {/* Вход тот же, что в прошлый заход: замечание повторится, и чинить надо разговор
          с агентом. Над сводкой. */}
      {agent.repeatedInput && <UnchangedInputNote ds />}
      {/* Ампутация пометок не должна быть молчаливой: пропавшие между попытками — НАД
          сводкой. */}
      {idle && agent.shrank.map((line) => (
        <p key={line} className="ds-warn dap-line">
          {line} Проверьте, не удалил ли агент пометки вместо того, чтобы исправить их
        </p>
      ))}
      {/* Непарсящиеся схемы — строкой НАД сводкой: в пакете на три десятка схем пометка в
          строке теряется. Применение не блокируем: битая схема всё ещё текст. */}
      {idle && agent.mmdPending && <p className="dap-line dap-quiet">Проверяем схемы</p>}
      {idle && report !== null && mmdBroken > 0 && (
        <p className="ds-warn dap-line">
          {mmdBroken} из {report.logic.length} схем не читаются как Mermaid. Исправьте эти файлы и
          загрузите их снова.
        </p>
      )}
      {idle && report !== null && report.applied && (
        <p className="dap-summary is-ok">
          Применено: схем создано {report.created_docs}, неописанных схем заполнено{" "}
          {report.filled_docs}, перезаписано {report.updated_docs}.
        </p>
      )}
      {idle && report !== null && !report.applied && report.errors.length === 0 && (
        <p className={"dap-summary" + (willWrite ? " is-ok" : "")}>{summaryLine(report.logic)}</p>
      )}
      {idle && report !== null && report.errors.length > 0 && (
        <NoteList ds danger title="Файлы не применить:" items={report.errors} />
      )}
      {idle && report !== null && report.logic.length > 0 && <PlanRows agent={agent} rows={report.logic} />}
      {idle && report !== null && report.conflicts.length > 0 && (
        <NoteList ds title="Конфликты файлов (оставлен первый файл):" items={report.conflicts} />
      )}
      {idle && report !== null && report.warnings.length > 0 && (
        <NoteList ds title="Проверьте:" items={report.warnings} />
      )}
      {idle && remarks.length > 0 && (
        <button type="button" className="ds-btn dap-remarks" onClick={agent.copyRemarks}>
          {agent.remarksCopied ? "Скопировано" : "Скопировать замечания для агента"}
        </button>
      )}
      {agent.askStale && <StaleFilesConfirm ds onKeep={agent.keepStale} onClear={agent.clearPackage} />}
    </div>
  );
}

// Enter в имени заканчивает правку: имя однострочное, перевод строки в него не входит.
function endOnEnter(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.currentTarget.blur();
}

/** Строки плана: имя (правится), вид (правится), что будет. Адрес объекта — над строками. */
function PlanRows({ agent, rows }: { agent: DocsAgent; rows: DocsPlanRow[] }) {
  const shown = rows.slice(0, SHOWN_ROWS);
  return (
    <div className="dap-plan">
      <p className="dap-plan-title">Схемы логики:</p>
      <div className="dap-rows">
        {shown.map((l, i) => {
          const err = agent.mmdErrs?.[i] ?? null;
          const name = agent.nameOf(l.source, l.name);
          return (
            <Fragment key={`${l.node_path}#${l.name}`}>
              {(i === 0 || shown[i - 1].node_path !== l.node_path) && (
                <p className="dap-path">{l.node_path}</p>
              )}
              <div className="dap-row">
                <div className="dap-name">
                  {/* Поле растёт по тексту: длинное имя переносится, строка не ломается. */}
                  <span className="ds-grow" data-value={name}>
                    <textarea
                      {...noAutofill("docs-agent-plan-name")}
                      rows={1}
                      className="ds-grow-input"
                      value={name}
                      onChange={(e) => agent.edit(l.source, { name: e.target.value || undefined })}
                      onKeyDown={endOnEnter}
                      title="Имя, под которым схема будет видна в ArchMap"
                      aria-label={`Имя схемы из файла ${l.source}`}
                    />
                  </span>
                  {l.operation && <span className="ds-mono dap-op">{l.operation}</span>}
                  {err !== null && (
                    <span className="dap-bad" title={err}>mermaid: {err.split("\n")[0]}</span>
                  )}
                </div>
                <span className="dap-kind">
                  <select
                    value={agent.kindOf(l.source, l.kind)}
                    onChange={(e) => agent.edit(l.source, { kind: e.target.value as NodeDocKind })}
                    title="Вид схемы можно поменять до применения"
                    aria-label={`Вид схемы из файла ${l.source}`}
                  >
                    {DOC_KIND_ORDER.map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
                  </select>
                  <span className="ds-value-chev" aria-hidden="true"><ChevronDownIcon /></span>
                </span>
                <span className={"dap-act" + (l.action === "overwrite" ? " is-warn" : "")}>
                  {ACTION_LABEL[l.action] ?? l.action}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
      {rows.length > shown.length && <p className="dap-more">и ещё {rows.length - shown.length}</p>}
    </div>
  );
}
