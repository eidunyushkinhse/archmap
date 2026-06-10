import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import type { EdgeCreate, Node } from "../types";
import { edgesApi, nodesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn } from "../ui/styles";

interface Props {
  // узел, от которого протянули стрелку (исходный конец связи)
  sourceId: string;
  sourceLabel: string;
  // хэндл узла-источника, из которого тянули стрелку — закрепляем за концом sourceId;
  // дальний конец (выбранный потомок) — дефолтная привязка
  sourceHandle: string | null;
  // узел-контейнер, на который отпустили стрелку — выбираем дальний конец из его потомков
  containerId: string;
  containerName: string;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * Поповер выбора дальнего конца межуровневой связи: стрелку протянули на узел с
 * детьми, и связь ведём к одному из его потомков. Скоуп — поддерево контейнера
 * (GET /nodes/{id}/descendants, плоский список); дерево собираем на клиенте по
 * parent_id. Навигация как в боковом дереве: по умолчанию видны только прямые дети,
 * раскрытие по шеврону. Поиск по имени — автокомплит-дропдаун под полем ввода.
 * Направление по умолчанию — от исходного узла к выбранному; тумблер разворачивает.
 */
export default function EdgeIntoPicker({
  sourceId, sourceLabel, sourceHandle, containerId, containerName, onClose, onCreated,
}: Props) {
  const [descendants, setDescendants] = useState<Node[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Node | null>(null);
  // раскрытые узлы дерева (по умолчанию свёрнуто — видны только прямые дети)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  // Индексы для дерева: узел по id и дети по parent_id (внутри поддерева).
  const byId = useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of descendants ?? []) m.set(n.id, n);
    return m;
  }, [descendants]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, Node[]>();
    for (const n of descendants ?? []) {
      if (!n.parent_id) continue;
      const arr = m.get(n.parent_id);
      if (arr) arr.push(n); else m.set(n.parent_id, [n]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [descendants]);
  // Прямые дети контейнера — корни дерева в поповере.
  const roots = childrenOf.get(containerId) ?? [];

  // Совпадения для автокомплита (плоский поиск по всему поддереву).
  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (descendants ?? []).filter((n) => n.name.toLowerCase().includes(q));
  }, [descendants, query]);

  // Путь от контейнера до узла (без него самого) — для подсказки в дропдауне.
  const pathOf = (n: Node): string => {
    const parts: string[] = [];
    let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
    while (cur && cur.id !== containerId) {
      parts.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts.join(" / ");
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });

  // Выбор из автокомплита: фиксируем узел, чистим поиск и раскрываем путь к нему
  // в дереве, чтобы выбранный узел стал виден.
  const pickFromSearch = (n: Node) => {
    setPicked(n);
    setQuery("");
    setExpanded((prev) => {
      const s = new Set(prev);
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      while (cur && cur.id !== containerId) {
        s.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      return s;
    });
  };

  const renderNode = (n: Node, depth: number): ReactElement => {
    const kids = childrenOf.get(n.id) ?? [];
    const hasKids = kids.length > 0;
    const isOpen = expanded.has(n.id);
    const isPicked = picked?.id === n.id;
    return (
      <div key={n.id}>
        <div
          onClick={() => setPicked(n)}
          style={{ ...treeRow, paddingLeft: 8 + depth * 16, background: isPicked ? "#eff6ff" : undefined }}
        >
          {hasKids ? (
            <button
              onClick={(e) => { e.stopPropagation(); toggle(n.id); }}
              style={chevBtn}
              title={isOpen ? "Свернуть" : "Развернуть"}
            >
              <span style={{ ...chevIcon, transform: isOpen ? "rotate(90deg)" : "none" }}>▸</span>
            </button>
          ) : (
            <span style={leafMark}>●</span>
          )}
          <span style={{ flex: 1 }}>
            {n.name}
            {n.role && <span style={roleMuted}>({n.role})</span>}
          </span>
        </div>
        {hasKids && isOpen && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

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
        // исходный хэндл закрепляем за концом sourceId (в какую сторону он смотрит —
        // зависит от направления), дальний конец — дефолтная привязка
        source_handle: direction === "out" ? sourceHandle : null,
        target_handle: direction === "out" ? null : sourceHandle,
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
    <Modal onClose={onClose} boxStyle={{ width: 440 }}>
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

        {/* Поиск: при вводе под полем выпадает автокомплит с совпадениями */}
        <div style={{ position: "relative", marginBottom: 10 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по имени..."
            style={{ ...input, marginBottom: 0 }}
            data-autofocus
          />
          {query.trim() && (
            <div style={dropdown}>
              {descendants === null ? (
                <div style={hint}>Загрузка...</div>
              ) : searchMatches.length === 0 ? (
                <div style={hint}>Ничего не найдено</div>
              ) : (
                searchMatches.map((n) => {
                  const path = pathOf(n);
                  return (
                    <div key={n.id} onClick={() => pickFromSearch(n)} style={dropdownItem}>
                      <div>
                        {n.name}
                        {n.role && <span style={roleMuted}>({n.role})</span>}
                      </div>
                      {path && <div style={breadcrumb}>{path}</div>}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Дерево потомков: по умолчанию только прямые дети, раскрытие по шеврону */}
        <div style={listBox}>
          {descendants === null ? (
            <div style={hint}>Загрузка...</div>
          ) : roots.length === 0 ? (
            <div style={hint}>Нет потомков</div>
          ) : (
            roots.map((n) => renderNode(n, 0))
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
    </Modal>
  );
}

const listBox: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  maxHeight: 200,
  overflowY: "auto",
  marginBottom: 14,
};
const treeRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 8px",
  cursor: "pointer",
  fontSize: 14,
};
const chevBtn: CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: 0,
  width: 20,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#6b7280",
};
const chevIcon: CSSProperties = {
  display: "inline-block",
  fontSize: 15,
  transition: "transform 0.12s ease",
};
const leafMark: CSSProperties = {
  width: 20,
  flexShrink: 0,
  textAlign: "center",
  color: "#cbd5e1",
  fontSize: 12,
};
const roleMuted: CSSProperties = {
  color: "#6b7280",
  marginLeft: 6,
  fontSize: 12,
};
const dropdown: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  background: "#fff",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  boxShadow: "0 6px 20px rgba(0,0,0,.12)",
  maxHeight: 220,
  overflowY: "auto",
  zIndex: 10,
};
const dropdownItem: CSSProperties = {
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 14,
  borderBottom: "1px solid #f3f4f6",
};
const breadcrumb: CSSProperties = {
  color: "#9ca3af",
  fontSize: 11,
  marginTop: 2,
};
const hint: CSSProperties = {
  padding: "12px",
  color: "#6b7280",
  fontSize: 13,
  textAlign: "center",
};
