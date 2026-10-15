// Уход элементов тура (аудит F-38): копия ушедшей карточки или затемнения гаснет на
// старом месте, а карточка паузы сворачивается в пилюлю «Продолжить обучение». Копии
// живут вне React — отдельным слоем в том же хосте — и сами себя убирают.
import { prefersReducedMotion } from "./tourMotion";

/** Хозяин слоя жив: в документе и, если это окно, открыт. */
export function hostAlive(el: HTMLElement): boolean {
  return el.isConnected && !(el instanceof HTMLDialogElement && !el.open);
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
export function leaveGhost(el: HTMLElement, ghostClass: string, toPill = false): void {
  const host = el.parentElement?.parentElement;
  if (!host || !hostAlive(host) || prefersReducedMotion()) return;
  queueMicrotask(() => {
    if (el.isConnected || !hostAlive(host)) return;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("role");
    ghost.removeAttribute("aria-label");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    // Класс полёта — до вставки: проявление карточки (tour-card-in) на копии не стартует
    // и не сдвигает её рамку, от которой считается перелёт.
    if (toPill) ghost.classList.add("tour-card--fly");
    const layer = document.createElement("div");
    layer.className = "tour-layer";
    layer.appendChild(ghost);
    host.appendChild(layer);
    const done = () => layer.remove();
    if (toPill && flyToPill(ghost, done)) return;
    ghost.classList.remove("tour-card--fly");
    ghost.classList.add(ghostClass);
    // пульс рамки внутри копии затемнения — свои события анимации, их пропускаем
    ghost.addEventListener("animationend", (e) => { if (e.target === ghost) done(); });
    window.setTimeout(done, GHOST_MS);
  });
}

/** Сворачивание в пилюлю: перелёт и до момента «долетела» (доля длительности), дальше
 *  копия гаснет поверх пилюли. Посадку пилюля отмечает вспышкой (tour.css,
 *  .tour-pill--resume: задержка — до «долетела»). */
const FLY_MS = 520;
const FLY_LAND = 0.8;

/**
 * Пауза: копия карточки сворачивается в пилюлю «Продолжить обучение» в шапке — видно,
 * куда нажать, чтобы продолжить. Летит и сжимается ровно в рамку пилюли, по пути текст
 * гаснет (сплющенным его не видно), фон и скругление становятся пилюльными. Пилюли нет
 * на экране или браузер без Web Animations — false: обычное угасание.
 */
function flyToPill(ghost: HTMLElement, done: () => void): boolean {
  const pill = document.querySelector<HTMLElement>("[data-tour-pill]");
  if (!pill || typeof ghost.animate !== "function") return false;
  // Копия — на своё видимое место без центрирования (у карточки по центру — translate):
  // перелёт и сжатие считаются от её рамки.
  const from = ghost.getBoundingClientRect();
  Object.assign(ghost.style, {
    left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    transform: "none", translate: "none",
  });
  // Кадр спустя пилюля уже «Продолжить обучение» (подпись шире) — её рамку и берём.
  requestAnimationFrame(() => {
    const to = pill.getBoundingClientRect();
    if (to.width <= 0 || from.width <= 0) { done(); return; }
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const sx = to.width / from.width, sy = to.height / from.height;
    // скругление до сжатия: после scale(sx, sy) — полукруглые торцы пилюли
    const r = to.height / 2;
    const end = { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: `${r / sx}px / ${r / sy}px` };
    for (const child of Array.from(ghost.children)) {
      child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLY_MS * 0.35, fill: "forwards" });
    }
    const flight = ghost.animate([
      { transform: "translate(0px, 0px) scale(1, 1)", borderRadius: "12px", backgroundColor: "#ffffff",
        boxShadow: "0 18px 44px rgba(15, 23, 42, 0.28)", opacity: 1, easing: "cubic-bezier(0.65, 0, 0.35, 1)" },
      { ...end, backgroundColor: "#fffbeb", boxShadow: "0 0 0 rgba(15, 23, 42, 0)", opacity: 1, offset: FLY_LAND },
      { ...end, backgroundColor: "#fffbeb", boxShadow: "0 0 0 rgba(15, 23, 42, 0)", opacity: 0 },
    ], { duration: FLY_MS, fill: "forwards" });
    flight.finished.then(done, done);
  });
  window.setTimeout(done, FLY_MS + 400);
  return true;
}
