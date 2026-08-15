// Компоненты отчёта превью/применения BYOA-модалок (DocsAgentModal /
// SpecAgentModal) и панели импорта: строки плана (ItemList), списки замечаний
// (NoteList), заметка гварда «вход не изменился» (UnchangedInputNote) и вопрос об
// устаревших файлах после копирования замечаний (StaleFilesConfirm).
// Файл экспортирует ТОЛЬКО компоненты (требование react-refresh); бейдж-стиль,
// текст заметки и сам гвард — в agentModalShared.ts.
import type { CSSProperties, ReactNode } from "react";
import { badge, UNCHANGED_INPUT_NOTE } from "./agentModalShared";

// Строки превью: текст + бейдж действия + советующий статус + опциональный
// доп. элемент справа (например, селект вида схемы в режиме «по одной»).
export function ItemList({ title, rows }: {
  title: string;
  rows: { key: string; text: string; badge: string; bad: string | null; ok: boolean; extra?: ReactNode }[];
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
          {r.extra}
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

// Заметка гварда: вход тот же, что в прошлый заход. Стоит НАД сводкой, тем же
// amber, что «Исчезли:» и «Пометок данных было …» — это один класс сообщений
// «посмотрите на пакет, прежде чем применять».
export function UnchangedInputNote() {
  return <div style={amberLine}>{UNCHANGED_INPUT_NOTE}</div>;
}

// Вопрос после успешного копирования замечаний: агент вернёт исправленную версию, и
// файлы, лежащие сейчас в панели, устареют — пользователь либо оставляет их, либо
// убирает сразу (находка приёмки: старый файл оставался, и его приходилось убирать
// догадкой). ⚠ ИНЛАЙН-плашка, а не вложенный <dialog>: cancel вложенного диалога
// всплывает и закрывает оба окна (ui/Modal.tsx, ловушка native-dialog-gotchas).
//
// text/clearLabel — для мульти-файлового импорта, где замечания копируются пофайлово
// и устаревает ОДИН файл, а не весь вход (Ф6). Дефолты — прежние тексты дозаливок.
export function StaleFilesConfirm({ onKeep, onClear, text, clearLabel }: {
  onKeep: () => void;
  onClear: () => void;
  text?: string;
  clearLabel?: string;
}) {
  return (
    <div style={confirmBox}>
      <span style={{ color: "#475569" }}>
        {text ?? "Агент вернёт исправленную версию — текущие файлы в панели устареют. Оставить их?"}
      </span>
      <button type="button" className="btn-soft" style={confirmBtn} onClick={onKeep}>
        Оставить
      </button>
      <button type="button" className="btn-soft" style={confirmBtn} onClick={onClear}>
        {clearLabel ?? "Убрать из панели"}
      </button>
    </div>
  );
}

// Список замечаний (конфликты файлов / предупреждения превью)
export function NoteList({ title, items }: { title: string; items: string[] }) {
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

// ── inline-стили заметки и вопроса ────────────────────────────────────
// Тот же amber, что у «Исчезли:» в панели импорта и у заголовков отчёта.
const amberLine: CSSProperties = {
  fontSize: 12.5, fontWeight: 600, color: "#b45309", marginBottom: 6,
};
const confirmBox: CSSProperties = {
  display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8,
  padding: "8px 10px", fontSize: 12.5, lineHeight: 1.45,
  border: "1px solid #fde68a", borderRadius: 8, background: "#fffbeb",
};
const confirmBtn: CSSProperties = { padding: "3px 9px", fontSize: 12.5 };
