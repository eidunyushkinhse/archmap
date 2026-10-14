import { useCallback, useEffect, useRef, useState } from "react";

// Разовая загрузка по ключу (аудит R-2, R-23): страница объекта, мета проекта, превью.
// Раньше каждая писала своё «setLoading(true) → await → finally setLoading(false)» без
// catch: отказ (404, 403, сеть) оставлял вечную «Загрузку…». Здесь:
// • отказ — состояние error, его показывает хозяин (ui/LoadError) с «Повторить»;
// • ответ по устаревшему ключу (быстро сменили объект) не применяется;
// • синхронного setState в эффекте нет: «идёт загрузка» выводится в рендере из того,
//   что последний результат — не для текущего ключа и попытки.
export interface AsyncLoad<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  // Повторить загрузку (кнопка «Повторить» или перечитать после правки).
  reload: () => void;
  // Поправить загруженные данные на месте (догрузили часть — например, связи узла).
  update: (fn: (data: T) => T) => void;
}

type Result<T> = { key: string; attempt: number } & ({ ok: true; data: T } | { ok: false; error: unknown });

export function useAsyncLoad<T>(key: string, load: () => Promise<T>): AsyncLoad<T> {
  // Свежий загрузчик без перезапуска эффекта: эффект зависит только от ключа и попытки.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result<T> | null>(null);

  useEffect(() => {
    let alive = true;
    loadRef.current().then(
      (data) => { if (alive) setResult({ key, attempt, ok: true, data }); },
      (error: unknown) => { if (alive) setResult({ key, attempt, ok: false, error }); },
    );
    return () => { alive = false; };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  const update = useCallback((fn: (data: T) => T) => {
    setResult((r) => (r && r.ok ? { ...r, data: fn(r.data) } : r));
  }, []);

  const fresh = result !== null && result.key === key && result.attempt === attempt ? result : null;
  return {
    data: fresh?.ok ? fresh.data : null,
    error: fresh && !fresh.ok ? fresh.error : null,
    loading: fresh === null,
    reload,
    update,
  };
}
