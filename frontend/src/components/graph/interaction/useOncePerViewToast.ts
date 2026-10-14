// Разовый тост холста «один на вход в вид» (perf.md P8, P13, P15): перегруженная сцена,
// ступени бюджета работ, совет о грязи стрелок. Честное предупреждение показывается
// один раз на вид (containerId), а не на каждый пересчёт; закрытие — крестиком.
// Механика у трёх тостов была одна и та же, расписанная трижды (аудит F-1).
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
