// Режим дерева объектов (NodeTreePanel) и правила строки, общие для строки дерева
// (nodeTree.Row) и строки результата поиска: подсказка по режиму и право на иконку
// «Указать размещение». Отдельным модулем: файлы компонентов экспортируют только
// компоненты (react-refresh).
import type { Node } from "../types";
import { canHaveChildren } from "../types";

// Страницы объектов, редактор-карта или «Развёртывание».
export type TreeMode = "pages" | "editor" | "deploy";

// Подсказка строки: страница объекта; в редакторе контейнер — его слой, в
// «Развёртывании» — его уровень; лист — показать на схеме.
export function treeRowTitle(mode: TreeMode, node: Node): string {
  if (mode === "pages") return `Страница: ${node.name}`;
  if (canHaveChildren(node.shape) && node.has_children) {
    return mode === "deploy" ? `Открыть уровень: ${node.name}` : `Открыть слой: ${node.name}`;
  }
  return `Показать на схеме: ${node.name}`;
}

// Положена ли строке иконка размещения: только архитектору (колбэк задан) и не
// «Пользователю» — он живёт вне системы, размещения у него нет.
export function placeable(
  node: Node, isArchitect: boolean, onPlace?: (node: Node) => void,
): onPlace is (node: Node) => void {
  return isArchitect && !!onPlace && node.shape !== "person";
}
