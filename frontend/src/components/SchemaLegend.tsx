// Легенда встроенного блока схемы (окно просмотра на странице). Компактная кнопка
// «Легенда» в правом нижнем углу холста + всплывающая панель-справочник по визуальным
// кодировкам схемы (фигуры объектов, статусы, пунктир гостя, рамки системы и контейнера).
//
// Механика панели — по образцу SchemaAlerts: relative-якорь + absolute-панель,
// useState(open), закрытие по клику вне и Escape. Отличие: кнопка стоит ВНИЗУ справа,
// поэтому панель раскрывается ВВЕРХ (bottom: calc(100% + 8px)). Видна всегда (обе
// роли, в т.ч. неактивный блок) — z-index выше оверлея активации.
// variant="deployment" — холст «Развёртывание»: пользователей и гостей там нет, зато
// есть площадки (зона с заливкой, свёрнутая — белая карточка), группа «Размещение не
// указано», пунктирная карточка системы целиком на площадке и пометка «1/2».
// Рамки — по элементу архитектуры (Р20, Р24 эпика docs/plan-c4-elements.md): обе
// пунктиром, у контейнера заливка цветом глубины (graph/frameStyle.ts). Знаки в углу блока
// (ChildrenBadge, node.md N17 и N4в): дерево — система, у пустой без числа; сетка —
// контейнер с компонентами.

import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import "./SchemaLegend.css";
import { useDismiss } from "../ui/useDismiss";
import { getNodeColors, hexToRgba } from "./graph/colors";

/* ── Мини-свотчи фигур (в тех же цветах, что узлы на схеме) ────────── */
const BLUE = "#1168bd";      // getNodeColors: internal, depth 0
const BLUE_BORDER = "#0d5196";
const GRAY = "#555555";      // getNodeColors: external, depth 0

function SwatchService() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={4} fill={BLUE} stroke={BLUE_BORDER} strokeWidth={1.3} />
    </svg>
  );
}
function SwatchDatabase() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <path d="M2,4 L2,14 A11,3.4 0 0 0 24,14 L24,4 Z" fill={BLUE} stroke={BLUE_BORDER} strokeWidth={1.3} />
      <ellipse cx={13} cy={4} rx={11} ry={3.4} fill={BLUE} stroke={BLUE_BORDER} strokeWidth={1.3} />
    </svg>
  );
}
function SwatchBroker() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <path d="M6,1 L20,1 A5,8 0 0 1 20,17 L6,17 A5,8 0 0 1 6,1 Z" fill={BLUE} stroke={BLUE_BORDER} strokeWidth={1.3} />
      <path d="M6,1 A5,8 0 0 1 6,17" fill="none" stroke={BLUE_BORDER} strokeWidth={1.3} />
    </svg>
  );
}
function SwatchPerson() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={4} fill={BLUE} stroke={BLUE_BORDER} strokeWidth={1.3} />
      <circle cx={8} cy={7} r={3.4} fill="rgba(255,255,255,0.92)" />
      <circle cx={8} cy={6} r={1.5} fill="none" stroke={BLUE_BORDER} strokeWidth={1.1} />
      <path d="M5.4 10.4 a2.6 2.2 0 0 1 5.2 0" fill="none" stroke={BLUE_BORDER} strokeWidth={1.1} strokeLinecap="round" />
    </svg>
  );
}
/* Гость — пунктирная рамка (объект с другого уровня) */
function SwatchGhost() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={4} fill="#f1f5f9" stroke={GRAY} strokeWidth={1.3} strokeDasharray="4 2.5" />
    </svg>
  );
}
/* Рамка системы (и группа «Размещение не указано») — серый пунктир без заливки */
function SwatchFrame() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={4} fill="transparent" stroke="#9ca3af" strokeWidth={1.3} strokeDasharray="4 2.5" />
    </svg>
  );
}
/* Рамка контейнера — тот же пунктир и заливка цветом глубины 0. На холсте заливка
   ~8 % (frameStyle.ts); в свотче 26×18 такая не читается, поэтому плотнее. */
const CONTAINER_SWATCH_ALPHA = 0.15;
function SwatchContainerFrame() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect
        x={1} y={1} width={24} height={16} rx={4}
        fill={hexToRgba(getNodeColors(false, 0).bg, CONTAINER_SWATCH_ALPHA)}
        stroke="#9ca3af" strokeWidth={1.3} strokeDasharray="4 2.5"
      />
    </svg>
  );
}
/* Система целиком на площадке — карточка пунктирным контуром (NodeShapeSvg dashed) */
function SwatchWholeSystem() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={4} fill={BLUE} stroke={BLUE_BORDER} strokeWidth={1.3} strokeDasharray="3.5 2" />
    </svg>
  );
}
/* Знак в правом нижнем углу блока (ChildrenBadge): дерево у системы, сетка у контейнера с
   компонентами — тот же глиф в масштабе свотча на блоке сервиса. */
function SwatchCornerBadge({ glyph }: { glyph: "tree" | "grid" }) {
  const stroke = { fill: "none", stroke: "#fff", strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={4} fill={BLUE} stroke={BLUE_BORDER} strokeWidth={1.3} />
      <g transform="translate(13.5 5.5) scale(0.42)" data-glyph={glyph}>
        {glyph === "tree" ? (
          <>
            <circle cx="12" cy="6" r="2.3" {...stroke} />
            <circle cx="6" cy="18" r="2.3" {...stroke} />
            <circle cx="18" cy="18" r="2.3" {...stroke} />
            <path d="M12 8.3 V13" {...stroke} />
            <path d="M6 15.7 V13 H18 V15.7" {...stroke} />
          </>
        ) : (
          <>
            <rect x="4" y="4" width="7" height="7" rx="1.5" {...stroke} />
            <rect x="13" y="4" width="7" height="7" rx="1.5" {...stroke} />
            <rect x="4" y="13" width="7" height="7" rx="1.5" {...stroke} />
            <rect x="13" y="13" width="7" height="7" rx="1.5" {...stroke} />
          </>
        )}
      </g>
    </svg>
  );
}
/* Площадка развёртывания — зона: лёгкая заливка и светлая граница (FrameNode, decor site) */
function SwatchSite() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={4} fill="rgba(100,116,139,0.07)" stroke="#cbd5e1" strokeWidth={1} />
    </svg>
  );
}
/* Свёрнутая площадка — белая карточка с лупой (SiteCardNode) */
function SwatchSiteCard() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <rect x={1} y={1} width={24} height={16} rx={3} fill="#fff" stroke="#94a3b8" strokeWidth={1} />
      <circle cx={17} cy={8} r={2.6} fill="none" stroke="#94a3b8" strokeWidth={1.1} />
      <path d="M19 10 L21 12" stroke="#94a3b8" strokeWidth={1.1} strokeLinecap="round" />
    </svg>
  );
}
/* Пометка карточки объекта на нескольких площадках */
function SwatchMark() {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <text x={13} y={13} textAnchor="middle" fontSize={11} fontWeight={700} fill="#374151">1/2</text>
    </svg>
  );
}
function StatusDot({ color }: { color: string }) {
  return (
    <svg width={26} height={18} viewBox="0 0 26 18">
      <circle cx={13} cy={9} r={6} fill={color} />
    </svg>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
       strokeLinecap="round" strokeLinejoin="round"
       style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
    <path d="M6 9 L12 15 L18 9" />
  </svg>
);

export default function SchemaLegend({ variant = "schema" }: { variant?: "schema" | "deployment" }) {
  const deployment = variant === "deployment";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(open, ref, setOpen);

  return (
    <div ref={ref} style={wrap}>
      <button
        className="sleg-btn"
        onClick={() => setOpen((o) => !o)}
        title="Легенда схемы"
        aria-expanded={open}
      >
        <span>Легенда</span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="sleg-panel" style={panel}>
          <div style={head}>Легенда</div>

          <Section title="Типы объектов">
            <Row swatch={<SwatchService />} label="Система, контейнер, компонент" />
            <Row swatch={<SwatchDatabase />} label="База данных" />
            <Row swatch={<SwatchBroker />} label="Брокер сообщений" />
            {!deployment && <Row swatch={<SwatchPerson />} label="Пользователь" />}
          </Section>

          <Section title="Статус">
            <Row swatch={<StatusDot color={BLUE} />} label="Существует" />
            <Row swatch={<StatusDot color="#1f9d57" />} label="Проектируется" />
            <Row swatch={<StatusDot color="#cb5a4f" />} label="Выводится" />
          </Section>

          {deployment ? (
            <Section title="Обозначения">
              <Row swatch={<SwatchSite />} label="Площадка" />
              <Row swatch={<SwatchSiteCard />} label="Свёрнутая площадка" />
              <Row swatch={<SwatchFrame />} label="Размещение не указано" />
              <Row swatch={<SwatchWholeSystem />} label="Система целиком на площадке" />
              <Row swatch={<SwatchMark />} label="Объект на нескольких площадках" />
            </Section>
          ) : (
            <Section title="Обозначения">
              <Row swatch={<SwatchGhost />} label="Объект с другого уровня" />
              <Row swatch={<SwatchFrame />} label="Рамка системы" />
              <Row swatch={<SwatchContainerFrame />} label="Рамка контейнера" />
              <Row swatch={<SwatchCornerBadge glyph="tree" />} label="Система, рядом число вложенных объектов" />
              <Row swatch={<SwatchCornerBadge glyph="grid" />} label="Контейнер с компонентами, рядом их число" />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={section}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function Row({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <div style={row}>
      <span style={rowSwatch}>{swatch}</span>
      <span style={rowLabel}>{label}</span>
    </div>
  );
}

/* ── стили ─────────────────────────────────────────────────────────── */
// Якорь — в правом нижнем углу холста; z-index выше оверлея активации (4) и
// контролов расстановки (5), чтобы легенда была доступна и в неактивном блоке.
const wrap: CSSProperties = { position: "absolute", bottom: 10, right: 10, zIndex: 6 };
// Панель раскрывается ВВЕРХ от кнопки (кнопка внизу холста).
const panel: CSSProperties = {
  position: "absolute", bottom: "calc(100% + 8px)", right: 0, width: 232,
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
  boxShadow: "0 12px 32px rgba(17,24,39,.16)", padding: "0 0 6px",
};
const head: CSSProperties = {
  padding: "10px 14px 9px", borderBottom: "1px solid #f3f4f6",
  fontSize: 13, fontWeight: 700, color: "#111827",
};
const section: CSSProperties = { padding: "8px 8px 2px" };
const sectionTitle: CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
  color: "#9ca3af", padding: "0 6px 5px",
};
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 9, padding: "3px 6px" };
const rowSwatch: CSSProperties = { display: "inline-flex", flexShrink: 0 };
const rowLabel: CSSProperties = { fontSize: 12.5, color: "#374151" };
