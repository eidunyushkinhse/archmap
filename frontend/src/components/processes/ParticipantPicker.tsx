// Выбор участников процесса деревом узлов C4 (а не поиском по имени): браузишь
// архитектуру глазами. Раскрытие шевронами, фильтр по имени (раскрывает путь к
// совпадениям), мультивыбор чекбоксами и добавление пачкой. Уже добавленные участники
// помечены и недоступны. Дерево собирается на клиенте из плоского /nodes/all.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";
import { Chevron, ShapeGlyph } from "../nodeTree.shared";
import { IcoSearch } from "./icons";
import { BPT } from "./tokens";
import "../NodeTreePanel.css";
import { noAutofill } from "../../ui/noAutofill";

interface Props {
  added: Set<string>; // node_id уже добавленных участников
  onAdd: (nodeIds: string[]) => void; // добавить выбранную пачку
}

export default function ParticipantPicker({ added, onAdd }: Props) {
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    nodesApi
      .getAll()
      .then((ns) => alive && setNodes(ns))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Не удалось загрузить узлы"));
    return () => { alive = false; };
  }, []);

  // Дерево: дети по parent_id + корни; сорт по имени.
  const { childrenOf, byId, roots } = useMemo(() => {
    const childrenOf: Record<string, Node[]> = {};
    const byId: Record<string, Node> = {};
    const roots: Node[] = [];
    for (const n of nodes ?? []) byId[n.id] = n;
    for (const n of nodes ?? []) {
      if (n.parent_id && byId[n.parent_id]) (childrenOf[n.parent_id] ??= []).push(n);
      else roots.push(n);
    }
    const cmp = (a: Node, b: Node) => a.name.localeCompare(b.name);
    roots.sort(cmp);
    for (const k of Object.keys(childrenOf)) childrenOf[k].sort(cmp);
    return { childrenOf, byId, roots };
  }, [nodes]);

  // Фильтр: видимые = совпавшие по имени + их предки (чтобы путь был виден); предки
  // авто-раскрываются. Пустой запрос — фильтра нет, раскрытие ручное (expanded).
  const q = query.trim().toLowerCase();
  const { visible, autoExpand } = useMemo(() => {
    if (!q) return { visible: null as Set<string> | null, autoExpand: new Set<string>() };
    const visible = new Set<string>();
    const autoExpand = new Set<string>();
    for (const n of nodes ?? []) {
      if (!n.name.toLowerCase().includes(q)) continue;
      visible.add(n.id);
      let p = n.parent_id;
      while (p && byId[p]) { visible.add(p); autoExpand.add(p); p = byId[p].parent_id; }
    }
    return { visible, autoExpand };
  }, [q, nodes, byId]);

  const isOpen = (id: string) => (q ? autoExpand.has(id) : expanded.has(id));
  const toggleOpen = (id: string) =>
    setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSel = (id: string) => {
    if (added.has(id)) return;
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  function renderRow(n: Node, depth: number): ReactNode {
    if (visible && !visible.has(n.id)) return null;
    const kids = childrenOf[n.id] ?? [];
    const hasKids = kids.length > 0;
    const open = isOpen(n.id);
    const isAdded = added.has(n.id);
    const isSel = selected.has(n.id);
    return (
      <div key={n.id}>
        <div style={{ ...row, paddingLeft: 6 + depth * 16, opacity: isAdded ? 0.5 : 1 }}>
          <span
            onClick={hasKids ? () => toggleOpen(n.id) : undefined}
            style={{
              width: 14, height: 14, display: "inline-flex", alignItems: "center",
              color: BPT.mut, cursor: hasKids ? "pointer" : "default",
              transform: open ? "rotate(90deg)" : "none", transition: "transform .12s",
            }}
          >
            {hasKids ? <Chevron /> : null}
          </span>
          <input
            type="checkbox"
            checked={isAdded || isSel}
            disabled={isAdded}
            onChange={() => toggleSel(n.id)}
            style={{ cursor: isAdded ? "default" : "pointer", flex: "none" }}
          />
          <span style={{ color: n.is_external ? BPT.mut : BPT.sec, display: "inline-flex", flex: "none" }}>
            <ShapeGlyph container={hasKids} shape={n.shape} />
          </span>
          <span
            onClick={() => toggleSel(n.id)}
            style={{ fontSize: 13, color: BPT.head, cursor: isAdded ? "default" : "pointer", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {n.name}
          </span>
          {isAdded && <span style={{ fontSize: 10, color: BPT.mut, flex: "none" }}>в процессе</span>}
        </div>
        {open && hasKids && kids.map((k) => renderRow(k, depth + 1))}
      </div>
    );
  }

  function add() {
    if (selected.size === 0) return;
    onAdd([...selected]);
    setSelected(new Set());
  }

  return (
    <div>
      <div style={searchWrap}>
        <span style={{ color: BPT.mut, display: "inline-flex", flex: "none" }}>
          <IcoSearch s={14} />
        </span>
        <input
          {...noAutofill("participant-picker-1")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Фильтр по имени…"
          style={{ border: "none", outline: "none", fontSize: 13, flex: 1, background: "transparent", color: BPT.head }}
        />
      </div>
      <div style={listBox}>
        {error ? (
          <div style={{ fontSize: 12, color: "#dc2626", padding: 8 }}>{error}</div>
        ) : nodes === null ? (
          <div style={{ fontSize: 12, color: BPT.mut, padding: 8 }}>Загрузка…</div>
        ) : roots.length === 0 ? (
          <div style={{ fontSize: 12, color: BPT.mut, padding: 8 }}>В схеме нет узлов</div>
        ) : (
          roots.map((r) => renderRow(r, 0))
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <button className="bp-btn-primary" onClick={add} disabled={selected.size === 0}>
          {selected.size > 0 ? `Добавить (${selected.size})` : "Добавить"}
        </button>
      </div>
    </div>
  );
}

const searchWrap: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  height: 34,
  padding: "0 10px",
  border: "1px solid " + BPT.line,
  borderRadius: 8,
  marginBottom: 8,
};
const listBox: CSSProperties = {
  maxHeight: 260,
  overflow: "auto",
  border: "1px solid " + BPT.line,
  borderRadius: 8,
  padding: "4px 2px",
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "3px 8px 3px 0",
  borderRadius: 6,
};
