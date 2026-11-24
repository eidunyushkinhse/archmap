import type { ReactNode } from "react";
import { TYPE_LABEL, TYPE_ORDER, type NodeType } from "./nodeTerms";
import type { PaletteTile } from "./element/paletteTiles";
import type { PaletteDrag } from "./nodeTree.usePaletteDrag";
import "../ui/ds.css";
import "./NodeTreePanel.css";

// Палитра «Добавить объект» дерева редактора-карты (аудит F-7): шесть типов объекта
// (Р41 раздела 13 docs/plan-c4-elements.md), которые тянут на схему, и «корзина» поверх
// панели на время драга — дроп на неё ничего не создаёт. Активность плиток решает
// страница по правилу «цель броска проверяет тип» (element/paletteTiles, приёмка Ф12
// 2026-10-31): тип, невозможный ни на уровне, ни в одной раскрытой рамке, — серая плитка
// с тем же объяснением, что в окне «Новый объект», и её не тянут.
// Палитра всегда раскрыта (редизайн, фаза 4б): тихая подпись и плитки 3×2 по 56px, без
// аккордеона и постоянной подсказки — «Перетащить «X» на схему» говорит подсказка плитки,
// а курсор над ней — «рука».
// Сама плитка-источник и секция объявлены на уровне модуля: компонент, объявленный
// внутри другого, ремаунтится на каждый рендер и срывает нативный драг.

// Значок типа для плитки — упрощённые формы в духе NodeShapeSvg, нарисованы в поле
// 40×30 и показаны в 27×20. Заливка и обводка — из CSS (.nt-tile-icon), у контуров без
// заливки — fill="none". Система, контейнер и компонент — прямоугольник сервиса с
// различием: система — пунктирная рамка вокруг двух прямоугольников, контейнер —
// сплошной прямоугольник, компонент — прямоугольник меньше.
function TypeIcon({ type }: { type: NodeType }) {
  let body: ReactNode;
  if (type === "database") {
    body = (
      <>
        <path d="M2,6 L2,24 A18,5 0 0 0 38,24 L38,6 Z" />
        <ellipse cx={20} cy={6} rx={18} ry={5} />
      </>
    );
  } else if (type === "broker") {
    body = (
      <>
        <path d="M8,2 L32,2 A6,13 0 0 1 32,28 L8,28 A6,13 0 0 1 8,2 Z" />
        <path d="M8,2 A6,13 0 0 1 8,28" fill="none" />
      </>
    );
  } else if (type === "person") {
    // Карточка как у сервиса + человечек слева (в духе аватара на узле)
    body = (
      <>
        <rect x={2} y={3} width={36} height={24} rx={4} />
        <circle cx={11} cy={11.5} r={2.8} fill="none" />
        <path d="M6 18.5 a 5 4.5 0 0 1 10 0" fill="none" strokeLinecap="round" />
      </>
    );
  } else if (type === "system") {
    // Пунктирная рамка (эхо рамки системы на холсте) вокруг двух контейнеров.
    body = (
      <>
        <rect x={2} y={3} width={36} height={24} rx={4} fill="none" strokeDasharray="3 2" />
        <rect x={7} y={10} width={11} height={10} rx={2} />
        <rect x={22} y={10} width={11} height={10} rx={2} />
      </>
    );
  } else if (type === "component") {
    body = <rect x={9} y={8} width={22} height={14} rx={3} />;
  } else {
    // container — прямоугольник со скруглением (прежний «сервис»)
    body = <rect x={2} y={3} width={36} height={24} rx={4} />;
  }
  return (
    <svg className="nt-tile-icon" width={27} height={20} viewBox="0 0 40 30" aria-hidden="true">
      {body}
    </svg>
  );
}

// Иконка корзины для оверлея отмены драга. Темнеет при наведении (drop = отмена): цвет —
// из CSS (.nt-trash, .nt-trash--active).
function TrashIcon() {
  return (
    <svg
      width="34" height="34" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// Палитра: подпись и шесть типов в сетке, активные плитки — источники нативного драга.
// tiles — плитки от страницы (element/paletteTiles); null — родитель уровня не загружен,
// палитра ничего не гасит (тип проверит окно «Новый объект»).
export function PaletteSection({ drag, tiles }: { drag: PaletteDrag; tiles: readonly PaletteTile[] | null }) {
  return (
    <div className="nt-palette">
      <div className="ds-sub">Добавить объект</div>
      <div className="nt-tiles" data-tour="palette">
        {TYPE_ORDER.map((type) => {
          const label = TYPE_LABEL[type];
          const tile = tiles?.find((t) => t.type === type);
          // Серая плитка не тянется: этот тип некуда положить ни на уровне, ни в раскрытые
          // рамки; объяснение — в подсказке.
          if (tile && !tile.enabled) {
            return (
              <div
                key={type}
                data-tour={`palette:${type}`}
                className="nt-tile nt-tile--off"
                aria-disabled="true"
                title={tile.reason}
              >
                <TypeIcon type={type} />
                <span className="nt-tile-label">{label}</span>
              </div>
            );
          }
          return (
            <div
              key={type}
              data-tour={`palette:${type}`}
              className="nt-tile"
              draggable
              onDragStart={(e) => drag.onTemplateDragStart(e, type)}
              onDragEnd={drag.onTemplateDragEnd}
              // Активная только благодаря рамкам — подсказка, куда положить.
              title={tile?.reason ?? `Перетащить «${label}» на схему`}
            >
              <TypeIcon type={type} />
              <span className="nt-tile-label">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// «Корзина» — плитка поверх всей панели на время драга шаблона. Рисуется СВЕРХУ (а не
// заменой контента), чтобы источник драга остался смонтированным: размонтирование
// плитки-источника во время нативного drag отменяет драг. Внутри — только значок урны:
// dragenter/leave ловит сам оверлей (содержимое для мыши прозрачно, .nt-trash-inner).
export function TrashOverlay({ drag }: { drag: PaletteDrag }) {
  return (
    <div
      className={"nt-trash" + (drag.trashActive ? " nt-trash--active" : "")}
      onDragOver={drag.onTrashDragOver}
      onDragLeave={drag.onTrashDragLeave}
      onDrop={drag.onTrashDrop}
    >
      <div className="nt-trash-inner">
        <TrashIcon />
      </div>
    </div>
  );
}
