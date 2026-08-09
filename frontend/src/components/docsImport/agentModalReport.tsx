// Компоненты отчёта превью/применения BYOA-модалок (DocsAgentModal /
// SpecAgentModal): строки плана (ItemList) и списки замечаний (NoteList).
// Файл экспортирует ТОЛЬКО компоненты (требование react-refresh); бейдж-стиль —
// в agentModalShared.ts.
import type { ReactNode } from "react";
import { badge } from "./agentModalShared";

// Строки превью: текст + бейдж действия + советующий статус + опциональный
// доп. элемент справа (например, селект вида схемы в режиме «по одной»).
export function ItemList({ title, rows }: {
  title: string;
  rows: { key: string; text: string; badge: string; bad: string | null; ok: boolean; extra?: ReactNode }[];
}) {
  const shown = rows.slice(0, 8);
  return (
    <div style={{ marginTop: 8, fontSize: 12.5 }}>
      <div style={{ fontWeight: 600, color: "#334155" }}>{title}</div>
      {shown.map((r) => (
        <div key={r.key} style={{ marginTop: 3, display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ color: "#475569", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.text}
          </span>
          <span style={badge}>{r.badge}</span>
          {r.extra}
          {r.bad !== null ? (
            <span style={{ color: "#b45309", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.bad}>
              ⚠ {r.bad}
            </span>
          ) : r.ok ? (
            <span style={{ color: "#15803d" }}>✓</span>
          ) : null}
        </div>
      ))}
      {rows.length > shown.length && (
        <div style={{ marginTop: 2, color: "#94a3b8" }}>…ещё {rows.length - shown.length}</div>
      )}
    </div>
  );
}

// Список замечаний (конфликты файлов / предупреждения превью)
export function NoteList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: "#b45309" }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {items.slice(0, 6).map((s, i) => (
        <div key={i} style={{ marginTop: 2, color: "#475569" }}>{s}</div>
      ))}
      {items.length > 6 && <div style={{ marginTop: 2, color: "#475569" }}>…ещё {items.length - 6}</div>}
    </div>
  );
}
