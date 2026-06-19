// Фильтр «Вид схемы» и легенда статусов — презентационные компоненты. Логика видов
// (какие статусы показывает каждый вид) — в ./schemaView. Цвета — в ./graph/colors.
import type { CSSProperties } from "react";
import type { NodeStatus } from "../types";
import { getNodeColors, STATUS_META } from "./graph/colors";
import { SCHEMA_VIEWS, VIEW_BY_ID, viewShows, type SchemaView } from "./schemaView";

// ── Переключатель вида (сегменты + подсказка) ──────────────────────────────────
export function SchemaViewFilter({
  view, onChange,
}: { view: SchemaView; onChange: (v: SchemaView) => void }) {
  return (
    <div style={wrap}>
      <div style={head}>Вид схемы</div>
      <div style={seg} role="radiogroup" aria-label="Вид схемы">
        {SCHEMA_VIEWS.map((v) => {
          const active = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(v.id)}
              style={active ? segBtnActive : segBtn}
            >
              {v.label}
            </button>
          );
        })}
      </div>
      <div style={hint}>{VIEW_BY_ID[view].hint}</div>
    </div>
  );
}

// ── Легенда статусов (свотч + подпись + счётчик видимых узлов) ──────────────────
// counts — число узлов каждого статуса НА УРОВНЕ (до приглушения). Строки статусов,
// скрытых текущим видом, гасим и показываем «—» вместо счётчика.
export function SchemaLegend({
  view, counts,
}: { view: SchemaView; counts: Record<NodeStatus, number> }) {
  const order: NodeStatus[] = ["existing", "planned", "deprecated"];
  return (
    <div style={legendWrap}>
      <div style={legendHead}>Цвет = статус узла</div>
      {order.map((st) => {
        const visible = viewShows(view, st);
        const swatch = getNodeColors(false, 0, st);
        return (
          <div key={st} style={{ ...legendRow, opacity: visible ? 1 : 0.32 }}>
            <span style={{ ...legendSwatch, background: swatch.bg, borderColor: swatch.border }} />
            <span style={legendLabel}>{STATUS_META[st].label}</span>
            <span style={legendCount}>{visible ? counts[st] : "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

// Фильтр живёт в правой панели схемы — без собственной «карточки» (рамки/тени/фона),
// сливается с панелью. Легенда на холсте свою карточку сохраняет (см. legendWrap).
const wrap: CSSProperties = { width: "100%" };
const head: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: ".04em", marginBottom: 6,
};
const seg: CSSProperties = { display: "flex", gap: 4 };
const segBtn: CSSProperties = {
  flex: 1, padding: "5px 4px", border: "1px solid #e2e8f0", borderRadius: 7,
  background: "#f8fafc", color: "#475569", cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const segBtnActive: CSSProperties = {
  ...segBtn, border: "1px solid #2563eb", background: "#2563eb", color: "#fff",
};
const hint: CSSProperties = { fontSize: 11, color: "#94a3b8", marginTop: 6, lineHeight: 1.35 };

const legendWrap: CSSProperties = {
  background: "rgba(255,255,255,0.96)", border: "1px solid #e5e7eb", borderRadius: 10,
  boxShadow: "0 2px 8px rgba(0,0,0,.08)", padding: "8px 10px", minWidth: 168,
};
const legendHead: CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: ".04em", marginBottom: 6,
};
const legendRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0" };
const legendSwatch: CSSProperties = {
  width: 13, height: 13, borderRadius: 3, border: "1px solid", flexShrink: 0,
};
const legendLabel: CSSProperties = { fontSize: 12, color: "#374151", flex: 1 };
const legendCount: CSSProperties = { fontSize: 12, fontWeight: 700, color: "#6b7280", minWidth: 14, textAlign: "right" };
