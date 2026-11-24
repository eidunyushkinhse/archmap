// Escape в поле свойства (страница объекта, панель объекта и связи в редакторе-карте).
// Поле с несохранённой правкой — Escape возвращает сохранённое значение и дальше не
// уходит: в редакторе клавиша выше закрыла бы панель, а набранное пропало бы молча или
// записалось бы уходом с поля. Поле без правки клавишу не трогает: она идёт выше и
// закрывает панель (и только следующим нажатием — редактор).
import type { KeyboardEvent } from "react";

export function revertOnEscape(dirty: boolean, revert: () => void) {
  return (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || !dirty) return;
    e.stopPropagation();
    revert();
  };
}
