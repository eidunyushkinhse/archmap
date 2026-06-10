import type { CSSProperties } from "react";
import type { Edge } from "../types";
import Modal from "../ui/Modal";

// Дженерик по типу ребра: onPick возвращает РОВНО тот объект, что пришёл в edges
// (с original_* полями), не теряя их в типе при сужении до базового Edge.
interface Props<E extends Edge> {
  edges: E[];
  sourceLabel: string;
  targetLabel: string;
  onPick: (edge: E) => void;
  onClose: () => void;
}

// Текст связи для пункта списка
function edgeText(e: Edge): string {
  return [e.label, e.technology].filter(Boolean).join(" · ") || "связь";
}

export default function EdgeChoiceModal<E extends Edge>({
  edges,
  sourceLabel,
  targetLabel,
  onPick,
  onClose,
}: Props<E>) {
  return (
    <Modal onClose={onClose} boxStyle={{ width: 420, maxHeight: "80vh", overflowY: "auto" }}>
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
    </Modal>
  );
}

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
