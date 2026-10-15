import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { processesApi } from "../../api/processes";
import type { ProcessDetail, ProcessMessage, ProcessParticipant, ProcessFragment } from "../../types";

// Процесс холста (аудит F-2): чтение по порядку, оптимистичная правка, каркас мутации
// и поиски по процессу. Холст рисует и командует — загрузку держит этот хук.
export interface ProcessDetailState {
  detail: ProcessDetail | null;
  error: string | null;
  // Перечитать после своей правки и сообщить воркспейсу «мы изменили» (список рейла).
  reload: () => void;
  // Показать правку до ответа API: она «новее» любого чтения в полёте.
  setOptimistic: (d: ProcessDetail) => void;
  runMutation: (work: () => Promise<void>, failText: string) => Promise<void>;
  // Шаги в порядке сценария и поиск шага/фрагмента/участника по id (аудит F-63).
  sortedMessages: ProcessMessage[];
  msgById: Map<string, ProcessMessage>;
  fragById: Map<string, ProcessFragment>;
  partById: Record<string, ProcessParticipant>;
  // Узел участника; у непривязанного — null.
  nodeOfPart: (pid: string) => string | null;
  // Порядковый номер следующего шага.
  nextOrder: number;
}

export function useProcessDetail(id: string, onChanged: () => void, syncRev: number | undefined): ProcessDetailState {
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Номер последнего чтения процесса (аудит F-49): применяется только ответ последнего
  // начатого — поздний ответ раннего чтения не перетирает свежее. Оптимистичная правка
  // (порядок, подпись, рамка, ветви) — тоже «новее» любого чтения в полёте: её ставит
  // setOptimistic, и ответ, выпущенный до неё, не вернёт на экран прежний порядок.
  const loadSeqRef = useRef(0);
  const fetchDetail = useCallback((after?: () => void) => {
    const seq = ++loadSeqRef.current;
    processesApi
      .get(id)
      .then((d) => {
        if (seq === loadSeqRef.current) setDetail(d);
        after?.();
      })
      .catch((e: unknown) => {
        if (seq === loadSeqRef.current) setError(e instanceof Error ? e.message : "Не удалось загрузить процесс");
      });
  }, [id]);
  const setOptimistic = useCallback((d: ProcessDetail) => {
    loadSeqRef.current++;
    setDetail(d);
  }, []);

  const reload = useCallback(() => fetchDetail(onChanged), [fetchDetail, onChanged]);

  // Чужая правка (Д9): поллинг воркспейса заметил рост process_rev — перечитываем
  // процесс. Без onChanged: список рейла воркспейс уже перечитал сам, а сигналить
  // «мы изменили» о чужой правке незачем. Значение счётчика на маунте чужой правкой не
  // считается: процесс прочитает первичная загрузка (иначе ремаунт читал его дважды).
  const seenSyncRev = useRef(syncRev);
  useEffect(() => {
    if (syncRev === seenSyncRev.current) return;
    seenSyncRev.current = syncRev;
    fetchDetail();
  }, [syncRev, fetchDetail]);

  // Первичная загрузка. Смену процесса воркспейс делает через key-remount (свежее
  // состояние оверлеев/истории), поэтому id за время жизни компонента не меняется —
  // [id] здесь эквивалентно «только маунт». setDetail — только в ответе чтения;
  // начальный fetch без onChanged (изменений ещё нет).
  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // Каркас мутации процесса (аудит F-18): работа — запрос и команда истории, затем
  // процесс перечитывается. Отказ тоже перечитывает: оптимистичный порядок, рамка или
  // подпись возвращаются к истине (БД не изменилась), а частично применённая серия
  // (несколько участников подряд) — к тому, что реально записано. Успех снимает прежнюю
  // ошибку — раньше её текст висел до ухода со страницы (F-36).
  async function runMutation(work: () => Promise<void>, failText: string): Promise<void> {
    try {
      await work();
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : failText);
    }
    reload();
  }

  const sortedMessages = useMemo(
    () => (detail ? [...detail.messages].sort((a, b) => a.order - b.order) : []),
    [detail],
  );
  const msgById = useMemo(() => new Map((detail?.messages ?? []).map((m) => [m.id, m])), [detail]);
  const fragById = useMemo(() => new Map((detail?.fragments ?? []).map((f) => [f.id, f])), [detail]);
  // Участник по id и его узел: сообщения ссылаются на УЧАСТНИКОВ.
  const partById = useMemo(() => {
    const m: Record<string, ProcessParticipant> = {};
    if (detail) for (const p of detail.participants) m[p.id] = p;
    return m;
  }, [detail]);
  const nodeOfPart = useCallback((pid: string) => partById[pid]?.node_id ?? null, [partById]);
  const nextOrder = useMemo(
    () => (detail ? detail.messages.reduce((mx, m) => Math.max(mx, m.order), -1) + 1 : 0),
    [detail],
  );

  return {
    detail, error, reload, setOptimistic, runMutation,
    sortedMessages, msgById, fragById, partById, nodeOfPart, nextOrder,
  };
}
