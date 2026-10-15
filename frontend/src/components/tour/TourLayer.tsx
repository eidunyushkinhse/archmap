// Слой тура: затемнение с вырезами и синей рамкой вокруг цели, пульс на шагах с
// действием, карточка «Шаг N из M» рядом с целью, на шаге «Перевесьте связь» —
// демонстрация жеста ладонью (TourDemo). Только отрисовка: что и где подсвечивать,
// решает TourRuntime (DemoTour.tsx).
//
// Клики. Затемнение пропускает события только в вырезах: перехватчик — SVG-путь с
// дырами (evenodd), ловящий указатель своей заливкой. Жест, начатый в вырезе (драг
// из палитры, протягивание связи от хэндла, перетаскивание узла), пропускается
// целиком до отпускания: бросать форму нужно на холст, а он под затемнением.
// Колёсико над затемнением на миг тоже пропускается — прокрутка и зум не залипают.
// Перехват идёт по ЦЕЛЕВЫМ вырезам, а не по нарисованным: по цели можно нажать сразу,
// пока вырез ещё едет к ней. Клик по самому затемнению — человек хочет осмотреться
// сам: тур встаёт на паузу (docs/tasks/demo-tour-pause.md); промах рядом с вырезом
// паузой не считается.
//
// Плавность (tourMotion.ts): затемнение и вырезы рисуются по кадру аниматора; карточка
// нового шага или нового места проявляется, а копия прежней гаснет на старом месте;
// при закрытии тура так же гаснет затемнение. Окно-хозяин слоя закрылось или ушло из
// DOM — слой переходит в body в той же отрисовке: затемнение не мигает.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { holePath, inHole, mergeHoles, nearHole, shadePath, type Hole } from "./tourGeometry";
import { restingFrame, type MotionFrame } from "./tourMotion";
import TourCard from "./TourCard";
import { hostAlive, leaveGhost } from "./tourGhost";
import TourDemo from "./TourDemo";
import type { TourStep } from "./tourSteps";
import type { TourView } from "./tourView";
import "./tour.css";

interface Props {
  /** цель кадра: фаза, куда рисовать, вырезы цели (по ним перехват кликов), место карточки */
  view: TourView;
  /** что рисовать сейчас — кадр аниматора; без него покой: вырезы ровно на цели */
  motion?: MotionFrame;
  /** ключ шага: новый шаг — свежее состояние перехватчика и новая карточка */
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
  /** клик по затемнению мимо выреза: пауза (на финале — завершить) */
  onShade: () => void;
}

// Размер окна — внешний стор: перерисовка на resize без эффектов с setState.
function subscribeViewport(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const viewportKey = () => `${window.innerWidth}x${window.innerHeight}`;

/**
 * Хозяин слоя, а если окно-хозяин закрылось или ушло из DOM (окно убрали по успеху),
 * — body. Слой внутри убранного окна ушёл бы из документа вместе с ним до ближайшего
 * кадра тура; смерть окна замечает MutationObserver (микрозадача после коммита), и
 * внешний стор перерисовывает слой синхронно — до отрисовки кадра.
 */
function useLiveHost(host: HTMLElement | null): HTMLElement | null {
  const subscribe = useCallback((onChange: () => void) => {
    if (!host || host === document.body) return () => {};
    const mo = new MutationObserver(onChange);
    mo.observe(document.body, { childList: true, subtree: true });
    mo.observe(host, { attributes: true, attributeFilter: ["open"] });
    return () => mo.disconnect();
  }, [host]);
  const alive = useSyncExternalStore(subscribe, () => !host || hostAlive(host));
  return alive ? host : document.body;
}

export default function TourLayer(props: Props) {
  const { view } = props;
  const vp = useSyncExternalStore(subscribeViewport, viewportKey);
  const host = useLiveHost(view.host);
  const motion = props.motion ?? restingFrame(view);
  const hasCard = view.phase === "center" || view.phase === "spot" || view.phase === "docked";
  if (!host || (!hasCard && motion.opacity <= 0)) return null;
  // После наблюдения за раскрытием (шаг с watchMs) порядок такой: затемнение и камера к
  // цели, потом карточка — когда вырез доехал до цели.
  const cardNow = hasCard && (view.phase !== "spot" || !props.step.watchMs || motion.settled);
  const [w, h] = vp.split("x").map(Number);
  // Клики держит только затемнение с целью или по центру; пока цель грузится, затемнение
  // (если было) лишь держится на экране и нажатиям не мешает.
  const blocks = view.phase === "center" || view.phase === "spot";
  return createPortal(
    <div className="tour-layer" data-tour-layer="">
      {motion.opacity > 0 && <ShadeArt width={w} height={h} frame={motion} act={props.step.kind === "act"} />}
      {blocks && (
        <Blocker
          key={props.stepKey} width={w} height={h} holes={view.phase === "spot" ? view.holes : []}
          onShade={props.onShade}
        />
      )}
      {/* Демонстрация жеста (шаг «Перевесьте связь»): когда вырезы доехали до цели */}
      {view.phase === "spot" && view.demo && motion.settled && (
        // свой ключ: перехватчик рядом тоже ключуется шагом — одинаковые ключи у соседей
        // React считает ошибкой (предупреждение в консоли на шагах с демонстрацией)
        <TourDemo key={`demo|${props.stepKey}`} demo={view.demo} width={w} height={h} />
      )}
      {cardNow && (
        <TourCard key={`${props.stepKey}|${view.phase}`} {...props} viewport={{ w, h }} moved={host !== view.host} />
      )}
    </div>,
    host,
  );
}

/** Затемнение с вырезами и синие рамки — по кадру аниматора. Вырез с alpha < 1
 *  наполовину затянут затемнением, рамка вокруг него видна в той же мере. Пульс —
 *  только когда вырезы доехали до цели. Снятое на виду (тур закрыт) гаснет копией. */
function ShadeArt({ width, height, frame, act }: { width: number; height: number; frame: MotionFrame; act: boolean }) {
  const maskId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Видимость последнего нарисованного кадра: погасшее до нуля затемнение копии не оставляет.
  const shownOpacity = useRef(frame.opacity);
  useLayoutEffect(() => { shownOpacity.current = frame.opacity; });
  useLayoutEffect(() => {
    const el = ref.current;
    return () => { if (el && shownOpacity.current > 0.05) leaveGhost(el, "tour-art--ghost"); };
  }, []);
  return (
    <div ref={ref} className="tour-art">
      <svg className="tour-shade" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <defs>
          <mask id={maskId}>
            <rect width={width} height={height} fill="#fff" />
            {frame.holes.map((hole, i) => (hole.alpha > 0
              ? <path key={i} d={holePath(hole, hole.r)} fill="#000" fillOpacity={hole.alpha} />
              : null))}
          </mask>
        </defs>
        <rect width={width} height={height} fill="rgba(15,23,42,.55)" mask={`url(#${maskId})`} opacity={frame.opacity} />
      </svg>
      {frame.holes.map((hole, i) => (hole.alpha > 0.01 ? (
        <div
          key={i}
          className={`tour-ring${hole.shape === "dot" ? " tour-ring--dot" : ""}${act && !hole.quiet && frame.settled ? " tour-ring--act" : ""}`}
          style={{
            left: hole.x, top: hole.y, width: hole.w, height: hole.h,
            borderRadius: hole.r, opacity: hole.alpha * frame.opacity,
          }}
        />
      ) : null))}
    </div>
  );
}

/** Промах мимо цели — до стольких px от края выреза: такой клик паузой не считается
 *  (точки связи на шаге «Проведите связь» всего 22 px). */
const NEAR_MISS = 24;

/** Перехватчик кликов по целевым вырезам. Ключ — шаг: новый шаг начинает без
 *  пропуска жеста. */
function Blocker({ width, height, holes, onShade }: {
  width: number; height: number; holes: Hole[]; onShade: () => void;
}) {
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

  // Нажатие пришлось на само затемнение (в вырезах заливки нет, карточка выше):
  // человек хочет осмотреться сам. Промах рядом с вырезом — не в счёт.
  const onShadeDown = (e: ReactPointerEvent<SVGPathElement>) => {
    if (e.button !== 0) return;
    if (holesRef.current.some((hole) => nearHole(hole, e.clientX, e.clientY, NEAR_MISS))) return;
    onShade();
  };

  return (
    <svg className="tour-shade" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path
        className={pass ? "tour-blocker tour-blocker--pass" : "tour-blocker"}
        data-tour-blocker=""
        d={shadePath(width, height, mergeHoles(holes))}
        fill="transparent"
        fillRule="evenodd"
        onWheel={onWheel}
        onPointerDown={onShadeDown}
      />
    </svg>
  );
}
