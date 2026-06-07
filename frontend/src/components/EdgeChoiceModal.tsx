import type { CSSProperties } from "react";
import type { Edge } from "../types";

interface Props {
  edges: Edge[];
  sourceLabel: string;
  targetLabel: string;
  onPick: (edge: Edge) => void;
  onClose: () => void;
}

// Текст связи для пункта списка
function edgeText(e: Edge): string {
  return [e.label, e.technology].filter(Boolean).join(" · ") || "связь";
}

export default function EdgeChoiceModal({
  edges,
  sourceLabel,
  targetLabel,
  onPick,
  onClose,
}: Props) {
  return (
    <div style={overlay}>
      <div style={modal}>
        <button onClick={onClose} style={closeBtn}>✕</button>
        <h2 style={{ margin: "0 0 6px" }}>Выберите связь</h2>
        <p style={{ margin: "0 0 16px", color: "#6b7280", fontSize: 13 }}>
          {sourceLabel} → {targetLabel}
        </p>
        <div style={list}>
          {edges.map((e) => (
            <button key={e.id} onClick={() => onPick(e)} style={linkRow}>
              {edgeText(e)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const modal: CSSProperties = {
  background: "#fff",
  borderRadius: 10,
  padding: 28,
  width: 420,
  maxHeight: "80vh",
  overflowY: "auto",
  position: "relative",
  boxShadow: "0 8px 32px rgba(0,0,0,.18)",
};
const closeBtn: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  border: "none",
  background: "none",
  fontSize: 18,
  cursor: "pointer",
  color: "#6b7280",
};
const list: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const linkRow: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
  color: "#2563eb",
};
