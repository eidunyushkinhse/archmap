// Прокрутка страницы к блоку-цели шага (шаг «Не только схема», раунд 5 обучения,
// docs/tasks/demo-tour-5.md): блок встаёт верхом сразу под шапку, а не выглядывает снизу.
// Страница объекта дорисовывается не сразу (свойства, схема, разделы документации),
// и блок после разовой прокрутки уезжал вниз. Поэтому прокрутка ждёт, пока место блока в
// содержимом перестанет меняться, и повторяется, если раскладка сдвинула его снова.
// Прокрутку, сделанную самим человеком, не перебивает: повод для новой прокрутки —
// только сдвиг блока в содержимом. Без DOM-логики шагов: элемент даёт кадровый цикл.

/** Зазор между верхом окна прокрутки (низом шапки) и верхом блока. */
export const SCROLL_GAP = 12;
/** Столько мс место блока в содержимом не меняется — раскладка улеглась. */
const SETTLE_MS = 300;
/** Столько мс от первого кадра с блоком прокрутка следит за раскладкой; не дождались —
 *  карточка показывается как есть. */
const ACTIVE_MS = 2500;

/** Ближайший прокручиваемый по вертикали предок элемента, иначе корень документа. */
export function scrollParent(el: Element): HTMLElement {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** Куда прокрутить контейнер, чтобы верх элемента встал на SCROLL_GAP ниже верха окна
 *  прокрутки (в пределах того, насколько контейнер вообще прокручивается). */
export function scrollTopFor(el: Element, box: HTMLElement): number {
  const viewTop = box === document.scrollingElement || box === document.documentElement
    ? 0
    : box.getBoundingClientRect().top;
  const offset = el.getBoundingClientRect().top - viewTop + box.scrollTop;
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  return Math.max(0, Math.min(offset - SCROLL_GAP, max));
}

/** Прокрутка к блоку на одном входе в шаг. frame() зовётся каждый кадр с элементом-целью
 *  и отвечает, встала ли страница: тогда карточку можно показывать (однажды вставшая —
 *  встала до конца шага). */
export class SectionScroll {
  private startedAt = -1;
  private lastWant: number | null = null;
  private stableSince = 0;
  private aimed: number | null = null;
  // Страница однажды встала — карточка показана; дальше она не прячется, даже если
  // человек прокрутил страницу сам или раскладка сдвинула блок и прокрутка его догоняет.
  private ready = false;

  private readonly smooth: boolean;

  constructor(smooth: boolean) {
    this.smooth = smooth;
  }

  frame(now: number, el: Element): boolean {
    if (this.startedAt < 0) this.startedAt = now;
    const box = scrollParent(el);
    const want = scrollTopFor(el, box);
    // Место блока в содержимом (а с ним и нужная прокрутка) сдвинулось — раскладка
    // ещё идёт: ждём, пока уляжется.
    if (this.lastWant === null || Math.abs(want - this.lastWant) > 1) {
      this.lastWant = want;
      this.stableSince = now;
    }
    const active = now - this.startedAt < ACTIVE_MS;
    const settled = now - this.stableSince >= SETTLE_MS;
    const aligned = Math.abs(box.scrollTop - want) <= 2;
    if (active && settled && !aligned && (this.aimed === null || Math.abs(want - this.aimed) > 2)) {
      this.aimed = want;
      box.scrollTo({ top: want, behavior: this.smooth ? "smooth" : "auto" });
    }
    if ((settled && aligned) || !active) this.ready = true;
    return this.ready;
  }
}
