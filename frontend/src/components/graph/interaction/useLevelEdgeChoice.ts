// Выбор связи по её членам (инспекция связей с канваса). Колбэк кормит cbRef владельца
// (LevelGraphInner) и зовётся из двойного клика по линии/плашке:
//  - openEdgeMembers(id связей) → onEdgesChoice с найденными связями. Неизвестные id
//    фильтруются; ни одной найденной → onEdgesChoice НЕ зовётся.
// Прежний второй колбэк openTrunkMembers (модалка «общего плеча», E80) снят 2026-10-11
// вместе со стволами: у каждой связи своя линия, и клик по линии адресует один пучок.
//  - Отображаемые концы стрелки холст разрешает как концы НОВОЙ связи (ends.connect) той же
//    классификацией, что протягивание и быстрая связь: по ним кнопка «+ Добавить связь»
//    окна выбора ведёт к показанной паре, а не к настоящим концам первой связи пучка
//    (edge.md E97, 2026-11-02). Решает, что открыть, хозяин (MapEditorPage).
//
// Вынесено из LevelGraph.tsx (Фаза 3б): колбэк чисто изолирован — зависит только от
// edges, классификации узлов холста и одного пропса.
import { useCallback } from "react";
import type { Edge as AppEdge } from "../../../types";
import type { EdgeChoiceEnds, NewEdgeEnd } from "../types";
import type { ConnectTarget } from "./useEdgeConnect";

interface UseLevelEdgeChoiceArgs {
  edges: AppEdge[];
  onEdgesChoice: (edges: AppEdge[], ends?: EdgeChoiceEnds) => void;
  // классификация узла холста как цели новой связи и его имя (useConnectTargets — общие
  // с протягиванием и быстрой связью; строит владелец по rfNodes) и имя контейнера,
  // показанного рамкой
  resolveTarget: (id: string) => ConnectTarget;
  displayNameOf: (id: string) => string | undefined;
  containerFrameName: (id: string) => string | undefined;
}

export interface LevelEdgeChoice {
  openEdgeMembers: (memberIds: string[], ends?: EdgeChoiceEnds) => void;
}

export function useLevelEdgeChoice({
  edges, onEdgesChoice, resolveTarget, displayNameOf, containerFrameName,
}: UseLevelEdgeChoiceArgs): LevelEdgeChoice {
  // Отображаемый конец как конец новой связи: лист — напрямую, объект с вложенными —
  // «зона входа». Рамка контейнера (раскрытого или уровня) — тоже зона входа: стрелка в
  // неё — связь в сам контейнер, и прямую связь в контейнер кнопка не создаёт (решение
  // владельца 2026-11-02). Распорка, площадка и неизвестный конец (общий участок, null) —
  // не цель.
  const newEdgeEnd = useCallback(
    (id: string | null): NewEdgeEnd | null => {
      if (!id) return null;
      const t = resolveTarget(id);
      if (!t) {
        const frameName = containerFrameName(id);
        return frameName === undefined ? null : { kind: "into", id, name: frameName };
      }
      return t.kind === "into" ? { kind: "into", id, name: t.name } : { kind: "direct", id, name: displayNameOf(id) };
    },
    [resolveTarget, displayNameOf, containerFrameName],
  );

  // Открыть список связей по их членам — всегда через «Выберите связь», даже для
  // одиночной связи: так в модалке доступна кнопка «Добавить связь» (дозапись новой
  // связи к показанной паре концов, E97). Общая точка для двойного клика по линии и по
  // плашке с описанием.
  const openEdgeMembers = useCallback(
    (memberIds: string[], ends?: EdgeChoiceEnds) => {
      const members = memberIds
        .map((mid) => edges.find((e) => e.id === mid))
        .filter((e): e is AppEdge => e != null);
      if (members.length === 0) return;
      onEdgesChoice(members, ends && {
        ...ends,
        connect: { source: newEdgeEnd(ends.source), target: newEdgeEnd(ends.target) },
      });
    },
    [edges, onEdgesChoice, newEdgeEnd],
  );

  return { openEdgeMembers };
}
