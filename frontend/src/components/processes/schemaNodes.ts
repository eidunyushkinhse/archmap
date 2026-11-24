// Объекты схемы для участников процесса: один источник на «Добавить участника» и
// привязку участника на холсте (ParticipantPicker) и на выбор объекта участнику в окне
// импорта (NodeChoice).
//
// Правило, какие объекты годятся в участники, тоже одно: любой объект проекта
// (/nodes/all), кроме уже занятого другим участником того же процесса. Бэкенд держит
// один объект на процесс (uq_participant_node): второй участник с тем же объектом
// остался бы без объекта. Занятые пикер показывает выключенными («в процессе»), окно
// импорта их не предлагает.
import { useCallback, useEffect, useRef, useState } from "react";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

export interface SchemaNodes {
  // null — ещё не загружены (или загрузка не удалась).
  nodes: Node[] | null;
  error: string | null;
  // Загрузить, если ещё не загружены и не грузятся. После отказа следующий вызов
  // пробует снова.
  request: () => void;
}

/** Объекты схемы, загружаемые по требованию один раз на владельца хука. */
export function useSchemaNodes(): SchemaNodes {
  const [state, setState] = useState<{ nodes: Node[] | null; error: string | null }>({ nodes: null, error: null });
  const started = useRef(false);
  // Ответ после размонтирования никуда не пишется.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const request = useCallback(() => {
    if (started.current) return;
    started.current = true;
    nodesApi.getAll().then(
      (nodes) => { if (alive.current) setState({ nodes, error: null }); },
      (e: unknown) => {
        started.current = false;
        const why = e instanceof Error && e.message ? ` ${e.message}` : "";
        if (alive.current) setState({ nodes: null, error: `Не удалось загрузить объекты.${why}` });
      },
    );
  }, []);

  return { nodes: state.nodes, error: state.error, request };
}
