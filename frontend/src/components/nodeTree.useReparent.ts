import { useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Node } from "../types";
import { canHaveChildren } from "../types";
import { NODE_MOVE_MIME } from "./nodeTree.mime";

// Служебный ключ цели «корень проекта» (строки у корня нет — только полоса).
const ROOT_TARGET = "__root__";

export interface TreeReparent {
  // Переносимый узел (для подсветки строки и показа полосы «в корень»).
  moving: Node | null;
  // Цель под курсором — id строки, если подсвечена строка.
  dropTargetId: string | null;
  // Подсвечена ли полоса «в корень проекта».
  rootActive: boolean;
  canDropInto: (node: Node, targetId: string | null) => boolean;
  onRowDragStart: (e: DragEvent, node: Node) => void;
  onRowDragEnd: () => void;
  onRowDragOver: (e: DragEvent, target: Node) => void;
  onRowDragLeave: (target: Node) => void;
  onRowDrop: (e: DragEvent, target: Node) => void;
  onRootDragOver: (e: DragEvent) => void;
  onRootDragLeave: () => void;
  onRootDrop: (e: DragEvent) => void;
}

// Окажется ли ребёнок цели частью контейнера: элемент считает сервер, здесь только
// чтение его ответа (element_effective) и намерения листа (element).
function joinsContainer(target: Node): boolean {
  if (target.element_effective === "component") return true;
  return target.element_effective === "container" && (target.has_children || target.element === "container");
}

// Перенос узла на другой уровень перетаскиванием строки дерева (аудит F-7): драг
// начинается с ручки-шести-точек, дроп — на строке-цели или полосе «в корень проекта».
export function useTreeReparent(
  allById: Map<string, Node>,
  pathTo: (node: Node) => Node[],
  onReparent: ((node: Node, newParentId: string | null) => void) | undefined,
): TreeReparent {
  // Ref — истина на момент события, стейт — для подсветки; зажигаем его отложенно
  // по той же причине, что и корзину палитры.
  const movingRef = useRef<Node | null>(null);
  const [moving, setMoving] = useState<Node | null>(null);
  // Цель под курсором: id строки, ROOT_TARGET (полоса «в корень») либо null.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  function onRowDragStart(e: DragEvent, node: Node) {
    e.dataTransfer.setData(NODE_MOVE_MIME, node.id);
    e.dataTransfer.effectAllowed = "move";
    movingRef.current = node;
    // Подсветку зажигаем СЛЕДУЮЩИМ кадром: перерисовка источника прямо в dragstart
    // отменяет нативный драг (та же причина, что у корзины палитры).
    requestAnimationFrame(() => { if (movingRef.current) setMoving(movingRef.current); });
  }
  function onRowDragEnd() {
    movingRef.current = null;
    setMoving(null);
    setDropTarget(null);
  }

  // Куда переносить МОЖНО. Зеркало серверных запретов (app/reparent.py): отказ должен
  // быть виден ДО дропа (цель просто не подсвечивается и не принимает), а не приходить
  // ошибкой после. targetId === null — корень проекта.
  function canDropInto(node: Node, targetId: string | null): boolean {
    // Человек по C4 живёт ЗА границей системы — ему доступен только вынос в корень.
    if (node.shape === "person") return targetId === null && node.parent_id !== null;
    if (targetId === null) return node.parent_id !== null;
    if (targetId === node.id || targetId === node.parent_id) return false;
    const target = allById.get(targetId);
    if (!target || !canHaveChildren(target.shape)) return false;
    // База и брокер не входят в состав контейнера (Р6 эпика элементов): цель —
    // контейнер с компонентами, лист с намерением «контейнер» или компонент. Лист без
    // элемента — можно: окно первого вложенного объекта сделает его системой. Поддерево
    // с базой внутри здесь не обходим — его отказывает сервер, текст приходит тостом.
    if ((node.shape === "database" || node.shape === "broker") && joinsContainer(target)) return false;
    // Собственный потомок (цикл): путь до цели строится по ЗАГРУЖЕННЫМ предкам, и
    // этого достаточно — чтобы строка была видна, все её предки раскрыты.
    return !pathTo(target).some((n) => n.id === node.id);
  }

  function onRowDragOver(e: DragEvent, target: Node) {
    const m = movingRef.current;
    if (!m || !e.dataTransfer.types.includes(NODE_MOVE_MIME)) return;
    if (!canDropInto(m, target.id)) return; // дроп не разрешаем — курсор останется «запретным»
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== target.id) setDropTarget(target.id);
  }
  function onRowDragLeave(target: Node) {
    setDropTarget((prev) => (prev === target.id ? null : prev));
  }
  function onRowDrop(e: DragEvent, target: Node) {
    e.preventDefault();
    const m = movingRef.current;
    setDropTarget(null);
    if (m && canDropInto(m, target.id)) onReparent?.(m, target.id);
  }

  function onRootDragOver(e: DragEvent) {
    const m = movingRef.current;
    if (!m || !e.dataTransfer.types.includes(NODE_MOVE_MIME) || !canDropInto(m, null)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== ROOT_TARGET) setDropTarget(ROOT_TARGET);
  }
  function onRootDragLeave() {
    setDropTarget((prev) => (prev === ROOT_TARGET ? null : prev));
  }
  function onRootDrop(e: DragEvent) {
    e.preventDefault();
    const m = movingRef.current;
    setDropTarget(null);
    if (m && canDropInto(m, null)) onReparent?.(m, null);
  }

  return {
    moving,
    dropTargetId: dropTarget === ROOT_TARGET ? null : dropTarget,
    rootActive: dropTarget === ROOT_TARGET,
    canDropInto,
    onRowDragStart, onRowDragEnd, onRowDragOver, onRowDragLeave, onRowDrop,
    onRootDragOver, onRootDragLeave, onRootDrop,
  };
}
