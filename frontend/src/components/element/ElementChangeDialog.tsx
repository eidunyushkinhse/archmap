// Окно последствий смены элемента архитектуры или переноса узла (Р18): одно на четыре
// вида, рендерит ElementChangePreview сервера. Секции «Площадки» (было → стало чипами,
// пояснение под таблицей) и «Документация» появляются, только если им есть что
// показать. Главная кнопка слева, «Отмена» справа; «Отмена» ничего не меняет.
import type { CSSProperties } from "react";
import type { ElementChangePreview, PlacementRowOut } from "../../types";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { consequenceTexts, placementsMove } from "./elementChange";

interface Props {
  preview: ElementChangePreview;
  // Объект, у которого меняют элемент или который переносят.
  nodeName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function Rows({ rows, label }: { rows: PlacementRowOut[]; label: string }) {
  return (
    <div role="list" aria-label={label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row) => (
        <div key={row.node_id} role="listitem" style={rowStyle}>
          <span style={rowName}>{row.name}</span>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {row.sites.map((site) => <span key={site} style={chip}>{site}</span>)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ElementChangeDialog({ preview, nodeName, onConfirm, onCancel }: Props) {
  const t = consequenceTexts(preview, nodeName);
  return (
    <ConfirmDialog
      tone="neutral"
      scroll
      title={t.title}
      lead={t.lead}
      confirmLabel={t.confirm}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {placementsMove(preview) && (
        <section>
          <div style={sectionLabel}>Площадки</div>
          <Rows rows={preview.before} label="Площадки до" />
          {/* Пустой системе (Р39) площадки отдать некому: строки «после» нет, стрелки тоже. */}
          {preview.after.length > 0 && (
            <>
              <div style={arrow} aria-hidden>↓</div>
              <Rows rows={preview.after} label="Площадки после" />
            </>
          )}
          <p style={note}>{t.placementNote}</p>
        </section>
      )}
      {t.docs && (
        <section>
          <div style={sectionLabel}>Документация</div>
          <p style={note}>{t.docs}</p>
        </section>
      )}
    </ConfirmDialog>
  );
}

const sectionLabel: CSSProperties = {
  fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
  color: "#94a3b8", margin: "12px 0 6px",
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "baseline", gap: 10 };
const rowName: CSSProperties = {
  width: 120, flexShrink: 0, fontSize: 13, fontWeight: 600, color: "#1e293b",
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const chip: CSSProperties = {
  fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "#eef2ff",
  color: "#3730a3", border: "1px solid #c7d2fe",
};
const arrow: CSSProperties = { color: "#94a3b8", fontSize: 14, margin: "4px 0 4px 130px" };
const note: CSSProperties = { margin: "8px 0 0", fontSize: 13, color: "#475569", lineHeight: 1.5 };
