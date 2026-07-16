// Поллинг курсора изменений проекта (этап 1 конкурентности, docs/plan-concurrency.md).
// Раз в POLL_MS (и сразу при возврате фокуса окна) сверяем graph_rev лёгким
// GET /views/{id}/state; вырос относительно известного (viewMeta — echo-suppression:
// собственные записи уже обновили его из ответов PUT/load) → onRemoteChange
// (TreePage перечитывает уровень + тост). Рефетч не врывается в работу: тик
// пропускается посреди жеста драга и при открытой модалке (все модалки проекта —
// нативные <dialog>, ловятся одним селектором); пропущенный тик догонит следующий
// (максимум ~2×POLL_MS задержки). Фоновая вкладка (document.hidden) не поллит —
// возврат фокуса сверяет немедленно. Поллят обе роли (наблюдателю — живость).
import { useEffect, useRef } from "react";
import { viewsApi } from "../api/nodes";
import type { ViewMetaState } from "../components/LevelGraph";

export const POLL_MS = 10_000;

export type RemoteSyncTick = "skipped" | "quiet" | "refetch" | "error";

// Ядро одного тика — чистое (тестируется без таймеров/DOM): сходить за состоянием,
// сравнить курсор с известным, дёрнуть колбэк. inflight-замок не даёт тикам
// накладываться при медленной сети (второй тик просто пропускается).
export function createRemoteSyncTick(deps: {
  fetchState: () => Promise<{ graph_rev: number }>;
  knownRev: () => number;
  canRefetch: () => boolean;
  onRemoteChange: () => void;
}): () => Promise<RemoteSyncTick> {
  let inflight = false;
  return async () => {
    if (inflight || !deps.canRefetch()) return "skipped";
    inflight = true;
    try {
      const s = await deps.fetchState();
      if (s.graph_rev > deps.knownRev()) {
        deps.onRemoteChange();
        return "refetch";
      }
      return "quiet";
    } catch {
      return "error"; // сеть/архив — молча, следующий тик попробует снова
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
}): void {
  // Латест-колбэк: эффект перезапускается только сменой уровня, а колбэк
  // (замыкание на load текущего уровня + тост) обновляется каждый рендер.
  const onChangeRef = useRef(opts.onRemoteChange);
  useEffect(() => { onChangeRef.current = opts.onRemoteChange; });
  const { currentParentId, viewMeta, gestureActiveRef } = opts;
  useEffect(() => {
    let disposed = false;
    const tick = createRemoteSyncTick({
      fetchState: () => viewsApi.state(currentParentId),
      knownRev: () => viewMeta.current.graphRev,
      canRefetch: () =>
        !disposed &&
        !document.hidden &&
        !gestureActiveRef.current &&
        document.querySelector("dialog[open]") == null,
      onRemoteChange: () => { if (!disposed) onChangeRef.current(); },
    });
    const id = window.setInterval(() => { void tick(); }, POLL_MS);
    const onFocus = () => { void tick(); };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [currentParentId, viewMeta, gestureActiveRef]);
}
