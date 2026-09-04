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
// обрезала бы панель в 360px и по ширине, и при прокрутке. Координаты снимаются
// с кнопки в момент открытия; прокрутка любого предка закрывает поповер, чтобы
// панель не «отклеивалась» от кнопки.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { QuestionCircleIcon } from "./icons";
import "./popover.css";

interface Props {
  // Подпись кнопки для скринридера и тултипа («Что такое якорь»).
  label: string;
  children: ReactNode;
  width?: number;
}

type Pos = { top: number; left: number };

// Зазор от кнопки и от края экрана.
const GAP = 6;

export default function InfoPopover({ label, children, width = 360 }: Props) {
  const [pos, setPos] = useState<Pos | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const open = pos !== null;

  const close = useCallback(() => setPos(null), []);

  const toggle = () => {
    if (open) { close(); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) { setPos({ top: GAP, left: GAP }); return; }
    // Вправо от кнопки, если хватает места, иначе прижимаем к правому краю окна.
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - width - GAP));
    setPos({ top: r.bottom + GAP, left });
  };

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
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", close, true);
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
      {pos && (
        <div
          className="ipop-panel"
          role="dialog"
          aria-label={label}
          style={{ top: pos.top, left: pos.left, width }}
        >
          {children}
        </div>
      )}
    </span>
  );
}
