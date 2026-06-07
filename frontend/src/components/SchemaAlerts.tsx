import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SchemaAlerts as Alerts } from "../types";

/**
 * Индикатор незавершённости схемы для архитектора. Когда есть активные алерты —
 * в правом верхнем углу схемы всплывает оранжевая плитка с восклицательным знаком
 * в треугольнике. Клик раскрывает меню с детализацией:
 *  1) атомарные узлы без единой связи («подвисшие»);
 *  2) связи, упирающиеся в промежуточный (контейнерный) узел, а не в атомарный.
 * Алерты глобальные (по всей схеме), считаются на бэке — здесь только отображение.
 */

interface Props {
  alerts: Alerts;
}

// Восклицательный знак в треугольнике
function WarningIcon({ size = 22, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export default function SchemaAlerts({ alerts }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const disconnected = alerts.disconnected_nodes;
  const intermediate = alerts.intermediate_edges;
  const total = disconnected.length + intermediate.length;

  // Закрытие меню по клику вне плитки и по Escape
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Нет активных алертов — индикатор не показываем
  if (total === 0) return null;

  return (
    <div ref={ref} style={wrap}>
      <button
        style={badge}
        onClick={() => setOpen((o) => !o)}
        title="Незавершённость схемы — открыть детали"
        aria-label={`Алертов: ${total}`}
      >
        <WarningIcon />
        <span style={count}>{total}</span>
      </button>

      {open && (
        <div style={menu}>
          <div style={menuTitle}>Незавершённость схемы</div>

          <div style={section}>
            <div style={sectionHead}>
              Узлы без связей
              <span style={sectionCount}>{disconnected.length}</span>
            </div>
            {disconnected.length === 0 ? (
              <div style={empty}>Нет</div>
            ) : (
              <ul style={list}>
                {disconnected.map((d) => (
                  <li key={d.node_id} style={item}>{d.node_name}</li>
                ))}
              </ul>
            )}
          </div>

          <div style={section}>
            <div style={sectionHead}>
              Связи в промежуточный узел
              <span style={sectionCount}>{intermediate.length}</span>
            </div>
            {intermediate.length === 0 ? (
              <div style={empty}>Нет</div>
            ) : (
              <ul style={list}>
                {intermediate.map((e) => (
                  <li key={e.edge_id} style={item}>
                    <span style={e.source_is_intermediate ? bad : undefined}>
                      {e.source_name}
                    </span>
                    <span style={arrow}> → </span>
                    <span style={e.target_is_intermediate ? bad : undefined}>
                      {e.target_name}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const wrap: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 6,
};
const badge: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  background: "#f59e0b",
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  color: "#fff",
  boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
};
const count: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1,
};
const menu: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  width: 300,
  maxHeight: 420,
  overflowY: "auto",
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
  padding: "10px 0",
};
const menuTitle: CSSProperties = {
  padding: "0 14px 8px",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  color: "#6b7280",
  borderBottom: "1px solid #f1f5f9",
};
const section: CSSProperties = {
  padding: "8px 0 4px",
};
const sectionHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 14px 6px",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
};
const sectionCount: CSSProperties = {
  minWidth: 20,
  textAlign: "center",
  padding: "1px 6px",
  fontSize: 11,
  fontWeight: 700,
  color: "#b45309",
  background: "#fef3c7",
  borderRadius: 999,
};
const list: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const item: CSSProperties = {
  padding: "4px 14px",
  fontSize: 13,
  color: "#374151",
  whiteSpace: "normal",
  wordBreak: "break-word",
};
const arrow: CSSProperties = {
  color: "#9ca3af",
};
// Подсветка конца-нарушителя (промежуточного узла) в строке связи
const bad: CSSProperties = {
  color: "#b45309",
  fontWeight: 600,
};
const empty: CSSProperties = {
  padding: "2px 14px 4px",
  fontSize: 12,
  color: "#9ca3af",
  fontStyle: "italic",
};
