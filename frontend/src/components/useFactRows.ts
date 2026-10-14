// Общая машинерия секций фактов на странице объекта: структура БД (DbStructureSection),
// каналы брокера (BrokerChannelsSection), конфигурация сервиса (ConfigParamsSection).
// Загрузка записей с обратным индексом, «применить и перечитать» и свободное имя были в
// секциях дословными копиями (аудит F-13, фаза 7); разметка строк у каждой своя.
import { useCallback, useEffect, useState } from "react";
import { limitMessage } from "./demo/demoLimits";
import type { LimitMessage } from "./demo/demoLimits";

// Ручки семьи: записи объекта и обратный индекс — кто на них ссылается из схем логики.
interface FactApi<T, U> {
  list: (nodeId: string) => Promise<T[]>;
  usage: (nodeId: string) => Promise<U[]>;
}

interface FactRows<T, U> {
  // null — список ещё не приехал (секция показывает «Загрузка…»).
  rows: T[] | null;
  usage: U[];
  error: string | null;
  // Отказ демо-стенда по пределу проекта — своей плашкой (docs/tasks/demo-mode.md).
  limit: LimitMessage | null;
  // Любая правка: применить на сервере и перечитать.
  apply: (fn: () => Promise<unknown>) => Promise<void>;
  // Перечитать без правки (дозаливка от агента применена).
  reload: () => void;
}

export function useFactRows<T, U>(
  nodeId: string,
  api: FactApi<T, U>,
  // «Не удалось загрузить структуру» — слово своей семьи.
  loadError: string,
): FactRows<T, U> {
  const [rows, setRows] = useState<T[] | null>(null);
  const [usage, setUsage] = useState<U[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<LimitMessage | null>(null);

  // Перезагрузка — через счётчик, а не вызовом загрузчика из эффекта: setState прямо
  // в теле эффекта даёт каскад рендеров (тот же приём, что в useContainerChildren).
  // Прежний список стоит, пока не приехал новый: «Загрузка…» после каждой правки
  // мигала бы всей секцией.
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let alive = true;
    api.list(nodeId)
      .then((xs) => { if (alive) { setRows(xs); setError(null); } })
      .catch(() => { if (alive) setError(loadError); });
    api.usage(nodeId)
      .then((u) => { if (alive) setUsage(u); })
      .catch(() => { if (alive) setUsage([]); });
    return () => { alive = false; };
  }, [api, nodeId, loadError, seq]);

  // Перечитывание после правки — не лень, а необходимость: CAS-версии и порядок
  // вложенных строк приходят с сервера, и локальная склейка разъезжалась бы с ними на
  // первой же ошибке.
  const apply = useCallback(async (fn: () => Promise<unknown>) => {
    setLimit(null);
    try {
      await fn();
      setError(null);
    } catch (e) {
      const refusal = limitMessage(e, "save");
      if (refusal) setLimit(refusal);
      else setError(e instanceof Error && e.message ? e.message : "Правка не прошла");
    }
    setSeq((n) => n + 1);
  }, []);

  const reload = useCallback(() => setSeq((n) => n + 1), []);

  return { rows, usage, error, limit, apply, reload };
}

// Множество раскрытых (или свёрнутых) ключей с переключателем.
export function useToggleSet(): [Set<string>, (key: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  return [set, toggle];
}

// Свободное имя вида «канал», «канал_2», … — чтобы «+ Канал» не упиралась в 409
// уникальности при повторном нажатии.
export function freeName(base: string, names: string[]): string {
  const taken = new Set(names);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
