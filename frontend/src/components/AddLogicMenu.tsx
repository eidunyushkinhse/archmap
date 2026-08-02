// Меню «+ Добавить» для раздела «Логика»: создание схемы вручную или дозаливка
// схем от ИИ-агента (BYOA) — пакетом либо по одной схеме. Единый вход для
// страницы узла (секция «Логика») и правой панели редактора (NodeInspector):
// триггер в духе np-addbtn, выпадающий список в духе np-dropdown.
import { useEffect, useState } from "react";
import "./AddLogicMenu.css";

interface Props {
  // Новая схема (вручную) — открыть редактор схем с автосозданием
  onManual: () => void;
  // Схемы от агента — пакетом (DocsAgentModal, режим batch)
  onBatch: () => void;
  // Схема от агента — по одной (DocsAgentModal, режим single)
  onSingle: () => void;
  // Прижатие выпадающего списка: left — страница узла, right — узкая правая
  // панель редактора (кнопка у правого края, список не выходит за панель).
  align?: "left" | "right";
}

export default function AddLogicMenu({ onManual, onBatch, onSingle, align = "left" }: Props) {
  const [open, setOpen] = useState(false);

  // Закрытие по Escape; клик мимо гасит фиктивный backdrop
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="alm-wrap">
      <button
        type="button"
        className="alm-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        + Добавить
        <span className={"alm-chev" + (open ? " alm-chev--open" : "")} aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9 L12 15 L18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <>
          <div className="alm-backdrop" onClick={() => setOpen(false)} />
          <div className={"alm-menu" + (align === "right" ? " alm-menu--right" : "")} role="menu">
            <button type="button" role="menuitem" onClick={pick(onManual)}>
              Новая схема (вручную)
            </button>
            <div className="alm-sep" aria-hidden="true" />
            <button type="button" role="menuitem" onClick={pick(onBatch)}>
              Схемы от агента — пакетом
            </button>
            <button type="button" role="menuitem" onClick={pick(onSingle)}>
              Схема от агента — по одной
            </button>
          </div>
        </>
      )}
    </div>
  );
}
