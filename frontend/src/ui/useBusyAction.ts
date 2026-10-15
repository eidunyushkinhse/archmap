import { useState } from "react";

// Автомат окна с одним действием: «занято» на время запроса и текст отказа под полями.
// Одна реализация вместо копий в окнах проектов и пользователей (аудит F-21).
// Успех оставляет busy: окно закрывается (onDone зовётся внутри action) или сменяет
// вид, и кнопка не должна ожить на время закрытия — иначе второй щелчок повторит
// запрос. Отказ снимает busy и показывает текст ошибки — можно поправить и повторить.
export function useBusyAction(fallback: string): {
  busy: boolean;
  error: string | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : fallback);
      setBusy(false);
    }
  };
  return { busy, error, run };
}
