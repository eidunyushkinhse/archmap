// Хост персиста раскладки схемы: ресинк при отказе записи и переигровка патча после
// 409. Общий для редактора-карты (MapEditorPage), схемы на странице объекта (NodePage,
// SchemaSection) и корня проекта (ProjectHomePage) — был написан трижды, и каждая копия
// прикрывала нестабильные колбэки eslint-disable (аудит F-10, F-6).
//
// • resync — перечитать уровень из БД (курсоры и раскладка к истине). Замок — один
//   запрос в полёте на серию отказов: батчи, упавшие разом, не множат перечитывания.
// • onConflict — 409 (вид изменён другой сессией): ресинк и одноразовая переигровка
//   исходного патча от свежего зеркала через retryPatch холста (token — одноразовость).
// • dropRetry — снять отложенную переигровку: при переходе на другой уровень у нового
//   холста счётчик токенов с нуля, и чужой патч переигрался бы на нём.
//
// Колбэки СТАБИЛЬНЫ: reload хозяина берётся из последнего рендера (latest-ref), поэтому
// бандл persistence больше не пересобирается на каждый рендер страницы.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ViewLayoutPayload } from "../types";

type LayoutPatch = Record<string, Partial<ViewLayoutPayload> | null>;

export function usePersistenceHost(reload: () => Promise<unknown>): {
  resync: () => Promise<void>;
  onConflict: (patch: LayoutPatch) => void;
  retryPatch: { patch: LayoutPatch; token: number } | null;
  dropRetry: () => void;
} {
  const reloadRef = useRef(reload);
  useLayoutEffect(() => {
    reloadRef.current = reload;
  });

  const resyncingRef = useRef<Promise<void> | null>(null);
  const resync = useCallback((): Promise<void> => {
    if (resyncingRef.current) return resyncingRef.current;
    const p = reloadRef.current()
      .then(() => undefined)
      .finally(() => { resyncingRef.current = null; });
    resyncingRef.current = p;
    return p;
  }, []);

  const retrySeq = useRef(0);
  const [retryPatch, setRetryPatch] = useState<{ patch: LayoutPatch; token: number } | null>(null);
  const onConflict = useCallback((patch: LayoutPatch) => {
    void resync().then(() => {
      setRetryPatch({ patch, token: ++retrySeq.current });
    });
  }, [resync]);
  const dropRetry = useCallback(() => setRetryPatch(null), []);

  return { resync, onConflict, retryPatch, dropRetry };
}
