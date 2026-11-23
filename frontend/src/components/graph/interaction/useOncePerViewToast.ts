// Разовый тост холста «один на вход в вид» (perf.md P8, P13): перегруженная сцена и
// ступени бюджета работ. Честное предупреждение показывается один раз на вид
// (containerId), а не на каждый пересчёт; закрытие — крестиком. Механика у разовых
// тостов одна и та же, раньше она была расписана у каждого отдельно (аудит F-1).
import { useCallback, useRef, useState } from "react";

export function useOncePerViewToast(): {
  open: boolean;
  // Показать, если в этом виде ещё не показывали. Стабилен — безопасен в deps конвейера.
  show: (viewKey: string) => void;
  close: () => void;
} {
  const [open, setOpen] = useState(false);
  const shownRef = useRef(new Set<string>());
  const show = useCallback((viewKey: string) => {
    if (shownRef.current.has(viewKey)) return;
    shownRef.current.add(viewKey);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { open, show, close };
}
