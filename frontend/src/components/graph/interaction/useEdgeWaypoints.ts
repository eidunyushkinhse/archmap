// Персист кастомного пути стрелки (waypoints) + синхронизация стейта уровня.
// Два слоя хранения (как у хэндлов): локальная стрелка (оба конца на этом уровне) —
// колонка самого ребра (глобально, единственный домашний уровень); гостевая/сквозная
// стрелка — пер-уровневый слой (container_id, edge_id), т.к. её геометрия уникальна
// для уровня. Какой слой — решает вызывающий по флагу ghost.
import { useCallback } from "react";
import { edgesApi, nodesApi } from "../../../api/nodes";
import { guardPersist } from "./persistGuard";
import type { EdgePoint } from "../../../types";

interface Params {
  isArchitect: boolean;
  containerId: string | null;
  // локальная стрелка сохранена в колонку — зеркало в стейт уровня (как вернул бы рефетч)
  onEdgeWaypointsChanged?: (edgeId: string, waypoints: EdgePoint[]) => void;
  // гостевая стрелка сохранена в пер-уровневый слой — зеркало в стейт уровня.
  // anchorNodeId помечает излом, владеемый узлом по идентичности (офсет от него, Ф3); ручной
  // коммит всегда абсолютный (null) — якорь приобретает раскладка при первом показе.
  onLevelEdgeWaypointsChanged?: (edgeId: string, waypoints: EdgePoint[], anchorNodeId?: string | null) => void;
  // фоновый персист пути упал — вернуть зеркало к истине (ресинк уровня из БД)
  onPersistError?: (e: unknown) => void;
}

export function useEdgeWaypoints({
  isArchitect, containerId, onEdgeWaypointsChanged, onLevelEdgeWaypointsChanged, onPersistError,
}: Params) {
  // зафиксировать путь по отпусканию драга. edgeIds — все члены стрелки (у одиночной
  // один, у мастер-стрелки несколько): путь общий, поэтому «размазываем» его по всем.
  // ghost=false → колонка ребра; ghost=true → пер-уровневый слой уровня containerId.
  // Пустой массив = сброс в авто.
  const commitWaypoints = useCallback(
    (edgeIds: string[], waypoints: EdgePoint[], ghost: boolean) => {
      if (!isArchitect) return;
      if (ghost) {
        if (!containerId) return; // гости только на не-корневых уровнях
        for (const edgeId of edgeIds) {
          guardPersist(nodesApi.saveEdgeWaypoints(containerId, edgeId, waypoints), onPersistError);
          onLevelEdgeWaypointsChanged?.(edgeId, waypoints);
        }
      } else {
        for (const edgeId of edgeIds) {
          guardPersist(edgesApi.update(edgeId, { waypoints }), onPersistError);
          onEdgeWaypointsChanged?.(edgeId, waypoints);
        }
      }
    },
    [isArchitect, containerId, onEdgeWaypointsChanged, onLevelEdgeWaypointsChanged, onPersistError],
  );
  return { commitWaypoints };
}
