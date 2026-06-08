// Удаление узла с клавиатуры через подтверждение (встроенное удаление RF отключено).
import { useCallback } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Node as RFNode } from "@xyflow/react";
import type { Node as AppNode } from "../../../types";
import type { BlockData } from "../types";

interface Params {
  rfNodes: RFNode[];
  isArchitect: boolean;
  isContext: boolean;
  onRequestDeleteNode?: (node: AppNode) => void;
}

export function useCanvasDelete({
  rfNodes, isArchitect, isContext, onRequestDeleteNode,
}: Params) {
  // По Backspace/Delete находим единственный выбранный локальный узел и просим
  // открыть то же подтверждение со списком связей, что и кнопка «Удалить».
  // Встроенное удаление React Flow отключено (deleteKeyCode=null), иначе Backspace
  // сносил бы узел и его связи прямо с канваса — без предупреждения и в обход модалки.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      if (isContext || !isArchitect || !onRequestDeleteNode) return;
      // не перехватываем удаление, когда правят текст в поле
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      // действуем только при ровно одном выбранном узле; мульти/ноль — игнор,
      // чтобы случайно не снести пачку
      const selected = rfNodes.filter((n) => n.type === "block" && n.selected);
      if (selected.length !== 1) return;
      e.preventDefault();
      onRequestDeleteNode((selected[0].data as BlockData).appNode);
    },
    [rfNodes, isArchitect, isContext, onRequestDeleteNode],
  );

  return { handleKeyDown };
}
