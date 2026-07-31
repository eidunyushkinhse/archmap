// Перетаскивание шаблона узла из боковой палитры на схему: превью-рамка с
// примагничиванием + создание узла на drop.
import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEvent } from "react";
import type { Node as RFNode } from "@xyflow/react";
import type { NodeShape } from "../../../types";
import { NODE_DRAG_MIME } from "../../NodeTreePanel";
import { NODE_W, NODE_H } from "../constants";
import { snapNode } from "./snap";
import type { Guides } from "./useAlignmentGuides";

// Раскрытая рамка (гостевая или локальная) как цель дропа: абсолютный rect + id
// контейнера (будущий parent_id) + depth (для выбора самой глубокой при вложенности).
export interface DropFrame {
  id: string;
  depth: number;
  rect: { x: number; y: number; w: number; h: number };
}

interface Params {
  rfNodes: RFNode[];
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
  setGuides: Dispatch<SetStateAction<Guides>>;
  clearGuides: () => void;
  isArchitect: boolean;
  disabled: boolean;
  // parentId — контейнер раскрытой рамки под курсором (узел станет его ребёнком) либо
  // null (текущий уровень). Позицию в текущий вид пишет вызывающий (см. TreePage).
  onDropNode?: (shape: NodeShape, pos: { x: number; y: number }, parentId: string | null) => void;
  dragShape?: NodeShape | null;
  // Раскрытые рамки текущего уровня (из layout.guestFrames) — цели дропа для хит-теста.
  expandedFrames: DropFrame[];
}

// Самая глубокая раскрытая рамка, чей rect накрывает точку (центр будущего узла). При
// вложенных рамках побеждает глубочайшая — узел попадёт в ближайший контейнер.
function frameAt(x: number, y: number, frames: DropFrame[]): DropFrame | null {
  let best: DropFrame | null = null;
  for (const f of frames) {
    const { x: fx, y: fy, w, h } = f.rect;
    if (x >= fx && x <= fx + w && y >= fy && y <= fy + h) {
      if (!best || f.depth > best.depth) best = f;
    }
  }
  return best;
}

export function useTemplateDrop({
  rfNodes, screenToFlowPosition, setGuides, clearGuides,
  isArchitect, disabled, onDropNode, dragShape, expandedFrames,
}: Params) {
  // Рамка-цель под курсором во время перетаскивания — для индикации («рамка раскрывается
  // шире под новый узел»). null — узел ляжет на текущий уровень.
  const [dropTargetFrame, setDropTargetFrame] = useState<DropFrame | null>(null);
  // Превью будущего узла при перетаскивании шаблона из палитры: форма + координаты
  // (левый-верхний угол) в системе графа. Рендерится в ViewportPortal, поэтому
  // автоматически масштабируется под текущий зум — рамка совпадает с реальным
  // размером узлов на схеме. null — превью не показываем.
  const [dropPreview, setDropPreview] = useState<{ shape: NodeShape; x: number; y: number } | null>(null);

  // Драг шаблона завершился (drop или отмена) — TreePage обнулил dragShape.
  // Убираем превью и направляющие.
  useEffect(() => {
    if (!dragShape) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс превью/цели по завершении драга — синхронизация с внешним событием; updater с noop-guard минимизирует рендеры
      setDropPreview((p) => (p === null ? p : null));
      setDropTargetFrame((f) => (f === null ? f : null));
      clearGuides();
    }
  }, [dragShape, clearGuides]);

  // Перетаскивание шаблона узла из боковой палитры на схему. dragOver с
  // preventDefault разрешает дроп; на drop читаем форму из dataTransfer, переводим
  // экранные координаты курсора в координаты графа и центрируем узел под курсором.
  const handleDragOver = useCallback((e: DragEvent) => {
    if (!isArchitect || disabled || !onDropNode) return;
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // Курсор = центр будущего узла. Притягиваем центр к соседям, рамку-превью
    // ставим на притянутую позицию, направляющие показываем как при обычном драге.
    if (!dragShape) return;
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const { snapCx, snapCy, hitX, hitY, spacing } = snapNode(flow.x, flow.y, NODE_W, NODE_H, rfNodes);
    setDropPreview({ shape: dragShape, x: snapCx - NODE_W / 2, y: snapCy - NODE_H / 2 });
    // Рамка-цель под центром будущего узла — для индикации (см. dropTargetFrame).
    const frame = frameAt(snapCx, snapCy, expandedFrames);
    setDropTargetFrame((prev) => (prev?.id === frame?.id ? prev : frame));
    const gx = hitX ? snapCx : null;
    const gy = hitY ? snapCy : null;
    setGuides((prev) =>
      prev.x === gx && prev.y === gy && prev.spacing.length === 0 && spacing.length === 0
        ? prev
        : { x: gx, y: gy, spacing },
    );
  }, [isArchitect, disabled, onDropNode, dragShape, rfNodes, screenToFlowPosition, setGuides, expandedFrames]);

  // Курсор ушёл с канваса (а не на его дочерний элемент) — убираем превью/направляющие,
  // чтобы рамка не «зависала» на краю.
  const handleDragLeave = useCallback((e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropPreview((p) => (p === null ? p : null));
    setDropTargetFrame((f) => (f === null ? f : null));
    clearGuides();
  }, [clearGuides]);

  const handleDrop = useCallback((e: DragEvent) => {
    if (!isArchitect || disabled || !onDropNode) return;
    const shape = e.dataTransfer.getData(NODE_DRAG_MIME);
    if (!shape) return;
    e.preventDefault();
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const s = shape as NodeShape;
    // Узел создаётся ровно там, где показывало превью (с тем же примагничиванием).
    const { snapCx, snapCy } = snapNode(flow.x, flow.y, NODE_W, NODE_H, rfNodes);
    // Раскрытая рамка под центром → узел станет ребёнком её контейнера; иначе текущий уровень.
    const frame = frameAt(snapCx, snapCy, expandedFrames);
    onDropNode(s, { x: snapCx - NODE_W / 2, y: snapCy - NODE_H / 2 }, frame?.id ?? null);
    setDropPreview(null);
    setDropTargetFrame(null);
    clearGuides();
  }, [isArchitect, disabled, onDropNode, rfNodes, screenToFlowPosition, clearGuides, expandedFrames]);

  return { dropPreview, dropTargetFrame, handleDragOver, handleDragLeave, handleDrop };
}
