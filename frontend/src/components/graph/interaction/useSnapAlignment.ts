// Магнитное выравнивание узлов по центру при драге + персист позиции по отпусканию.
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import type { Node as RFNode, NodeChange } from "@xyflow/react";
import { nodesApi } from "../../../api/nodes";
import { snapCenter, nodeSize } from "./snap";
import { computeFrames, type FrameRect } from "../layout/frames";
import { clampOutOfNativeFrames } from "../layout/keepGhostsOut";
import type { GhostData, ContainerData } from "../types";
import type { AncestorRef } from "../../../types";
import type { Guides } from "./useAlignmentGuides";

interface Params {
  rfNodes: RFNode[];
  onNodesChange: (changes: NodeChange<RFNode>[]) => void;
  setGuides: Dispatch<SetStateAction<Guides>>;
  isArchitect: boolean;
  isContext: boolean;
  containerId: string | null;
  // breadcrumb-предки уровня — нужны для запрета задвинуть гостя в чужую родную рамку
  ancestorIds: string[];
  ancestorNames: string[];
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
  rfNodes, onNodesChange, setGuides, isArchitect, isContext, containerId,
  ancestorIds, ancestorNames, onNodeMoved,
}: Params) {
  // Нативные рамки уровня по текущим узлам — общий вход запрета проникновения гостей
  // (живой clamp при драге и clamp при отпускании). Запретная рамка гостя не включает
  // его членом, поэтому от его собственной позиции не зависит.
  const levelFrames = useCallback((): FrameRect[] => {
    const blocks = rfNodes.filter((n) => n.type === "block");
    const externals = rfNodes.filter((n) => n.type === "ghost" || n.type === "container");
    const extAncestors = (n: RFNode): AncestorRef[] =>
      n.type === "ghost"
        ? (n.data as GhostData).appNode.ancestors ?? []
        : ((n.data as ContainerData).ancestors ?? []);
    const posById = new Map(rfNodes.map((n) => [n.id, n.position]));
    return computeFrames({
      localIds: blocks.map((b) => b.id),
      externals: externals.map((n) => ({ id: n.id, ancestors: extAncestors(n) })),
      pos: (id) => posById.get(id),
      ancestorIds, ancestorNames,
    });
  }, [rfNodes, ancestorIds, ancestorNames]);

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
        // уровню (containerId + id отображаемой сущности = rfNode.id). Строгий запрет
        // проникновения в чужую родную рамку обеспечивает живой clamp в handleNodesChange;
        // здесь повторяем его для СОХРАНЯЕМОЙ позиции (rfNode.position — сырая RF-координата
        // без наших правок), чтобы персистнуть валидную точку.
        const clamped = clampOutOfNativeFrames(rfNode.id, { x: pos.pos_x, y: pos.pos_y }, levelFrames());
        const gpos = { pos_x: clamped.x, pos_y: clamped.y };
        if (clamped.x !== pos.pos_x || clamped.y !== pos.pos_y) {
          onNodesChange([{ id: rfNode.id, type: "position", position: { x: clamped.x, y: clamped.y } }]);
        }
        nodesApi.saveGhostPosition(containerId, rfNode.id, gpos);
        onNodeMoved?.(rfNode.id, rfNode.type, gpos);
      }
    },
    [isArchitect, containerId, isContext, setGuides, onNodeMoved, onNodesChange, levelFrames, rfNodes],
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
      // нативные рамки считаем лениво — только если тащат гостя/контейнер
      let frames: FrameRect[] | null = null;
      const snapped = changes.map((change) => {
        if (change.type !== "position" || !change.position) return change;
        const dragged = rfNodes.find((n) => n.id === change.id);
        const { w: dw, h: dh } = nodeSize(dragged);
        // Центр узла в текущей (перетаскиваемой) позиции
        const cx = change.position.x + dw / 2;
        const cy = change.position.y + dh / 2;
        const { snapCx, snapCy, hitX, hitY } = snapCenter(cx, cy, rfNodes, change.id);
        // Координата угла после притяжки (позиция узла = левый-верхний угол)
        const baseX = snapCx - dw / 2, baseY = snapCy - dh / 2;
        let x = baseX, y = baseY;
        // Строгий запрет проникновения: гостя/контейнер НЕ пускаем внутрь чужой родной
        // рамки прямо во время драга — он скользит вдоль её края (clamp к ближайшей грани).
        if (dragged && (dragged.type === "ghost" || dragged.type === "container")) {
          frames ??= levelFrames();
          const c = clampOutOfNativeFrames(change.id, { x, y }, frames);
          x = c.x; y = c.y;
        }
        // Направляющие — только при активном драге и только по оси, которую clamp не двигал
        // (иначе линия показывала бы притяжку там, где узел уже оттолкнут рамкой).
        if (change.dragging) {
          if (hitX && x === baseX) guideX = snapCx;
          if (hitY && y === baseY) guideY = snapCy;
        }
        return { ...change, position: { x, y } };
      });
      setGuides((prev) =>
        prev.x === guideX && prev.y === guideY ? prev : { x: guideX, y: guideY },
      );
      onNodesChange(snapped);
    },
    [rfNodes, onNodesChange, setGuides, levelFrames],
  );

  return { handleNodesChange, handleNodeDragStop };
}
