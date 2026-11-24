// Курсоры изменений проекта, которые увидел опрос (находка 6, 2026-11-24): рекомендации
// оболочки проекта и строка «Документацию пора обновить» читались при открытии проекта и
// после своих правок, а чужая правка и сигнал CI доезжали только после перезагрузки.
// Своего таймера здесь нет: страницы проекта уже опрашивают GET /views/{id}/state раз в
// POLL_MS (useRemoteSync, процессы), а pollViewState отдаёт курсоры из этих ответов
// слушателям. В покое запросов не прибавляется; рекомендации перечитываются, только когда
// курсор сдвинулся.
import { useEffect, useEffectEvent } from "react";
import { viewsApi } from "../api/nodes";
import type { ViewState } from "../types";

type Cursors = Pick<ViewState, "graph_rev" | "meta_rev" | "process_rev">;

const listeners = new Set<(c: Cursors) => void>();

/** GET /views/{id}/state для опроса: тот же запрос, курсоры ответа — слушателям. */
export async function pollViewState(viewId: string | null): Promise<ViewState> {
  const s = await viewsApi.state(viewId);
  for (const listener of listeners) listener(s);
  return s;
}

/** onMove — когда опрос увидел, что курсоры проекта сдвинулись с прошлого замера (схема,
 * мета или процессы). Первый замер только запоминается. Оболочка живёт с ключом проекта,
 * поэтому замеры другого проекта сюда не попадают. */
export function useProjectCursorMove(onMove: () => void): void {
  const move = useEffectEvent(onMove);
  useEffect(() => {
    let seen: Cursors | null = null;
    const listener = (c: Cursors) => {
      const moved = seen !== null
        && (c.graph_rev !== seen.graph_rev || c.meta_rev !== seen.meta_rev || c.process_rev !== seen.process_rev);
      seen = { graph_rev: c.graph_rev, meta_rev: c.meta_rev, process_rev: c.process_rev };
      if (moved) move();
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
}
