// Универсальное меню «+ Добавить» для разделов документации («Логика» и
// «OpenAPI»): создание вручную и дозаливка от ИИ-агента (BYOA). Пункты
// задаются группами — между группами рисуется разделитель («Логика»:
// вручную | пакетом/по одной; «OpenAPI»: вручную | от агента). Единый вход
// для страницы узла и правой панели редактора (NodeInspector): триггер в духе
// np-addbtn, выпадающий список в духе np-dropdown (adm-*).
import { Fragment, useEffect, useState } from "react";
import "./AddDocsMenu.css";

export interface AddDocsMenuItem {
  label: string;
  onSelect: () => void;
}

interface Props {
  // Группы пунктов: плоский список, между группами — разделитель
  groups: AddDocsMenuItem[][];
  // Прижатие выпадающего списка: left — страница узла, right — узкая правая
  // панель редактора (кнопка у правого края, список не выходит за панель).
  align?: "left" | "right";
}

export default function AddDocsMenu({ groups, align = "left" }: Props) {
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
    <div className="adm-wrap">
      <button
        type="button"
        className="adm-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        + Добавить
        <span className={"adm-chev" + (open ? " adm-chev--open" : "")} aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9 L12 15 L18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <>
          <div className="adm-backdrop" onClick={() => setOpen(false)} />
          <div className={"adm-menu" + (align === "right" ? " adm-menu--right" : "")} role="menu">
            {groups.map((items, gi) => (
              <Fragment key={gi}>
                {gi > 0 && <div className="adm-sep" aria-hidden="true" />}
                {items.map((it) => (
                  <button key={it.label} type="button" role="menuitem" onClick={pick(it.onSelect)}>
                    {it.label}
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
