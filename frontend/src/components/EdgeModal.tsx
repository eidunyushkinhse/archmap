import { useState } from "react";
import type { CSSProperties } from "react";
import type { EdgeCreate } from "../types";
import { edgesApi } from "../api/nodes";
import NodeSearchPicker from "./NodeSearchPicker";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export default function EdgeModal({ onClose, onCreated }: Props) {
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [label, setLabel] = useState("");
  const [technology, setTechnology] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!sourceId || !targetId) {
      setError("Выберите исходный и целевой узлы");
      return;
    }
    if (sourceId === targetId) {
      setError("Узел не может ссылаться сам на себя");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data: EdgeCreate = {
        source_id: sourceId,
        target_id: targetId,
        label: label || null,
        technology: technology || null,
      };
      await edgesApi.create(data);
      onCreated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка создания связи");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <button onClick={onClose} style={closeBtn}>✕</button>
        <h2 style={{ margin: "0 0 16px" }}>Новая связь</h2>

        <label style={labelStyle}>Откуда *</label>
        <NodeSearchPicker value={sourceId} onChange={setSourceId} />

        <label style={labelStyle}>Куда *</label>
        <NodeSearchPicker value={targetId} onChange={setTargetId} />

        <label style={labelStyle}>Описание</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="запрос, событие..."
          style={input}
        />

        <label style={labelStyle}>Технология</label>
        <input
          value={technology}
          onChange={(e) => setTechnology(e.target.value)}
          placeholder="REST, gRPC, Kafka..."
          style={input}
        />

        {error && <p style={{ color: "#dc2626", margin: "8px 0" }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={handleSave} disabled={saving} style={primaryBtn}>
            {saving ? "Создание..." : "Создать"}
          </button>
          <button onClick={onClose} style={secondaryBtn}>
            Отмена
          </button>
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
  width: 440,
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
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  marginBottom: 4,
};
const input: CSSProperties = {
  display: "block",
  width: "100%",
  marginBottom: 10,
  padding: "7px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};
const primaryBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
const secondaryBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
