import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Node } from "../types";
import { canHaveChildren } from "../types";
import { nodesApi } from "../api/nodes";
import { input } from "../ui/styles";
import { CloseIcon } from "../ui/icons";
import { ShapeGlyph } from "./nodeTree.shared";
import "./NodeTreePanel.css";
import { noAutofill } from "../ui/noAutofill";

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
  // Подсветка пункта под курсором (инлайн-стилями :hover недоступен).
  const [hovered, setHovered] = useState<string | null>(null);

  // Дебаунс-поиск: при пустом query результаты НЕ трогаем (показ — производный
  // `shown` ниже), эффект только фетчит. Пустой query невозможен «извне»: компонент
  // используется лишь в EdgeInspector с value-UUID существующей связи, а очистку
  // (clear) сам же зануляет локально — поэтому зеркалящего value→selected эффекта нет.
  useEffect(() => {
    if (!query.trim()) return;
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

  // Что показываем в дропдауне: при пустом query — ничего (производное, не стейт).
  const shown = query.trim() ? results : [];

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
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: "#1d4ed8" }}>{selected.label}</span>
        <button onClick={clear} style={clearBtn} aria-label="Снять выбор">
          <CloseIcon size={15} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", marginBottom: 10 }}>
      <input
        {...noAutofill("node-search-picker-1")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск по имени..."
        style={input}
        autoFocus
      />
      {shown.length > 0 && (
        <div style={dropdown}>
          {shown.map((n) => (
            <div
              key={n.id}
              onClick={() => select(n)}
              onMouseEnter={() => setHovered(n.id)}
              onMouseLeave={() => setHovered((h) => (h === n.id ? null : h))}
              style={{ ...dropdownItem, background: hovered === n.id ? "#eff6ff" : "#fff" }}
            >
              <ShapeGlyph container={canHaveChildren(n.shape) && !!n.has_children} shape={n.shape} />
              <span style={{ flex: 1, minWidth: 0 }}>{n.name}</span>
              {n.role && <span style={{ color: "#94a3b8", fontSize: 12 }}>({n.role})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const selectedRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 10,
  padding: "8px 11px",
  border: "1px solid #bfdbfe",
  borderRadius: 8,
  background: "#dbeafe",
};
const clearBtn: CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  color: "#94a3b8",
  display: "inline-flex",
  padding: 0,
};
const dropdown: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  boxShadow: "0 16px 40px rgba(15,23,42,.16)",
  zIndex: 10,
  maxHeight: 200,
  overflowY: "auto",
  marginTop: 4,
};
const dropdownItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 14,
  color: "#0f172a",
  borderBottom: "1px solid #eef2f6",
};
