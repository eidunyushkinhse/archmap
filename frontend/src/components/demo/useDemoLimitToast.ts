// Состояние тоста предела демо-стенда (DemoLimitToast): показ на несколько секунд,
// повторный показ продлевает. Таймер чистится при размонтировании.
import { useCallback, useEffect, useRef, useState } from "react";
import { limitMessage } from "./demoLimits";
import type { LimitAction, LimitMessage } from "./demoLimits";

const HOLD_MS = 6000;

/** Состояние тоста предела: show(e, action) показывает его, если это отказ по
 *  пределу, и возвращает true; иную ошибку оставляет вызывающему (false). */
export function useDemoLimitToast(): [LimitMessage | null, (e: unknown, action: LimitAction) => boolean] {
  const [message, setMessage] = useState<LimitMessage | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const show = useCallback((e: unknown, action: LimitAction): boolean => {
    const next = limitMessage(e, action);
    if (!next) return false;
    setMessage(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), HOLD_MS);
    return true;
  }, []);
  return [message, show];
}
