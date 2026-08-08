// Модалка «Описать логику с помощью агента» (BYOA-дозаливка) — ТОЛЬКО СХЕМЫ
// ЛОГИКИ (node_docs, mermaid). OpenAPI-спека узла — отдельное окно
// SpecAgentModal: сущности не смешиваются (include промпта и фильтр
// превью/применения зафиксированы на «logic»). Скоуп — ТЕКУЩИЙ УЗЕЛ, два режима:
// «Пакетом» — все схемы объекта за заход (микросервисы); «По одной схеме» — один
// воркер/эндпоинт (крупные монолиты), слева поле «Что описать» (target — блок
// фокуса в промпте).
// Пакет — самодостаточные .mmd: имя схемы, вид и привязка к операции лежат в
// ШАПКЕ файла, файла-описи нет (docs/plan-docs-mmd.md). Имя и вид правятся прямо
// в строке превью; правка уезжает полем overrides, а не переписыванием текста,
// как было с манифестом.
// Mermaid-тексты схем валидируются здесь фронтом (бэкового валидатора нет) —
// советующе, ✗ не блокирует применение. Применение НЕ кладётся в undo (см.
// примечание к версионированию в tasks.md) — страховка: превью + дефолт
// «не перезаписывать». Закрытие после успешного применения — отсюда (onClose);
// родитель через onApplied только освежает мету узла.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { DocsImportReport, NodeDocKind } from "../../types";
import { docsImportApi, type DocsOverride, type DocsPromptParams } from "../../api/docsImport";
import { validateMermaid } from "../mermaidLoader";
import { useDocsFiles, MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import {
  ACTION_LABEL, countAction,
  head, sub, cols, leftCol, rightCol, radioRow, hintsArea,
  chipsRow, chipOn, chip, chipBtn, chipX, fileArea, dropHint, grayLine, footRow,
} from "./agentModalShared";
import { ItemList, NoteList } from "./agentModalReport";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

type Mode = "batch" | "single";

interface Props {
  // Узел, для которого агент готовит документы (скоуп промпта и применения).
  nodeId: string;
  nodeName: string;
  // Режим открытия модалки (пункты меню «+ Добавить» в секции «Логика»).
  initialMode?: Mode;
  onClose: () => void;
  // Дозаливка применена — родитель освежает мету узла (docs/спека).
  onApplied: () => void;
}

const KIND_LABEL: Record<NodeDocKind, string> = {
  overview: "Обзор",
  operation: "Операция",
  worker: "Воркер",
};
const KIND_ORDER: NodeDocKind[] = ["overview", "operation", "worker"];

export default function DocsAgentModal({ nodeId, nodeName, initialMode = "batch", onClose, onApplied }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  // ── параметры промпта (include зафиксирован на схемах логики) ──
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  const [target, setTarget] = useState(""); // «По одной»: воркер/эндпоинт
  const [promptCopied, setPromptCopied] = useState(false);
  // ── файлы пакета и превью (общие для обоих режимов) ──
  const pkg = useDocsFiles();
  const [overwrite, setOverwrite] = useState(false);
  // Отчёт последнего превью/применения. Пустые файлы прячут его ПРОИЗВОДНО
  // (pkg.hasContent ниже) — эффекты не зеркалят состояние синхронными setState.
  const [rawReport, setRawReport] = useState<DocsImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  // Результаты mermaid-валидации привязаны к породившему их отчёту (сравнение
  // по ссылке — паттерн importSummary.forDocs): чужому отчёту не показываются.
  const [mmdRes, setMmdRes] = useState<{ forReport: DocsImportReport; errs: (string | null)[] } | null>(null);
  const [applying, setApplying] = useState(false);
  const [remarksCopied, setRemarksCopied] = useState(false);
  // Правки строк превью: ключ — ФАЙЛ-источник (одна схема = один файл .mmd).
  // Уезжают на бэк отдельным полем overrides: манифеста, текст которого раньше
  // переписывался ради правки вида, больше нет (docs/plan-docs-mmd.md).
  const [overrides, setOverrides] = useState<DocsOverride[]>([]);
  const fileRef = useRef<HTMLInputElement>(null); // скрытый input «Загрузить файлы…»
  const seqRef = useRef(0);
  // Перетаскивание в ту же зону, что и кнопка загрузки. Расширения не сужаем:
  // в пакете archmap-docs лежит манифест и файлы схем, состав задаёт агент.
  const drop = useFileDrop({ onFiles: pkg.pickFiles, disabled: pkg.files.length >= MAX_FILES });

  const report = pkg.hasContent ? rawReport : null;
  const mmdErrs = report !== null && mmdRes?.forReport === report ? mmdRes.errs : null;

  // Дебаунс-превью по файлам и тумблеру; план фильтруется по схемам логики
  // (only="logic"). Все setState — в таймере/ответе (асинхронно); seq отбрасывает
  // устаревшие ответы при быстрой правке.
  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return; // отчёт скрыт производно (hasContent)
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      docsImportApi.preview({ files: nonEmpty, overwrite, only: "logic", nodeId, overrides })
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
    // overrides в зависимостях намеренно: правка имени/вида в превью меняет
    // ПЛАН (создание вместо перезаписи), и пользователь должен видеть это сразу.
  }, [pkg.files, overwrite, nodeId, overrides]);

  // Mermaid-валидация текстов схем из превью (советующая, ленивый чанк mermaid).
  useEffect(() => {
    if (report === null || report.logic.length === 0) return;
    let alive = true;
    void Promise.all(report.logic.map((l) => validateMermaid(l.mermaid))).then((errs) => {
      if (alive) setMmdRes({ forReport: report, errs });
    });
    return () => { alive = false; };
  }, [report]);

  function copyPrompt() {
    // include зафиксирован на схемах логики (OpenAPI-спека — окно SpecAgentModal);
    // в режиме «по одной» target фокусирует агента на одном воркере/эндпоинте
    // (пустой target в «пакетом» клиент не передаёт).
    const params: DocsPromptParams = { nodeId, include: "logic", lang, hints, target };
    void docsImportApi.prompt(params).then(({ prompt }) =>
      navigator.clipboard.writeText(prompt).then(() => {
        setPromptCopied(true);
        setTimeout(() => setPromptCopied(false), 2000);
      }),
    );
  }

  // ── правка строки превью (имя и вид схемы) ──
  function kindOf(file: string, reportKind: NodeDocKind): NodeDocKind {
    return overrides.find((o) => o.file === file)?.kind ?? reportKind;
  }
  function nameOf(file: string, reportName: string): string {
    return overrides.find((o) => o.file === file)?.name ?? reportName;
  }
  function edit(file: string, patch: Partial<DocsOverride>) {
    setOverrides((prev) => {
      const cur = prev.find((o) => o.file === file) ?? { file };
      const next = { ...cur, ...patch };
      const rest = prev.filter((o) => o.file !== file);
      // Пустая правка (вернули как было) — не храним
      return next.name === undefined && next.kind === undefined ? rest : [...rest, next];
    });
  }

  // Замечания для агента: ошибки/конфликты/предупреждения + mermaid-ошибки фронта.
  const mmdRemarks =
    report === null || mmdErrs === null
      ? []
      : report.logic
          .map((l, i) => ({ l, err: mmdErrs[i] }))
          .filter((x): x is { l: (typeof report.logic)[number]; err: string } => x.err !== null)
          .map(({ l, err }) => `схема "${l.name}" узла «${l.node_path}»: ошибка mermaid — ${err.split("\n")[0]}`);
  const remarks = report === null ? [] : [...report.errors, ...report.conflicts, ...report.warnings, ...mmdRemarks];

  function copyRemarks() {
    const text =
      "Валидатор дозаливки доков ArchMap нашёл замечания к пакету archmap-docs. " +
      "Исправь пакет и сообщи, какие файлы изменились:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setRemarksCopied(true);
      setTimeout(() => setRemarksCopied(false), 2000);
    });
  }

  // «Добавить ещё» (режим «по одной»): применить, затем очистить поля для
  // следующего воркера/эндпоинта (модалка остаётся открытой в режиме single).
  function resetSingleForNext() {
    setTarget("");
    pkg.reset();
    setRawReport(null);
    setMmdRes(null);
    setOverrides([]);
  }

  function apply(closeAfter: boolean) {
    setApplying(true);
    // Окно логики: применяются только схемы логики (only="logic")
    docsImportApi.apply({ files: pkg.nonEmpty, overwrite, only: "logic", nodeId, overrides })
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        onApplied();
        if (closeAfter) onClose();
        else resetSingleForNext();
      })
      .finally(() => setApplying(false));
  }

  // Правка в превью делает схему «перезаписью» даже при unchanged в отчёте
  // (бэк сверяет имя и вид) — учитываем её в доступности кнопок применения.
  const kindEdited = overrides.length > 0 && report !== null && report.logic.length > 0;
  const willWrite =
    report !== null &&
    report.errors.length === 0 &&
    (kindEdited || countAction(report.logic, "create") + countAction(report.logic, "overwrite") > 0);

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Описать логику с помощью агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        ИИ-агент поможет дополнить документацию объекта «{nodeName}» логическими диаграммами
        в Mermaid. Скопируйте промпт, запустите своим агентом в репозитории сервиса и загрузите
        сюда полученные файлы пакета archmap-docs/.
      </p>

      {/* Переключатель режимов */}
      <div style={segWrap}>
        <div style={seg} role="tablist" aria-label="Режим дозаливки">
          <button type="button" role="tab" aria-selected={mode === "batch"} style={mode === "batch" ? segBtnOn : segBtn} onClick={() => setMode("batch")}>
            Пакетом
          </button>
          <button type="button" role="tab" aria-selected={mode === "single"} style={mode === "single" ? segBtnOn : segBtn} onClick={() => setMode("single")}>
            По одной схеме
          </button>
        </div>
        <span style={segNote}>
          {mode === "batch"
            ? "Агент отдаст пакет со всеми схемами объекта за один заход. Используйте этот режим в репозиториях микросервисов"
            : "Агент отдаст схему одного воркера или эндпоинта за один заход. Используйте этот режим в репозиториях крупных монолитов"}
        </span>
      </div>

      <div style={cols}>
        {/* ── Слева: параметры промпта ── */}
        <div style={leftCol}>
          {mode === "single" && (
            <>
              <label style={labelStyle}>Что описать</label>
              <textarea
                style={targetInput}
                rows={3}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="воркер или эндпоинт: OrderCreatedHandler, POST /orders"
              />
            </>
          )}

          <label style={labelStyle}>Язык подписей</label>
          <div style={{ display: "flex", gap: 14, marginBottom: 10 }}>
            <label style={radioRow}>
              <input type="radio" checked={lang === "ru"} onChange={() => setLang("ru")} /> Русский
            </label>
            <label style={radioRow}>
              <input type="radio" checked={lang === "en"} onChange={() => setLang("en")} /> English
            </label>
          </div>

          <label style={labelStyle}>Подсказки агенту (опционально)</label>
          <textarea
            style={hintsArea}
            value={hints}
            onChange={(e) => setHints(e.target.value)}
            placeholder={"Например: документируй только сервис billing;\nкаждый воркер опиши отдельной схемой."}
          />

          <button type="button" style={{ ...primaryBtn, marginTop: 4 }} onClick={copyPrompt}>
            {promptCopied ? "Скопировано ✓" : "Скопировать промпт"}
          </button>
        </div>

        {/* ── Справа: файлы пакета + превью + применение ── */}
        <div style={rightCol}>
          <div style={chipsRow}>
            {pkg.files.map((f, i) => (
              <span key={f.name} style={i === pkg.active ? chipOn : chip}>
                <button type="button" style={chipBtn} title={f.name} onClick={() => pkg.setActive(i)}>
                  {f.name}
                </button>
                <button type="button" style={chipX} title="Убрать файл" onClick={() => pkg.removeFile(i)}>×</button>
              </span>
            ))}
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { pkg.pickFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              type="button"
              className="btn-soft"
              disabled={pkg.files.length >= MAX_FILES}
              onClick={() => fileRef.current?.click()}
            >
              Загрузить файлы…
            </button>
            <button
              type="button"
              className="btn-soft"
              disabled={pkg.files.length >= MAX_FILES}
              title="Добавить схему вставкой текста"
              onClick={pkg.addPaste}
            >
              + вставить из буфера
            </button>
          </div>

          <div className={drop.over ? "drop-zone--over" : undefined} {...drop.bind}>
            {pkg.files.length > 0 ? (
              <textarea
                style={fileArea}
                value={pkg.files[pkg.active]?.content ?? ""}
                onChange={(e) => pkg.setText(pkg.active, e.target.value)}
                placeholder="вставьте содержимое файла"
                spellCheck={false}
              />
            ) : (
              <button type="button" style={dropHint} onClick={() => fileRef.current?.click()}>
                Перетащите сюда файлы схем, которые создал агент, — или нажмите, чтобы выбрать
                их на диске. Схему можно и вставить текстом.
              </button>
            )}
          </div>
          {drop.error && (
            <p style={{ ...grayLine, color: "#b45309", marginTop: 6 }}>{drop.error}</p>
          )}

          {/* Отчёт превью / применения */}
          <div style={{ marginTop: 10, minHeight: 20 }}>
            {checking && <div style={grayLine}>Проверяю пакет…</div>}
            {!checking && report !== null && report.applied && (
              <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
                Применено: схем создано {report.created_docs}, перезаписано {report.updated_docs}.
              </div>
            )}
            {!checking && report !== null && !report.applied && report.errors.length === 0 && (
              <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
                Схем: {report.logic.length} (новых {countAction(report.logic, "create")},
                перезапись {countAction(report.logic, "overwrite")}, пропуск {countAction(report.logic, "skip")},
                без изменений {countAction(report.logic, "unchanged")})
              </div>
            )}
            {!checking && report !== null && report.errors.length > 0 && (
              <div style={{ fontSize: 12.5, color: "#dc2626" }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>Пакет не применить:</div>
                {report.errors.slice(0, 6).map((e, i) => <div key={i} style={{ marginTop: 2 }}>{e}</div>)}
                {report.errors.length > 6 && <div>…ещё {report.errors.length - 6}</div>}
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
                    // умолчанию) — и то и другое правится до применения.
                    extra: (
                      <>
                        <input
                          style={nameInput}
                          value={nameOf(l.source, l.name)}
                          onChange={(e) => edit(l.source, { name: e.target.value || undefined })}
                          title="Имя схемы — под ним она будет видна в ArchMap"
                          aria-label={`Имя схемы из файла ${l.source}`}
                        />
                        <select
                          style={kindSelect}
                          value={kindOf(l.source, l.kind)}
                          onChange={(e) => edit(l.source, { kind: e.target.value as NodeDocKind })}
                          title="Вид схемы — можно поменять до применения"
                          aria-label={`Вид схемы из файла ${l.source}`}
                        >
                          {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                        </select>
                      </>
                    ),
                  };
                })}
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
          </div>

          <div style={footRow}>
            <label
              style={{ ...radioRow, marginRight: "auto" }}
              title="Если имя схемы от агента совпадёт с именем схемы, задокументированной в ArchMap, сервис по умолчанию пропустит её. Поставьте галочку, чтобы новые схемы автоматически перезаписывали старые"
            >
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              Обновлять готовые диаграммы
            </label>
            {mode === "batch" ? (
              <button
                type="button"
                style={{ ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
                disabled={!willWrite || applying}
                onClick={() => apply(true)}
              >
                {applying ? "Применяю…" : "Применить"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  style={{ ...secondaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
                  disabled={!willWrite || applying}
                  title="Применить и подготовить поля к следующему воркеру/эндпоинту"
                  onClick={() => apply(false)}
                >
                  Добавить ещё
                </button>
                <button
                  type="button"
                  style={{ ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
                  disabled={!willWrite || applying}
                  onClick={() => apply(true)}
                >
                  {applying ? "Применяю…" : "Добавить"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── inline-стили только для режимов/правки вида (остальные — agentModalShared) ──

const segWrap: CSSProperties = { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "0 0 14px" };
const seg: CSSProperties = {
  display: "inline-flex", gap: 3, padding: 3, background: "#f1f5f9",
  border: "1px solid #e2e8f0", borderRadius: 10,
};
const segBtnBase: CSSProperties = {
  border: "none", borderRadius: 8, padding: "6px 14px", font: "inherit",
  fontSize: 13, cursor: "pointer", transition: "background .12s, color .12s",
};
const segBtn: CSSProperties = { ...segBtnBase, background: "transparent", color: "#64748b", fontWeight: 500 };
const segBtnOn: CSSProperties = {
  ...segBtnBase, background: "#fff", color: "#1e293b", fontWeight: 600,
  boxShadow: "0 1px 3px rgba(15,23,42,.14)",
};
const segNote: CSSProperties = { fontSize: 12, color: "#94a3b8", lineHeight: 1.4 };
const targetInput: CSSProperties = {
  width: "100%", boxSizing: "border-box", marginBottom: 10, padding: "8px 10px",
  border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, color: "#0f172a",
  fontFamily: "inherit", resize: "vertical", lineHeight: 1.45,
};
const nameInput: CSSProperties = {
  flex: "none", width: 190, font: "inherit", fontSize: 11.5, color: "#0f172a",
  border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", padding: "1px 5px",
};
const kindSelect: CSSProperties = {
  flex: "none", font: "inherit", fontSize: 11.5, color: "#334155", cursor: "pointer",
  border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", padding: "1px 4px",
};
