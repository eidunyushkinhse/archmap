// Магнитное выравнивание узлов по центру при драге + персист позиции по отпусканию.
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import type { Node as RFNode, NodeChange } from "@xyflow/react";
import { nodesApi } from "../../../api/nodes";
import { snapCenter, nodeSize } from "./snap";
import type { Guides } from "./useAlignmentGuides";

interface Params {
  rfNodes: RFNode[];
  onNodesChange: (changes: NodeChange<RFNode>[]) => void;
  setGuides: Dispatch<SetStateAction<Guides>>;
  isArchitect: boolean;
  isContext: boolean;
  containerId: string | null;
  // узел перетащили и позиция сохранена — родитель синхронизирует стейт уровня теми
  // же значениями, что вернул бы рефетч. Без этого пересчёт раскладки БЕЗ рефетча
  // (напр. локальный setEdges при реконнекте хэндла) откатывал бы узел на старую
  // сохранённую позицию. kind: block → координаты в самом узле (nodes[].pos_x/y);
  // ghost/container → координаты уровня (levelPositions[id]).
  onNodeMoved?: (
    id: string,
    kind: "block" | "ghost" | "container",
    pos: { pos_x: number; pos_y: number },
  ) => void;
}

export function useSnapAlignment({
  rfNodes, onNodesChange, setGuides, isArchitect, isContext, containerId, onNodeMoved,
}: Params) {
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, rfNode: RFNode) => {
      setGuides({ x: null, y: null }); // прячем направляющие
      // В контекст-режиме раскладка эфемерная — перетаскивания не сохраняем
      if (isContext) return;
      if (!isArchitect) return;
      // ВАЖНО: rfNode.position здесь — «сырая» позиция драга React Flow. Наши снап-
      // правки из onNodesChange меняют ОТРИСОВАННЫЙ стейт (rfNodes), но внутренний
      // трекер драга RF их не видит — поэтому пришедшая сюда координата без притяжки
      // (в пределах порога от соседа, но не ровно на нём). Пересчитываем тот же снап,
      // чтобы СОХРАНИТЬ ровно то, что показывала направляющая, иначе схема чуть
      // разъезжается и стрелки остаются кривыми, хотя визуально выровнялись.
      const { w: dw, h: dh } = nodeSize(rfNode);
      const { snapCx, snapCy } = snapCenter(
        rfNode.position.x + dw / 2, rfNode.position.y + dh / 2, rfNodes, rfNode.id,
      );
      const pos = { pos_x: snapCx - dw / 2, pos_y: snapCy - dh / 2 };
      if (rfNode.type === "block") {
        // Локальный узел — координаты в самом узле
        nodesApi.update(rfNode.id, pos);
        onNodeMoved?.(rfNode.id, "block", pos);
      } else if ((rfNode.type === "ghost" || rfNode.type === "container") && containerId) {
        // Гость (лист) или свёрнутый предок-контейнер — координаты привязаны к
        // уровню (containerId + id отображаемой сущности = rfNode.id)
        nodesApi.saveGhostPosition(containerId, rfNode.id, pos);
        onNodeMoved?.(rfNode.id, rfNode.type, pos);
      }
    },
    [isArchitect, containerId, isContext, setGuides, onNodeMoved, rfNodes],
  );

  // Магнитное выравнивание по центру при драге: перехватываем position-изменения
  // и, если центр перетаскиваемого узла оказался ближе SNAP_THRESHOLD к центру
  // соседа по X или Y, сдвигаем координату так, чтобы центры совпали. По осям
  // независимо — X может «прилипнуть» к одному соседу, Y к другому. Снапим и
  // финальное изменение (отпускание), чтобы узел остался ровно на магнитной
  // координате. Пока идёт драг — публикуем координаты центральных направляющих.
  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode>[]) => {
      let guideX: number | null = null;
      let guideY: number | null = null;
      const snapped = changes.map((change) => {
        if (change.type !== "position" || !change.position) return change;
        const dragged = rfNodes.find((n) => n.id === change.id);
        const { w: dw, h: dh } = nodeSize(dragged);
        // Центр узла в текущей (перетаскиваемой) позиции
        const cx = change.position.x + dw / 2;
        const cy = change.position.y + dh / 2;
        const { snapCx, snapCy, hitX, hitY } = snapCenter(cx, cy, rfNodes, change.id);
        // Направляющие показываем только во время активного драга
        if (change.dragging) {
          if (hitX) guideX = snapCx;
          if (hitY) guideY = snapCy;
        }
        // Обратно из центра в координату угла (позиция узла = левый-верхний угол)
        return { ...change, position: { x: snapCx - dw / 2, y: snapCy - dh / 2 } };
      });
      setGuides((prev) =>
        prev.x === guideX && prev.y === guideY ? prev : { x: guideX, y: guideY },
      );
      onNodesChange(snapped);
    },
    [rfNodes, onNodesChange, setGuides],
  );

  return { handleNodesChange, handleNodeDragStop };
}
