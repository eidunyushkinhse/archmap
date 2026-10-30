import { useRef, useState } from "react";
import type { DragEvent } from "react";
import type { NodeType } from "./nodeTerms";
import { NODE_DRAG_MIME } from "./nodeTree.mime";

// Драг шаблона из палитры «Добавить объект» (аудит F-7): тип объекта уходит под своим
// MIME, схема рисует превью, панель на время драга накрывается «корзиной»
// (nodeTree.Palette).

// Прозрачная 1×1 картинка вместо стандартного drag-image: прячем «снимок» плитки —
// вместо него схема показывает свою рамку-превью будущего узла (масштаб под зум).
const EMPTY_DRAG_IMG =
  typeof Image !== "undefined" ? new Image() : null;
if (EMPTY_DRAG_IMG) {
  EMPTY_DRAG_IMG.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}

export interface PaletteDrag {
  // Идёт драг шаблона — панель накрыта «корзиной».
  dragging: boolean;
  // Курсор над «корзиной» (drop здесь = отмена) — подсветка.
  trashActive: boolean;
  onTemplateDragStart: (e: DragEvent, type: NodeType) => void;
  onTemplateDragEnd: () => void;
  onTrashDragOver: (e: DragEvent) => void;
  onTrashDragLeave: () => void;
  onTrashDrop: (e: DragEvent) => void;
}

// onTemplateDrag — начало/конец драга шаблона: тип при старте, null при завершении.
// По нему схема рисует превью-рамку будущего узла под курсором.
export function usePaletteDrag(onTemplateDrag: ((type: NodeType | null) => void) | undefined): PaletteDrag {
  const [dragging, setDragging] = useState(false);
  const [trashActive, setTrashActive] = useState(false);
  // синхронный флаг «идёт драг» — оверлей показываем отложенно (см. onTemplateDragStart),
  // а ref нужен, чтобы не зажечь его уже после завершения короткого драга
  const draggingRef = useRef(false);

  function onTemplateDragStart(e: DragEvent, type: NodeType) {
    e.dataTransfer.setData(NODE_DRAG_MIME, type);
    e.dataTransfer.effectAllowed = "copy";
    // Прячем стандартный drag-image (снимок плитки) — превью рисует схема.
    if (EMPTY_DRAG_IMG) e.dataTransfer.setDragImage(EMPTY_DRAG_IMG, 0, 0);
    onTemplateDrag?.(type);
    // ВАЖНО: оверлей-корзину показываем НЕ синхронно. Если смонтировать плитку
    // поверх карточки-источника прямо в обработчике dragstart, браузер отменяет
    // нативный drag (источник под курсором исчезает/накрывается). Откладываем на
    // следующий кадр — драг к этому моменту уже «схвачен» и накрытие безопасно.
    draggingRef.current = true;
    requestAnimationFrame(() => {
      if (draggingRef.current) setDragging(true);
    });
  }
  function onTemplateDragEnd() {
    onTemplateDrag?.(null);
    draggingRef.current = false;
    setDragging(false);
    setTrashActive(false);
  }

  // «Корзина» поверх панели во время драга шаблона. preventDefault на dragover
  // делает панель валидной зоной дропа → курсор перестаёт быть «запретным» красным
  // кругом над панелью. Дроп здесь ничего не создаёт (onDropNode зовётся только из
  // LevelGraph) — узел просто не сохраняется.
  function onTrashDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return;
    e.preventDefault();
    // dropEffect должен быть совместим с effectAllowed="copy", иначе вернётся
    // «запретный» курсор; "copy" даёт обычный курсор-плюс, не красный круг.
    e.dataTransfer.dropEffect = "copy";
    if (!trashActive) setTrashActive(true);
  }
  function onTrashDragLeave() {
    setTrashActive(false);
  }
  function onTrashDrop(e: DragEvent) {
    e.preventDefault(); // гасим драг над панелью — узел не создаётся
    setTrashActive(false);
  }

  return {
    dragging, trashActive,
    onTemplateDragStart, onTemplateDragEnd, onTrashDragOver, onTrashDragLeave, onTrashDrop,
  };
}
