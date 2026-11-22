// Универсальное меню добавления для разделов документации («Логика», «OpenAPI»,
// «Структура» базы): создание вручную и дозаливка от ИИ-агента (BYOA). Пункты
// задаются группами — между группами рисуется разделитель («Логика»:
// вручную | пакетом/по одной; «OpenAPI»: вручную | от агента). На странице объекта
// триггер — тихая текстовая кнопка «+ Добавить» в строке заголовка раздела (ui/ds.css,
// ds-add; редизайн, направление А). Тот же список живёт и в окне схемы/спецификации
// (DocOverlay): «Изменить» в шапке — вторичная кнопка ds-btn, «Описать» у неописанной
// схемы — главная; список у них — меню нового языка (ds-menu, фаза 7а).
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDownIcon, PlusIcon } from "../ui/icons";
import "./AddDocsMenu.css";
import "../ui/ds.css";

export interface AddDocsMenuItem {
  label: string;
  onSelect: () => void;
}

interface Props {
  // Группы пунктов: плоский список, между группами — разделитель
  groups: AddDocsMenuItem[][];
  // Прижатие выпадающего списка: left — страница узла, right — узкая правая
  // панель редактора и шапка окна (кнопка у правого края, список не выходит за
  // край), center — кнопка посреди окна.
  align?: "left" | "right" | "center";
  // Подпись триггера: у разделов страницы — «Добавить» (плюс рисуется значком).
  label?: string;
  // Вид триггера: «add» — тихая «+ Добавить» разделов страницы; «button» — вторичная
  // кнопка («Изменить» в шапке окна), «primary» — главная («Описать»).
  variant?: "add" | "button" | "primary";
}

export default function AddDocsMenu({ groups, align = "left", label = "Добавить", variant = "add" }: Props) {
  const asButton = variant !== "add";
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

  const place = (align === "left" ? "" : ` adm-menu--${align}`) + (up ? " adm-menu--up" : "");

  return (
    <div className="adm-wrap" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={asButton ? "ds-btn" + (variant === "primary" ? " ds-btn--primary" : "") : "ds-add"}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {!asButton && <PlusIcon size={12} />}
        {label}
        {asButton && <span className="adm-chev" aria-hidden="true"><ChevronDownIcon /></span>}
      </button>
      {open && asButton && (
        <>
          <div className="ds-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className={"ds-menu adm-dsmenu" + place} role="menu">
            {groups.map((items, gi) => (
              <Fragment key={gi}>
                {gi > 0 && <div className="ds-menu-sep" aria-hidden="true" />}
                {items.map((it) => (
                  <button key={it.label} type="button" role="menuitem" className="ds-menu-item" onClick={pick(it.onSelect)}>
                    {it.label}
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        </>
      )}
      {open && !asButton && (
        <>
          <div className="adm-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className={"adm-menu adm-menu--quiet" + place} role="menu">
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
