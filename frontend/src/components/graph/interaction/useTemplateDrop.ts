// Перетаскивание шаблона узла из боковой палитры на схему: превью-рамка с
// примагничиванием + создание узла на drop.
import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEvent } from "react";
import type { Node as RFNode } from "@xyflow/react";
import type { NodeShape } from "../../../types";
import { NODE_DRAG_MIME } from "../../NodeTreePanel";
import { NODE_W, shapeHeight } from "../constants";
import { snapCenter } from "./snap";
import type { Guides } from "./useAlignmentGuides";

interface Params {
  rfNodes: RFNode[];
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
  setGuides: Dispatch<SetStateAction<Guides>>;
  clearGuides: () => void;
  isArchitect: boolean;
  isContext: boolean;
  onDropNode?: (shape: NodeShape, pos: { x: number; y: number }) => void;
  dragShape?: NodeShape | null;
}

export function useTemplateDrop({
  rfNodes, screenToFlowPosition, setGuides, clearGuides,
  isArchitect, isContext, onDropNode, dragShape,
}: Params) {
  // Превью будущего узла при перетаскивании шаблона из палитры: форма + координаты
  // (левый-верхний угол) в системе графа. Рендерится в ViewportPortal, поэтому
  // автоматически масштабируется под текущий зум — рамка совпадает с реальным
  // размером узлов на схеме. null — превью не показываем.
  const [dropPreview, setDropPreview] = useState<{ shape: NodeShape; x: number; y: number } | null>(null);

  // Драг шаблона завершился (drop или отмена) — TreePage обнулил dragShape.
  // Убираем превью и направляющие.
  useEffect(() => {
    if (!dragShape) {
      setDropPreview((p) => (p === null ? p : null));
      clearGuides();
    }
  }, [dragShape, clearGuides]);

  // Перетаскивание шаблона узла из боковой палитры на схему. dragOver с
  // preventDefault разрешает дроп; на drop читаем форму из dataTransfer, переводим
  // экранные координаты курсора в координаты графа и центрируем узел под курсором.
  const handleDragOver = useCallback((e: DragEvent) => {
    if (!isArchitect || isContext || !onDropNode) return;
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // Курсор = центр будущего узла. Притягиваем центр к соседям, рамку-превью
    // ставим на притянутую позицию, направляющие показываем как при обычном драге.
    if (!dragShape) return;
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const dh = shapeHeight(dragShape);
    const { snapCx, snapCy, hitX, hitY } = snapCenter(flow.x, flow.y, rfNodes);
    setDropPreview({ shape: dragShape, x: snapCx - NODE_W / 2, y: snapCy - dh / 2 });
    const gx = hitX ? snapCx : null;
    const gy = hitY ? snapCy : null;
    setGuides((prev) => (prev.x === gx && prev.y === gy ? prev : { x: gx, y: gy }));
  }, [isArchitect, isContext, onDropNode, dragShape, rfNodes, screenToFlowPosition, setGuides]);

  // Курсор ушёл с канваса (а не на его дочерний элемент) — убираем превью/направляющие,
  // чтобы рамка не «зависала» на краю.
  const handleDragLeave = useCallback((e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropPreview((p) => (p === null ? p : null));
    clearGuides();
  }, [clearGuides]);

  const handleDrop = useCallback((e: DragEvent) => {
    if (!isArchitect || isContext || !onDropNode) return;
    const shape = e.dataTransfer.getData(NODE_DRAG_MIME);
    if (!shape) return;
    e.preventDefault();
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const s = shape as NodeShape;
    // Узел создаётся ровно там, где показывало превью (с тем же примагничиванием).
    const { snapCx, snapCy } = snapCenter(flow.x, flow.y, rfNodes);
    onDropNode(s, { x: snapCx - NODE_W / 2, y: snapCy - shapeHeight(s) / 2 });
    setDropPreview(null);
    clearGuides();
  }, [isArchitect, isContext, onDropNode, rfNodes, screenToFlowPosition, clearGuides]);

  return { dropPreview, handleDragOver, handleDragLeave, handleDrop };
}
