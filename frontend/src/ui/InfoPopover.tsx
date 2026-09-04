// ⓘ-поповер: кнопка «знак вопроса в круге» рядом с полем и панель с пояснением.
// Заводится под поле «Якорь» (docs/plan-anchor-ux.md), но примитив общий: любое
// поле с неинтуитивной механикой может объяснить себя на месте, не уводя человека
// в документацию.
//
// Почему НЕ нативный <dialog>: пояснение — не модальный шаг, оно не забирает
// фокус и не блокирует работу с полем под ним; к тому же вложенные <dialog>
// в проекте запрещены (ui/Modal.tsx — cancel всплывает, top-layer ломает
// позиционирование), а поповер обязан открываться и внутри модалок.
//
// Почему панель position: fixed, а не абсолютный слой внутри обёртки: правая
// панель редактора шириной 272px со своим overflowY (MapEditorPage.rightPanel)
// обрезала бы панель по ширине и при прокрутке. Координаты снимаются с кнопки в
// момент открытия; прокрутка ПРЕДКА закрывает поповер, чтобы панель не
// «отклеивалась» от кнопки, — а прокрутка внутри самой панели, разумеется, нет.
//
// Пояснение обязано читаться ЦЕЛИКОМ, пока окно это позволяет: место под кнопкой
// у нижних полей мало, и панель, просто открытая вниз, прячет хвост текста за
// внутренней прокруткой (находка приёмки Ф1 — четвёртый абзац не виден). Поэтому
// высота панели меряется ПОСЛЕ монтирования (её нельзя знать заранее: она зависит
// от текста и ширины) и место выбирается по факту — вниз, вверх или прижатием к
// краю окна поверх кнопки. Прокрутка внутри остаётся только если окно ниже панели.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { QuestionCircleIcon } from "./icons";
import "./popover.css";

interface Props {
  // Подпись кнопки для скринридера и тултипа («Что такое якорь»).
  label: string;
  children: ReactNode;
  width?: number;
}

// Кнопка в момент открытия: панель живёт fixed-слоем и считает своё место от неё.
type Anchor = { top: number; bottom: number; left: number };

// Зазор от кнопки и от края экрана.
const GAP = 6;

export default function InfoPopover({ label, children, width = 420 }: Props) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  const close = useCallback(() => setAnchor(null), []);

  const toggle = () => {
    if (open) { close(); return; }
    const r = btnRef.current?.getBoundingClientRect();
    setAnchor(r ? { top: r.top, bottom: r.bottom, left: r.left } : { top: 0, bottom: 0, left: 0 });
  };

  // Место по ФАКТИЧЕСКОЙ высоте панели — до отрисовки (useLayoutEffect), чтобы
  // не мигнуть в неверной позиции. Пишем прямо в style по ref, а не в стейт:
  // это измерение, а не производное состояние, и лишний рендер ему не нужен.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!anchor || !el) return;
    const vh = window.innerHeight;
    // scrollHeight — контент с полями; +2 на рамки. Это высота, которую панель
    // заняла бы БЕЗ ограничения, даже когда ограничение её уже режет.
    const need = el.scrollHeight + 2;
    const below = vh - anchor.bottom - GAP * 2;
    const above = anchor.top - GAP * 2;
    el.style.top = `${
      need <= below ? anchor.bottom + GAP
      : need <= above ? anchor.top - GAP - need
      // Не помещается ни под кнопкой, ни над ней — прижимаем к краю окна и
      // разрешаем перекрыть кнопку: прочитать текст важнее, чем видеть ⓘ.
      : Math.max(GAP, vh - GAP - need)
    }px`;
  }, [anchor, width]);

  // Escape, клик вне и прокрутка предка — три способа закрыть. Слушатели живут
  // только пока панель открыта (иначе document копил бы их на каждое поле).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Поповер закрывается первым и НЕ даёт Escape уехать выше (в модалку или
      // на снятие выделения холста): открытый слой всегда старше своего фона.
      e.stopPropagation();
      close();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && wrapRef.current?.contains(t)) return; // клик по кнопке — это toggle
      if (t?.closest?.(".ipop-panel")) return;
      close();
    };
    // capture: прокрутка идёт во вложенном контейнере (панель инспектора), до
    // window событие не всплывает.
    // ⚠️ capture ловит прокрутку ЛЮБОГО узла, включая саму панель: без этой
    // проверки колесо над длинным пояснением закрывало бы его на первом же
    // движении, и хвост текста прочитать было бы нельзя вовсе.
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".ipop-panel")) return;
      close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  return (
    <span className="ipop-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="ipop-btn"
        onClick={toggle}
        aria-label={label}
        title={label}
        aria-expanded={open}
      >
        <QuestionCircleIcon />
      </button>
      {anchor && (
        <div
          className="ipop-panel"
          ref={panelRef}
          role="dialog"
          aria-label={label}
          style={{
            // Стартовая позиция — под кнопкой; окончательную ставит layout-эффект
            // выше, измерив панель. Вправо от кнопки, пока хватает места, иначе
            // прижимаем к правому краю окна.
            top: anchor.bottom + GAP,
            left: Math.max(GAP, Math.min(anchor.left, window.innerWidth - width - GAP)),
            width,
            // Прокрутка внутри — только если окно НИЖЕ панели.
            maxHeight: window.innerHeight - GAP * 2,
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}
