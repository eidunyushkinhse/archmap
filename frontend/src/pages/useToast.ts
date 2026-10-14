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

// Тот же транзиентный тост, но с текстом (сообщение об отказе): show(text) показывает
// его на holdMs, повторный show заменяет текст и продлевает показ.
export function useMessageToast(holdMs = 6000): [string | null, (text: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const show = useCallback((text: string) => {
    setMessage(text);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), holdMs);
  }, [holdMs]);
  return [message, show];
}
