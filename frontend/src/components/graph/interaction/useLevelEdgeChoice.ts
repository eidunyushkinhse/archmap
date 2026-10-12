// Выбор связи по её членам (инспекция связей с канваса). Колбэк кормит cbRef владельца
// (LevelGraphInner) и зовётся из двойного клика по линии/плашке:
//  - openEdgeMembers(id связей) → onEdgesChoice с найденными связями. Неизвестные id
//    фильтруются; ни одной найденной → onEdgesChoice НЕ зовётся.
// Прежний второй колбэк openTrunkMembers (модалка «общего плеча», E80) снят 2026-10-11
// вместе со стволами: у каждой связи своя линия, и клик по линии адресует один пучок.
//
// Вынесено из LevelGraph.tsx (Фаза 3б): колбэк чисто изолирован — зависит только от
// edges и одного пропса.
import { useCallback } from "react";
import type { Edge as AppEdge } from "../../../types";

interface UseLevelEdgeChoiceArgs {
  edges: AppEdge[];
  onEdgesChoice: (edges: AppEdge[]) => void;
}

export interface LevelEdgeChoice {
  openEdgeMembers: (memberIds: string[]) => void;
}

export function useLevelEdgeChoice({ edges, onEdgesChoice }: UseLevelEdgeChoiceArgs): LevelEdgeChoice {
  // Открыть список связей по их членам — всегда через «Выберите связь», даже для
  // одиночной связи: так в модалке доступна кнопка «Добавить связь» (дозапись новой
  // связи того же направления). Общая точка для двойного клика по линии и по
  // плашке с описанием.
  const openEdgeMembers = useCallback(
    (memberIds: string[]) => {
      const members = memberIds
        .map((mid) => edges.find((e) => e.id === mid))
        .filter((e): e is AppEdge => e != null);
      if (members.length === 0) return;
      onEdgesChoice(members);
    },
    [edges, onEdgesChoice],
  );

  return { openEdgeMembers };
}
