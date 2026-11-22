// Отчёт превью и применения в стадии «Через ИИ-агента» окна спецификации OpenAPI на новом
// языке (редизайн, фаза 7в): те же части, что в прежней панели, вид общий с окнами схем
// логики и фактов (agentParts.css: apl-*). Состояние — useSpecAgent.
//
// Строка спецификации без склейки через «·»: путь объекта подписью над строкой, в строке
// имя файла, тихим цветом версия («OAS 3.0.3»), справа что будет. Пометка строки («YAML не
// читается», «синтезирована из кода…», «не похожа на OpenAPI») — под именем цветом
// предупреждения; само значение происхождения латиницей в строку не выводится. Заголовка
// над строкой нет: спецификация у объекта одна.
import { Fragment } from "react";
import type { DocsImportReport } from "../../types";
import { ACTION_LABEL, countAction } from "./agentModalShared";
import { NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import type { SpecAgent } from "./useSpecAgent";
import "../../ui/ds.css";
import "./agentParts.css";

type SpecRow = DocsImportReport["specs"][number];

// Сколько строк видно; остальные — строкой «и ещё N», как в прежнем отчёте.
const SHOWN_ROWS = 8;

// Части сводки в порядке прежнего отчёта; слова прежние.
const SUMMARY_PARTS: [string, string][] = [
  ["новых", "create"],
  ["перезапись", "overwrite"],
  ["пропуск", "skip"],
  ["без изменений", "unchanged"],
];

/** «Спецификаций: 1 (новых 1)»: в скобках только ненулевые счётчики, без них — без скобок. */
function summaryLine(rows: SpecRow[]): string {
  const parts = SUMMARY_PARTS
    .map(([word, action]) => [word, countAction(rows, action)] as const)
    .filter(([, n]) => n > 0)
    .map(([word, n]) => `${word} ${n}`);
  return `Спецификаций: ${rows.length}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

/** Пометка строки; порядок прежний: нечитаемый YAML важнее происхождения и вида. */
function specMark(s: SpecRow): string | null {
  if (!s.valid_yaml) return "YAML не читается";
  if (s.origin === "synthesized") return "синтезирована из кода, проверьте глазами";
  if (!s.looks_openapi) return "не похожа на OpenAPI";
  return null;
}

export default function SpecAgentPlan({ agent }: { agent: SpecAgent }) {
  const { report, checking, willWrite } = agent;
  const idle = !checking;
  return (
    <div className="apl">
      {checking && <p className="apl-line apl-quiet">Проверяем файлы</p>}
      {/* Вход тот же, что в прошлый заход: замечание повторится, и чинить надо разговор
          с агентом. Над сводкой. */}
      {agent.repeatedInput && <UnchangedInputNote />}
      {idle && report !== null && report.applied && (
        <p className="apl-summary is-ok">Применено: спецификаций записано {report.specs_written}.</p>
      )}
      {idle && report !== null && !report.applied && report.errors.length === 0 && (
        <p className={"apl-summary" + (willWrite ? " is-ok" : "")}>{summaryLine(report.specs)}</p>
      )}
      {idle && report !== null && report.errors.length > 0 && (
        <NoteList danger title="Файлы не применить:" items={report.errors} />
      )}
      {idle && report !== null && report.specs.length > 0 && <SpecRows rows={report.specs} />}
      {idle && report !== null && report.conflicts.length > 0 && (
        <NoteList title="Конфликты файлов (оставлен первый файл):" items={report.conflicts} />
      )}
      {idle && report !== null && report.warnings.length > 0 && (
        <NoteList title="Проверьте:" items={report.warnings} />
      )}
      {idle && agent.remarks.length > 0 && (
        <button type="button" className="ds-btn apl-remarks" onClick={agent.copyRemarks}>
          {agent.remarksCopied ? "Скопировано" : "Скопировать замечания для агента"}
        </button>
      )}
      {agent.askStale && <StaleFilesConfirm onKeep={agent.keepStale} onClear={agent.clearPackage} />}
    </div>
  );
}

/** Строки спецификаций общей сеткой: имя файла, версия, что будет; путь объекта — над ними. */
function SpecRows({ rows }: { rows: SpecRow[] }) {
  const shown = rows.slice(0, SHOWN_ROWS);
  return (
    <div className="apl-plan">
      <div className="apl-rows">
        {shown.map((s, i) => {
          const mark = specMark(s);
          return (
            <Fragment key={`${s.node_path}#${s.source}`}>
              {(i === 0 || shown[i - 1].node_path !== s.node_path) && <p className="apl-path">{s.node_path}</p>}
              <div className="apl-row">
                <div className="apl-name">
                  <span className="apl-cell">{s.source}</span>
                  {mark !== null && <span className="apl-bad" title={mark}>{mark}</span>}
                </div>
                <span className="apl-detail">{s.oas_version ? `OAS ${s.oas_version}` : null}</span>
                <span className={"apl-act" + (s.action === "overwrite" ? " is-warn" : "")}>
                  {ACTION_LABEL[s.action] ?? s.action}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
      {rows.length > shown.length && <p className="apl-more">и ещё {rows.length - shown.length}</p>}
    </div>
  );
}
