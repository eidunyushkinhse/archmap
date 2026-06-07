import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Node } from "../types";
import { nodesApi } from "../api/nodes";

/**
 * Поиск узла по имени среди всех уровней. Используется для выбора концов связи —
 * в т.ч. сквозной (узел с другого уровня). value — id выбранного узла ("" = нет).
 * initialLabel — подпись для предзаполненного выбора (при редактировании).
 */
export default function NodeSearchPicker({
  value,
  initialLabel,
  onChange,
}: {
  value: string;
  initialLabel?: string;
  onChange: (id: string, label?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Node[]>([]);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(
    value ? { id: value, label: initialLabel ?? value } : null,
  );

  useEffect(() => {
    if (!value) setSelected(null);
  }, [value]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await nodesApi.search(query);
        setResults(data);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  function select(node: Node) {
    const label = node.name + (node.role ? ` (${node.role})` : "");
    setSelected({ id: node.id, label });
    onChange(node.id, label);
    setQuery("");
    setResults([]);
  }

  function clear() {
    setSelected(null);
    onChange("");
  }

  if (selected) {
    return (
      <div style={selectedRow}>
        <span style={{ flex: 1, fontSize: 14 }}>{selected.label}</span>
        <button onClick={clear} style={clearBtn}>✕</button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", marginBottom: 10 }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск по имени..."
        style={input}
        autoFocus
      />
      {results.length > 0 && (
        <div style={dropdown}>
          {results.map((n) => (
            <div key={n.id} onClick={() => select(n)} style={dropdownItem}>
              {n.name}
              {n.role && <span style={{ color: "#6b7280", marginLeft: 6, fontSize: 12 }}>({n.role})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
const selectedRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 10,
  padding: "7px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "#f0fdf4",
};
const clearBtn: CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  color: "#6b7280",
  fontSize: 14,
  padding: 0,
};
const dropdown: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  background: "#fff",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0,0,0,.12)",
  zIndex: 10,
  maxHeight: 200,
  overflowY: "auto",
};
const dropdownItem: CSSProperties = {
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 14,
  borderBottom: "1px solid #f3f4f6",
};
