// Персист кастомного пути стрелки (waypoints). R3: путь живёт на ключе ПУЧКА
// ("b:<src>><tgt>" в view_layout вида) — один для всех членов мастер-стрелки и
// уникальный для проекции (пары отображаемых концов). Прежние два слоя хранения
// (колонка ребра / пер-уровневая таблица) слиты в один.
import { useCallback } from "react";
import type { EdgePoint, ViewLayoutPayload } from "../../../types";

interface Params {
  isArchitect: boolean;
  // единая запись раскладки вида: патч payload пучка (персист+зеркало — LevelGraph)
  commitLayout: (items: Record<string, Partial<ViewLayoutPayload> | null>) => void;
}

export function useEdgeWaypoints({ isArchitect, commitLayout }: Params) {
  // Зафиксировать путь по отпусканию драга. bundleId — ключ пучка стрелки
  // ("b:<src>><tgt>"). Пустой массив = сброс в авто (поле убирается из payload).
  // Ручной коммит всегда абсолютный (anchor снимается) — якорь приобретает
  // раскладка при первом показе (интент own-bundle-waypoints).
  const commitWaypoints = useCallback(
    (bundleId: string, waypoints: EdgePoint[]) => {
      if (!isArchitect) return;
      commitLayout({
        [bundleId]: {
          waypoints: waypoints.length > 0 ? waypoints : null,
          anchor: null,
        },
      });
    },
    [isArchitect, commitLayout],
  );
  return { commitWaypoints };
}
