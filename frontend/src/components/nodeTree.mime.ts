// MIME-типы драгов дерева объектов. Шаблон узла из палитры: на схеме (useTemplateDrop)
// по нему читается выбранная форма из dataTransfer.
export const NODE_DRAG_MIME = "application/archmap-node-shape";
// Перенос СУЩЕСТВУЮЩЕГО узла на другой уровень (драг строки дерева). Тип нарочно свой:
// корзина палитры и холст фильтруют драги по MIME и этот пропустят мимо.
export const NODE_MOVE_MIME = "application/archmap-node-move";
