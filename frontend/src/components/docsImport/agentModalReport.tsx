// Компоненты отчёта превью/применения окон дозаливки от агента и панели импорта: списки
// замечаний (NoteList), заметка гварда «вход не изменился» (UnchangedInputNote) и вопрос об
// устаревших файлах после копирования замечаний (StaleFilesConfirm).
// Файл экспортирует ТОЛЬКО компоненты (требование react-refresh); текст заметки и сам
// гвард — в agentModalShared.ts.
import type { CSSProperties } from "react";
import { UNCHANGED_INPUT_NOTE } from "./agentModalShared";
import "../../ui/ds.css";
import "./agentParts.css";

// Заметка гварда: вход тот же, что в прошлый заход. Стоит НАД сводкой, тем же
// amber, что «Исчезли:» и «Пометок данных было …» — это один класс сообщений
// «посмотрите на пакет, прежде чем применять». ds — вид нового языка (окно «Описать
// схемы логики…», редизайн, фаза 6в): строка цветом предупреждения.
export function UnchangedInputNote({ ds = false }: { ds?: boolean }) {
  if (ds) return <p className="ds-warn anl-line">{UNCHANGED_INPUT_NOTE}</p>;
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
// ds — вид нового языка: вопрос строкой и две текстовые кнопки, без плашки.
export function StaleFilesConfirm({ onKeep, onClear, text, clearLabel, ds = false }: {
  onKeep: () => void;
  onClear: () => void;
  text?: string;
  clearLabel?: string;
  ds?: boolean;
}) {
  if (ds) {
    return (
      <div className="asf">
        <p className="asf-text">
          {text ?? "Агент пришлёт исправленные файлы, и те, что сейчас в окне, станут не нужны. Оставить их?"}
        </p>
        <div className="asf-acts">
          <button type="button" className="ds-add" onClick={onKeep}>Оставить</button>
          <button type="button" className="ds-add" onClick={onClear}>{clearLabel ?? "Убрать из окна"}</button>
        </div>
      </div>
    );
  }
  return (
    <div style={confirmBox}>
      <span style={{ color: "#475569" }}>
        {text ?? "Агент пришлёт исправленные файлы, и те, что сейчас в окне, станут не нужны. Оставить их?"}
      </span>
      <button type="button" className="btn-soft" style={confirmBtn} onClick={onKeep}>
        Оставить
      </button>
      <button type="button" className="btn-soft" style={confirmBtn} onClick={onClear}>
        {clearLabel ?? "Убрать из окна"}
      </button>
    </div>
  );
}

// Список замечаний (конфликты файлов / предупреждения превью). ds — вид нового языка
// для окон «Обновить из кода» и «Описать схемы логики…» (редизайн, фазы 6а и 6в; классы
// agentParts.css): окна прежнего вида его не передают и рисуют список как раньше.
// danger — заголовок цветом ошибки («Файлы не применить:»), только у вида нового языка.
export function NoteList({ title, items, ds = false, danger = false }: {
  title: string;
  items: string[];
  ds?: boolean;
  danger?: boolean;
}) {
  if (ds) {
    return (
      <div className={"anl" + (danger ? " is-danger" : "")}>
        <p className="anl-title">{title}</p>
        {items.slice(0, 6).map((s, i) => <p key={i} className="anl-item">{s}</p>)}
        {items.length > 6 && <p className="anl-item">и ещё {items.length - 6}</p>}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: "#b45309" }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {items.slice(0, 6).map((s, i) => (
        <div key={i} style={{ marginTop: 2, color: "#475569" }}>{s}</div>
      ))}
      {items.length > 6 && <div style={{ marginTop: 2, color: "#475569" }}>и ещё {items.length - 6}</div>}
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
