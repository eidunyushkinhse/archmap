// Отчёт превью и применения прежнего вида (панель DocsAgentPanel, окно одной схемы):
// заметки о попытках агента, проверка Mermaid, сводка, строки плана, замечания, вопрос об
// устаревших файлах и рисунок входящей схемы. Состояние — useDocsAgent; окно «Описать
// схемы логики…» нового языка рисует отчёт своим видом (DocsAgentPlan).
import type { CSSProperties } from "react";
import type { NodeDocKind } from "../../types";
import MermaidRenderer from "../MermaidRenderer";
import { ACTION_LABEL, countAction, grayLine } from "./agentModalShared";
import { ItemList, NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import type { DocsAgent } from "./useDocsAgent";
import { secondaryBtn } from "../../ui/styles";
import { noAutofill } from "../../ui/noAutofill";
import { DOC_KIND_LABEL, DOC_KIND_ORDER } from "../nodeTerms";

// Сводка окна одной схемы: что станет с ЭТОЙ схемой, словами, а не счётчиками пакета.
function docSummary(action: string, name: string): string {
  if (action === "overwrite") return `Схема «${name}» будет обновлена`;
  if (action === "fill") return `Схема «${name}» будет описана`;
  if (action === "unchanged") return "Файл совпадает со схемой, менять нечего";
  if (action === "create") return `Будет создана новая схема «${name}»`;
  return `Схема «${name}» не изменится`;
}

export default function DocsAgentReport({ agent }: { agent: DocsAgent }) {
  const {
    docName, report, checking, mmdErrs, mmdBroken, mmdPending, shrank, repeatedInput,
    remarks, remarksCopied, copyRemarks, willWrite, incoming,
  } = agent;
  return (
    <div style={{ marginTop: 10, minHeight: 20 }}>
      {checking && <div style={grayLine}>Проверяем файлы</div>}
      {/* Вход тот же, что в прошлый заход, — заметка над сводкой: замечание
          повторится, и чинить надо не его, а разговор с агентом. */}
      {repeatedInput && <UnchangedInputNote />}
      {/* Ампутация пометок не должна быть молчаливой: пропавшие между
          попытками — НАД сводкой, до зелёного «Схем: N». */}
      {!checking && shrank.map((line) => (
        <div key={line} style={shrankLine}>
          {line} Проверьте, не удалил ли агент пометки вместо того, чтобы исправить их
        </div>
      ))}
      {/* Непарсящиеся схемы — строкой НАД сводкой, а не только значком ✗ в
          строке файла: в пакете на три десятка схем значок в списке теряется,
          и пакет применяют целиком (полевая находка Zulip v2). Применение не
          блокируем: схема с битым mermaid — всё ещё текст, который правят. */}
      {!checking && mmdPending && <div style={grayLine}>Проверяем схемы</div>}
      {!checking && report !== null && mmdBroken > 0 && (
        <div style={shrankLine}>
          {mmdBroken} из {report.logic.length} схем не читаются как Mermaid. Исправьте эти
          файлы и загрузите их снова.
        </div>
      )}
      {!checking && report !== null && report.applied && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
          Применено: схем создано {report.created_docs}, неописанных схем заполнено{" "}
          {report.filled_docs}, перезаписано {report.updated_docs}.
        </div>
      )}
      {!checking && report !== null && !report.applied && report.errors.length === 0 && (
        docName !== null && report.logic.length === 1 ? (
          <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
            {docSummary(report.logic[0].action, docName)}
          </div>
        ) : (
          <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
            Схем: {report.logic.length} (новых {countAction(report.logic, "create")},
            заполнение неописанных {countAction(report.logic, "fill")},
            перезапись {countAction(report.logic, "overwrite")}, пропуск {countAction(report.logic, "skip")},
            без изменений {countAction(report.logic, "unchanged")})
          </div>
        )
      )}
      {!checking && report !== null && report.errors.length > 0 && (
        <div style={{ fontSize: 12.5, color: "#dc2626" }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>Файлы не применить:</div>
          {report.errors.slice(0, 6).map((e, i) => <div key={i} style={{ marginTop: 2 }}>{e}</div>)}
          {report.errors.length > 6 && <div>и ещё {report.errors.length - 6}</div>}
        </div>
      )}

      {!checking && report !== null && report.logic.length > 0 && (
        <ItemList
          title="Схемы логики:"
          rows={report.logic.map((l, i) => {
            // Фиксируем в const: TS не сужает индексацию через ?. в тернарнике
            const err = mmdErrs?.[i] ?? null;
            const key = `${l.node_path}#${l.name}`;
            return {
              key,
              text: `«${l.node_path}»${l.operation ? ` · ${l.operation}` : ""}`,
              badge: ACTION_LABEL[l.action] ?? l.action,
              bad: err !== null ? `mermaid: ${err.split("\n")[0]}` : null,
              ok: mmdErrs?.[i] === null,
              // Имя и вид приехали из шапки файла (или подставлены по
              // умолчанию) — и то и другое правится до применения. В окне
              // схемы имя уже её, править нечего.
              extra: docName !== null ? undefined : (
                <>
                  <input
                    {...noAutofill("docs-agent-panel-1")}
                    style={nameInput}
                    value={agent.nameOf(l.source, l.name)}
                    onChange={(e) => agent.edit(l.source, { name: e.target.value || undefined })}
                    title="Имя, под которым схема будет видна в ArchMap"
                    aria-label={`Имя схемы из файла ${l.source}`}
                  />
                  <select
                    style={kindSelect}
                    value={agent.kindOf(l.source, l.kind)}
                    onChange={(e) => agent.edit(l.source, { kind: e.target.value as NodeDocKind })}
                    title="Вид схемы можно поменять до применения"
                    aria-label={`Вид схемы из файла ${l.source}`}
                  >
                    {DOC_KIND_ORDER.map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
                  </select>
                </>
              ),
            };
          })}
        />
      )}
      {!checking && report !== null && report.conflicts.length > 0 && (
        <NoteList title="Конфликты файлов (оставлен первый файл):" items={report.conflicts} />
      )}
      {!checking && report !== null && report.warnings.length > 0 && (
        <NoteList title="Проверьте:" items={report.warnings} />
      )}
      {!checking && remarks.length > 0 && (
        <button
          type="button"
          style={{ ...secondaryBtn, marginTop: 8, padding: "4px 10px", fontSize: 12.5 }}
          onClick={copyRemarks}
        >
          {remarksCopied ? "Скопировано ✓" : "Скопировать замечания для агента"}
        </button>
      )}
      {agent.askStale && (
        <StaleFilesConfirm onKeep={agent.keepStale} onClear={agent.clearPackage} />
      )}
      {!checking && incoming !== null && incoming.mermaid.trim() !== "" && (
        <div style={incomingBox}>
          <MermaidRenderer chart={incoming.mermaid} />
        </div>
      )}
    </div>
  );
}

// ── inline-стили отчёта и правки строк (остальные — agentModalShared) ──

// Тот же amber, что у «Исчезли:» в панели импорта и у заголовков отчёта.
const shrankLine: CSSProperties = {
  fontSize: 12.5, fontWeight: 600, color: "#b45309", marginBottom: 6,
};
const nameInput: CSSProperties = {
  flex: "none", width: 190, font: "inherit", fontSize: 11.5, color: "#0f172a",
  border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", padding: "1px 5px",
};
const kindSelect: CSSProperties = {
  flex: "none", font: "inherit", fontSize: 11.5, color: "#334155", cursor: "pointer",
  border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", padding: "1px 4px",
};
// Превью входящей схемы: рамка и точечный фон — как у превью окна схемы.
const incomingBox: CSSProperties = {
  marginTop: 10, maxHeight: 260, overflow: "auto", padding: 12,
  border: "1px solid #e2e8f0", borderRadius: 10,
  backgroundColor: "#fbfcfd",
  backgroundImage: "radial-gradient(#e3e8ee 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};
