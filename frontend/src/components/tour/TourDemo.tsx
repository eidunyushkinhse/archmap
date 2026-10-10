// Демонстрация перевеса на шаге «Перевесьте связь» (tourDemo.ts): курсор-ладонь берёт
// конец стрелки на рамке и переносит его на точку сервиса, полупрозрачная копия
// стрелки едет за ней. Слой поверх затемнения и под карточкой, мышь не ловит.
//
// Цикл повторяется, пока человек не возьмётся сам: нажатие где угодно прячет
// демонстрацию, отпускание возвращает её через DEMO_RESUME_MS (шаг не сделан — ещё
// раз видно, что делать). Кадры — императивно по rAF, без setState: геометрия
// (пан и зум холста) читается из последних пропсов. При prefers-reduced-motion —
// один неподвижный кадр: копия стрелки уже на точке, ладонь на ней.
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { DEMO_RESUME_MS, demoFrame, ghostPath, type DemoFrame, type RehangDemo } from "./tourDemo";
import { prefersReducedMotion } from "./tourMotion";

/** Тот же серый, что у превью-линии и наконечников связей на холсте. */
const COLOR = "#6b7280";
/** Неподвижный кадр без анимаций: ладонь держит конец на точке. */
const STILL_T = 2200;
/** Ладонь: размер на экране (как у курсора, от зума не зависит) и точка хвата в ней. */
const HAND = 30;
const HOT = { x: 16, y: 18 };

// Пальцы, ладонь и большой палец (viewBox 32×32): белая заливка поверх тех же фигур
// с обводкой даёт один общий контур; пальцы разделяют тонкие линии.
const OPEN_SHAPES = (
  <>
    <rect x="9" y="14" width="15.2" height="13" rx="5" />
    <rect x="9.4" y="5.2" width="3.7" height="13" rx="1.85" />
    <rect x="13.2" y="3.4" width="3.7" height="14" rx="1.85" />
    <rect x="17" y="4.4" width="3.7" height="13" rx="1.85" />
    <rect x="20.8" y="7.4" width="3.3" height="10" rx="1.65" />
    <rect x="4.4" y="12.6" width="3.7" height="10" rx="1.85" transform="rotate(-38 6.3 22)" />
  </>
);
const OPEN_SEAMS = "M13.15 7.5V14.6M16.95 6.6V14.6M20.75 9.2V14.6";
const CLOSED_SHAPES = (
  <>
    <rect x="8.6" y="12" width="15.8" height="15" rx="5.5" />
    <rect x="9.4" y="9.4" width="3.7" height="6.4" rx="1.85" />
    <rect x="13.2" y="8.6" width="3.7" height="7" rx="1.85" />
    <rect x="17" y="9" width="3.7" height="6.8" rx="1.85" />
    <rect x="20.8" y="10.2" width="3.3" height="5.8" rx="1.65" />
    <rect x="5.6" y="14.4" width="4" height="8" rx="2" transform="rotate(-22 7.6 18.4)" />
  </>
);
const CLOSED_SEAMS = "M13.15 10.6V14.2M16.95 10V14.2M20.75 11.4V14.2";

function Hand({ shapes, seams }: { shapes: ReactNode; seams: string }) {
  return (
    <>
      <g fill="#0f172a" stroke="#0f172a" strokeWidth="2.4" strokeLinejoin="round">{shapes}</g>
      <g fill="#ffffff">{shapes}</g>
      <path d={seams} stroke="#0f172a" strokeWidth="1" strokeLinecap="round" fill="none" />
    </>
  );
}

export default function TourDemo({ demo, width, height }: { demo: RehangDemo; width: number; height: number }) {
  const markerId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const demoRef = useRef(demo);
  useLayoutEffect(() => { demoRef.current = demo; });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ghostG = svg.querySelector<SVGGElement>("[data-demo='ghost']");
    const ghostPathEl = svg.querySelector<SVGPathElement>("[data-demo='ghost-path']");
    const haloEl = svg.querySelector<SVGPathElement>("[data-demo='ghost-halo']");
    const handG = svg.querySelector<SVGGElement>("[data-demo='hand']");
    const openG = svg.querySelector<SVGGElement>("[data-demo='open']");
    const closedG = svg.querySelector<SVGGElement>("[data-demo='closed']");
    const ripple = svg.querySelector<SVGCircleElement>("[data-demo='ripple']");
    if (!ghostG || !ghostPathEl || !haloEl || !handG || !openG || !closedG || !ripple) return;

    const draw = (f: DemoFrame | null) => {
      const d = demoRef.current;
      if (!f) {
        ghostG.setAttribute("opacity", "0");
        handG.setAttribute("opacity", "0");
        ripple.setAttribute("opacity", "0");
        return;
      }
      if (f.ghost && f.ghost.opacity > 0) {
        const path = ghostPath(d, f.ghost, f.ghost.snapped);
        ghostPathEl.setAttribute("d", path);
        ghostPathEl.setAttribute("stroke-width", String(1.5 * d.zoom));
        haloEl.setAttribute("d", path);
        haloEl.setAttribute("stroke-width", String(5 * d.zoom));
        ghostG.setAttribute("opacity", f.ghost.opacity.toFixed(3));
      } else {
        ghostG.setAttribute("opacity", "0");
      }
      const s = (HAND / 32) * (1 - 0.1 * f.hand.press);
      handG.setAttribute("transform", `translate(${f.hand.x} ${f.hand.y}) scale(${s}) translate(${-HOT.x} ${-HOT.y})`);
      handG.setAttribute("opacity", f.hand.opacity.toFixed(3));
      openG.setAttribute("display", f.hand.closed ? "none" : "inline");
      closedG.setAttribute("display", f.hand.closed ? "inline" : "none");
      if (f.ripple) {
        ripple.setAttribute("cx", String(f.ripple.x));
        ripple.setAttribute("cy", String(f.ripple.y));
        ripple.setAttribute("r", String(6 + 14 * f.ripple.k));
        ripple.setAttribute("opacity", (0.8 * (1 - f.ripple.k)).toFixed(3));
      } else {
        ripple.setAttribute("opacity", "0");
      }
    };

    if (prefersReducedMotion()) {
      draw({ ...demoFrame(STILL_T, demoRef.current), ripple: null });
      return;
    }

    let raf = 0;
    let start = performance.now();
    let holding = false;
    let resumeAt = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      draw(holding || now < resumeAt ? null : demoFrame(now - start, demoRef.current));
    };
    // Человек взялся сам — демонстрация прячется; отпустил, а шаг не сделан — через паузу
    // начинается заново.
    const onDown = () => { holding = true; };
    const onUp = () => {
      if (!holding) return;
      holding = false;
      resumeAt = performance.now() + DEMO_RESUME_MS;
      start = resumeAt;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
    };
  }, []);

  const head = `url(#${markerId})`;
  return (
    <svg ref={svgRef} className="tour-demo" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" data-tour-demo="">
      <defs>
        {/* Копия наконечника превью-линии (graph/ConnectionLine): размер от толщины линии. */}
        <marker
          id={markerId} markerWidth="12.5" markerHeight="12.5" viewBox="-10 -10 20 20"
          refX="0" refY="0" orient="auto-start-reverse" markerUnits="strokeWidth"
        >
          <polyline points="-5,-4 0,0 -5,4 -5,-4" stroke={COLOR} fill={COLOR} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <g data-demo="ghost" opacity="0">
        {/* светлая подложка: копия видна и на затемнении, где идёт почти вся связь */}
        <path data-demo="ghost-halo" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path
          data-demo="ghost-path" fill="none" stroke={COLOR} strokeWidth="1.5"
          markerEnd={demo.headAtFixed ? undefined : head}
          markerStart={demo.headAtFixed ? head : undefined}
        />
      </g>
      <circle data-demo="ripple" r="6" fill="none" stroke="#2563eb" strokeWidth="2" opacity="0" />
      <g data-demo="hand" className="tour-demo-hand" opacity="0">
        <g data-demo="open"><Hand shapes={OPEN_SHAPES} seams={OPEN_SEAMS} /></g>
        <g data-demo="closed" display="none"><Hand shapes={CLOSED_SHAPES} seams={CLOSED_SEAMS} /></g>
      </g>
    </svg>
  );
}
