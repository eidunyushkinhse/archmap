// Иконки и глифы бизнес-процессов — портированы 1:1 из дизайн-референса (bp-parts.jsx).
// Контурные SVG, наследуют цвет через currentColor; эмодзи нет.
import type { NodeShape } from "../../types";
import { BPT, svgBase } from "./tokens";

// C4-глиф формы узла (монохром). Не переиспользуем ShapeGlyph из дерева: тот
// фиксирован 14×12 с семантикой «контейнер», а здесь нужна чистая форма участника
// заданного размера — это и есть глиф из дизайн-референса диаграммы.
export function C4Glyph({ shape, s = 16 }: { shape: NodeShape; s?: number }) {
  const sw = 1.6;
  if (shape === "database")
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={sw}>
        <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
        <path d="M4.5 6 V18 a7.5 2.8 0 0 0 15 0 V6" />
      </svg>
    );
  if (shape === "broker")
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={sw}>
        <path d="M8 4 H17 a4 8 0 0 1 0 16 H8 a4 8 0 0 1 0-16 Z" />
        <path d="M8 4 a4 8 0 0 0 0 16" />
      </svg>
    );
  if (shape === "person")
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={sw}>
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5.5 20 a6.5 5 0 0 1 13 0" />
      </svg>
    );
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={sw}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.4" />
    </svg>
  );
}

export function IcoFlow({ s = 17 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={1.7}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <path d="M8.4 6 H13 a2.6 2.6 0 0 1 2.6 2.6 V9.6 M8.4 18 H13 a2.6 2.6 0 0 0 2.6-2.6 V14.4" />
    </svg>
  );
}
export function IcoPlus({ s = 16 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={1.9}>
      <path d="M12 5 V19 M5 12 H19" />
    </svg>
  );
}
export function IcoClose({ s = 16 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={1.9}>
      <path d="M6 6 L18 18 M18 6 L6 18" />
    </svg>
  );
}
export function IcoEdit({ s = 15 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase}>
      <path d="M4 20 h4 L19 9 a2 2 0 0 0-3-3 L5 17 Z" />
      <path d="M14 7 L17 10" />
    </svg>
  );
}
export function IcoChevron({ s = 13, open }: { s?: number; open?: boolean }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      style={{ ...svgBase, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s ease" }}
    >
      <path d="M9 6 L15 12 L9 18" />
    </svg>
  );
}
export function IcoDots({ s = 16 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}
export function IcoArrowR({ s = 14 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={2.1}>
      <path d="M5 12 H18 M13 7 L18 12 L13 17" />
    </svg>
  );
}
export function IcoReturn({ s = 14 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={2}>
      <path d="M19 12 H6 M11 7 L6 12 L11 17" />
      <path d="M19 7 V12" />
    </svg>
  );
}
export function IcoAsync({ s = 14 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={2}>
      <path d="M4 12 H18 M13 7 L18 12 L13 17" strokeDasharray="2.4 2.4" />
    </svg>
  );
}
export function IcoLink({ s = 14 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase}>
      <path d="M9 13 a4 4 0 0 0 6 .5 l2-2 a4 4 0 0 0-6-6 l-1 1" />
      <path d="M15 11 a4 4 0 0 0-6-.5 l-2 2 a4 4 0 0 0 6 6 l1-1" />
    </svg>
  );
}
export function IcoSearch({ s = 14 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16 L21 21" />
    </svg>
  );
}
export function IcoWarn({ s = 15 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase} strokeWidth={1.8}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3 h17 a2 2 0 0 0 1.7-3 L13.7 3.9 a2 2 0 0 0-3.4 0z" />
      <path d="M12 9 V13.4 M12 16.8 h.01" />
    </svg>
  );
}
export function IcoExport({ s = 16 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" {...svgBase}>
      <path d="M12 3 V14 M8 10 L12 14 L16 10 M5 17 V20 H19 V17" />
    </svg>
  );
}

export function TechChip({ t }: { t: string }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: ".02em",
        color: BPT.micro,
        background: "#f1f5f9",
        border: "1px solid " + BPT.line,
        borderRadius: 4,
        padding: "1px 5px",
        whiteSpace: "nowrap",
      }}
    >
      {t}
    </span>
  );
}
