// Хром «Вида схемы» для окна процесса: компактный переключатель (шапка окна),
// строка-подсказка вида (по центру канвы). Логика видов — в ../schemaView. Все экспорты —
// компоненты (правило react-refresh): константы/функции живут в ../schemaView.
import type { CSSProperties } from "react";
import { SCHEMA_VIEWS, VIEW_BY_ID, type SchemaView } from "../schemaView";
import { BPT } from "./tokens";

// ── Переключатель вида (сегменты) — в actions шапки окна ─────────────────────────
export function SchemaViewSeg({ view, onChange }: { view: SchemaView; onChange: (v: SchemaView) => void }) {
  return (
    <div style={segWrap} role="radiogroup" aria-label="Вид схемы">
      {SCHEMA_VIEWS.map((v) => {
        const active = v.id === view;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={v.hint}
            onClick={() => onChange(v.id)}
            style={active ? segBtnActive : segBtn}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Строка-подсказка текущего вида — плашка по центру над канвой ─────────────────
export function ViewHint({ view }: { view: SchemaView }) {
  return <div style={hintWrap}>{VIEW_BY_ID[view].hint}</div>;
}

const segWrap: CSSProperties = { display: "inline-flex", gap: 2, padding: 2, background: "#f1f5f9", border: "1px solid " + BPT.line, borderRadius: 9 };
const segBtn: CSSProperties = {
  padding: "4px 10px", border: "1px solid transparent", borderRadius: 7,
  background: "transparent", color: BPT.sec, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
};
const segBtnActive: CSSProperties = {
  ...segBtn, background: "#fff", color: BPT.head, border: "1px solid " + BPT.line, boxShadow: "0 1px 2px rgba(15,23,42,.08)",
};
const hintWrap: CSSProperties = {
  alignSelf: "center", margin: "8px auto 0", padding: "5px 14px", maxWidth: 640,
  background: "rgba(255,255,255,.92)", border: "1px solid " + BPT.line, borderRadius: 20,
  fontSize: 11.5, color: BPT.sec, textAlign: "center", lineHeight: 1.35,
};
