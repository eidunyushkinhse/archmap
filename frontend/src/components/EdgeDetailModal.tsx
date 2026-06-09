import { useState } from "react";
import type { CSSProperties } from "react";
import type { Edge } from "../types";
import { edgesApi } from "../api/nodes";
import NodeSearchPicker from "./NodeSearchPicker";

interface Props {
  edge: Edge;
  sourceLabel: string;
  targetLabel: string;
  isArchitect: boolean;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onSaved: (edge: Edge) => void;
}

export default function EdgeDetailModal({
  edge,
  sourceLabel,
  targetLabel,
  isArchitect,
  onClose,
  onDeleted,
  onSaved,
}: Props) {
  const [editing, setEditing] = useState(false);
  // Локальные значения отображаемых полей (обновляются после сохранения)
  const [labelText, setLabelText] = useState(edge.label ?? "");
  const [technology, setTechnology] = useState(edge.technology ?? "");
  // Концы связи: id для сохранения + подписи для отображения
  const [sourceId, setSourceId] = useState(edge.source_id);
  const [targetId, setTargetId] = useState(edge.target_id);
  const [srcLabel, setSrcLabel] = useState(sourceLabel);
  const [tgtLabel, setTgtLabel] = useState(targetLabel);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await edgesApi.delete(edge.id);
      onDeleted(edge.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setDeleting(false);
    }
  }

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
      const updated = await edgesApi.update(edge.id, {
        label: labelText || null,
        technology: technology || null,
        source_id: sourceId,
        target_id: targetId,
      });
      onSaved(updated);
      // После сохранения закрываем модалку и возвращаемся прямо на схему (как и крестик),
      // а не в предыдущий поповер детализации.
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <button onClick={onClose} style={closeBtn}>✕</button>
        <h2 style={{ margin: "0 0 16px" }}>{editing ? "Редактирование связи" : "Связь"}</h2>

        {editing ? (
          <>
            <label style={fieldLabel}>Откуда *</label>
            <NodeSearchPicker
              value={sourceId}
              initialLabel={srcLabel}
              onChange={(id, lbl) => { setSourceId(id); if (lbl != null) setSrcLabel(lbl); }}
            />
            <label style={fieldLabel}>Куда *</label>
            <NodeSearchPicker
              value={targetId}
              initialLabel={tgtLabel}
              onChange={(id, lbl) => { setTargetId(id); if (lbl != null) setTgtLabel(lbl); }}
            />
            <label style={fieldLabel}>Описание</label>
            <input
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              placeholder="запрос, событие..."
              style={input}
            />
            <label style={fieldLabel}>Технология</label>
            <input
              value={technology}
              onChange={(e) => setTechnology(e.target.value)}
              placeholder="REST, gRPC, Kafka..."
              style={input}
            />
          </>
        ) : (
          <>
            <div style={row}>
              <span style={label}>Откуда</span>
              <span style={value}>{srcLabel}</span>
            </div>
            <div style={row}>
              <span style={label}>Куда</span>
              <span style={value}>{tgtLabel}</span>
            </div>
            {labelText && (
              <div style={row}>
                <span style={label}>Описание</span>
                <span style={value}>{labelText}</span>
              </div>
            )}
            {technology && (
              <div style={row}>
                <span style={label}>Технология</span>
                <span style={value}>{technology}</span>
              </div>
            )}
          </>
        )}

        {error && <p style={{ color: "#dc2626", margin: "8px 0 0" }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          {editing ? (
            <button onClick={handleSave} disabled={saving} style={primaryBtn}>
              {saving ? "Сохранение..." : "Сохранить"}
            </button>
          ) : isArchitect ? (
            <>
              <button onClick={() => setEditing(true)} style={primaryBtn}>
                Редактировать
              </button>
              <button onClick={handleDelete} disabled={deleting} style={dangerBtn}>
                {deleting ? "Удаление..." : "Удалить связь"}
              </button>
            </>
          ) : (
            <button onClick={onClose} style={secondaryBtn}>Закрыть</button>
          )}
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
  width: 400,
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
const row: CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 10,
  fontSize: 14,
};
const label: CSSProperties = {
  width: 90,
  color: "#6b7280",
  fontWeight: 600,
  flexShrink: 0,
};
const value: CSSProperties = {
  color: "#111827",
};
const fieldLabel: CSSProperties = {
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
const dangerBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#fee2e2",
  color: "#dc2626",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
