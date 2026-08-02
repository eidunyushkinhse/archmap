// Модалка «Доки от агента» (BYOA-дозаливка) — ТОЛЬКО СХЕМЫ ЛОГИКИ (node_docs,
// mermaid). OpenAPI-спека узла — отдельное окно SpecAgentModal: сущности не
// смешиваются (include промпта и фильтр превью/применения зафиксированы на
// «logic»). Скоуп — ТЕКУЩИЙ УЗЕЛ, два режима.
// «Пакетом» — агент отдаёт пакет со всеми схемами узла за один заход (небольшие
// сервисы): слева параметры промпта (язык/подсказки → «Скопировать промпт»),
// справа файлы пакета archmap-docs (чипы с ИМЕНАМИ — по ним манифест ссылается
// на файлы пакета), живой dry-run с политикой перезаписи и «Применить».
// «По одной схеме» — один воркер/эндпоинт за заход (крупные монолиты): слева
// поле «Что описать» (target — приоритетный блок фокуса в промпте), справа
// ОДИН манифест; вид схемы (kind) приходит из манифеста и правится селектом
// прямо в превью — правка вносится в YAML-текст манифеста перед применением.
// Mermaid-тексты схем валидируются здесь фронтом (бэкового валидатора нет) —
// советующе, ✗ не блокирует применение. Применение НЕ кладётся в undo (см.
// примечание к версионированию в tasks.md) — страховка: превью + дефолт
// «не перезаписывать». Закрытие после успешного применения — отсюда (onClose);
// родитель через onApplied только освежает мету узла.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DocsImportReport, NodeDocKind } from "../../types";
import { docsImportApi, type DocsFile, type DocsPromptParams } from "../../api/docsImport";
import { replaceLogicKind } from "./manifestKind";
import { validateMermaid } from "../mermaidLoader";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

const MAX_FILES = 16; // клиентский предохранитель (бэк режет на 32)

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

const ACTION_LABEL: Record<string, string> = {
  create: "новая",
  overwrite: "перезапись",
  skip: "пропуск (занято)",
  unchanged: "без изменений",
};

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
  const [files, setFiles] = useState<DocsFile[]>([]);
  const [activeRaw, setActiveRaw] = useState(0);
  const [overwrite, setOverwrite] = useState(false);
  // Отчёт последнего превью/применения. Пустые файлы прячут его ПРОИЗВОДНО
  // (hasContent ниже) — эффекты не зеркалят состояние синхронными setState.
  const [rawReport, setRawReport] = useState<DocsImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  // Результаты mermaid-валидации привязаны к породившему их отчёту (сравнение
  // по ссылке — паттерн importSummary.forDocs): чужому отчёту не показываются.
  const [mmdRes, setMmdRes] = useState<{ forReport: DocsImportReport; errs: (string | null)[] } | null>(null);
  const [applying, setApplying] = useState(false);
  const [remarksCopied, setRemarksCopied] = useState(false);
  // Правки вида схем из превью (режим «по одной»): key — `${node_path}#${name}`
  // строки отчёта; перед применением вносятся в YAML-текст манифеста.
  const [kindOverrides, setKindOverrides] = useState<{ key: string; name: string; kind: NodeDocKind }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  const active = Math.min(activeRaw, files.length - 1);
  const hasContent = files.some((f) => f.content.trim() !== "");
  const report = hasContent ? rawReport : null;
  const mmdErrs = report !== null && mmdRes?.forReport === report ? mmdRes.errs : null;

  // Дебаунс-превью по файлам и тумблеру. Все setState — в таймере/ответе
  // (асинхронно); seq отбрасывает устаревшие ответы при быстрой правке.
  useEffect(() => {
    const nonEmpty = files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return; // отчёт скрыт производно (hasContent)
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      // Окно логики: план фильтруется по схемам логики (only="logic")
      docsImportApi.preview(nonEmpty, overwrite, "logic")
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
  }, [files, overwrite]);

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

  function addFiles(added: DocsFile[]) {
    if (!added.length) return;
    setFiles((prev) => {
      // Повторная загрузка файла с тем же именем замещает старый (не плодим дубли)
      const merged = [...prev];
      for (const f of added) {
        const at = merged.findIndex((x) => x.name === f.name);
        if (at >= 0) merged[at] = f;
        else merged.push(f);
      }
      const next = merged.slice(0, MAX_FILES);
      setActiveRaw(next.length - 1);
      return next;
    });
  }

  function pickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    void Promise.all(
      Array.from(list).map(async (f) => ({ name: f.name, content: await f.text() })),
    ).then(addFiles);
  }

  function addPaste() {
    let i = 1;
    while (files.some((f) => f.name === `вставка-${i}`)) i++;
    addFiles([{ name: `вставка-${i}`, content: "" }]);
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, k) => k !== i));
    setActiveRaw(Math.max(0, active - (i <= active ? 1 : 0)));
  }

  function setText(i: number, content: string) {
    setFiles((prev) => prev.map((f, k) => (k === i ? { ...f, content } : f)));
  }

  // ── правка вида схемы в превью (режим «по одной») ──
  function kindOf(key: string, reportKind: NodeDocKind): NodeDocKind {
    return kindOverrides.find((o) => o.key === key)?.kind ?? reportKind;
  }
  function pickKind(key: string, name: string, reportKind: NodeDocKind, kind: NodeDocKind) {
    setKindOverrides((prev) => {
      const rest = prev.filter((o) => o.key !== key);
      // Выбор вида из манифеста — не правка (не плодим пустые override)
      return kind === reportKind ? rest : [...rest, { key, name, kind }];
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
    setFiles([]);
    setActiveRaw(0);
    setRawReport(null);
    setMmdRes(null);
    setKindOverrides([]);
  }

  function apply(closeAfter: boolean) {
    const nonEmpty = files.filter((f) => f.content.trim() !== "");
    // Правки вида из превью-селектов вносятся в текст манифеста; блок схемы не
    // найден (текст правили руками после превью) — файл уходит как есть.
    const finalFiles = mode === "single" && kindOverrides.length > 0
      ? nonEmpty.map((f) => {
          let content = f.content;
          for (const o of kindOverrides) content = replaceLogicKind(content, o.name, o.kind) ?? content;
          return content === f.content ? f : { ...f, content };
        })
      : nonEmpty;
    setApplying(true);
    // Окно логики: применяются только схемы логики (only="logic")
    docsImportApi.apply(finalFiles, overwrite, "logic")
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        onApplied();
        if (closeAfter) onClose();
        else resetSingleForNext();
      })
      .finally(() => setApplying(false));
  }

  const count = (arr: { action: string }[], action: string) => arr.filter((a) => a.action === action).length;
  // Правка вида в превью делает схему «перезаписью» даже при unchanged в отчёте
  // (бэк сверяет и kind) — учитываем override в доступности кнопок применения.
  const kindEdited = mode === "single" && kindOverrides.length > 0 && report !== null && report.logic.length > 0;
  const willWrite =
    report !== null &&
    report.errors.length === 0 &&
    (kindEdited || count(report.logic, "create") + count(report.logic, "overwrite") > 0);

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Доки от агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        Схема уже есть — ИИ-агент дополняет документацию объекта «{nodeName}» схемами логики (mermaid).
        Скопируйте промпт, запустите своим агентом в репозитории сервиса, затем загрузите сюда
        полученные файлы пакета archmap-docs/. OpenAPI-спека узла готовится в отдельном окне
        («+ Добавить» в разделе OpenAPI).
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
            ? "Агент отдаёт пакет со всеми схемами узла за один заход — для небольших сервисов."
            : "Один воркер или эндпоинт за заход — для крупных монолитов."}
        </span>
      </div>

      <div style={cols}>
        {/* ── Слева: параметры промпта ── */}
        <div style={leftCol}>
          {mode === "single" && (
            <>
              <label style={labelStyle}>Что описать</label>
              <input
                style={targetInput}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="воркер или эндпоинт: OrderCreatedHandler, POST /orders"
              />
            </>
          )}

          <label style={labelStyle}>Язык подписей</label>
          <div style={{ display: "flex", gap: 14, marginBottom: 10 }}>
            <label style={radioRow}>
              <input type="radio" checked={lang === "ru"} onChange={() => setLang("ru")} /> русский
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
          <p style={leftNote}>
            {mode === "batch"
              ? "Промпт запускается в репозитории сервиса этого узла; файлы пакета archmap-docs/ из репозитория загружаются сюда."
              : "Скопируйте промпт, запустите агент на этом воркере/эндпоинте, затем загрузите полученный манифест (или вставьте текстом)."}
          </p>
        </div>

        {/* ── Справа: файлы пакета + превью + применение ── */}
        <div style={rightCol}>
          <div style={chipsRow}>
            {files.map((f, i) => (
              <span key={f.name} style={i === active ? chipOn : chip}>
                <button type="button" style={chipBtn} title={f.name} onClick={() => setActiveRaw(i)}>
                  {f.name}
                </button>
                <button type="button" style={chipX} title="Убрать файл" onClick={() => removeFile(i)}>×</button>
              </span>
            ))}
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              type="button"
              style={{ ...secondaryBtn, padding: "4px 10px", fontSize: 12.5 }}
              disabled={files.length >= MAX_FILES}
              onClick={() => fileRef.current?.click()}
            >
              {mode === "single" ? "Загрузить манифест…" : "Загрузить файлы…"}
            </button>
            <button
              type="button"
              style={{ ...secondaryBtn, padding: "4px 10px", fontSize: 12.5 }}
              disabled={files.length >= MAX_FILES}
              title="Добавить манифест вставкой текста"
              onClick={addPaste}
            >
              + вставка
            </button>
          </div>

          {files.length > 0 ? (
            <textarea
              style={fileArea}
              value={files[active]?.content ?? ""}
              onChange={(e) => setText(active, e.target.value)}
              placeholder="Содержимое файла (manifest.yaml — можно вставить текстом)"
              spellCheck={false}
            />
          ) : (
            <div style={dropHint}>
              {mode === "single"
                ? "Загрузите манифест от агента (manifest.yaml с одной схемой) — или вставьте текстом."
                : "Загрузите все файлы папки archmap-docs/ из репозитория (manifest.yaml + файлы спек) — или вставьте манифест текстом."}
            </div>
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
                Схем: {report.logic.length} (новых {count(report.logic, "create")},
                перезапись {count(report.logic, "overwrite")}, пропуск {count(report.logic, "skip")},
                без изменений {count(report.logic, "unchanged")})
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
                    text: `«${l.node_path}» · ${l.name}${l.operation ? ` (${l.operation})` : ""}`,
                    badge: ACTION_LABEL[l.action] ?? l.action,
                    bad: err !== null ? `mermaid: ${err.split("\n")[0]}` : null,
                    ok: mmdErrs?.[i] === null,
                    // Режим «по одной»: вид из манифеста правится до применения
                    kindSel: mode === "single" ? (
                      <select
                        style={kindSelect}
                        value={kindOf(key, l.kind)}
                        onChange={(e) => pickKind(key, l.name, l.kind, e.target.value as NodeDocKind)}
                        title="Вид схемы из манифеста — можно поменять до применения"
                        aria-label={`Вид схемы ${l.name}`}
                      >
                        {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </select>
                    ) : undefined,
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
            <label style={{ ...radioRow, marginRight: "auto" }} title="Занятые слоты (схема с тем же именем) по умолчанию пропускаются">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              Перезаписывать занятые
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

// Строки превью: текст + бейдж действия + советующий статус (mermaid/origin)
// + опциональный селект вида схемы (режим «по одной»).
function ItemList({ title, rows }: {
  title: string;
  rows: { key: string; text: string; badge: string; bad: string | null; ok: boolean; kindSel?: ReactNode }[];
}) {
  const shown = rows.slice(0, 8);
  return (
    <div style={{ marginTop: 8, fontSize: 12.5 }}>
      <div style={{ fontWeight: 600, color: "#334155" }}>{title}</div>
      {shown.map((r) => (
        <div key={r.key} style={{ marginTop: 3, display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ color: "#475569", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.text}
          </span>
          <span style={badge}>{r.badge}</span>
          {r.kindSel}
          {r.bad !== null ? (
            <span style={{ color: "#b45309", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.bad}>
              ⚠ {r.bad}
            </span>
          ) : r.ok ? (
            <span style={{ color: "#15803d" }}>✓</span>
          ) : null}
        </div>
      ))}
      {rows.length > shown.length && (
        <div style={{ marginTop: 2, color: "#94a3b8" }}>…ещё {rows.length - shown.length}</div>
      )}
    </div>
  );
}

function NoteList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: "#b45309" }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {items.slice(0, 6).map((s, i) => (
        <div key={i} style={{ marginTop: 2, color: "#475569" }}>{s}</div>
      ))}
      {items.length > 6 && <div style={{ marginTop: 2, color: "#475569" }}>…ещё {items.length - 6}</div>}
    </div>
  );
}

const head: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 };
const sub: CSSProperties = { margin: "0 0 12px", fontSize: 12.5, color: "#64748b", lineHeight: 1.5 };
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
const cols: CSSProperties = { display: "flex", gap: 18, alignItems: "stretch" };
const leftCol: CSSProperties = { width: 300, flex: "none", display: "flex", flexDirection: "column" };
const rightCol: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" };
const radioRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#334155",
  cursor: "pointer", userSelect: "none",
};
const targetInput: CSSProperties = {
  width: "100%", boxSizing: "border-box", marginBottom: 10, padding: "8px 10px",
  border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, color: "#0f172a",
  fontFamily: "inherit",
};
const hintsArea: CSSProperties = {
  width: "100%", height: 74, boxSizing: "border-box", resize: "vertical", marginBottom: 8,
  padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13,
  color: "#0f172a", fontFamily: "inherit",
};
const leftNote: CSSProperties = { margin: "10px 0 0", fontSize: 11.5, color: "#94a3b8", lineHeight: 1.5 };
const chipsRow: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 };
const chip: CSSProperties = {
  display: "inline-flex", alignItems: "center", border: "1px solid #e2e8f0",
  borderRadius: 8, background: "#f8fafc", color: "#475569", maxWidth: 220,
};
const chipOn: CSSProperties = { ...chip, border: "1px solid #2563eb", background: "#eff6ff", color: "#1e3a8a" };
const chipBtn: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", font: "inherit", fontSize: 12.5,
  fontWeight: 600, color: "inherit", padding: "3px 2px 3px 10px", minWidth: 0,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const chipX: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", color: "#94a3b8",
  fontSize: 14, lineHeight: 1, padding: "3px 8px 3px 4px",
};
const fileArea: CSSProperties = {
  width: "100%", height: 200, boxSizing: "border-box", resize: "none",
  padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12.5, lineHeight: 1.5, color: "#0f172a", background: "#fff",
};
const dropHint: CSSProperties = {
  height: 200, boxSizing: "border-box", border: "1.5px dashed #cbd5e1", borderRadius: 10,
  display: "grid", placeItems: "center", padding: 20, textAlign: "center",
  fontSize: 12.5, color: "#94a3b8", lineHeight: 1.6,
};
const grayLine: CSSProperties = { fontSize: 12.5, color: "#94a3b8" };
const badge: CSSProperties = {
  flex: "none", fontSize: 10.5, fontWeight: 700, color: "#475569", background: "#f1f5f9",
  border: "1px solid #e2e8f0", borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap",
};
const kindSelect: CSSProperties = {
  flex: "none", font: "inherit", fontSize: 11.5, color: "#334155", cursor: "pointer",
  border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", padding: "1px 4px",
};
const footRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 12,
  borderTop: "1px solid #eef0f2",
};
