import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { EdgeCreate, Node } from "../types";
import { edgesApi, nodesApi } from "../api/nodes";

interface Props {
  // узел, от которого протянули стрелку (исходный конец связи)
  sourceId: string;
  sourceLabel: string;
  // узел-контейнер, на который отпустили стрелку — выбираем дальний конец из его потомков
  containerId: string;
  containerName: string;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * Поповер выбора дальнего конца межуровневой связи: стрелку протянули на узел с
 * детьми, и связь ведём к одному из его потомков. Поиск скоупится поддеревом
 * (GET /nodes/{id}/descendants). Направление по умолчанию — от исходного узла к
 * выбранному; тумблер позволяет развернуть (на случай входящей связи).
 */
export default function EdgeIntoPicker({
  sourceId, sourceLabel, containerId, containerName, onClose, onCreated,
}: Props) {
  const [descendants, setDescendants] = useState<Node[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Node | null>(null);
  // "out" — связь sourceId→выбранный (по умолчанию); "in" — выбранный→sourceId
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [label, setLabel] = useState("");
  const [technology, setTechnology] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    nodesApi
      .getDescendants(containerId)
      .then((d) => { if (!cancelled) setDescendants(d); })
      .catch(() => { if (!cancelled) { setDescendants([]); setError("Не удалось загрузить потомков"); } });
    return () => { cancelled = true; };
  }, [containerId]);

  const filtered = useMemo(() => {
    const list = descendants ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((n) => n.name.toLowerCase().includes(q));
  }, [descendants, query]);

  async function handleCreate() {
    if (!picked) {
      setError("Выберите узел-потомок");
      return;
    }
    if (picked.id === sourceId) {
      setError("Узел не может ссылаться сам на себя");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data: EdgeCreate = {
        source_id: direction === "out" ? sourceId : picked.id,
        target_id: direction === "out" ? picked.id : sourceId,
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

  // Текстовое превью направления (что и куда).
  const farLabel = picked ? picked.name : `узел из «${containerName}»`;
  const arrow = direction === "out"
    ? `${sourceLabel} → ${farLabel}`
    : `${farLabel} → ${sourceLabel}`;

  return (
    <div style={overlay}>
      <div style={modal}>
        <button onClick={onClose} style={closeBtn}>✕</button>
        <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>Связь внутрь «{containerName}»</h2>
        <p style={{ margin: "0 0 16px", color: "#6b7280", fontSize: 13 }}>
          Выберите узел-потомок — дальний конец межуровневой связи.
        </p>

        {/* Направление */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ flex: 1, fontSize: 14, color: "#374151" }}>{arrow}</span>
          <button
            onClick={() => setDirection((d) => (d === "out" ? "in" : "out"))}
            style={secondaryBtn}
            title="Поменять направление"
          >⇄</button>
        </div>

        {/* Поиск по потомкам */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по имени..."
          style={input}
          autoFocus
        />
        <div style={listBox}>
          {descendants === null ? (
            <div style={hint}>Загрузка...</div>
          ) : filtered.length === 0 ? (
            <div style={hint}>{query ? "Ничего не найдено" : "Нет потомков"}</div>
          ) : (
            filtered.map((n) => (
              <div
                key={n.id}
                onClick={() => setPicked(n)}
                style={{ ...listItem, background: picked?.id === n.id ? "#eff6ff" : undefined }}
              >
                {n.name}
                {n.role && <span style={{ color: "#6b7280", marginLeft: 6, fontSize: 12 }}>({n.role})</span>}
              </div>
            ))
          )}
        </div>

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
          <button onClick={handleCreate} disabled={saving || !picked} style={primaryBtn}>
            {saving ? "Создание..." : "Создать связь"}
          </button>
          <button onClick={onClose} style={secondaryBtn}>Отмена</button>
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
const listBox: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  maxHeight: 180,
  overflowY: "auto",
  marginBottom: 14,
};
const listItem: CSSProperties = {
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 14,
  borderBottom: "1px solid #f3f4f6",
};
const hint: CSSProperties = {
  padding: "12px",
  color: "#6b7280",
  fontSize: 13,
  textAlign: "center",
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
