// «Язык описаний» в окне «Обновить из кода»: значение-кнопка и меню из двух пунктов,
// выбранный с галочкой. Меню — обычный блок внутри окна (вложенный <dialog> нельзя), но
// position: fixed с координатами от кнопки, как панель выбора объекта в импорте процессов
// (processes/NodeChoice): прокрутка тела окна его не обрезает. Escape меню гасит само
// (preventDefault и stopPropagation на keydown): иначе нативный cancel закрыл бы всё
// окно. Закрытие любым путём возвращает фокус на значение.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { CheckIcon, ChevronDownIcon } from "../../ui/icons";
import "../../ui/ds.css";
import "./syncRepo.css";

type Lang = "ru" | "en";
const LANGS: readonly Lang[] = ["ru", "en"];
const LANG_LABEL: Record<Lang, string> = { ru: "Русский", en: "Английский" };

// Место меню: под кнопкой, текст пунктов на вертикали текста значения (у пункта 15px до
// текста: рамка меню, его поле и поле пункта; у значения 6px). Снизу тесно — над кнопкой.
const MENU_H = 80;
function place(btn: HTMLElement): CSSProperties {
  const r = btn.getBoundingClientRect();
  const left = Math.max(8, r.left - 9);
  return window.innerHeight - r.bottom >= MENU_H + 8
    ? { left, top: r.bottom + 2 }
    : { left, bottom: window.innerHeight - r.top + 2 };
}

export default function SyncLangChoice({ value, onChange, labelId }: {
  value: Lang;
  onChange: (lang: Lang) => void;
  // id подписи строки: кнопка читается как «Язык описаний Русский».
  labelId: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  function openMenu() {
    if (!btnRef.current) return;
    setPos(place(btnRef.current));
    setOpen(true);
  }
  function close() {
    setOpen(false);
    btnRef.current?.focus();
  }
  function pick(lang: Lang) {
    if (lang !== value) onChange(lang);
    close();
  }

  // Открытое меню: фокус на выбранном пункте (стрелки ходят от него).
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  // Тело окна прокрутили или изменили размер браузера: меню едет за кнопкой.
  useEffect(() => {
    if (!open) return;
    const follow = () => { if (btnRef.current) setPos(place(btnRef.current)); };
    window.addEventListener("resize", follow);
    document.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", follow);
      document.removeEventListener("scroll", follow, true);
    };
  }, [open]);

  function onKey(e: KeyboardEvent<HTMLSpanElement>) {
    if (!open) {
      if (e.key === "ArrowDown") { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
      items[next]?.focus();
    } else if (e.key === "Tab") {
      // Уход Tab-ом — то же, что Escape: фокус на значение, дальше Tab идёт как обычно.
      e.preventDefault();
      close();
    }
  }

  return (
    <span className="sync-lang" onKeyDown={onKey}>
      <button
        ref={btnRef}
        id={`${labelId}-value`}
        type="button"
        className="ds-value-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${labelId}-value`}
        onClick={() => (open ? close() : openMenu())}
      >
        {LANG_LABEL[value]}
        <span className="ds-value-chev" aria-hidden="true"><ChevronDownIcon /></span>
      </button>
      {open && (
        <>
          {/* Клик мимо: закрыть, не уводя фокус (preventDefault), и вернуть его на кнопку. */}
          <div className="sync-lang-backdrop" onMouseDown={(e) => { e.preventDefault(); close(); }} />
          <ul ref={menuRef} className="ds-menu sync-lang-menu" role="menu" style={pos}>
            {LANGS.map((lang) => (
              <li key={lang} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={lang === value}
                  className="ds-menu-item"
                  onClick={() => pick(lang)}
                >
                  <span className="sync-lang-label">{LANG_LABEL[lang]}</span>
                  {lang === value && <span className="sync-lang-check"><CheckIcon /></span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </span>
  );
}
