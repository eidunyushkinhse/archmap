// Отчёт превью и применения окон фактов от агента (структура базы, каналы, конфигурация) на
// новом языке (редизайн, фаза 6г): те же слова, что в прежнем отчёте, вид общий с окном схем
// логики (agentParts.css: apl-*). Записи плана — строками «имя, число, что будет» общей
// сеткой: путь объекта подписью над его строками, число («колонок 5») тихим цветом,
// замечание записи («без колонок, проверьте файл») под именем. Состояние — useFactAgent.
import { Fragment } from "react";
import { NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import type { FactAgent, FactReport } from "./useFactAgent";
import "../../ui/ds.css";
import "./agentParts.css";

// Сколько записей видно; остальные — строкой «и ещё N», как в прежнем отчёте.
const SHOWN_ROWS = 8;

/** Запись плана: путь объекта, имя, число тихим цветом, что будет, замечание. */
export interface FactRow {
  key: string;
  path: string;
  name: string;
  detail: string | null;
  action: string;
  /** Что будет — перезапись описанного (цветом предупреждения). */
  overwrite: boolean;
  bad: string | null;
}

/** Слова семьи, которые нужны отчёту. */
export interface FactPlanWords<R extends FactReport> {
  count: (r: R) => number;
  listTitle: string;
  rows: (r: R) => FactRow[];
  applied: (r: R) => string;
  summary: (r: R) => string;
}

export default function FactAgentPlan<R extends FactReport>({ agent, words }: {
  agent: FactAgent<R>;
  words: FactPlanWords<R>;
}) {
  const { report, checking, willWrite } = agent;
  const idle = !checking;
  return (
    <div className="apl">
      {checking && <p className="apl-line apl-quiet">Проверяем файлы</p>}
      {/* Вход тот же, что в прошлый заход: замечание повторится, и чинить надо разговор
          с агентом. Над сводкой. */}
      {agent.repeatedInput && <UnchangedInputNote ds />}
      {idle && report !== null && report.applied && (
        <p className="apl-summary is-ok">Применено: {words.applied(report)}.</p>
      )}
      {idle && report !== null && !report.applied && report.errors.length === 0 && (
        <p className={"apl-summary" + (willWrite ? " is-ok" : "")}>{words.summary(report)}</p>
      )}
      {idle && report !== null && report.errors.length > 0 && (
        <NoteList ds danger title="Файлы не применить:" items={report.errors} />
      )}
      {idle && report !== null && words.count(report) > 0 && (
        <PlanRows title={words.listTitle} rows={words.rows(report)} />
      )}
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

/** Записи плана общей сеткой; путь объекта — над его строками. */
function PlanRows({ title, rows }: { title: string; rows: FactRow[] }) {
  const shown = rows.slice(0, SHOWN_ROWS);
  return (
    <div className="apl-plan">
      <p className="apl-plan-title">{title}</p>
      <div className="apl-rows">
        {shown.map((r, i) => (
          <Fragment key={r.key}>
            {(i === 0 || shown[i - 1].path !== r.path) && <p className="apl-path">{r.path}</p>}
            <div className="apl-row">
              <div className="apl-name">
                <span className="apl-cell">{r.name}</span>
                {r.bad !== null && <span className="apl-bad" title={r.bad}>{r.bad}</span>}
              </div>
              <span className="apl-detail">{r.detail}</span>
              <span className={"apl-act" + (r.overwrite ? " is-warn" : "")}>{r.action}</span>
            </div>
          </Fragment>
        ))}
      </div>
      {rows.length > shown.length && <p className="apl-more">и ещё {rows.length - shown.length}</p>}
    </div>
  );
}
