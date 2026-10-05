// Плавные переходы слоя тура: интерполяция вырезов (перетекание, рост из центра,
// стягивание в центр, рамка ↔ круг) и аниматор — появление, смена цели, слежение за
// той же целью без твина, долгий кадр, смена цели на ходу, ожидание цели, угасание
// затемнения, без анимаций.
import { describe, it, expect } from "vitest";
import type { Hole } from "../tourGeometry";
import {
  APPEAR_MS, FADE_MS, HOLE_RADIUS, MAX_FRAME_MS, MOVE_MS, SCREEN_BLEED, TourMotion, collapsed, easeInOut, easeOut,
  lerpHole, motionTarget, restingFrame, screenHole, shownHole, tweenHoles, type MotionFrame, type MotionTarget,
} from "../tourMotion";
import type { TourView } from "../tourView";

const VW = 1440, VH = 900;
const A: Hole = { x: 100, y: 100, w: 200, h: 80, shape: "rect" };
const B: Hole = { x: 600, y: 400, w: 60, h: 30, shape: "rect" };
const DOT: Hole = { x: 500, y: 300, w: 22, h: 22, shape: "dot" };

const spot = (step: string, holes: Hole[]): MotionTarget => ({ key: `spot|${step}|${holes.map((h) => h.shape).join(",")}`, shade: 1, holes });
const PENDING: MotionTarget = { key: "pending", shade: null, holes: null };
const DOCKED: MotionTarget = { key: "docked", shade: 0, holes: null };
const geo = (h: Hole) => ({ x: h.x, y: h.y, w: h.w, h: h.h });

/** Кадры каждые 16 мс, как у requestAnimationFrame: аниматор на отрезке [from, to]
 *  с одной целью. Возвращает последний кадр (ровно в to). */
function run(m: TourMotion, from: number, to: number, t: MotionTarget): MotionFrame {
  let f = m.frame(from, t, VW, VH);
  for (let now = from + 16; now < to; now += 16) f = m.frame(now, t, VW, VH);
  return to > from ? m.frame(to, t, VW, VH) : f;
}

/** Довести аниматор до покоя на цели (появление от нуля); вернуть время. */
function settledOn(m: TourMotion, t: MotionTarget, start = 0): number {
  run(m, start, start + 1000, t);
  return start + 1000;
}

describe("кривые", () => {
  it("концы на месте, ease-out быстрее в начале, ease-in-out симметрична", () => {
    for (const f of [easeOut, easeInOut]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
    }
    expect(easeOut(0.25)).toBeGreaterThan(0.5);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1);
  });
});

describe("интерполяция вырезов", () => {
  it("вырез перетекает: позиция, размер, скругление; на k = 1 — ровно цель", () => {
    const a = shownHole(A), b = shownHole(B);
    const mid = lerpHole(a, b, 0.5);
    expect(geo(mid)).toEqual({ x: 350, y: 250, w: 130, h: 55 });
    expect(mid.r).toBe(HOLE_RADIUS);
    expect(tweenHoles([a], [b], 1)).toEqual([b]);
  });

  it("рамка ↔ круг: по пути скруглённая рамка с перетекающим радиусом, форма цели в конце", () => {
    const rect = shownHole(A), dot = shownHole(DOT);
    expect(dot.r).toBe(11);
    const mid = lerpHole(rect, dot, 0.5);
    expect(mid.shape).toBe("rect");
    expect(mid.r).toBeCloseTo((HOLE_RADIUS + 11) / 2);
    expect(lerpHole(rect, dot, 1).shape).toBe("dot");
    expect(lerpHole(dot, dot, 0.5).shape).toBe("dot");
  });

  it("вырезов стало больше — новый растёт из своего центра; меньше — лишний стягивается и исчезает", () => {
    const a = shownHole(A), b = shownHole(B);
    const grown = tweenHoles([a], [a, b], 0.5);
    expect(grown).toHaveLength(2);
    expect(grown[1].x + grown[1].w / 2).toBeCloseTo(B.x + B.w / 2);
    expect(grown[1].w).toBeCloseTo(B.w / 2);
    expect(grown[1].alpha).toBeCloseTo(0.5);
    const shrunk = tweenHoles([a, b], [a], 0.5);
    expect(shrunk).toHaveLength(2);
    expect(shrunk[1].y + shrunk[1].h / 2).toBeCloseTo(B.y + B.h / 2);
    expect(shrunk[1].h).toBeCloseTo(B.h / 2);
    expect(tweenHoles([a, b], [a], 1)).toEqual([a]);
    expect(collapsed(b)).toMatchObject({ x: 630, y: 415, w: 0, h: 0, alpha: 0 });
  });

  it("зона без пульса остаётся зоной по пути", () => {
    const zone = shownHole({ ...B, quiet: true });
    expect(lerpHole(shownHole(A), zone, 0.3).quiet).toBe(true);
    expect(lerpHole(shownHole(A), shownHole(B), 0.3).quiet).toBeUndefined();
  });

  it("«весь экран» — с запасом за краями, чтобы рамки не было видно", () => {
    expect(screenHole(VW, VH, 0)).toMatchObject({ x: -SCREEN_BLEED, y: -SCREEN_BLEED, w: VW + 2 * SCREEN_BLEED, alpha: 0 });
  });
});

describe("цель анимации по виду кадра", () => {
  const view = (patch: Partial<TourView>): TourView => ({
    phase: "spot", host: null, holes: [], anchor: null, avoid: [], soft: [], ...patch,
  });

  it("вырез — шаг и формы; центр — затемнение без выреза; ожидание — держать затемнение; сбоку — без него", () => {
    expect(motionTarget("connect", view({ holes: [DOT, DOT] })).key).toBe("spot|connect|dot,dot");
    expect(motionTarget("final", view({ phase: "center" }))).toEqual({ key: "center", shade: 1, holes: null });
    expect(motionTarget("drag", view({ phase: "pending" })).shade).toBeNull();
    expect(motionTarget("drag", view({ phase: "docked" })).shade).toBe(0);
    expect(motionTarget("drag", view({ phase: "hidden" })).shade).toBe(0);
  });

  it("кадр покоя: вырезы ровно на цели, затемнение только у выреза и по центру", () => {
    expect(restingFrame(view({ holes: [A] }))).toEqual({ opacity: 1, holes: [shownHole(A)], settled: true });
    expect(restingFrame(view({ phase: "docked" })).opacity).toBe(0);
  });
});

describe("аниматор", () => {
  it("появление: затемнение проявляется за FADE_MS, вырез сужается от всего экрана за APPEAR_MS", () => {
    const m = new TourMotion();
    const t = spot("yar-home", [A]);
    const f0 = m.frame(0, t, VW, VH);
    expect(f0.opacity).toBe(0);
    expect(geo(f0.holes[0])).toEqual(geo(screenHole(VW, VH, 1)));
    expect(f0.holes[0].alpha).toBe(1);
    expect(f0.settled).toBe(false);
    const f1 = run(m, 16, FADE_MS / 2, t);
    expect(f1.opacity).toBeCloseTo(0.5);
    // FADE_MS = APPEAR_MS / 2: затемнение проявилось, вырез на полпути по времени и
    // (ease-out) дальше половины пути
    const half = run(m, FADE_MS / 2 + 16, APPEAR_MS / 2, t);
    expect(half.opacity).toBe(1);
    expect(half.holes[0].x).toBeGreaterThan(A.x / 2);
    expect(half.holes[0].x).toBeLessThan(A.x);
    const end = run(m, APPEAR_MS / 2 + 16, APPEAR_MS, t);
    expect(end.holes).toEqual([shownHole(A)]);
    expect(end.settled).toBe(true);
  });

  it("та же цель сдвинулась (прокрутка, зум, пан) — вырез на новом месте в том же кадре", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("yar-home", [A]));
    const moved = { ...A, x: A.x + 40, y: A.y - 25 };
    const f = m.frame(now + 16, spot("yar-home", [moved]), VW, VH);
    expect(f.holes).toEqual([shownHole(moved)]);
    expect(f.settled).toBe(true);
  });

  it("смена цели — вырез перетекает за MOVE_MS (ease-in-out), пульс ждёт конца", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("yar-home", [A]));
    const t = spot("open-editor", [B]);
    const f0 = m.frame(now, t, VW, VH);
    expect(f0.holes).toEqual([shownHole(A)]);
    expect(f0.settled).toBe(false);
    const mid = run(m, now + 16, now + MOVE_MS / 2, t);
    expect(mid.holes[0].x).toBeCloseTo((A.x + B.x) / 2);
    expect(mid.opacity).toBe(1);
    // цель поехала на полпути (плавная прокрутка) — вырез приходит на её новое место
    const moved = { ...B, y: B.y + 50 };
    const end = run(m, now + MOVE_MS / 2 + 16, now + MOVE_MS, spot("open-editor", [moved]));
    expect(end.holes).toEqual([shownHole(moved)]);
    expect(end.settled).toBe(true);
  });

  it("долгий кадр (поток занят раскладкой) не проскакивает перелёт: вырез продолжает с того же места", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("yar-home", [A]));
    const t = spot("open-editor", [B]);
    m.frame(now, t, VW, VH);
    // следующий кадр пришёл через 300 мс — вырез прошёл путь одного шага в MAX_FRAME_MS
    const after = m.frame(now + 300, t, VW, VH).holes[0];
    expect(after.x).toBeCloseTo(A.x + (B.x - A.x) * easeInOut(MAX_FRAME_MS / MOVE_MS));
    expect(after.x).toBeLessThan(A.x + (B.x - A.x) * 0.1);
    // дальше — обычными кадрами до конца
    const end = run(m, now + 316, now + 300 + MOVE_MS - MAX_FRAME_MS, t);
    expect(end.holes).toEqual([shownHole(B)]);
    expect(end.settled).toBe(true);
  });

  it("цель сменилась на ходу — вырез не останавливается: перезапуск идёт ease-out", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("yar-home", [A]));
    m.frame(now, spot("open-editor", [B]), VW, VH);
    const mid = run(m, now + 16, now + MOVE_MS / 2, spot("open-editor", [B]));
    const C: Hole = { x: 1000, y: 700, w: 100, h: 50, shape: "rect" };
    const t = spot("drag", [C]);
    const f0 = m.frame(now + MOVE_MS / 2 + 16, t, VW, VH);
    expect(f0.holes[0].x).toBeCloseTo(mid.holes[0].x); // кадр смены — без скачка
    const f1 = m.frame(now + MOVE_MS / 2 + 32, t, VW, VH);
    const step = (f1.holes[0].x - f0.holes[0].x) / (C.x - f0.holes[0].x);
    expect(step).toBeCloseTo(easeOut(16 / MOVE_MS));
    expect(step).toBeGreaterThan(0.1); // ease-in-out дал бы ~0,0004 — вырез бы встал
  });

  it("смена экрана: пока цели нет, вырез раскрывается до экрана, затемнение держится; нашлась — сужается", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("open-yar", [A]));
    m.frame(now, PENDING, VW, VH);
    const released = run(m, now + 16, now + MOVE_MS, PENDING);
    expect(released.opacity).toBe(1);
    expect(released.holes).toEqual([screenHole(VW, VH, 0)]);
    // затемнение без выреза держится, сколько бы цель ни грузилась
    expect(run(m, now + MOVE_MS + 16, now + 1400, PENDING).opacity).toBe(1);
    const t = spot("yar-home", [B]);
    const f0 = m.frame(now + 1416, t, VW, VH);
    expect(geo(f0.holes[0])).toEqual(geo(screenHole(VW, VH, 0)));
    const half = run(m, now + 1432, now + 1416 + APPEAR_MS / 2, t).holes[0];
    expect(half.alpha).toBeGreaterThan(0.5); // ease-out: раскрылся больше чем наполовину
    expect(run(m, now + 1416 + APPEAR_MS / 2 + 16, now + 1416 + APPEAR_MS, t).holes).toEqual([shownHole(B)]);
  });

  it("цель ушла с экрана (карточка сбоку) — затемнение гаснет за FADE_MS; вернулась — проявляется", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("drag", [A]));
    m.frame(now, DOCKED, VW, VH);
    expect(run(m, now + 16, now + FADE_MS / 2, DOCKED).opacity).toBeCloseTo(0.5);
    expect(run(m, now + FADE_MS / 2 + 16, now + FADE_MS, DOCKED).opacity).toBe(0);
    // затемнения не было видно — вырез снова сужается от всего экрана, раскрытым
    m.frame(now + 984, DOCKED, VW, VH);
    const back = m.frame(now + 1000, spot("drag", [A]), VW, VH);
    expect(back.opacity).toBeCloseTo(16 / FADE_MS);
    expect(back.holes[0]).toEqual(screenHole(VW, VH, 1));
  });

  it("финал после выреза: вырез раскрывается до экрана и затягивается, затемнение остаётся", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("inside", [A]));
    const center: MotionTarget = { key: "center", shade: 1, holes: null };
    m.frame(now, center, VW, VH);
    const mid = run(m, now + 16, now + MOVE_MS / 2, center);
    expect(mid.holes[0].w).toBeGreaterThan(A.w);
    expect(mid.holes[0].alpha).toBeCloseTo(0.5);
    const end = run(m, now + MOVE_MS / 2 + 16, now + MOVE_MS, center);
    expect(end.holes).toEqual([screenHole(VW, VH, 0)]);
    expect(end.opacity).toBe(1);
  });

  it("два выреза: каждый от своего, второй растёт из центра и стягивается в центр", () => {
    const m = new TourMotion();
    const now = settledOn(m, spot("create-system", [A]));
    const two = spot("create-system", [A, B]);
    m.frame(now, two, VW, VH);
    const mid = run(m, now + 16, now + MOVE_MS / 2, two);
    expect(mid.holes[0]).toEqual(shownHole(A));
    expect(mid.holes[1].w).toBeCloseTo(B.w / 2);
    run(m, now + MOVE_MS / 2 + 16, now + MOVE_MS, two);
    const one = spot("add-peer", [B]);
    run(m, now + MOVE_MS + 16, now + 1000, two);
    m.frame(now + 1016, one, VW, VH);
    const back = run(m, now + 1032, now + 1016 + MOVE_MS / 2, one);
    expect(back.holes).toHaveLength(2);
    expect(back.holes[1].w).toBeCloseTo(B.w / 2);
    expect(run(m, now + 1016 + MOVE_MS / 2 + 16, now + 1016 + MOVE_MS, one).holes).toEqual([shownHole(B)]);
  });

  it("без анимаций (prefers-reduced-motion) — всё мгновенно", () => {
    const m = new TourMotion(true);
    const f0 = m.frame(0, spot("yar-home", [A]), VW, VH);
    expect(f0).toEqual({ opacity: 1, holes: [shownHole(A)], settled: true });
    expect(m.frame(16, spot("open-editor", [B]), VW, VH).holes).toEqual([shownHole(B)]);
    expect(m.frame(32, DOCKED, VW, VH).opacity).toBe(0);
  });
});
