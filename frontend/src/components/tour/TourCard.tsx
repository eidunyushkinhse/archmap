// Карточка шага тура (аудит F-38): заголовок, текст, «Шаг N из M» и кнопки хода. Место
// у цели считается по замеренному размеру (tourGeometry.placeCard); уход — копией,
// которая гаснет или (пауза) сворачивается в пилюлю (tourGhost).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { placeCard } from "./tourGeometry";
import { leaveGhost } from "./tourGhost";
import { takeExitToPill } from "./tourStore";
import type { TourStep } from "./tourSteps";
import type { TourView } from "./tourView";

interface TourCardProps {
  /** цель кадра: фаза и место карточки (якорь, что не заслонять) */
  view: TourView;
  step: TourStep;
  texts: { title: string; body: string; action?: string };
  /** «Шаг N из M» или null у приветствия и финалов */
  count: string | null;
  canBack: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
  viewport: { w: number; h: number };
  moved: boolean;
}

// Оценка размера до первого замера (ширина — как в прототипе).
const CARD_ESTIMATE = { w: 340, h: 200 };

/** moved — карточку перенесли из убранного окна в body: она уже была на экране, заново
 *  не проявляется (признак запоминается на всю жизнь карточки — снятый класс запустил
 *  бы проявление уже видимой карточки). */
export default function TourCard({
  view, step, texts, count, canBack, onNext, onBack, onSkip, onFinish, viewport, moved,
}: TourCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(CARD_ESTIMATE);
  const [wasMoved] = useState(moved);
  // Новая карточка замеряется до первой отрисовки: место у цели сразу по её размеру,
  // а не по оценке (иначе она проявлялась бы с прыжком).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.offsetWidth > 0) setSize({ w: el.offsetWidth, h: el.offsetHeight });
    // ушла по клику на затемнение (пауза) — сворачивается в пилюлю, иначе гаснет
    return () => { if (el) leaveGhost(el, "tour-card--ghost", takeExitToPill()); };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setSize((prev) => (prev.w === el.offsetWidth && prev.h === el.offsetHeight
        ? prev
        : { w: el.offsetWidth, h: el.offsetHeight }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let style: CSSProperties | undefined;
  let cls = wasMoved ? "tour-card tour-card--moved" : "tour-card";
  if (view.phase === "center") cls += " tour-card--center";
  else if (view.phase === "docked") cls += " tour-card--docked";
  else if (view.anchor) {
    const at = placeCard(view.anchor, view.avoid, size, viewport, view.soft);
    style = { left: at.x, top: at.y };
  }

  const isStart = step.kind === "start";
  const isEnd = step.kind === "end";
  return (
    <div ref={ref} className={cls} style={style} role="dialog" aria-label={texts.title}>
      {count && <span className="tour-count">{count}</span>}
      <h3>{texts.title}</h3>
      {texts.body && <p>{texts.body}</p>}
      {texts.action && <p className="tour-do">{texts.action}</p>}
      <div className="tour-bar">
        {isEnd ? <span /> : (
          <button type="button" className="tour-skip" onClick={onSkip}>
            {isStart ? "Пропустить" : "Пропустить обучение"}
          </button>
        )}
        <div className="tour-btns">
          {canBack && !isEnd && (
            <button type="button" className="tour-btn tour-btn--sec" onClick={onBack}>Назад</button>
          )}
          {isStart && <button type="button" className="tour-btn tour-btn--pri" onClick={onNext}>Начать</button>}
          {isEnd && <button type="button" className="tour-btn tour-btn--pri" onClick={onFinish}>Завершить</button>}
          {step.kind === "info" && (
            <button type="button" className="tour-btn tour-btn--pri" onClick={onNext}>Далее</button>
          )}
        </div>
      </div>
    </div>
  );
}
