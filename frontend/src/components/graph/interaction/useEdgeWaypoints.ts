// Персист кастомного пути стрелки (waypoints) + синхронизация стейта уровня.
import { useCallback } from "react";
import { edgesApi } from "../../../api/nodes";
import type { EdgePoint } from "../../../types";

interface Params {
  isArchitect: boolean;
  // путь сохранён — родитель зеркалирует waypoints в стейт уровня теми же значениями,
  // что вернул бы рефетч, чтобы пересчёт раскладки без рефетча не сбросил изломы.
  onEdgeWaypointsChanged?: (edgeId: string, waypoints: EdgePoint[]) => void;
}

export function useEdgeWaypoints({ isArchitect, onEdgeWaypointsChanged }: Params) {
  // зафиксировать новый путь ребра по отпусканию драга: PATCH в БД + зеркало наверх.
  // Пустой массив waypoints = сброс ребра в авто-маршрут.
  const commitWaypoints = useCallback(
    (edgeId: string, waypoints: EdgePoint[]) => {
      if (!isArchitect) return;
      void edgesApi.update(edgeId, { waypoints });
      onEdgeWaypointsChanged?.(edgeId, waypoints);
    },
    [isArchitect, onEdgeWaypointsChanged],
  );
  return { commitWaypoints };
}
