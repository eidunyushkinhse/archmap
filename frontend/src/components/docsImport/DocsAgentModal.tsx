// Модалка «Доки от агента» (BYOA-дозаливка, этап 2 plan-agent-docs.md): слева
// параметры промпта (область/состав/язык/подсказки → «Скопировать промпт»),
// справа файлы пакета archmap-docs (чипы с ИМЕНАМИ — по ним манифест ссылается
// на спеки), живой dry-run с политикой перезаписи и «Применить». Mermaid-тексты
// схем валидируются здесь фронтом (бэкового валидатора нет) — советующе, ✗ не
// блокирует применение. Применение НЕ кладётся в undo (см. примечание к
// версионированию в tasks.md) — страховка: превью + дефолт «не перезаписывать».
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { DocsImportReport } from "../../types";
import { docsImportApi, type DocsFile } from "../../api/docsImport";
import { validateMermaid } from "../mermaidLoader";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

const MAX_FILES = 16; // клиентский предохранитель (бэк режет на 32)

interface Props {
  // Текущий уровень для области «текущий контейнер»; null — открыт корень.
  currentParentId: string | null;
  currentParentName: string | null;
  onClose: () => void;
  // Дозаливка применена — родитель перечитывает уровень (мета docs узлов).
  onApplied: () => void;
}

const ACTION_LABEL: Record<string, string> = {
  create: "новая",
  overwrite: "перезапись",
  skip: "пропуск (занято)",
  unchanged: "без изменений",
};

export default function DocsAgentModal({ currentParentId, currentParentName, onClose, onApplied }: Props) {
  // ── параметры промпта ──
  const [scope, setScope] = useState<"project" | "container">(currentParentId ? "container" : "project");
  const [incLogic, setIncLogic] = useState(true);
  const [incApi, setIncApi] = useState(true);
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  // ── файлы пакета и превью ──
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
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  const active = Math.min(activeRaw, files.length - 1);
  const include = incLogic && incApi ? "both" : incLogic ? "logic" : "api";
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
      docsImportApi.preview(nonEmpty, overwrite)
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
    const nodeId = scope === "container" ? currentParentId : null;
    void docsImportApi.prompt({ nodeId, include, lang, hints }).then(({ prompt }) =>
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

  function apply() {
    const nonEmpty = files.filter((f) => f.content.trim() !== "");
    setApplying(true);
    docsImportApi.apply(nonEmpty, overwrite)
      .then((r) => {
        setRawReport(r);
        if (r.applied) onApplied();
      })
      .finally(() => setApplying(false));
  }

  const count = (arr: { action: string }[], action: string) => arr.filter((a) => a.action === action).length;
  const willWrite =
    report !== null &&
    report.errors.length === 0 &&
    (count(report.logic, "create") + count(report.logic, "overwrite") +
      count(report.specs, "create") + count(report.specs, "overwrite")) > 0;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Доки от агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        Схема уже есть — ИИ-агент дополняет её документами: схемами логики (mermaid) и OpenAPI-спеками.
        Скопируйте промпт, запустите своим агентом в репозитории сервиса, затем загрузите сюда файлы
        пакета archmap-docs/ из репозитория.
      </p>

      <div style={cols}>
        {/* ── Слева: параметры промпта ── */}
        <div style={leftCol}>
          <label style={labelStyle}>Область схемы в промпте</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
            <label style={radioRow}>
              <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} />
              Весь проект
            </label>
            <label style={{ ...radioRow, opacity: currentParentId ? 1 : 0.45 }}>
              <input
                type="radio"
                disabled={!currentParentId}
                checked={scope === "container"}
                onChange={() => setScope("container")}
              />
              Текущий контейнер{currentParentName ? ` — «${currentParentName}»` : ""}
            </label>
          </div>

          <label style={labelStyle}>Что готовит агент</label>
          <div style={{ display: "flex", gap: 14, marginBottom: 10 }}>
            <label style={radioRow}>
              <input
                type="checkbox"
                checked={incLogic}
                onChange={(e) => { if (!e.target.checked && !incApi) return; setIncLogic(e.target.checked); }}
              />
              Схемы логики
            </label>
            <label style={radioRow}>
              <input
                type="checkbox"
                checked={incApi}
                onChange={(e) => { if (!e.target.checked && !incLogic) return; setIncApi(e.target.checked); }}
              />
              API-спеки
            </label>
          </div>

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
            placeholder={"Например: документируй только сервис billing;\nспеку не синтезируй."}
          />

          <button type="button" style={{ ...primaryBtn, marginTop: 4 }} onClick={copyPrompt}>
            {promptCopied ? "Скопировано ✓" : "Скопировать промпт"}
          </button>
          <p style={leftNote}>
            Один и тот же промпт запускается в каждом репозитории системы — манифесты
            из всех репозиториев загружаются сюда вместе.
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
              Загрузить файлы…
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
              Загрузите все файлы папки archmap-docs/ из репозитория
              (manifest.yaml + файлы спек) — или вставьте манифест текстом.
            </div>
          )}

          {/* Отчёт превью / применения */}
          <div style={{ marginTop: 10, minHeight: 20 }}>
            {checking && <div style={grayLine}>Проверяю пакет…</div>}
            {!checking && report !== null && report.applied && (
              <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
                Применено: схем создано {report.created_docs}, перезаписано {report.updated_docs},
                спек записано {report.specs_written}.
              </div>
            )}
            {!checking && report !== null && !report.applied && report.errors.length === 0 && (
              <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
                Схем: {report.logic.length} (новых {count(report.logic, "create")},
                перезапись {count(report.logic, "overwrite")}, пропуск {count(report.logic, "skip")},
                без изменений {count(report.logic, "unchanged")}) ·
                Спек: {report.specs.length} (новых {count(report.specs, "create")},
                перезапись {count(report.specs, "overwrite")}, пропуск {count(report.specs, "skip")})
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
                rows={report.logic.map((l, i) => ({
                  key: `${l.node_path}#${l.name}`,
                  text: `«${l.node_path}» · ${l.name}${l.operation ? ` (${l.operation})` : ""}`,
                  badge: ACTION_LABEL[l.action] ?? l.action,
                  bad: mmdErrs?.[i] != null ? `mermaid: ${mmdErrs[i]!.split("\n")[0]}` : null,
                  ok: mmdErrs?.[i] === null,
                }))}
              />
            )}
            {!checking && report !== null && report.specs.length > 0 && (
              <ItemList
                title="OpenAPI-спеки:"
                rows={report.specs.map((s) => ({
                  key: `${s.node_path}#spec`,
                  text: `«${s.node_path}» · ${s.source}${s.oas_version ? ` · OAS ${s.oas_version}` : ""}`,
                  badge: `${ACTION_LABEL[s.action] ?? s.action}${s.origin ? ` · ${s.origin}` : ""}`,
                  bad: s.origin === "synthesized"
                    ? "синтезирована из кода — проверьте глазами"
                    : !s.looks_openapi ? "не похожа на OpenAPI" : null,
                  ok: s.looks_openapi && s.origin !== "synthesized",
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
          </div>

          <div style={footRow}>
            <label style={{ ...radioRow, marginRight: "auto" }} title="Занятые слоты (схема с тем же именем / непустая спека узла) по умолчанию пропускаются">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              Перезаписывать занятые
            </label>
            <button
              type="button"
              style={{ ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
              disabled={!willWrite || applying}
              onClick={apply}
            >
              {applying ? "Применяю…" : "Применить"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Строки превью: текст + бейдж действия + советующий статус (mermaid/origin).
function ItemList({ title, rows }: {
  title: string;
  rows: { key: string; text: string; badge: string; bad: string | null; ok: boolean }[];
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
const sub: CSSProperties = { margin: "0 0 14px", fontSize: 12.5, color: "#64748b", lineHeight: 1.5 };
const cols: CSSProperties = { display: "flex", gap: 18, alignItems: "stretch" };
const leftCol: CSSProperties = { width: 300, flex: "none", display: "flex", flexDirection: "column" };
const rightCol: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" };
const radioRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#334155",
  cursor: "pointer", userSelect: "none",
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
const footRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 12,
  borderTop: "1px solid #eef0f2",
};
