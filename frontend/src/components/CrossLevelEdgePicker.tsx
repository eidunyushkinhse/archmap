import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import type { EdgeCreate, Node } from "../types";
import { edgesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn } from "../ui/styles";

interface Props {
  title: string;
  subtitle: string;
  // узел, от которого протянули стрелку (ближний конец связи)
  sourceId: string;
  sourceLabel: string;
  // хэндл узла-источника, из которого тянули — закрепляем за концом sourceId;
  // дальний конец (выбранный узел) — дефолтная привязка
  sourceHandle: string | null;
  // плоский список узлов-кандидатов; дерево собирается из него по parent_id
  loadNodes: () => Promise<Node[]>;
  // ключ скоупа (для перезагрузки при смене источника данных)
  scopeKey: string;
  // корни дерева = узлы с этим parent_id; pathOf останавливается на нём.
  // null — корни всей схемы (parent_id == null).
  rootParentId: string | null;
  // узлы, которые нельзя выбрать (greyed, прячем из поиска) — в т.ч. сам источник
  excludeIds?: Set<string>;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * Поповер выбора дальнего конца межуровневой связи: дерево узлов-кандидатов
 * (собирается на клиенте из плоского списка по parent_id) + автокомплит по имени.
 * Один компонент для двух жестов: «связь внутрь контейнера» (скоуп — поддерево,
 * rootParentId = контейнер) и «связь к узлу вне уровня» (скоуп — вся схема,
 * rootParentId = null, недоступные узлы текущего уровня в excludeIds). Навигация
 * как в боковом дереве: по умолчанию видны прямые дети корня, раскрытие по шеврону.
 * Направление по умолчанию — от исходного узла к выбранному; тумблер разворачивает.
 */
export default function CrossLevelEdgePicker({
  title, subtitle, sourceId, sourceLabel, sourceHandle,
  loadNodes, scopeKey, rootParentId, excludeIds, onClose, onCreated,
}: Props) {
  const [allNodes, setAllNodes] = useState<Node[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Node | null>(null);
  // раскрытые узлы дерева (по умолчанию свёрнуто — видны только прямые дети корня)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // "out" — связь sourceId→выбранный (по умолчанию); "in" — выбранный→sourceId
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [label, setLabel] = useState("");
  const [technology, setTechnology] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const excluded = useMemo(() => (id: string) => excludeIds?.has(id) ?? false, [excludeIds]);

  useEffect(() => {
    let cancelled = false;
    loadNodes()
      .then((d) => { if (!cancelled) setAllNodes(d); })
      .catch(() => { if (!cancelled) { setAllNodes([]); setError("Не удалось загрузить узлы"); } });
    return () => { cancelled = true; };
    // loadNodes — нестабильная ссылка из родителя; перезагружаем по scopeKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Индексы для дерева: узел по id и дети по parent_id.
  const byId = useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of allNodes ?? []) m.set(n.id, n);
    return m;
  }, [allNodes]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, Node[]>();
    for (const n of allNodes ?? []) {
      if (!n.parent_id) continue;
      const arr = m.get(n.parent_id);
      if (arr) arr.push(n); else m.set(n.parent_id, [n]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [allNodes]);
  // Корни дерева — узлы с parent_id == rootParentId (для «вне уровня» это корни схемы).
  const roots = useMemo(
    () =>
      (allNodes ?? [])
        .filter((n) => (n.parent_id ?? null) === rootParentId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allNodes, rootParentId],
  );

  // Совпадения для автокомплита (плоский поиск, недоступные узлы скрыты).
  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (allNodes ?? []).filter((n) => !excluded(n.id) && n.name.toLowerCase().includes(q));
  }, [allNodes, query, excluded]);

  // Путь от корня скоупа до узла (без него самого) — для подсказки в дропдауне.
  const pathOf = (n: Node): string => {
    const parts: string[] = [];
    let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
    while (cur && cur.id !== rootParentId) {
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

  // Выбор из автокомплита: фиксируем узел, чистим поиск и раскрываем путь к нему.
  const pickFromSearch = (n: Node) => {
    setPicked(n);
    setQuery("");
    setExpanded((prev) => {
      const s = new Set(prev);
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      while (cur && cur.id !== rootParentId) {
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
    const isExcluded = excluded(n.id);
    return (
      <div key={n.id}>
        <div
          // Недоступный узел (текущего уровня / источник) не выбираем, но дерево
          // оставляем проходимым — его потомки могут быть валидными целями.
          onClick={() => { if (!isExcluded) setPicked(n); }}
          style={{
            ...treeRow,
            paddingLeft: 8 + depth * 16,
            background: isPicked ? "#eff6ff" : undefined,
            cursor: isExcluded ? "default" : "pointer",
            color: isExcluded ? "#9ca3af" : undefined,
          }}
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
            {isExcluded && <span style={roleMuted}>на этом уровне</span>}
          </span>
        </div>
        {hasKids && isOpen && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  async function handleCreate() {
    if (!picked) {
      setError("Выберите узел");
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
        // исходный хэндл закрепляем за концом sourceId (куда он смотрит — зависит от
        // направления), дальний конец — дефолтная привязка
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
  const farLabel = picked ? picked.name : "выбранный узел";
  const arrow = direction === "out"
    ? `${sourceLabel} → ${farLabel}`
    : `${farLabel} → ${sourceLabel}`;

  return (
    <Modal onClose={onClose} boxStyle={{ width: 440 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>{title}</h2>
        <p style={{ margin: "0 0 16px", color: "#6b7280", fontSize: 13 }}>{subtitle}</p>

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
              {allNodes === null ? (
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

        {/* Дерево: по умолчанию только прямые дети корня, раскрытие по шеврону */}
        <div style={listBox}>
          {allNodes === null ? (
            <div style={hint}>Загрузка...</div>
          ) : roots.length === 0 ? (
            <div style={hint}>Нет узлов</div>
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
