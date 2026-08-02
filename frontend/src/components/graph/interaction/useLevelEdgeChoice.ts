// Выбор связи по её членам (инспекция связей с канваса). Два колбэка кормят cbRef
// владельца (LevelGraphInner) и зовутся из двойного клика по линии/плашке/общему плечу:
//  - openEdgeMembers(id связей) → onEdgesChoice с найденными связями. Неизвестные id
//    фильтруются; ни одной найденной → onEdgesChoice НЕ зовётся.
//  - openTrunkMembers(kind, id) → onTrunkChoice(kind, связи) для ОБЩЕГО ПЛЕЧА (E80);
//    вырожденный ствол (<2 связей) или отсутствие onTrunkChoice → false (вызывающий
//    уходит в обычную детализацию).
//
// Вынесено из LevelGraph.tsx (Фаза 3б): колбэки чисто изолированы — зависят только от
// edges и двух пропсов. Возвращает оба колбэка для сборки cbRef владельцем.
import { useCallback } from "react";
import type { Edge as AppEdge } from "../../../types";

interface UseLevelEdgeChoiceArgs {
  edges: AppEdge[];
  onEdgesChoice: (edges: AppEdge[]) => void;
  onTrunkChoice?: (kind: "out" | "in", edges: AppEdge[]) => void;
}

export interface LevelEdgeChoice {
  openEdgeMembers: (memberIds: string[]) => void;
  openTrunkMembers: (kind: "out" | "in", memberIds: string[]) => boolean;
}

export function useLevelEdgeChoice({
  edges,
  onEdgesChoice,
  onTrunkChoice,
}: UseLevelEdgeChoiceArgs): LevelEdgeChoice {
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
  // Выбор связи ОБЩЕГО ПЛЕЧА (E80): члены отрисованных участников ствола флаттенятся
  // до связей БД. Меньше двух связей (вырожденный ствол) — false, вызывающий уходит
  // в обычную детализацию.
  const openTrunkMembers = useCallback(
    (kind: "out" | "in", memberIds: string[]): boolean => {
      const members = memberIds
        .map((mid) => edges.find((e) => e.id === mid))
        .filter((e): e is AppEdge => e != null);
      if (members.length < 2 || !onTrunkChoice) return false;
      onTrunkChoice(kind, members);
      return true;
    },
    [edges, onTrunkChoice],
  );

  return { openEdgeMembers, openTrunkMembers };
}
