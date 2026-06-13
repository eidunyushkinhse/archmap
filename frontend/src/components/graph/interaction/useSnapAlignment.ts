// Магнитное выравнивание узлов по центру при драге + персист позиции по отпусканию.
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import type { Node as RFNode, NodeChange } from "@xyflow/react";
import { nodesApi } from "../../../api/nodes";
import { snapNode, nodeSize } from "./snap";
import type { SpacingGuide } from "./distribute";
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

  // Персист позиций ВСЕХ перетянутых узлов. При мультивыделении RF тащит группу, но
  // раньше сохранялся только узел-«ручка» — после ближайшего пересчёта раскладки
  // соседи откатывались на старые сохранённые координаты. Поэтому сохраняем каждый.
  // Снап применяем только к одиночному узлу: групповой снап считал бы притяжку
  // каждого к своим соседям и исказил бы взаимные интервалы перемещаемой группы.
  const persistGroup = useCallback(
    (group: RFNode[]) => {
      if (isContext) return; // контекст read-only — перетаскивания не сохраняем
      if (!isArchitect) return;
      const single = group.length === 1;
      // нативные рамки считаем один раз на группу — нужны только при наличии гостей
      const frames =
        group.some((n) => n.type === "ghost" || n.type === "container") ? levelFrames() : [];
      for (const n of group) {
        const { w: dw, h: dh } = nodeSize(n);
        let px = n.position.x;
        let py = n.position.y;
        if (single) {
          // ВАЖНО: n.position здесь — «сырая» позиция драга React Flow. Наши снап-правки
          // из onNodesChange меняют ОТРИСОВАННЫЙ стейт (rfNodes), но внутренний трекер
          // драга RF их не видит — координата без притяжки. Пересчитываем тот же снап,
          // чтобы СОХРАНИТЬ ровно то, что показывала направляющая.
          const { snapCx, snapCy } = snapNode(px + dw / 2, py + dh / 2, dw, dh, rfNodes, n.id);
          px = snapCx - dw / 2;
          py = snapCy - dh / 2;
        }
        if (n.type === "block") {
          // Локальный узел — координаты в самом узле
          const pos = { pos_x: px, pos_y: py };
          nodesApi.update(n.id, pos);
          onNodeMoved?.(n.id, "block", pos);
        } else if ((n.type === "ghost" || n.type === "container") && containerId) {
          // Гость (лист) или свёрнутый предок-контейнер — координаты привязаны к уровню.
          // Строгий запрет проникновения в чужую родную рамку держит живой clamp в
          // handleNodesChange; здесь повторяем его для СОХРАНЯЕМОЙ позиции.
          const clamped = clampOutOfNativeFrames(n.id, { x: px, y: py }, frames);
          const gpos = { pos_x: clamped.x, pos_y: clamped.y };
          if (clamped.x !== px || clamped.y !== py) {
            onNodesChange([{ id: n.id, type: "position", position: { x: clamped.x, y: clamped.y } }]);
          }
          nodesApi.saveGhostPosition(containerId, n.id, gpos);
          onNodeMoved?.(n.id, n.type, gpos);
        }
      }
    },
    [isArchitect, containerId, isContext, onNodeMoved, onNodesChange, levelFrames, rfNodes],
  );

  // Отпускание драга одиночного узла (или узла-«ручки» мультивыделения). RF отдаёт
  // все перетянутые узлы третьим аргументом — сохраняем их все.
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, rfNode: RFNode, draggedNodes: RFNode[]) => {
      setGuides({ x: null, y: null, spacing: [] }); // прячем направляющие
      persistGroup(draggedNodes.length > 0 ? draggedNodes : [rfNode]);
    },
    [setGuides, persistGroup],
  );

  // Отпускание драга рамки выделения (NodesSelection) — RF тащит всю группу через
  // отдельный обработчик. Сохраняем те же узлы.
  const handleSelectionDragStop = useCallback(
    (_event: MouseEvent, draggedNodes: RFNode[]) => {
      setGuides({ x: null, y: null, spacing: [] });
      persistGroup(draggedNodes);
    },
    [setGuides, persistGroup],
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
      let guideSpacing: SpacingGuide[] = [];
      // нативные рамки считаем лениво — только если тащат гостя/контейнер
      let frames: FrameRect[] | null = null;
      // Мультидраг (тянут несколько выделенных узлов сразу): магнитный снап и
      // направляющие отключаем — групповой снап притянул бы каждый узел к своим
      // соседям и исказил бы взаимные интервалы группы. Гостей всё равно держим вне
      // чужих рамок. Считаем по числу одновременных position-изменений драга.
      const multiDrag =
        changes.filter((c) => c.type === "position" && c.dragging).length > 1;
      const snapped = changes.map((change) => {
        if (change.type !== "position" || !change.position) return change;
        const dragged = rfNodes.find((n) => n.id === change.id);
        const { w: dw, h: dh } = nodeSize(dragged);
        let x = change.position.x, y = change.position.y;
        const isExternal = dragged && (dragged.type === "ghost" || dragged.type === "container");
        if (multiDrag) {
          // Без снапа; гостям/контейнерам только запрет проникновения в чужие рамки.
          if (isExternal) {
            frames ??= levelFrames();
            const c = clampOutOfNativeFrames(change.id, { x, y }, frames);
            x = c.x; y = c.y;
          }
          return { ...change, position: { x, y } };
        }
        // Центр узла в текущей (перетаскиваемой) позиции
        const cx = x + dw / 2;
        const cy = y + dh / 2;
        const { snapCx, snapCy, hitX, hitY, spacing } = snapNode(cx, cy, dw, dh, rfNodes, change.id);
        // Координата угла после притяжки (позиция узла = левый-верхний угол)
        const baseX = snapCx - dw / 2, baseY = snapCy - dh / 2;
        x = baseX; y = baseY;
        // Строгий запрет проникновения: гостя/контейнер НЕ пускаем внутрь чужой родной
        // рамки прямо во время драга — он скользит вдоль её края (clamp к ближайшей грани).
        if (isExternal) {
          frames ??= levelFrames();
          const c = clampOutOfNativeFrames(change.id, { x, y }, frames);
          x = c.x; y = c.y;
        }
        // Направляющие — только при активном драге и только по оси, которую clamp не двигал
        // (иначе линия показывала бы притяжку там, где узел уже оттолкнут рамкой).
        if (change.dragging) {
          if (hitX && x === baseX) guideX = snapCx;
          if (hitY && y === baseY) guideY = snapCy;
          // Индикаторы зазоров — по оси ряда (x→ось X, y→ось Y), тоже только если
          // clamp не сдвинул узел по этой оси.
          guideSpacing = spacing.filter((g) => (g.axis === "x" ? x === baseX : y === baseY));
        }
        return { ...change, position: { x, y } };
      });
      setGuides((prev) => {
        // Пустые spacing-массивы считаем равными, чтобы не плодить ререндеры в
        // обычном случае (ничего не примагнитилось по зазорам).
        const sameSpacing =
          prev.spacing === guideSpacing ||
          (prev.spacing.length === 0 && guideSpacing.length === 0);
        return prev.x === guideX && prev.y === guideY && sameSpacing
          ? prev
          : { x: guideX, y: guideY, spacing: guideSpacing };
      });
      onNodesChange(snapped);
    },
    [rfNodes, onNodesChange, setGuides, levelFrames],
  );

  return { handleNodesChange, handleNodeDragStop, handleSelectionDragStop };
}
