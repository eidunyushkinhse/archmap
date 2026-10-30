import type { CSSProperties, ReactNode } from "react";
import { ChevronIcon } from "../ui/icons";
import { TYPE_LABEL, TYPE_ORDER, type NodeType } from "./nodeTerms";
import type { TypeOption } from "./element/typeOptions";
import type { PaletteDrag } from "./nodeTree.usePaletteDrag";
import "./NodeTreePanel.css";

// Палитра «Добавить объект» дерева редактора-карты (аудит F-7): шесть типов объекта
// (Р41 раздела 13 docs/plan-c4-elements.md), которые тянут на схему, и «корзина» поверх
// панели на время драга — дроп на неё ничего не создаёт. Тип, невозможный на текущем
// уровне, — серая плитка с тем же объяснением, что в окне «Новый объект»; её не тянут.
// Сама плитка-источник и секция объявлены на уровне модуля: компонент, объявленный
// внутри другого, ремаунтится на каждый рендер и срывает нативный драг.

// Мини-иконка типа для палитры — упрощённые SVG в духе NodeShapeSvg. Система, контейнер
// и компонент — прямоугольник сервиса с различием: система — пунктирная рамка вокруг двух
// прямоугольников, контейнер — сплошной прямоугольник, компонент — прямоугольник меньше.
function TypeIcon({ type }: { type: NodeType }) {
  const W = 40, H = 30, stroke = "#475569", fill = "#f1f5f9", sw = 1.4;
  const common = { fill, stroke, strokeWidth: sw };
  if (type === "database") {
    const rx = (W - 4) / 2, ry = 5, cx = W / 2;
    return (
      <svg width={W} height={H} style={iconSvg}>
        <path d={`M2,${ry + 1} L2,${H - ry - 1} A${rx},${ry} 0 0 0 ${W - 2},${H - ry - 1} L${W - 2},${ry + 1} Z`} {...common} />
        <ellipse cx={cx} cy={ry + 1} rx={rx} ry={ry} {...common} />
      </svg>
    );
  }
  if (type === "broker") {
    const rxc = 6, ryc = (H - 4) / 2;
    return (
      <svg width={W} height={H} style={iconSvg}>
        <path d={`M${rxc + 2},2 L${W - rxc - 2},2 A${rxc},${ryc} 0 0 1 ${W - rxc - 2},${H - 2} L${rxc + 2},${H - 2} A${rxc},${ryc} 0 0 1 ${rxc + 2},2 Z`} {...common} />
        <path d={`M${rxc + 2},2 A${rxc},${ryc} 0 0 1 ${rxc + 2},${H - 2}`} fill="none" stroke={stroke} strokeWidth={sw} />
      </svg>
    );
  }
  if (type === "person") {
    // Карточка как у сервиса + мини-человечок слева (в духе аватара на узле)
    return (
      <svg width={W} height={H} style={iconSvg}>
        <rect x={2} y={3} width={36} height={24} rx={4} {...common} />
        <circle cx={11} cy={11.5} r={2.8} fill="none" stroke="#475569" strokeWidth={1.4} />
        <path d="M6 18.5 a 5 4.5 0 0 1 10 0" fill="none" stroke="#475569" strokeWidth={1.4} strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "system") {
    // Пунктирная рамка (эхо рамки системы на холсте) вокруг двух контейнеров.
    return (
      <svg width={W} height={H} style={iconSvg}>
        <rect x={2} y={3} width={W - 4} height={H - 6} rx={4} fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray="3 2" />
        <rect x={7} y={10} width={11} height={10} rx={2} {...common} />
        <rect x={22} y={10} width={11} height={10} rx={2} {...common} />
      </svg>
    );
  }
  if (type === "component") {
    return (
      <svg width={W} height={H} style={iconSvg}>
        <rect x={9} y={8} width={W - 18} height={H - 16} rx={3} {...common} />
      </svg>
    );
  }
  // container — прямоугольник со скруглением (прежний «сервис»)
  return (
    <svg width={W} height={H} style={iconSvg}>
      <rect x={2} y={3} width={W - 4} height={H - 6} rx={4} {...common} />
    </svg>
  );
}

// Иконка корзины для оверлея отмены драга. Темнеет при наведении (drop = отмена).
function TrashIcon({ active }: { active: boolean }) {
  const c = active ? "#475569" : "#94a3b8";
  return (
    <svg
      width="34" height="34" viewBox="0 0 24 24" fill="none"
      stroke={c} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: "stroke 0.12s ease" }}
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// Сворачиваемая секция аккордеона. ВАЖНО: объявлена на уровне модуля, а не внутри
// NodeTreePanel. Если объявлять внутри, у компонента на каждый рендер новая
// идентичность функции → React размонтирует и заново монтирует всё поддерево
// секции. Для палитры «Добавить узел» это критично: remount во время нативного
// drag уничтожал перетаскиваемый <div> и браузер отменял драг (плавающий баг
// «шаблон не берётся», особенно при быстром старте). Стабильный тип = палитра
// переиспользуется на месте, источник драга не пропадает.
function Section({ open, grow, title, onToggle, children }: {
  open: boolean; grow?: boolean; title: string;
  onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="nt-section" style={{ ...section, flex: grow && open ? 1 : "none" }}>
      <button className="nt-sechead" onClick={onToggle} title={open ? "Свернуть" : "Развернуть"}>
        <span>{title}</span>
        {/* SVG-шеврон у правого края, поворачивается на 90° при раскрытии секции. */}
        <span className={open ? "nt-secchev nt-secchev--open" : "nt-secchev"}><ChevronIcon /></span>
      </button>
      {open && <div style={sectionBody}>{children}</div>}
    </div>
  );
}

// Секция палитры: шесть типов в сетке, каждый — источник нативного драга. options —
// варианты поля «Тип» на текущем уровне (element/typeOptions); null — родитель уровня
// не загружен, палитра ничего не гасит (тип проверит окно «Новый объект»).
export function PaletteSection({ open, onToggle, drag, options }: {
  open: boolean; onToggle: () => void; drag: PaletteDrag; options: readonly TypeOption[] | null;
}) {
  return (
    <Section title="Добавить объект" open={open} onToggle={onToggle}>
      <div style={paletteHint}>Перетащите форму на схему</div>
      <div style={palette} data-tour="palette">
        {TYPE_ORDER.map((type) => {
          const label = TYPE_LABEL[type];
          const off = options?.find((o) => o.type === type && o.disabled);
          if (off) {
            return (
              <div
                key={type}
                data-tour={`palette:${type}`}
                className="template-card template-card--off"
                aria-disabled="true"
                style={templateCard}
                title={off.reason}
              >
                <TypeIcon type={type} />
                <span style={templateLabel}>{label}</span>
              </div>
            );
          }
          return (
            <div
              key={type}
              data-tour={`palette:${type}`}
              className="template-card"
              draggable
              onDragStart={(e) => drag.onTemplateDragStart(e, type)}
              onDragEnd={drag.onTemplateDragEnd}
              style={templateCard}
              title={`Перетащить «${label}» на схему`}
            >
              <TypeIcon type={type} />
              <span style={templateLabel}>{label}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// «Корзина» — плитка поверх всей панели на время драга шаблона. Рисуется СВЕРХУ (а не
// заменой контента), чтобы источник драга остался смонтированным: размонтирование
// плитки-источника во время нативного drag отменяет драг.
export function TrashOverlay({ drag }: { drag: PaletteDrag }) {
  return (
    <div
      style={{ ...trashOverlay, ...(drag.trashActive ? trashOverlayActive : null) }}
      onDragOver={drag.onTrashDragOver}
      onDragLeave={drag.onTrashDragLeave}
      onDrop={drag.onTrashDrop}
    >
      {/* pointerEvents:none на содержимом — dragenter/leave ловит только сам
          оверлей, без дёрганья подсветки при наведении на иконку */}
      <div style={trashInner}>
        <TrashIcon active={drag.trashActive} />
      </div>
    </div>
  );
}

// Секция аккордеона (разделители-границы — в .nt-section CSS)
const section: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const sectionBody: CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
};
// Палитра шаблонов
const paletteHint: CSSProperties = {
  padding: "0 14px 8px",
  fontSize: 11,
  color: "#94a3b8",
};
const palette: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
  padding: "0 14px 12px",
};
const templateCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  padding: "11px 6px 9px",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  // cursor (grab/grabbing) и hover-подсветка — в .template-card (нужны :active/:hover)
  userSelect: "none",
};
const templateLabel: CSSProperties = {
  fontSize: 11.5,
  color: "#475569",
  fontWeight: 500,
  textAlign: "center",
};
const iconSvg: CSSProperties = {
  display: "block",
  pointerEvents: "none",
};
// Оверлей-«корзина» поверх панели на время драга шаблона. Не упирается в края
// панели (inset-отступ) → плитка «внутри» панели; пунктирная рамка, без подписи.
const trashOverlay: CSSProperties = {
  position: "absolute",
  inset: 10,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(248,250,252,.92)",
  border: "1.5px dashed #cbd5e1",
  borderRadius: 10,
  transition: "background 0.12s ease, border-color 0.12s ease",
};
// Активное состояние (курсор над корзиной) — рамка темнее, фон плотнее
const trashOverlayActive: CSSProperties = {
  background: "#eef2f6",
  borderColor: "#94a3b8",
};
const trashInner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};
