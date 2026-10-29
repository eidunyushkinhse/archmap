// Режим дерева объектов (NodeTreePanel) и правила строки, общие для строки дерева
// (nodeTree.Row) и строки результата поиска: подсказка по режиму и право на иконку
// «Указать размещение». Отдельным модулем: файлы компонентов экспортируют только
// компоненты (react-refresh).
import type { Node } from "../types";
import { nodeNesting } from "../types";

// Страницы объектов, редактор-карта или «Развёртывание».
export type TreeMode = "pages" | "editor" | "deploy";

// Подсказка строки: страница объекта; в редакторе узел с детьми — его слой, лист —
// показать на схеме. В «Развёртывании» уровень есть только у системы (D24: у
// контейнера он закрыт), остальные — показать на схеме.
export function treeRowTitle(mode: TreeMode, node: Node): string {
  if (mode === "pages") return `Страница: ${node.name}`;
  if (mode === "deploy") {
    return node.element_effective === "system" ? `Открыть уровень: ${node.name}` : `Показать на схеме: ${node.name}`;
  }
  if (nodeNesting(node) === "group") return `Открыть слой: ${node.name}`;
  return `Показать на схеме: ${node.name}`;
}

// Положена ли строке иконка размещения: только архитектору (колбэк задан), не
// «Пользователю» — он живёт вне системы — и не компоненту: площадки задаются его
// контейнеру (D29, D33).
export function placeable(
  node: Node, isArchitect: boolean, onPlace?: (node: Node) => void,
): onPlace is (node: Node) => void {
  return isArchitect && !!onPlace && node.shape !== "person" && node.element_effective !== "component";
}
