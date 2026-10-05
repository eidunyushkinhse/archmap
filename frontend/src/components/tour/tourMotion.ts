// Плавные переходы слоя тура (docs/tasks/demo-tour-motion.md). Вырезы в затемнении
// перетекают от прежней цели к новой; при появлении сужаются от всего экрана; пока
// новой цели нет, раскрываются до всего экрана и затягиваются, так что затемнение
// держится без выреза; затемнение проявляется и гаснет плавно. Анимируется только
// смена цели. Ту же цель, сдвинутую прокруткой, зумом или паном, вырез догоняет в том
// же кадре: твин идёт от снимка на старте к ЖИВОЙ цели кадра.
//
// Чистые функции интерполяции и маленький аниматор со временем снаружи: кадровый цикл
// тура (DemoTour) зовёт frame() на каждом requestAnimationFrame, TourLayer рисует кадр.
import type { Hole } from "./tourGeometry";
import type { TourView } from "./tourView";

/** Вырез в кадре: геометрия, скругление r и раскрытость alpha (1 — вырезан, 0 —
 *  затянут затемнением; рамка вокруг выреза видна в той же мере). */
export interface ShownHole extends Hole { r: number; alpha: number }

export interface MotionFrame {
  /** непрозрачность затемнения, 0..1 */
  opacity: number;
  holes: ShownHole[];
  /** вырезы доехали до цели: пульс рамки начинается только тогда */
  settled: boolean;
}

/** Появление: вырез сужается к цели от всего экрана (ease-out). */
export const APPEAR_MS = 400;
/** Шаг → шаг: вырез перетекает к новой цели или раскрывается до экрана (ease-in-out). */
export const MOVE_MS = 350;
/** Затемнение проявляется и гаснет с постоянной скоростью: 0 → 1 за это время. */
export const FADE_MS = 200;
/** Шаг анимации за кадр — не больше, чем за столько мс (кадр при 50–60 Гц): долгий кадр
 *  (раскладка холста заняла поток) не проскакивает ни проявление, ни перелёт выреза —
 *  анимация продолжается обычным шагом с того места, где её застал долгий кадр. */
export const MAX_FRAME_MS = 20;
/** Скругление выреза-рамки (как у holePath по умолчанию). */
export const HOLE_RADIUS = 10;
/** «Весь экран»: вырез с запасом за краями окна, чтобы его рамки не было видно. */
export const SCREEN_BLEED = 12;

export const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/** Вырез цели в покое: круг скруглён на половину стороны, рамка — на HOLE_RADIUS. */
export function shownHole(h: Hole, alpha = 1): ShownHole {
  return { ...h, r: h.shape === "dot" ? h.w / 2 : HOLE_RADIUS, alpha };
}

/** Вырез на весь экран (с запасом за краями). */
export function screenHole(vw: number, vh: number, alpha: number): ShownHole {
  const b = SCREEN_BLEED;
  return { x: -b, y: -b, w: vw + 2 * b, h: vh + 2 * b, shape: "rect", r: HOLE_RADIUS, alpha };
}

/** Точка в центре выреза: из неё растёт новый вырез, в неё стягивается и гаснет лишний. */
export function collapsed(h: ShownHole): ShownHole {
  return { ...h, x: h.x + h.w / 2, y: h.y + h.h / 2, w: 0, h: 0, r: 0, alpha: 0 };
}

/** Вырез между a и b (k от 0 до 1). Кругом он остаётся только между кругами; рамка ↔
 *  круг идёт скруглённой рамкой (радиус перетекает), форма цели — в конце. */
export function lerpHole(a: ShownHole, b: ShownHole, k: number): ShownHole {
  const out: ShownHole = {
    x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k),
    r: lerp(a.r, b.r, k), alpha: lerp(a.alpha, b.alpha, k),
    shape: k >= 1 || a.shape === b.shape ? b.shape : "rect",
  };
  if (b.quiet) out.quiet = true;
  return out;
}

/** Набор вырезов между from и to: i-й перетекает в i-й; новый растёт из своего центра,
 *  лишний стягивается в свой центр и на k = 1 исчезает. */
export function tweenHoles(from: readonly ShownHole[], to: readonly ShownHole[], k: number): ShownHole[] {
  if (k >= 1) return to.slice();
  const out: ShownHole[] = [];
  for (let i = 0; i < Math.max(from.length, to.length); i++) {
    const a: ShownHole | undefined = from[i];
    const b: ShownHole | undefined = to[i];
    if (a && b) out.push(lerpHole(a, b, k));
    else if (b) out.push(lerpHole(collapsed(b), b, k));
    else if (a) out.push(lerpHole(a, collapsed(a), k));
  }
  return out;
}

/** Куда идёт слой в этом кадре. */
export interface MotionTarget {
  /** смена ключа — новый твин; тот же ключ — слежение за живой целью без анимации */
  key: string;
  /** затемнение: 1 — есть, 0 — нет, null — как было (ждём цель: что видно, то и держим) */
  shade: 0 | 1 | null;
  /** вырезы цели; null — отпустить: каждый вырез раскрывается до всего экрана и
   *  затягивается (затемнение без выреза — приветствие, финал, ожидание цели) */
  holes: readonly Hole[] | null;
}

/** Цель анимации по виду кадра. Ключ выреза — шаг и формы вырезов: на шаге появилась
 *  зона второго выреза — она вырастает, а та же цель, сдвинутая прокруткой, — нет. */
export function motionTarget(step: string, view: TourView): MotionTarget {
  switch (view.phase) {
    case "spot":
      return { key: `spot|${step}|${view.holes.map((h) => h.shape).join(",")}`, shade: 1, holes: view.holes };
    case "center":
      return { key: "center", shade: 1, holes: null };
    case "pending":
      return { key: "pending", shade: null, holes: null };
    case "docked":
      return { key: "docked", shade: 0, holes: null };
    case "hidden":
      return { key: "hidden", shade: 0, holes: null };
  }
}

/** Кадр покоя для вида без аниматора: вырезы ровно на цели, затемнение по фазе. */
export function restingFrame(view: TourView): MotionFrame {
  const shaded = view.phase === "spot" || view.phase === "center";
  return {
    opacity: shaded ? 1 : 0,
    holes: view.phase === "spot" ? view.holes.map((h) => shownHole(h)) : [],
    settled: true,
  };
}

/** Пользователь просит без анимаций: слой переключается мгновенно, как без твина. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Аниматор слоя: помнит, что нарисовано, и ведёт это к цели кадра. Время — снаружи
 * (performance.now() кадрового цикла), поэтому под тестами он детерминирован.
 */
export class TourMotion {
  private readonly reduced: boolean;
  private key: string | null = null;
  /** твин: снимок на старте, сколько пройдено (мс, шагами кадров), длительность, кривая */
  private from: ShownHole[] = [];
  private elapsed = 0;
  private dur = 0;
  private ease: (t: number) => number = easeInOut;
  /** прежняя цель — вырезы (а не «отпустить»): от неё перетекаем, а не сужаемся */
  private wasSpot = false;
  private shown: ShownHole[] = [];
  private opacity = 0;
  private shade = 0;
  private last: number | null = null;

  constructor(reduced = false) {
    this.reduced = reduced;
  }

  frame(now: number, target: MotionTarget, vw: number, vh: number): MotionFrame {
    const dt = this.last === null ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, now - this.last));
    this.last = now;
    if (target.key !== this.key) this.retarget(target, vw, vh);
    else this.elapsed += dt;
    if (target.shade !== null) this.shade = target.shade;
    const to = target.holes
      ? target.holes.map((h) => shownHole(h))
      : Array.from({ length: Math.max(1, this.from.length) }, () => screenHole(vw, vh, 0));
    const k = this.dur > 0 ? clamp01(this.elapsed / this.dur) : 1;
    this.shown = tweenHoles(this.from, to, this.ease(k));
    // Затемнение идёт к цели с постоянной скоростью: развернулось на полпути — без скачка.
    const d = this.reduced ? 1 : dt / FADE_MS;
    this.opacity = this.opacity < this.shade
      ? Math.min(this.shade, this.opacity + d)
      : Math.max(this.shade, this.opacity - d);
    if (Math.abs(this.opacity - this.shade) < 1e-6) this.opacity = this.shade; // хвост сложения дробей
    return { opacity: this.opacity, holes: this.shown, settled: k >= 1 };
  }

  private retarget(target: MotionTarget, vw: number, vh: number): void {
    // Затемнения не видно (тур только появился, карточка была сбоку, окно поверх) —
    // вырез начинает от всего экрана, раскрытым; иначе — от того, что нарисовано.
    this.from = target.holes && this.opacity < 0.05
      ? target.holes.map(() => screenHole(vw, vh, 1))
      : this.shown;
    // Цель нашлась после затемнения без выреза — сужение, как при появлении.
    const appear = target.holes !== null && !this.wasSpot;
    // Цель сменилась на ходу (вторая зона появилась посреди перелёта, «Далее» подряд) —
    // вырез продолжает движение без остановки: ease-out стартует сразу со скоростью.
    const moving = this.dur > 0 && this.elapsed < this.dur;
    this.dur = this.reduced ? 0 : appear ? APPEAR_MS : MOVE_MS;
    this.ease = appear || moving ? easeOut : easeInOut;
    this.elapsed = 0;
    this.key = target.key;
    this.wasSpot = target.holes !== null;
  }
}
