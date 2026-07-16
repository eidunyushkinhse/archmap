import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ImportPreviewOut } from "../../types";
import { secondaryBtn } from "../../ui/styles";

/**
 * Правая панель импорта YAML в модалке создания проекта: несколько документов
 * (чипы «Файл N» — мульти-репо сценарий «Из репозитория»), textarea активного
 * документа, сводка dry-run с отчётом слияния и кнопка «Скопировать замечания»
 * (уносится ИИ-агенту на починку). Данные (docs) и сводка живут у родителя —
 * здесь представление и локальный выбор активного документа.
 */

// Зеркало MAX_IMPORT_FILES бэка (schemas/project.py) — клиентский предохранитель.
export const MAX_IMPORT_FILES = 16;

interface Props {
  docs: string[];
  onDocs: (next: string[]) => void;
  // Актуальная сводка по ТЕКУЩИМ docs (устаревшие родитель уже отбросил); null — нет/грузится.
  summary: ImportPreviewOut | null;
}

export default function ImportPane({ docs, onDocs, summary }: Props) {
  // Индекс активного документа — чисто вьюшное состояние; при удалении чипов
  // может выйти за границы, поэтому в рендере всегда клампится.
  const [activeRaw, setActiveRaw] = useState(0);
  const active = Math.min(activeRaw, docs.length - 1);
  const fileRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  function setDoc(i: number, text: string) {
    onDocs(docs.map((d, k) => (k === i ? text : d)));
  }

  function addDocs(texts: string[]) {
    if (!texts.length) return;
    // Единственный пустой стартовый документ замещается загруженными файлами.
    const base = docs.length === 1 && !docs[0].trim() ? [] : docs;
    const next = [...base, ...texts].slice(0, MAX_IMPORT_FILES);
    onDocs(next);
    setActiveRaw(next.length - 1);
  }

  function removeDoc(i: number) {
    const next = docs.filter((_, k) => k !== i);
    onDocs(next.length ? next : [""]);
    setActiveRaw(Math.max(0, active - (i <= active ? 1 : 0)));
  }

  function pickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    void Promise.all(Array.from(list).map((f) => f.text())).then(addDocs);
  }

  // Замечания для агента: при ошибках — они; при зелёной сводке — конфликты и
  // предупреждения слияния (промпт учит агента чинить по такому списку).
  const remarks = summary === null
    ? []
    : summary.ok
      ? [...summary.conflicts, ...summary.warnings]
      : summary.errors;

  function copyRemarks() {
    const text =
      "Валидатор импорта ArchMap нашёл замечания к YAML. Исправь их и выведи весь " +
      "YAML-документ целиком заново:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <>
      <div style={chipsRow}>
        {docs.map((_, i) => (
          <span key={i} className={`cp-chip${i === active ? " cp-chip--on" : ""}`}>
            <button type="button" style={chipBtn} onClick={() => setActiveRaw(i)}>
              Файл {i + 1}
            </button>
            {docs.length > 1 && (
              <button
                type="button"
                style={chipX}
                title="Убрать файл"
                onClick={() => removeDoc(i)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {/* «+» — пустой документ под вставку текста (второй YAML не обязан быть файлом) */}
        {docs.length < MAX_IMPORT_FILES && docs[docs.length - 1].trim() !== "" && (
          <button
            type="button"
            className="cp-chip"
            style={{ ...chipBtn, padding: "3px 10px" }}
            title="Добавить ещё один YAML вставкой"
            onClick={() => { onDocs([...docs, ""]); setActiveRaw(docs.length); }}
          >
            +
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".yaml,.yml"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }}
        />
        <button
          type="button"
          style={{ ...secondaryBtn, padding: "4px 10px", fontSize: 12.5 }}
          disabled={docs.length >= MAX_IMPORT_FILES}
          onClick={() => fileRef.current?.click()}
        >
          Загрузить файлы…
        </button>
      </div>

      <textarea
        style={importArea}
        value={docs[active]}
        onChange={(e) => setDoc(active, e.target.value)}
        placeholder={
          "Вставьте YAML — тот же формат, что выдаёт «Экспорт».\n" +
          "Файлов может быть несколько (по одному на репозиторий) — они сольются автоматически."
        }
        spellCheck={false}
      />

      <div style={{ marginTop: 10 }}>
        {summary?.ok && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
              Готово к импорту: {summary.node_count} объектов · {summary.edge_count} связей
              {summary.files > 1 && ` · из ${summary.files} файлов`}
            </div>
            {summary.roots.length > 0 && (
              <div style={grayLine}>Корневые: {summary.roots.join(", ")}</div>
            )}
            {summary.merged_count > 0 && (
              <div style={grayLine}>
                Склеено узлов: {summary.merged_count} ({summary.merged.join(", ")}
                {summary.merged_count > summary.merged.length ? ", …" : ""})
                {summary.dropped_edges > 0 && ` · дублей связей выброшено: ${summary.dropped_edges}`}
              </div>
            )}
            {summary.conflicts.length > 0 && (
              <ReportList title="Конфликты слияния (оставлено первое значение):" items={summary.conflicts} />
            )}
            {summary.warnings.length > 0 && (
              <ReportList title="Проверьте:" items={summary.warnings} />
            )}
          </>
        )}
        {summary && !summary.ok && (
          <div style={{ fontSize: 13, color: "#dc2626" }}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>Не получается разобрать YAML:</div>
            {summary.errors.slice(0, 5).map((e, i) => (
              <div key={i} style={{ marginTop: 2 }}>{e}</div>
            ))}
            {summary.errors.length > 5 && (
              <div style={{ marginTop: 2 }}>…ещё {summary.errors.length - 5}</div>
            )}
          </div>
        )}
        {remarks.length > 0 && (
          <button
            type="button"
            style={{ ...secondaryBtn, marginTop: 8, padding: "4px 10px", fontSize: 12.5 }}
            onClick={copyRemarks}
          >
            {copied ? "Скопировано ✓" : "Скопировать замечания для агента"}
          </button>
        )}
      </div>
    </>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 6, fontSize: 12.5, color: "#b45309" }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {items.slice(0, 6).map((s, i) => (
        <div key={i} style={{ marginTop: 2, color: "#475569" }}>{s}</div>
      ))}
      {items.length > 6 && <div style={{ marginTop: 2, color: "#475569" }}>…ещё {items.length - 6}</div>}
    </div>
  );
}

const chipsRow: CSSProperties = {
  display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8,
};
const chipBtn: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", font: "inherit",
  fontSize: 12.5, fontWeight: 600, color: "inherit", padding: "3px 2px 3px 10px",
};
const chipX: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", color: "#94a3b8",
  fontSize: 14, lineHeight: 1, padding: "3px 8px 3px 4px",
};
const grayLine: CSSProperties = { fontSize: 12.5, color: "#94a3b8", marginTop: 3 };
const importArea: CSSProperties = {
  width: "100%", height: 246, boxSizing: "border-box", resize: "none",
  padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12.5, lineHeight: 1.5, color: "#0f172a", background: "#fff",
};
