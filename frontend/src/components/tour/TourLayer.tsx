// Слой тура: затемнение с вырезами и синей рамкой вокруг цели, пульс на шагах с
// действием, карточка «Шаг N из M» рядом с целью. Только отрисовка: что и где
// подсвечивать, решает TourRuntime (DemoTour.tsx).
//
// Клики. Затемнение пропускает события только в вырезах: перехватчик — SVG-путь с
// дырами (evenodd), ловящий указатель своей заливкой. Жест, начатый в вырезе (драг
// из палитры, протягивание связи от хэндла, перетаскивание узла), пропускается
// целиком до отпускания: бросать форму нужно на холст, а он под затемнением.
// Колёсико над затемнением на миг тоже пропускается — прокрутка и зум не залипают.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { holePath, inHole, mergeHoles, placeCard, shadePath, type Hole } from "./tourGeometry";
import type { TourStep } from "./tourSteps";
import type { TourView } from "./tourView";
import "./tour.css";

interface Props {
  view: TourView;
  /** ключ шага: новый шаг — свежее состояние перехватчика */
  stepKey: string;
  step: TourStep;
  texts: { title: string; body: string; action?: string };
  /** «Шаг N из M» или null у приветствия и финалов */
  count: string | null;
  canBack: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
}

// Размер окна — внешний стор: перерисовка на resize без эффектов с setState.
function subscribeViewport(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const viewportKey = () => `${window.innerWidth}x${window.innerHeight}`;

export default function TourLayer(props: Props) {
  const { view } = props;
  const vp = useSyncExternalStore(subscribeViewport, viewportKey);
  if (!view.host || view.phase === "hidden" || view.phase === "pending") return null;
  const [w, h] = vp.split("x").map(Number);
  const shaded = view.phase === "center" || view.phase === "spot";
  return createPortal(
    <div className="tour-layer" data-tour-layer="">
      {shaded && (
        <Shade
          key={props.stepKey}
          width={w}
          height={h}
          holes={view.phase === "spot" ? view.holes : []}
          act={props.step.kind === "act"}
        />
      )}
      <Card {...props} viewport={{ w, h }} />
    </div>,
    view.host,
  );
}

function Shade({ width, height, holes, act }: { width: number; height: number; holes: Hole[]; act: boolean }) {
  const maskId = useId();
  const [pass, setPass] = useState(false);
  const holesRef = useRef(holes);
  useEffect(() => { holesRef.current = holes; }, [holes]);

  // Жест из выреза — сквозь затемнение до отпускания. Отпускание снимаем на следующем
  // такте: обработчики продукта (конец протягивания связи) смотрят elementFromPoint
  // уже после нашего capture-слушателя и должны увидеть холст, а не затемнение.
  useEffect(() => {
    let nativeDrag = false;
    let timer = 0;
    const release = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (!nativeDrag) setPass(false); }, 0);
    };
    const onDown = (e: PointerEvent) => {
      if (holesRef.current.some((hole) => inHole(hole, e.clientX, e.clientY))) {
        window.clearTimeout(timer);
        setPass(true);
      }
    };
    const onDragStart = () => { nativeDrag = true; window.clearTimeout(timer); setPass(true); };
    const onDragEnd = () => { nativeDrag = false; release(); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("dragend", onDragEnd, true);
    document.addEventListener("drop", onDragEnd, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      document.removeEventListener("dragstart", onDragStart, true);
      document.removeEventListener("dragend", onDragEnd, true);
      document.removeEventListener("drop", onDragEnd, true);
    };
  }, []);

  const wheelTimer = useRef(0);
  const onWheel = () => {
    setPass(true);
    window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => setPass(false), 350);
  };
  useEffect(() => () => window.clearTimeout(wheelTimer.current), []);

  return (
    <>
      <svg className="tour-shade" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <defs>
          <mask id={maskId}>
            <rect width={width} height={height} fill="#fff" />
            {holes.map((hole, i) => <path key={i} d={holePath(hole)} fill="#000" />)}
          </mask>
        </defs>
        <rect width={width} height={height} fill="rgba(15,23,42,.55)" mask={`url(#${maskId})`} />
        <path
          className={pass ? "tour-blocker tour-blocker--pass" : "tour-blocker"}
          data-tour-blocker=""
          d={shadePath(width, height, mergeHoles(holes))}
          fill="transparent"
          fillRule="evenodd"
          onWheel={onWheel}
        />
      </svg>
      {holes.map((hole, i) => (
        <div
          key={i}
          className={`tour-ring${hole.shape === "dot" ? " tour-ring--dot" : ""}${act && !hole.quiet ? " tour-ring--act" : ""}`}
          style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
        />
      ))}
    </>
  );
}

// Оценка размера до первого замера (ширина — как в прототипе).
const CARD_ESTIMATE = { w: 340, h: 200 };

function Card({
  view, step, texts, count, canBack, onNext, onBack, onSkip, onFinish, viewport,
}: Props & { viewport: { w: number; h: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(CARD_ESTIMATE);
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
  let cls = "tour-card";
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
