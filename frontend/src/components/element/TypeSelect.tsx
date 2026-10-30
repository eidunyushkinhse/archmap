// Поле «Тип» (Р35–Р37 раздела 13 docs/plan-c4-elements.md) — выпадашка из шести типов,
// один рендер на окно «Новый объект», инспектор редактора и «Свойства» страницы объекта.
// Пункты в две строки: подпись и подсказка; серый пункт вместо подсказки объясняет,
// почему он недоступен (aria-disabled), и не выбирается. Какие пункты серые, решает
// чистая модель typeOptions; здесь только разметка и клавиатура.
//
// Клавиатура: пункты — кнопки (Tab и Enter работают сами), стрелки ходят по пунктам,
// Escape закрывает меню и возвращает фокус на поле. Escape гасится только у самого меню:
// окно «Новый объект» — нативный <dialog>, и без этого клавиша закрыла бы всё окно.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { TYPE_HINT, TYPE_LABEL, type NodeType } from "../nodeTerms";
import type { TypeOption } from "./typeOptions";
import "./element.css";

interface Props {
  // Выбранный тип; null — ещё не выбран (окно создания без предвыбора).
  value: NodeType | null;
  options: readonly TypeOption[];
  onPick: (type: NodeType) => void;
  // Классы кнопки-значения в месте вызова: поле окна, инспектора или карточки страницы.
  triggerClass: string;
  // Иконка-шеврон места вызова (у инспектора и страницы свои).
  chevron?: ReactNode;
  placeholder?: string;
  // Подпись для скринридера, когда видимой подписи рядом нет.
  label?: string;
}

export default function TypeSelect({ value, options, onPick, triggerClass, chevron, placeholder = "Выберите тип", label }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Открытое меню — фокус на выбранном пункте (или первом): с клавиатуры выбирают сразу.
  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>(".ts-option");
    if (!items || items.length === 0) return;
    const current = [...items].find((b) => b.getAttribute("aria-selected") === "true");
    (current ?? items[0]).focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>(".ts-option") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
    items[next]?.focus();
  };

  const pick = (option: TypeOption) => {
    if (option.disabled) return;
    close();
    if (option.type !== value) onPick(option.type);
  };

  return (
    <span className="ts-wrap">
      <button
        ref={trigger}
        type="button"
        className={`ts-trigger ${triggerClass}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        <span className={value ? "ts-value" : "ts-value ts-placeholder"}>
          {value ? TYPE_LABEL[value] : placeholder}
        </span>
        {chevron}
      </button>
      {open && (
        <>
          <div className="ts-backdrop" onClick={() => setOpen(false)} />
          <div className="ts-menu" role="listbox" aria-label={label ?? "Тип"} ref={menu} onKeyDown={onKeyDown}>
            {options.map((o) => (
              <button
                key={o.type}
                type="button"
                role="option"
                className="ts-option"
                aria-selected={o.type === value}
                aria-disabled={o.disabled || undefined}
                onClick={() => pick(o)}
              >
                <span className="ts-label">{TYPE_LABEL[o.type]}</span>
                <small className="ts-hint">{o.disabled ? o.reason : TYPE_HINT[o.type]}</small>
                {o.type === value && <span className="ts-check" aria-hidden><CheckMark /></span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

function CheckMark() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12 L10 17 L19 7" /></svg>;
}
