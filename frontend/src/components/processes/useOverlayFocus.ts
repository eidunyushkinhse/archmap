import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Overlay, OverlayKind } from "./useOverlayStack";

// Фокус окон правки процесса (редизайн, фаза 13в). Окна поверх диаграммы — div-слои одного
// стека (useOverlayStack), не <dialog>: фокус в них держим сами, как его держит нативное окно.
//  - При открытии фокус внутри окна: поле, которое взяло его само (autoFocus), остаётся;
//    иначе первое текстовое поле (поиск в «Участниках» и «Привязать «…»»), иначе первая
//    незапертая кнопка, кроме крестика (у подтверждения — главная, в «Добавить шаг» —
//    первый вариант шага). Окно, которое сначала грузится («Добавить шаг» читает связи),
//    получает фокус, когда цель появится.
//  - Tab и Shift+Tab ходят по кругу внутри ВЕРХНЕГО окна и наружу не выходят.
//  - Закрылось верхнее окно — фокус туда, где он был до его открытия (окно под ним, кнопка
//    шапки процесса), если этот элемент ещё на странице и фокус потерян. Окно, открытое из
//    окна, которое тут же закрылось («Привязать «…»» → «Имена расходятся»), возвращает фокус
//    туда, куда вернуло бы закрывшееся.
// Escape здесь не слушаем: его держит стек (ProcessCanvas). Пока открыто нативное окно
// (схема логики шага — ui/Modal), фокусом владеет оно, и Tab сюда не относится.
//
// layerRef — область, где лежат окна стека (центры .proc-center и .proc-confirm-center —
// прямые дети, в порядке стека: верхнее последним). Возвращает remember: его зовёт открытие
// окна ДО того, как окно возьмёт фокус. Так запоминается, куда фокус вернуть.

// Поле ввода текста (список «Тип связи» сюда не входит: в окне шага главное — выбор варианта).
const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not(:disabled), textarea:not(:disabled)';
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

function topWindow(layer: HTMLElement | null): HTMLElement | null {
  if (!layer) return null;
  const centers = layer.querySelectorAll<HTMLElement>(":scope > .proc-center, :scope > .proc-confirm-center");
  return centers.length > 0 ? centers[centers.length - 1] : null;
}

// Элементы окна в порядке документа, подходящие под селектор. Перебор всех потомков, а не
// querySelectorAll со списком селекторов: порядок выдачи по списку не везде документный.
function inOrder(win: HTMLElement, selector: string): HTMLElement[] {
  return [...win.querySelectorAll<HTMLElement>("*")].filter((e) => e.matches(selector));
}

// Всё, что окно рисует, видно: скрытых полей и кнопок в окнах стека нет (что не нужно,
// не рисуется), поэтому видимость не проверяем.
function focusables(win: HTMLElement): HTMLElement[] {
  return inOrder(win, FOCUSABLE).filter((e) => e.tabIndex >= 0);
}

// Куда поставить фокус в только что открытом окне.
function initialTarget(win: HTMLElement): HTMLElement | null {
  return inOrder(win, FIELD)[0] ?? win.querySelector<HTMLElement>("button:not(:disabled):not(.ds-win-close)");
}

// Нативное окно поверх (ui/Modal): фокус и Tab — его.
const nativeOnTop = () => document.querySelector("dialog[open]") !== null;

export function useOverlayFocus(layerRef: RefObject<HTMLElement | null>, stack: readonly Overlay[]): (kind: OverlayKind) => void {
  // Куда вернуть фокус, по видам открытых окон: элемент в фокусе на момент открытия, за ним
  // запасные — куда вернули бы окна, открытые раньше (первый, что ещё на странице).
  const openers = useRef(new Map<OverlayKind, HTMLElement[]>());
  const remember = useCallback((kind: OverlayKind) => {
    const a = document.activeElement;
    const earlier = [...openers.current.entries()].filter(([k]) => k !== kind).reverse().flatMap(([, chain]) => chain);
    openers.current.set(kind, a instanceof HTMLElement && a !== document.body ? [a, ...earlier] : earlier);
  }, []);

  const kinds = stack.map((o) => o.kind);
  const kindsKey = kinds.join(",");
  const top = kinds.at(-1) ?? null;
  const prevKinds = useRef<OverlayKind[]>([]);

  // Открытие и закрытие: сразу после того, как стек отрисован (до кадра на экране).
  useLayoutEffect(() => {
    // Окно ещё грузится, и ставить фокус некуда: ждём, пока в нём появится цель, если фокус
    // к тому времени не ушёл в окно сам.
    let waiting: MutationObserver | null = null;
    const focusInto = (win: HTMLElement) => {
      const target = initialTarget(win);
      if (target) { target.focus(); return; }
      const observer = new MutationObserver(() => {
        if (!win.isConnected || win.contains(document.activeElement)) { observer.disconnect(); return; }
        const later = initialTarget(win);
        if (later) { observer.disconnect(); later.focus(); }
      });
      observer.observe(win, { childList: true, subtree: true });
      waiting = observer;
    };
    const prev = prevKinds.current;
    const now = kindsKey ? (kindsKey.split(",") as OverlayKind[]) : [];
    prevKinds.current = now;
    const prevTop = prev.at(-1) ?? null;
    const nowTop = now.at(-1) ?? null;
    if (prevTop === nowTop) return;
    const lost = () => {
      const a = document.activeElement;
      return a === null || a === document.body || !a.isConnected;
    };
    // Верхнее окно закрылось: вернуть фокус открывшему его элементу. Записи закрытых окон
    // (и тех, что закрылись под верхним) больше не нужны.
    const back = prevTop !== null && !now.includes(prevTop)
      ? openers.current.get(prevTop)?.find((e) => e.isConnected)
      : undefined;
    for (const k of [...openers.current.keys()]) if (!now.includes(k)) openers.current.delete(k);
    if (back && lost()) back.focus();
    // Открылось новое верхнее окно (не нативное): фокус внутрь, если он не там.
    if (nowTop !== null && nowTop !== "doc" && !prev.includes(nowTop)) {
      const win = topWindow(layerRef.current);
      if (win && !win.contains(document.activeElement)) focusInto(win);
    } else if (nowTop !== null && nowTop !== "doc" && lost()) {
      // Под закрывшимся окном осталось другое, а открывший элемент пропал: фокус в него.
      const win = topWindow(layerRef.current);
      if (win) focusInto(win);
    }
    return () => waiting?.disconnect();
  }, [kindsKey, layerRef]);

  // Tab по кругу внутри верхнего окна.
  useEffect(() => {
    if (top === null || top === "doc") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
      if (nativeOnTop()) return;
      const win = topWindow(layerRef.current);
      if (!win) return;
      const items = focusables(win);
      const a = document.activeElement;
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!(a instanceof HTMLElement) || !win.contains(a)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && a === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && a === first) {
        e.preventDefault();
        last.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [top, layerRef]);

  return remember;
}
