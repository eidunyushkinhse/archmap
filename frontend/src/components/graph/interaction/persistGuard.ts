// Обёртка для «оптимистичных» / компенсирующих записей в API. Контракт правок канваса:
// изменение СРАЗУ зеркалится в локальный стейт (визуально мгновенно), а PATCH летит
// фоном (fire-and-forget). То же у Undo/Redo — их undo/redo это компенсирующий вызов.
// Если фоновый запрос падает (сеть/409), БД остаётся в прежнем состоянии, а зеркало
// показывает новое — они молча расходятся. guardPersist ловит отказ и зовёт onError:
// его задача — вернуть зеркало к истине (перезагрузить уровень из БД). Логируем всегда.
// NB: записи РАСКЛАДКИ идут своим путём (persistFenced в LevelGraph) — у них поверх
// ресинка есть политика 409 (см. planPersistFailure ниже).
export function guardPersist(
  p: Promise<unknown>,
  onError?: (e: unknown) => void,
): void {
  p.catch((e) => {
    console.error("Запись на сервер не прошла — ресинхронизирую уровень из БД", e);
    onError?.(e);
  });
}

// Происхождение батча раскладки (этап 0 конкурентности, docs/plan-concurrency.md):
// "user" — прямой интент пользователя (драг/клавиатура/undo перемещений/раскрытие);
// "derived" — производный интент конвейера (сиды own-on-first-render, keep-out).
export type CommitOrigin = "user" | "derived";

// Чистая политика обработки отказа фенсированной записи раскладки:
// 409 у user-интента → ресинк уровня и ОДНА переигровка исходного патча поверх
// свежего мира («этот узел сюда» валидно независимо от чужих правок); всё
// остальное (409 у derived — конвейер пересчитает сам; любые прочие ошибки;
// повторный отказ ретрая) → только ресинк.
export type PersistFailurePlan = "retry-after-resync" | "resync-only";
export function planPersistFailure(
  conflict: boolean,
  origin: CommitOrigin,
  isRetry: boolean,
): PersistFailurePlan {
  return conflict && origin === "user" && !isRetry ? "retry-after-resync" : "resync-only";
}
