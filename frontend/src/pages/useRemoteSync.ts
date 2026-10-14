// Поллинг курсора изменений проекта (этап 1 конкурентности, docs/archive/plan-concurrency.md).
// Раз в POLL_MS (и сразу при возврате фокуса окна) сверяем graph_rev лёгким
// GET /views/{id}/state; вырос относительно известного (viewMeta — echo-suppression:
// собственные записи уже обновили его из ответов PUT/load) → onRemoteChange
// (хозяин перечитывает уровень + тост). Рефетч не врывается в работу: тик
// пропускается посреди жеста драга и при открытой модалке (все модалки проекта —
// нативные <dialog>, ловятся одним селектором); пропущенный тик догонит следующий
// (максимум ~2×POLL_MS задержки). Фоновая вкладка (document.hidden) не поллит —
// возврат фокуса сверяет немедленно. Поллят обе роли (наблюдателю — живость).
import { useEffect, useRef } from "react";
import { viewsApi } from "../api/nodes";
import type { ViewMetaState } from "../components/graph/types";
import { isConnectionError, setOffline } from "../lib/connection";

export const POLL_MS = 10_000;
// Откат при отказах связи (аудит R-24): интервал удваивается до POLL_MS × MAX_BACKOFF
// (80 с) — лежащий сервер не долбят тиками раз в 10 с из каждой вкладки.
export const MAX_BACKOFF = 8;
// Столько отказов связи подряд — и горит плашка «нет связи» (один сбой — не повод).
export const OFFLINE_AFTER = 2;

// "offline" — не достучались (сеть, 5xx); "error" — прочий отказ (архив, права).
export type RemoteSyncTick = "skipped" | "quiet" | "refetch" | "error" | "offline";

// Ядро одного тика — чистое (тестируется без таймеров/DOM): сходить за состоянием,
// сравнить курсоры с известными, дёрнуть колбэки. Два курсора: graph_rev — схема
// (узлы/рёбра/раскладка) → onRemoteChange; meta_rev — мета узла (атрибуты/доки/
// спеки) → onMetaChange (поллинг страницы объекта: тост «данные изменены»).
// inflight-замок не даёт тикам накладываться при медленной сети (второй тик
// просто пропускается).
export function createRemoteSyncTick(deps: {
  fetchState: () => Promise<{ graph_rev: number; meta_rev: number }>;
  knownRev: () => number;
  // undefined = курсор меты ещё не инициализирован (до первой загрузки) — тик
  // меты пропускается (эхо-подавление: свои записи обновляют курсор из ответов).
  knownMeta?: () => number | undefined;
  canRefetch: () => boolean;
  onRemoteChange: () => void;
  onMetaChange?: (metaRev: number) => void;
}): () => Promise<RemoteSyncTick> {
  let inflight = false;
  return async () => {
    if (inflight || !deps.canRefetch()) return "skipped";
    inflight = true;
    try {
      const s = await deps.fetchState();
      let tick: RemoteSyncTick = "quiet";
      if (s.graph_rev > deps.knownRev()) {
        deps.onRemoteChange();
        tick = "refetch";
      }
      const km = deps.knownMeta?.();
      if (deps.onMetaChange && km !== undefined && s.meta_rev > km) {
        deps.onMetaChange(s.meta_rev);
        tick = "refetch";
      }
      return tick;
    } catch (e) {
      // Следующий тик попробует снова; отказ связи хозяин считает для отката и плашки.
      return isConnectionError(e) ? "offline" : "error";
    } finally {
      inflight = false;
    }
  };
}

export function useRemoteSync(opts: {
  currentParentId: string | null;
  viewMeta: { current: ViewMetaState };
  gestureActiveRef: { current: boolean };
  onRemoteChange: () => void;
  // Рост meta_rev относительно известного (viewMeta.metaRev) — мета узла
  // изменилась (другая сессия правит атрибуты/доки/спеки).
  onMetaChange?: (metaRev: number) => void;
}): void {
  // Латест-колбэк: эффект перезапускается только сменой уровня, а колбэк
  // (замыкание на load текущего уровня + тост) обновляется каждый рендер.
  const onChangeRef = useRef(opts.onRemoteChange);
  useEffect(() => { onChangeRef.current = opts.onRemoteChange; });
  const onMetaRef = useRef(opts.onMetaChange);
  useEffect(() => { onMetaRef.current = opts.onMetaChange; });
  const { currentParentId, viewMeta, gestureActiveRef } = opts;
  useEffect(() => {
    let disposed = false;
    const tick = createRemoteSyncTick({
      fetchState: () => viewsApi.state(currentParentId),
      knownRev: () => viewMeta.current.graphRev,
      knownMeta: () => viewMeta.current.metaRev,
      canRefetch: () =>
        !disposed &&
        !document.hidden &&
        !gestureActiveRef.current &&
        document.querySelector("dialog[open]") == null,
      onRemoteChange: () => { if (!disposed) onChangeRef.current(); },
      onMetaChange: (rev) => { if (!disposed) onMetaRef.current?.(rev); },
    });
    // Цепочка таймеров вместо setInterval: задержка следующего тика зависит от исхода
    // предыдущего (откат при отказах связи).
    let failures = 0;
    let timer = 0;
    const note = (result: RemoteSyncTick) => {
      if (result === "skipped") return;
      if (result === "offline") {
        failures += 1;
        if (failures >= OFFLINE_AFTER) setOffline(true);
      } else {
        failures = 0;
        setOffline(false);
      }
    };
    const loop = async () => {
      note(await tick());
      if (disposed) return;
      timer = window.setTimeout(() => { void loop(); }, POLL_MS * Math.min(2 ** failures, MAX_BACKOFF));
    };
    timer = window.setTimeout(() => { void loop(); }, POLL_MS);
    const onFocus = () => { void tick().then((r) => { if (!disposed) note(r); }); };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [currentParentId, viewMeta, gestureActiveRef]);
}
