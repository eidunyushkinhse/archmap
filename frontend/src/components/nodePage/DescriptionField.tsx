// Описание объекта (редизайн, направление А «Документ»): на странице объекта — сразу под
// названием, в панели объекта редактора-карты — под заголовком. У читателя абзац (пустое
// описание не показывается вовсе), у редактора поле без рамки, растущее по тексту. Высоту
// поля задаёт невидимая копия текста в той же ячейке сетки (тот же приём, что у поля
// имени, np-name-fit): ручки растяжения и прокрутки у поля нет. Стили — в
// pages/NodePage.css (их же берёт описание проекта на главной); подключены и здесь: в
// редакторе-карте стили страницы объекта могут быть ещё не загружены.
import { noAutofill } from "../../ui/noAutofill";
import { revertOnEscape } from "./revertOnEscape";
import "../../pages/NodePage.css";

export default function DescriptionField({ value, editable, onChange, onCommit, saved }: {
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  // Записанное описание: Escape в поле с правкой возвращает его (панель редактора, где
  // клавиша выше закрыла бы панель). Нет — Escape поле не трогает.
  saved?: string;
}) {
  if (!editable) return value ? <p className="np-desc">{value}</p> : null;
  return (
    <div className="np-desc-fit" data-value={value}>
      <textarea
        {...noAutofill("node-page-4")}
        className="np-desc-input"
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={saved === undefined ? undefined : revertOnEscape(value !== saved, () => onChange(saved))}
        placeholder="Добавьте описание"
        aria-label="Описание"
      />
    </div>
  );
}
