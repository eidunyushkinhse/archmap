import { useEffect, type RefObject } from "react";

// Закрыть всплывающее — меню, поповер, панель — по нажатию мыши вне ref и по Escape,
// пока оно открыто. Одна реализация вместо шести копий (аудит F-19). setOpen — сеттер
// состояния: он стабилен, подписка не пересобирается на каждый рендер.
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, setOpen]);
}
