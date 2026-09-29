// Универсальное меню добавления для разделов документации («Логика», «OpenAPI»,
// «Структура» базы): создание вручную и дозаливка от ИИ-агента (BYOA). Пункты
// задаются группами — между группами рисуется разделитель («Логика»:
// вручную | пакетом/по одной; «OpenAPI»: вручную | от агента). Единый вход
// для страницы узла и правой панели редактора (NodeInspector): триггер в духе
// np-addbtn, выпадающий список в духе np-dropdown (adm-*). Тот же список живёт и в
// окне схемы/спеки (DocOverlay): кнопка «Изменить» в шапке и «Описать» у
// неописанной схемы — там триггер залитый (variant="primary"), без отступа сверху.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import "./AddDocsMenu.css";

export interface AddDocsMenuItem {
  label: string;
  onSelect: () => void;
}

interface Props {
  // Группы пунктов: плоский список, между группами — разделитель
  groups: AddDocsMenuItem[][];
  // Прижатие выпадающего списка: left — страница узла, right — узкая правая
  // панель редактора и шапка окна (кнопка у правого края, список не выходит за
  // край), center — кнопка посреди карточки.
  align?: "left" | "right" | "center";
  // Подпись триггера. Разделы документации говорят «+ Добавить», структура базы —
  // «+ Таблица»: там добавляется сущность одного вида, и называть её стоит прямо.
  label?: string;
  // Вид триггера: «add» — пунктирная «+ Добавить» разделов страницы, «primary» —
  // залитая кнопка действия (шапка окна схемы/спеки).
  variant?: "add" | "primary";
  // Значок перед подписью (карандаш у «Изменить»). Пункты меню — всегда без значков.
  icon?: ReactNode;
}

export default function AddDocsMenu({ groups, align = "left", label = "+ Добавить", variant = "add", icon }: Props) {
  const [open, setOpen] = useState(false);
  // Меню раскрывается вверх, если под кнопкой не хватает места (кнопка у низа
  // экрана — например, «+ Добавить» в разделе OpenAPI в подвале страницы).
  const [up, setUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Закрытие по Escape; клик мимо гасит фиктивный backdrop
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // До отрисовки (layout-эффект — без вспышки вниз→вверх): если меню не
  // помещается под кнопкой, а сверху места больше — раскрываем вверх.
  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;
    const rect = wrap.getBoundingClientRect();
    const menuH = menu.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    setUp(spaceBelow < menuH + 8 && rect.top > spaceBelow);
  }, [open]);

  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  // Escape при открытом меню закрывает ТОЛЬКО меню. Внутри окна (нативный <dialog>
  // или оверлей процесса со своим слушателем на document) та же клавиша иначе
  // закрыла бы окно целиком: гасим дефолт (cancel диалога) и всплытие.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };

  return (
    <div
      className={"adm-wrap" + (variant === "primary" ? " adm-wrap--inline" : "")}
      ref={wrapRef}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className={"adm-btn" + (variant === "primary" ? " adm-btn--primary" : "")}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon}
        {label}
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
          <div
            ref={menuRef}
            className={"adm-menu" + (align === "left" ? "" : ` adm-menu--${align}`) + (up ? " adm-menu--up" : "")}
            role="menu"
          >
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
