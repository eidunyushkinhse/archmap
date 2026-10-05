// Слой тура: затемнение с вырезами и синей рамкой вокруг цели, пульс на шагах с
// действием, карточка «Шаг N из M» рядом с целью. Только отрисовка: что и где
// подсвечивать, решает TourRuntime (DemoTour.tsx).
//
// Клики. Затемнение пропускает события только в вырезах: перехватчик — SVG-путь с
// дырами (evenodd), ловящий указатель своей заливкой. Жест, начатый в вырезе (драг
// из палитры, протягивание связи от хэндла, перетаскивание узла), пропускается
// целиком до отпускания: бросать форму нужно на холст, а он под затемнением.
// Колёсико над затемнением на миг тоже пропускается — прокрутка и зум не залипают.
// Перехват идёт по ЦЕЛЕВЫМ вырезам, а не по нарисованным: по цели можно нажать сразу,
// пока вырез ещё едет к ней.
//
// Плавность (tourMotion.ts): затемнение и вырезы рисуются по кадру аниматора; карточка
// нового шага или нового места проявляется, а копия прежней гаснет на старом месте;
// при закрытии тура так же гаснет затемнение. Окно-хозяин слоя закрылось или ушло из
// DOM — слой переходит в body в той же отрисовке: затемнение не мигает.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { holePath, inHole, mergeHoles, placeCard, shadePath, type Hole } from "./tourGeometry";
import { prefersReducedMotion, restingFrame, type MotionFrame } from "./tourMotion";
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
}

// Размер окна — внешний стор: перерисовка на resize без эффектов с setState.
function subscribeViewport(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const viewportKey = () => `${window.innerWidth}x${window.innerHeight}`;

/** Хозяин слоя жив: в документе и, если это окно, открыт. */
function hostAlive(el: HTMLElement): boolean {
  return el.isConnected && !(el instanceof HTMLDialogElement && !el.open);
}

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
  const [w, h] = vp.split("x").map(Number);
  // Клики держит только затемнение с целью или по центру; пока цель грузится, затемнение
  // (если было) лишь держится на экране и нажатиям не мешает.
  const blocks = view.phase === "center" || view.phase === "spot";
  return createPortal(
    <div className="tour-layer" data-tour-layer="">
      {motion.opacity > 0 && <ShadeArt width={w} height={h} frame={motion} act={props.step.kind === "act"} />}
      {blocks && <Blocker key={props.stepKey} width={w} height={h} holes={view.phase === "spot" ? view.holes : []} />}
      {hasCard && (
        <Card key={`${props.stepKey}|${view.phase}`} {...props} viewport={{ w, h }} moved={host !== view.host} />
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

/** Перехватчик кликов по целевым вырезам. Ключ — шаг: новый шаг начинает без
 *  пропуска жеста. */
function Blocker({ width, height, holes }: { width: number; height: number; holes: Hole[] }) {
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
    <svg className="tour-shade" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path
        className={pass ? "tour-blocker tour-blocker--pass" : "tour-blocker"}
        data-tour-blocker=""
        d={shadePath(width, height, mergeHoles(holes))}
        fill="transparent"
        fillRule="evenodd"
        onWheel={onWheel}
      />
    </svg>
  );
}

/** Сколько живёт копия ушедшего элемента, если конца анимации не дождались (tour.css:
 *  tour-fade-out 200 мс). */
const GHOST_MS = 400;

/**
 * Карточка или затемнение ушли (новый шаг, новое место, тур закрыт) — копия гаснет на
 * старом месте (tour.css: .tour-card--ghost, .tour-art--ghost), пока новое проявляется:
 * место и текст меняются без вспышки, затемнение при закрытии тура гаснет, а не
 * пропадает. Копия живёт вне React — отдельный слой в том же хосте, сам себя убирает.
 * Смотрим после коммита: StrictMode «размонтирует» понарошку, и элемент тогда остаётся
 * в DOM — копия не нужна. Хозяин закрыт или ушёл из DOM — копии не видно, её нет.
 */
function leaveGhost(el: HTMLElement, ghostClass: string): void {
  const host = el.parentElement?.parentElement;
  if (!host || !hostAlive(host) || prefersReducedMotion()) return;
  queueMicrotask(() => {
    if (el.isConnected || !hostAlive(host)) return;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.add(ghostClass);
    ghost.removeAttribute("role");
    ghost.removeAttribute("aria-label");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    const layer = document.createElement("div");
    layer.className = "tour-layer";
    layer.appendChild(ghost);
    host.appendChild(layer);
    const done = () => layer.remove();
    // пульс рамки внутри копии затемнения — свои события анимации, их пропускаем
    ghost.addEventListener("animationend", (e) => { if (e.target === ghost) done(); });
    window.setTimeout(done, GHOST_MS);
  });
}

// Оценка размера до первого замера (ширина — как в прототипе).
const CARD_ESTIMATE = { w: 340, h: 200 };

/** moved — карточку перенесли из убранного окна в body: она уже была на экране, заново
 *  не проявляется (признак запоминается на всю жизнь карточки — снятый класс запустил
 *  бы проявление уже видимой карточки). */
function Card({
  view, step, texts, count, canBack, onNext, onBack, onSkip, onFinish, viewport, moved,
}: Props & { viewport: { w: number; h: number }; moved: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(CARD_ESTIMATE);
  const [wasMoved] = useState(moved);
  // Новая карточка замеряется до первой отрисовки: место у цели сразу по её размеру,
  // а не по оценке (иначе она проявлялась бы с прыжком).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.offsetWidth > 0) setSize({ w: el.offsetWidth, h: el.offsetHeight });
    return () => { if (el) leaveGhost(el, "tour-card--ghost"); };
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
