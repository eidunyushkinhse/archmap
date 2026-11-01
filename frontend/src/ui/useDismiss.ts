import { useEffect, type RefObject } from "react";

// Закрыть всплывающее — меню, поповер, панель — по нажатию мыши вне ref и по Escape,
// пока оно открыто. Одна реализация вместо шести копий (аудит F-19). setOpen — сеттер
// состояния: он стабилен, подписка не пересобирается на каждый рендер.
// inside — ещё одна область «внутри»: панель, вынесенная порталом из-под якоря
// (SchemaLegend), в DOM не лежит внутри ref, но нажатие в ней не закрывает её.
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  setOpen: (open: boolean) => void,
  inside?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inside?.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, setOpen, inside]);
}
