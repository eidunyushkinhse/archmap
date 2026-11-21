// Описание объекта сразу под названием (редизайн, направление А «Документ»): у читателя
// абзац (пустое описание не показывается вовсе), у редактора поле без рамки, растущее по
// тексту. Высоту поля задаёт невидимая копия текста в той же ячейке сетки (тот же приём,
// что у поля имени, np-name-fit): ручки растяжения и прокрутки у поля нет.
import { noAutofill } from "../../ui/noAutofill";

export default function DescriptionField({ value, editable, onChange, onCommit }: {
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
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
        placeholder="Добавьте описание"
        aria-label="Описание"
      />
    </div>
  );
}
