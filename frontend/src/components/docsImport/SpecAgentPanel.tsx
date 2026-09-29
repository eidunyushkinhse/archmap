// Правая колонка дозаливки OpenAPI-спеки от агента (BYOA): файлы пакета, живой
// dry-run и «Применить». Вынесена из SpecAgentModal, чтобы жить и в окне спеки
// (DocOverlay → «Изменить → Через ИИ-агента»): тело одно, окно-хозяин решает, что
// делать после применения. Промпт — забота окна (левая колонка).
//
// Спека у узла одна — без режимов «пакетом/по одной» и «Добавить ещё». Политика
// перезаписи всегда «перезаписывать»: окно открывают, чтобы получить новую спеку.
// Применение НЕ кладётся в undo — страховка: превью до записи.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsImportReport } from "../../types";
import { docsImportApi, type DocsFile } from "../../api/docsImport";
import { useDocsFiles } from "./useDocsFiles";
import {
  ACTION_LABEL, countAction, inputFingerprint, useRepeatedInput, rightCol, grayLine, footRow,
} from "./agentModalShared";
import { ItemList, NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import AgentPackageInput from "./AgentPackageInput";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

interface Props {
  // Узел, для которого агент готовит спеку (скоуп превью и применения).
  nodeId: string;
  // Спека записана — окно-хозяин освежает данные и закрывается / возвращается к просмотру.
  onApplied: () => void;
}

export default function SpecAgentPanel({ nodeId, onApplied }: Props) {
  const pkg = useDocsFiles();
  // Отчёт последнего превью/применения. Пустые файлы прячут его ПРОИЗВОДНО
  // (pkg.hasContent) — эффекты не зеркалят состояние синхронными setState.
  const [rawReport, setRawReport] = useState<DocsImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [remarksCopied, setRemarksCopied] = useState(false);
  const seqRef = useRef(0);

  const report = pkg.hasContent ? rawReport : null;

  // Гвард «вход не изменился»: тот же байт-в-байт пакет, что в прошлый заход, —
  // повод посмотреть на файлы агента, а не на замечание (находка полевой приёмки).
  const fingerprint = useMemo(() => inputFingerprint(pkg.files), [pkg.files]);
  const repeatedInput = useRepeatedInput(pkg.files, fingerprint);
  // Пакет, к которому задан вопрос об устаревании (после копирования замечаний).
  // Сравнение по ссылке: тронули файлы — вопрос снят сам, без эффекта.
  const [askedFor, setAskedFor] = useState<DocsFile[] | null>(null);

  // Дебаунс-превью по файлам; план фильтруется по спекам (only="api").
  // Все setState — в таймере/ответе (асинхронно); seq отбрасывает устаревшие
  // ответы при быстрой правке.
  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return; // отчёт скрыт производно (hasContent)
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      docsImportApi.preview({ files: nonEmpty, overwrite: true, only: "api", nodeId })
        .then((r) => {
          if (seqRef.current !== seq) return;
          setRawReport(r);
          setChecking(false);
        })
        .catch(() => {
          if (seqRef.current !== seq) return;
          setRawReport(null);
          setChecking(false);
        });
    }, 600);
    return () => window.clearTimeout(t);
  }, [pkg.files, nodeId]);

  // Замечания для агента: ошибки/конфликты/предупреждения по спеке.
  const remarks = report === null ? [] : [...report.errors, ...report.conflicts, ...report.warnings];

  function copyRemarks() {
    const text =
      "Валидатор дозаливки доков ArchMap нашёл замечания к пакету archmap-docs. " +
      "Исправь пакет и сообщи, какие файлы изменились:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setRemarksCopied(true);
      setTimeout(() => setRemarksCopied(false), 2000);
      // Замечания ушли агенту — значит вернётся исправленная версия, и лежащий в
      // панели пакет устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать пакет из панели: файлы и отчёт уходят целиком (зеркало снятия
  // последнего файла крестиком) — новый заход сравнивать будет не с чем.
  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
  }

  function apply() {
    setApplying(true);
    // Применяются только OpenAPI-спеки (only="api")
    docsImportApi.apply({ files: pkg.nonEmpty, overwrite: true, only: "api", nodeId })
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        onApplied();
      })
      .finally(() => setApplying(false));
  }

  const willWrite =
    report !== null &&
    report.errors.length === 0 &&
    countAction(report.specs, "create") + countAction(report.specs, "overwrite") > 0;

  return (
    <div style={rightCol}>
      <AgentPackageInput
        pkg={pkg}
        onRemove={pkg.removeFile}
        dropText="Перетащите сюда файл спеки, который подготовил агент, или нажмите, чтобы выбрать его на диске. Спеку можно и вставить текстом."
        pasteTitle="Добавить спеку вставкой текста"
      />

      {/* Отчёт превью / применения */}
      <div style={{ marginTop: 10, minHeight: 20 }}>
        {checking && <div style={grayLine}>Проверяю пакет…</div>}
        {/* Вход тот же, что в прошлый заход, — заметка над сводкой: замечание
            повторится, и чинить надо не его, а разговор с агентом. */}
        {repeatedInput && <UnchangedInputNote />}
        {!checking && report !== null && report.applied && (
          <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
            Применено: спек записано {report.specs_written}.
          </div>
        )}
        {!checking && report !== null && !report.applied && report.errors.length === 0 && (
          <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
            Спек: {report.specs.length} (новых {countAction(report.specs, "create")},
            перезапись {countAction(report.specs, "overwrite")}, пропуск {countAction(report.specs, "skip")},
            без изменений {countAction(report.specs, "unchanged")})
          </div>
        )}
        {!checking && report !== null && report.errors.length > 0 && (
          <div style={{ fontSize: 12.5, color: "#dc2626" }}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>Пакет не применить:</div>
            {report.errors.slice(0, 6).map((e, i) => <div key={i} style={{ marginTop: 2 }}>{e}</div>)}
            {report.errors.length > 6 && <div>…ещё {report.errors.length - 6}</div>}
          </div>
        )}

        {!checking && report !== null && report.specs.length > 0 && (
          <ItemList
            title="OpenAPI-спеки:"
            rows={report.specs.map((s) => ({
              key: `${s.node_path}#spec`,
              text: `«${s.node_path}» · ${s.source}${s.oas_version ? ` · OAS ${s.oas_version}` : ""}`,
              badge: `${ACTION_LABEL[s.action] ?? s.action}${s.origin ? ` · ${s.origin}` : ""}`,
              bad: !s.valid_yaml
                ? "невалидный YAML"
                : s.origin === "synthesized"
                  ? "синтезирована из кода — проверьте глазами"
                  : !s.looks_openapi ? "не похожа на OpenAPI" : null,
              ok: s.valid_yaml && s.looks_openapi && s.origin !== "synthesized",
            }))}
          />
        )}
        {!checking && report !== null && report.conflicts.length > 0 && (
          <NoteList title="Конфликты файлов (оставлен первый источник):" items={report.conflicts} />
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
        {askedFor === pkg.files && (
          <StaleFilesConfirm onKeep={() => setAskedFor(null)} onClear={clearPackage} />
        )}
      </div>

      <div style={footRow}>
        <button
          type="button"
          style={{ ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55, marginLeft: "auto" }}
          disabled={!willWrite || applying}
          onClick={apply}
        >
          {applying ? "Применяю…" : "Применить"}
        </button>
      </div>
    </div>
  );
}
