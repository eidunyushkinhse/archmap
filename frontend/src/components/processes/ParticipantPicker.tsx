// Выбор участников процесса деревом узлов C4 (а не поиском по имени): браузишь
// архитектуру глазами. Раскрытие шевронами, фильтр по имени (раскрывает путь к
// совпадениям), мультивыбор чекбоксами и добавление пачкой. Уже добавленные участники
// помечены и недоступны. Дерево собирается на клиенте из плоского /nodes/all. Источник
// объектов и правило отбора участников общие с окном импорта (schemaNodes).
// Вид — новый язык (редизайн, фаза 13г; processes.css, блок «Выбор объектов»): поле
// поиска ds-input без значка, как в дереве объектов слева; дерево в рамке, строки 28px;
// «Добавить» главной кнопкой у левого края под деревом.
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Node } from "../../types";
import { treeNesting } from "../../types";
import { Chevron, ShapeGlyph } from "../nodeTree.shared";
import "../NodeTreePanel.css";
import "../../ui/ds.css";
import "./processes.css";
import { noAutofill } from "../../ui/noAutofill";
import { useSchemaNodes } from "./schemaNodes";

interface Props {
  added: Set<string>; // node_id уже добавленных участников
  onAdd: (nodeIds: string[]) => void; // добавить выбранную пачку
}

export default function ParticipantPicker({ added, onAdd }: Props) {
  const { nodes, error, request } = useSchemaNodes();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Пикер открыт — объекты нужны сразу.
  useEffect(() => { request(); }, [request]);

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
        {/* Отступ уровня — единственное вычисляемое свойство строки. */}
        <div className={"pp-row" + (isAdded ? " is-added" : "")} style={{ paddingLeft: 6 + depth * 16 }}>
          <span
            className={"pp-chev" + (hasKids ? " has-kids" : "") + (open ? " is-open" : "")}
            onClick={hasKids ? () => toggleOpen(n.id) : undefined}
          >
            {hasKids ? <Chevron /> : null}
          </span>
          <input
            type="checkbox"
            checked={isAdded || isSel}
            disabled={isAdded}
            onChange={() => toggleSel(n.id)}
          />
          {/* Глиф — как в дереве объектов: пустая система (лист с элементом «система»,
              Р39) и внешняя система (Р42) рисуются системой, а не листом */}
          <ShapeGlyph nesting={treeNesting(n)} shape={n.shape} />
          <span className="pp-name" onClick={() => toggleSel(n.id)}>
            {n.name}
          </span>
          {isAdded && <span className="pp-added">в процессе</span>}
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
    <div className="pp">
      <input
        {...noAutofill("participant-picker-1")}
        className="ds-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск по имени"
      />
      <div className="pp-tree">
        {error ? (
          <p className="ds-danger pp-note">{error}</p>
        ) : nodes === null ? (
          <p className="ds-empty pp-note">Загрузка</p>
        ) : roots.length === 0 ? (
          <p className="ds-empty pp-note">В схеме нет объектов</p>
        ) : (
          roots.map((r) => renderRow(r, 0))
        )}
      </div>
      <div className="pp-foot">
        <button type="button" className="ds-btn ds-btn--primary" onClick={add} disabled={selected.size === 0}>
          {selected.size > 0 ? `Добавить (${selected.size})` : "Добавить"}
        </button>
      </div>
    </div>
  );
}
