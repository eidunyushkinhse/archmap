// Компоненты отчёта превью/применения окон дозаливки от агента и «Обновить из кода»: списки
// замечаний (NoteList), заметка гварда «вход не изменился» (UnchangedInputNote) и вопрос об
// устаревших файлах после копирования замечаний (StaleFilesConfirm). Вид — новый язык
// (классы agentParts.css); прежний вид на инлайн-стилях снят вместе с последним окном
// прежнего вида (стадия агента окна документа, редизайн, фаза 7в).
// Файл экспортирует ТОЛЬКО компоненты (требование react-refresh); текст заметки и сам
// гвард — в agentModalShared.ts.
import { UNCHANGED_INPUT_NOTE } from "./agentModalShared";
import "../../ui/ds.css";
import "./agentParts.css";

// Заметка гварда: вход тот же, что в прошлый заход. Стоит НАД сводкой строкой цветом
// предупреждения, как «Пометок данных было …»: это один класс сообщений «посмотрите на
// пакет, прежде чем применять».
export function UnchangedInputNote() {
  return <p className="ds-warn anl-line">{UNCHANGED_INPUT_NOTE}</p>;
}

// Вопрос после успешного копирования замечаний: агент вернёт исправленную версию, и
// файлы, лежащие сейчас в окне, устареют. Пользователь либо оставляет их, либо убирает
// сразу (находка приёмки: старый файл оставался, и его приходилось убирать догадкой).
// Вопрос строкой и две текстовые кнопки. ⚠ Слой в окне, а не вложенный <dialog>: cancel
// вложенного диалога всплывает и закрывает оба окна (ui/Modal.tsx, ловушка
// native-dialog-gotchas).
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

// Список замечаний (конфликты файлов, предупреждения превью): заголовок цветом
// предупреждения, пункты тихим цветом. danger — заголовок цветом ошибки («Файлы не
// применить:»).
export function NoteList({ title, items, danger = false }: {
  title: string;
  items: string[];
  danger?: boolean;
}) {
  return (
    <div className={"anl" + (danger ? " is-danger" : "")}>
      <p className="anl-title">{title}</p>
      {items.slice(0, 6).map((s, i) => <p key={i} className="anl-item">{s}</p>)}
      {items.length > 6 && <p className="anl-item">и ещё {items.length - 6}</p>}
    </div>
  );
}
