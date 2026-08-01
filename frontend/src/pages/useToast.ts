import { useCallback, useEffect, useRef, useState } from "react";

// Транзиентный тост: show() показывает его на holdMs, затем авто-скрытие.
// Повторный show() сбрасывает таймер (удерживает видимым). Таймер чистится при
// размонтировании. Общий паттерн тостов «Схема/Данные обновлены в другой сессии».
export function useToast(holdMs = 4000): [boolean, () => void] {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const show = useCallback(() => {
    setVisible(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), holdMs);
  }, [holdMs]);
  return [visible, show];
}
