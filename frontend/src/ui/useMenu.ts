import { useCallback, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { flushSync } from "react-dom";
import { useDismiss } from "./useDismiss";

// Меню у кнопки (меню профиля, «Действия со схемой», выбор проекта, меню строки
// пользователя и карточки проекта, «⋯» страницы объекта): закрытие и клавиатура одним хуком
// вместо копий в каждом меню (редизайн, фаза 13в).
//  - Щелчок мимо и Escape закрывают (ui/useDismiss); при щелчке мимо фокус не трогаем.
//  - Escape с пункта или с кнопки возвращает фокус на кнопку меню: пункт размонтируется, и
//    без этого фокус уходил в никуда.
//  - Выбор пункта (pick) сначала ставит фокус на кнопку меню, потом закрывает меню и зовёт
//    действие. Окно, открытое пунктом (нативный <dialog> ui/Modal), запоминает элемент в
//    фокусе на момент открытия и при закрытии возвращает фокус на кнопку, а не на
//    размонтированный пункт.
//  - Стрелки вниз и вверх ходят по незапертым пунктам по кругу, Home и End ставят на первый
//    и последний; стрелка вниз на кнопке открытого меню ставит на первый пункт (вверх — на
//    последний). В поле внутри меню (поиск проекта) Home и End остаются полю.
//  - Tab с пункта закрывает меню, а фокус идёт дальше своим ходом от кнопки меню: меню
//    снимается синхронно (flushSync), до того как браузер переставит фокус.
// Пункты — элементы .ds-menu-item внутри menuRef: роль menuitem есть не у всех меню.
// onKeyDown ставится на кнопку и на само меню (не на обёртку: в обёртке бывают окна,
// открытые пунктами, их клавиши меню не касаются).
interface Menu {
  wrapRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  pick: (action: () => void) => void;
}

export function useMenu(open: boolean, setOpen: (open: boolean) => void): Menu {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useDismiss(open, wrapRef, setOpen);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    const target = e.target as Node;
    const onTrigger = target === trigger;
    const inMenu = !!menu && menu.contains(target);
    if (!onTrigger && !inMenu) return;
    const items = menu
      ? [...menu.querySelectorAll<HTMLButtonElement>(".ds-menu-item")].filter((b) => !b.disabled)
      : [];
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    switch (e.key) {
      case "Escape":
        trigger?.focus();
        setOpen(false);
        return;
      case "ArrowDown":
      case "ArrowUp": {
        if (items.length === 0) return;
        e.preventDefault();
        const down = e.key === "ArrowDown";
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
        return;
      }
      case "Home":
      case "End":
        if (typing || items.length === 0) return;
        e.preventDefault();
        items[e.key === "Home" ? 0 : items.length - 1]?.focus();
        return;
      case "Tab":
        // Без preventDefault: браузер сам переставит фокус от кнопки меню дальше.
        if (!inMenu) return;
        trigger?.focus();
        flushSync(() => setOpen(false));
        return;
    }
  }, [open, setOpen]);

  const pick = useCallback((action: () => void) => {
    triggerRef.current?.focus();
    setOpen(false);
    action();
  }, [setOpen]);

  return { wrapRef, triggerRef, menuRef, onKeyDown, pick };
}
