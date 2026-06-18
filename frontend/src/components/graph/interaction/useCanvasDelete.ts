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
  onRequestDeleteNodes?: (nodes: AppNode[]) => void;
}

export function useCanvasDelete({
  rfNodes, isArchitect, isContext, onRequestDeleteNode, onRequestDeleteNodes,
}: Params) {
  // По Backspace/Delete находим выбранные локальные узлы и просим открыть
  // подтверждение удаления. Один узел → та же модалка со списком связей, что и
  // кнопка «Удалить»; несколько → агрегированное подтверждение (мультиудаление).
  // Встроенное удаление React Flow отключено (deleteKeyCode=null), иначе Backspace
  // сносил бы узлы и их связи прямо с канваса — без предупреждения и в обход модалки.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      if (isContext || !isArchitect) return;
      // не перехватываем удаление, когда правят текст в поле
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      // удаляем только локальные узлы (block); гости/контейнеры — проекции с других
      // уровней, их с канваса не сносим. Узлы уровня — сиблинги (общий родитель),
      // вложенности между ними нет, поэтому пачку можно сносить параллельно.
      const selected = rfNodes.filter((n) => n.type === "block" && n.selected);
      if (selected.length === 0) return;
      const appNodes = selected.map((n) => (n.data as BlockData).appNode);
      if (appNodes.length === 1) {
        if (!onRequestDeleteNode) return;
        e.preventDefault();
        onRequestDeleteNode(appNodes[0]);
        return;
      }
      if (!onRequestDeleteNodes) return;
      e.preventDefault();
      onRequestDeleteNodes(appNodes);
    },
    [rfNodes, isArchitect, isContext, onRequestDeleteNode, onRequestDeleteNodes],
  );

  return { handleKeyDown };
}
