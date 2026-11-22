// Значения строк связи, общие у панели связи редактора-карты (inspector/EdgeInspector) и
// окна «Связь» на странице объекта (EdgeEditModal): конец связи «Откуда» / «Куда» с поиском
// объекта, поля «Описание» и «Технология». Строки вокруг значений у каждого места свои:
// в панели строки свойств объекта (nodePage/PropRows, Prop), в окне строки окна (ui/ds.css,
// ds-prop). Запись делает вызывающий через общий хук useEdgeEdit: значение отдаёт
// изменения и уход с поля, само ничего не шлёт.
//
// Escape, который значение обработало само (закрыть поиск конца, вернуть записанный текст
// в поле с правкой), гасится и по умолчанию: в окне (нативный <dialog>) иначе браузер
// закрыл бы всё окно. В панели действия по умолчанию у клавиши нет.
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import NodeSearchPicker from "../NodeSearchPicker";
import { revertOnEscape } from "../nodePage/revertOnEscape";
import { noAutofill } from "../../ui/noAutofill";
import "../../ui/ds.css";
import "./panel.css";

// Значение «Откуда» / «Куда»: значок формы конца висит слева от имени (имя начинается с
// того же x, что и остальные значения). У редактора значение — кнопка: по клику под
// строкой открывается поиск объекта по всему проекту (NodeSearchPicker), выбор
// записывает конец и закрывает поиск; Escape и клик мимо закрывают без записи. Поиск
// встаёт под строкой во всю её ширину: строка места вызова — его опора (position).
export function EndValue({ label, glyph, onPick, term }: {
  label: string;
  glyph: ReactNode;
  onPick?: (id: string, label?: string) => void;
  term: string;
}) {
  const [open, setOpen] = useState(false);
  const name = <span className="ip-end">{glyph && <span className="ip-end-glyph">{glyph}</span>}<span>{label}</span></span>;
  if (!onPick) return name;
  return (
    <>
      <button
        type="button"
        className="ds-value-btn"
        aria-label={`${term}: ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {name}
      </button>
      {open && (
        <>
          <div className="ds-backdrop" onClick={() => setOpen(false)} />
          <div
            className="ip-pop"
            role="group"
            aria-label={term}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }}
          >
            <NodeSearchPicker
              value=""
              onChange={(id, lbl) => { if (!id) return; setOpen(false); onPick(id, lbl); }}
            />
          </div>
        </>
      )}
    </>
  );
}

// Escape в поле: с правкой — вернуть записанное и не пускать клавишу дальше (в том числе
// в окно: оно закрылось бы, а следующим нажатием закроется и так).
function revertKey(dirty: boolean, revert: () => void) {
  const onRevert = revertOnEscape(dirty, revert);
  return (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onRevert(e);
    if (e.isPropagationStopped()) e.preventDefault();
  };
}

interface FieldProps {
  value: string;
  // Записанное значение: к нему возвращает Escape в поле с правкой.
  saved: string;
  onChange: (value: string) => void;
  // Уход с поля: вызывающий коммитит значение.
  onCommit: () => void;
  // Ключ поля для noAutofill: свой у каждой формы.
  autofill: string;
  // id поля: окно связывает с ним подпись строки (<label htmlFor>).
  id?: string;
}

// «Описание» связи: многострочное (лимит модели — 256), переносы автора уважает и плашка
// на схеме (wrapLabel по \n). Поле растёт по тексту (ui/ds.css, ds-grow).
export function EdgeLabelField({ value, saved, onChange, onCommit, autofill, id }: FieldProps) {
  return (
    <span className="ds-grow" data-value={value}>
      <textarea
        {...noAutofill(autofill)}
        id={id}
        className="ds-grow-input"
        rows={1}
        aria-label="Описание"
        maxLength={256}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={revertKey(value !== saved, () => onChange(saved))}
        placeholder="не указано"
      />
    </span>
  );
}

// «Технология» связи: поле в виде текста (ui/ds.css, ds-field).
export function EdgeTechField({ value, saved, onChange, onCommit, autofill, id }: FieldProps) {
  return (
    <input
      {...noAutofill(autofill)}
      id={id}
      className="ds-field"
      aria-label="Технология"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={revertKey(value !== saved, () => onChange(saved))}
      placeholder="не указана"
    />
  );
}
