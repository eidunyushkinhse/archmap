// Строка дерева объектов и её рекурсия по детям.
//
// ВЫНЕСЕНА ИЗ NodeTreePanel (2026-08-12) не ради красоты: компонент, объявленный
// ВНУТРИ другого, пересоздаётся на каждый рендер родителя, а значит ремаунтится —
// и ремаунт источника СРЫВАЕТ нативный HTML5-драг (этой панели уже стоило одного
// бага с палитрой). Строку предстоит сделать перетаскиваемой, поэтому сначала она
// становится самостоятельной. Перенос дословный: поведение то же, что было.
//
// Всё, что строке нужно от панели, приходит одним объектом-контекстом: он меняется
// свободно (ссылочная стабильность здесь не нужна — важно лишь, чтобы не менялся
// ТИП компонента).
import type { CSSProperties, DragEvent } from "react";
import type { Node } from "../types";
import { canHaveChildren } from "../types";
import { ShapeGlyph, Chevron } from "./nodeTree.shared";
import { PlusIcon } from "../ui/icons";

export interface TreeRowCtx {
  // раскрытые ветки / идёт догрузка детей / уже загруженные дети по id родителя
  expanded: Set<string>;
  loadingId: Set<string>;
  childrenById: Record<string, Node[]>;
  // узлы с has_children=true, у которых после отсева персон детей не осталось —
  // показываем листьями, чтобы шеврон не раскрывался в пустоту
  leaves: Set<string>;
  // id узла, чья страница сейчас открыта (подсветка строки)
  currentNodeId?: string | null;
  // pages_pivot: клик по любому узлу ведёт на его страницу (меняется только подсказка)
  pagesMode: boolean;
  isArchitect: boolean;
  onCreateChild?: (parentId: string) => void;
  // клик по строке: навигация + раскрытие ветки у промежуточного узла
  onSelect: (node: Node) => void;
  // клик по шеврону
  onToggle: (node: Node) => void;
  // Перенос узла на другой уровень перетаскиванием строки. Задаётся ТОЛЬКО
  // редактором (и только архитектору) — в режиме просмотра страниц ручки нет.
  // undefined → строка не перетаскивается вовсе.
  drag?: {
    onStart: (e: DragEvent<HTMLElement>, node: Node) => void;
    onEnd: () => void;
  };
  // id переносимой сейчас строки — она приглушается на время жеста
  movingId?: string | null;
  // строка-цель под курсором (подсвечивается рамкой) и приём дропа. Появляются
  // вместе с drag: без жеста переноса строка обычная.
  dropTargetId?: string | null;
  onDragOverRow?: (e: DragEvent<HTMLElement>, node: Node) => void;
  onDragLeaveRow?: (node: Node) => void;
  onDropRow?: (e: DragEvent<HTMLElement>, node: Node) => void;
}

// Глиф шеврона: размер/поворот. Кликабельная зона и хит-бокс — в CSS
// (.nt-chevzone / .nt-chevhit), поворот зависит от состояния, поэтому остаётся inline.
const chevIcon: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
  transition: "transform 0.12s ease",
  display: "inline-block",
};

export function TreeRow({ node, ctx }: { node: Node; ctx: TreeRowCtx }) {
  const id = node.id;
  const isExpanded = ctx.expanded.has(id);
  const isLoading = ctx.loadingId.has(id);
  const kids = ctx.childrenById[id] ?? [];
  // Контейнером (drill внутрь) может быть только сервис: у БД/брокера детей нет,
  // в дереве они — листья (без шеврона, клик → контекст), хотя сами видны.
  const drillable = canHaveChildren(node.shape);
  // шеврон скрываем, если все дети узла оказались персонами (узел стал листом)
  const hasChildren = drillable && node.has_children && !ctx.leaves.has(id);
  // pages_pivot: клик по любому узлу → его страница (единообразно).
  // редактор: контейнер → дрилл на слой, лист → показать на холсте.
  // В обоих режимах выбор узла с детьми РАСКРЫВАЕТ его ветку (дети видны
  // сразу, без отдельного клика по шеврону).
  const isIntermediate = drillable && node.has_children;
  const title = ctx.pagesMode
    ? `Страница: ${node.name}`
    : isIntermediate
      ? `Открыть слой: ${node.name}`
      : `Показать на схеме: ${node.name}`;
  // Текущая открытая страница — подсветка строки.
  const isCurrent = node.id === ctx.currentNodeId;
  return (
    <>
      <div
        className={
          "nt-row nt-row--clickable"
          + (isCurrent ? " nt-row--current" : "")
          + (ctx.movingId === id ? " nt-row--moving" : "")
          + (ctx.dropTargetId === id ? " nt-row--droptarget" : "")
        }
        onClick={() => ctx.onSelect(node)}
        onDragOver={ctx.drag && ((e) => ctx.onDragOverRow?.(e, node))}
        onDragLeave={ctx.drag && (() => ctx.onDragLeaveRow?.(node))}
        onDrop={ctx.drag && ((e) => ctx.onDropRow?.(e, node))}
        title={title}
      >
        {hasChildren ? (
          <button
            // клик по «бережной зоне» раскрывает/сворачивает, не пуская событие на
            // строку (иначе провалились бы на слой). Зона широкая (26px, вся высота
            // строки), глиф визуально остаётся на месте — см. .nt-chevzone/.nt-chevhit.
            className="nt-chevzone"
            onClick={(e) => { e.stopPropagation(); ctx.onToggle(node); }}
            title={isExpanded ? "Свернуть" : "Развернуть"}
            aria-label={isExpanded ? "Свернуть ветку" : "Развернуть ветку"}
            aria-expanded={isExpanded}
          >
            <span className="nt-chevhit">
              <span style={{ ...chevIcon, transform: isExpanded ? "rotate(90deg)" : "none" }}>
                {isLoading ? "⋯" : <Chevron />}
              </span>
            </span>
          </button>
        ) : (
          <span className="nt-chevspacer" />
        )}
        {/* Зона захвата для переноса на другой уровень. Слот занимает место ВСЕГДА
            (visibility, не display): иначе строки дёргались бы на hover. */}
        {ctx.drag && (
          <span
            className="nt-grip"
            draggable
            onDragStart={(e) => ctx.drag?.onStart(e, node)}
            onDragEnd={() => ctx.drag?.onEnd()}
            // клик по ручке не должен проваливаться в навигацию строки
            onClick={(e) => e.stopPropagation()}
            title={`Перенести «${node.name}» в другой объект`}
            aria-label={`Перенести «${node.name}» в другой объект`}
          ><GripIcon /></span>
        )}
        <ShapeGlyph container={isIntermediate} shape={node.shape} />
        <span className={isIntermediate ? "nt-name nt-name--container" : "nt-name"}>
          {node.name}
        </span>
        {/* «+» — создать дочерний объект (pages_pivot / редактор, архитектор, только сервисы) */}
        {ctx.isArchitect && ctx.onCreateChild && node.shape === "service" && (
          <button
            className="nt-add-child"
            onClick={(e) => { e.stopPropagation(); ctx.onCreateChild?.(node.id); }}
            title={`Создать объект внутри «${node.name}»`}
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {/* Дети раскрытого узла — с направляющей вложенности (border-left). */}
      {isExpanded && kids.length > 0 && (
        <div className="nt-children">
          {kids.map((k) => <TreeRow key={k.id} node={k} ctx={ctx} />)}
        </div>
      )}
    </>
  );
}

// Шесть точек — общепринятый знак «за это можно тащить».
function GripIcon() {
  return (
    <svg width={8} height={12} viewBox="0 0 8 12" fill="currentColor" aria-hidden>
      {[2, 6].map((x) => [2, 6, 10].map((y) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} />
      )))}
    </svg>
  );
}
