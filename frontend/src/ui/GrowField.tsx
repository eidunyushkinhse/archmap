// Поле в виде текста, растущее по тексту с переносом строк (редизайн): в таблицах фактов
// текст не обрезается, а дочитывается целиком. Высоту задаёт невидимая копия текста в
// той же ячейке сетки (приём поля имени страницы объекта, np-name-fit): ручки
// растяжения и прокрутки нет. Однострочное по смыслу поле (имя, тип, значение по
// умолчанию) переносит длинный текст, но Enter не вставляет перевод строки, а
// заканчивает правку. Значение уходит наружу по blur — как у прежних полей секций;
// свежее значение с сервера приходит перемонтированием (ключ по версии записи).
import { useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import "./ds.css";

type Rest = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange" | "onBlur" | "rows" | "className">;

export default function GrowField({ initial, onCommit, multiline = false, className, ...rest }: Rest & {
  initial: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  // Класс обёртки (кегль, гарнитура ячейки).
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    // is-empty — пустое необязательное поле строки фактов прячется до наведения на строку
    // (правило места вызова, components/factRows.css).
    <span className={"ds-grow" + (className ? ` ${className}` : "") + (value === "" ? " is-empty" : "")} data-value={value}>
      <textarea
        {...rest}
        rows={1}
        className="ds-grow-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (!multiline && e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}
