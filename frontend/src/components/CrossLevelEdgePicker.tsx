import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { Edge, EdgeCreate, Node } from "../types";
import { compareByRank } from "../types";
import { edgesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn } from "../ui/styles";

interface Props {
  title: string;
  subtitle: string;
  // Узел, от которого протянули стрелку (ближний конец связи). Хэндл жеста связь
  // больше не несёт (R3): геометрию пучка display-пары сохраняет TreePage после
  // onCreated (направление выводит из created.source_id).
  sourceId: string;
  sourceLabel: string;
  // плоский список узлов-кандидатов; дерево собирается из него по parent_id
  loadNodes: () => Promise<Node[]>;
  // ключ скоупа (для перезагрузки при смене источника данных)
  scopeKey: string;
  // корни дерева = узлы с этим parent_id; pathOf останавливается на нём.
  // null — корни всей схемы (parent_id == null).
  rootParentId: string | null;
  // узлы, которые нельзя выбрать (greyed, не считаются совпадениями) — в т.ч. сам источник
  excludeIds?: Set<string>;
  // подпись пустого слота цели (различает жесты: «вне уровня» / «внутрь контейнера»)
  slotPlaceholder: string;
  onClose: () => void;
  // created — созданная связь (для отката создания через Undo в TreePage).
  onCreated: (created: Edge) => void;
}

/**
 * Поповер выбора дальнего конца межуровневой связи: визуальный «маршрут»
 * [источник] → [слот цели] над деревом узлов-кандидатов (собирается на клиенте
 * из плоского списка по parent_id). Один компонент для двух жестов: «связь внутрь
 * контейнера» (скоуп — поддерево, rootParentId = контейнер) и «связь к узлу вне
 * уровня» (скоуп — вся схема, rootParentId = null, недоступные узлы в excludeIds).
 * Поиск фильтрует дерево на месте (совпадения + их предки, авто-раскрытие), а не
 * открывает отдельный дропдаун. Направление по умолчанию — от источника к цели;
 * кнопка на линии разворачивает, не меняя элементы местами.
 */
export default function CrossLevelEdgePicker({
  title, subtitle, sourceId, sourceLabel,
  loadNodes, scopeKey, rootParentId, excludeIds, slotPlaceholder, onClose, onCreated,
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
  // прокрутка к выбранной строке после выбора из поиска
  const pickedRowRef = useRef<HTMLDivElement | null>(null);

  const excluded = useMemo(() => (id: string) => excludeIds?.has(id) ?? false, [excludeIds]);

  useEffect(() => {
    let cancelled = false;
    loadNodes()
      .then((d) => { if (!cancelled) setAllNodes(d); })
      .catch(() => { if (!cancelled) { setAllNodes([]); setError("Не удалось загрузить объекты"); } });
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
    for (const arr of m.values()) arr.sort(compareByRank);
    return m;
  }, [allNodes]);
  // Корни дерева — узлы с parent_id == rootParentId (для «вне уровня» это корни схемы).
  const roots = useMemo(
    () =>
      (allNodes ?? [])
        .filter((n) => (n.parent_id ?? null) === rootParentId)
        .sort(compareByRank),
    [allNodes, rootParentId],
  );

  const q = query.trim().toLowerCase();
  const filtering = q.length > 0;

  // Фильтр дерева: при непустом запросе видимы узлы-совпадения и все их предки
  // (ветки к совпадениям авто-раскрыты). expanded НЕ мутируем — это производное
  // отображение. null = фильтр выключен (показываем обычное дерево по expanded).
  const visibleIds = useMemo<Set<string> | null>(() => {
    if (!filtering) return null;
    const ids = new Set<string>();
    for (const n of allNodes ?? []) {
      if (excluded(n.id) || !n.name.toLowerCase().includes(q)) continue;
      ids.add(n.id);
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      while (cur && cur.id !== rootParentId) {
        ids.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
    }
    return ids;
  }, [allNodes, q, filtering, excluded, byId, rootParentId]);

  // Путь от корня скоупа до узла (без него самого) — подпись под именем в слоте.
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

  // Выбор узла: фиксируем, чистим поиск и раскрываем путь к нему (чтобы после
  // очистки фильтра строка осталась видна в обычном дереве).
  const selectNode = (n: Node) => {
    setPicked(n);
    if (query) setQuery("");
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

  // Прокрутить выбранную строку в зону видимости (после выбора из поиска).
  useEffect(() => {
    pickedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  // Подсветка совпавшего фрагмента имени (только при активном фильтре).
  const highlight = (name: string): ReactNode => {
    if (!filtering) return name;
    const idx = name.toLowerCase().indexOf(q);
    if (idx === -1) return name;
    return (
      <>
        {name.slice(0, idx)}
        <mark style={markStyle}>{name.slice(idx, idx + q.length)}</mark>
        {name.slice(idx + q.length)}
      </>
    );
  };

  const renderNode = (n: Node, depth: number): ReactElement | null => {
    // В режиме фильтра показываем только узлы из visibleIds (совпадения + предки).
    if (visibleIds && !visibleIds.has(n.id)) return null;
    const kids = childrenOf.get(n.id) ?? [];
    const visibleKids = visibleIds ? kids.filter((k) => visibleIds.has(k.id)) : kids;
    const showChev = visibleKids.length > 0;
    const isOpen = visibleIds ? true : expanded.has(n.id);
    const isPicked = picked?.id === n.id;
    const isExcluded = excluded(n.id);
    return (
      <div key={n.id}>
        <div
          ref={isPicked ? pickedRowRef : undefined}
          // Недоступный узел (текущего уровня / источник) не выбираем, но дерево
          // оставляем проходимым — его потомки могут быть валидными целями.
          onClick={() => { if (!isExcluded) selectNode(n); }}
          style={{
            ...treeRow,
            paddingLeft: 8 + depth * 16,
            background: isPicked ? "#eff6ff" : undefined,
            cursor: isExcluded ? "default" : "pointer",
            color: isExcluded ? "#94a3b8" : undefined,
          }}
        >
          {showChev ? (
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
          <span style={{ flex: 1, fontWeight: isPicked ? 600 : undefined, color: isPicked ? "#1d4ed8" : undefined }}>
            {highlight(n.name)}
            {n.role && <span style={roleMuted}>({n.role})</span>}
            {isExcluded && <span style={roleMuted}>на этом уровне</span>}
          </span>
          {isPicked && <span style={checkMark}>✓</span>}
        </div>
        {isOpen && visibleKids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  async function handleCreate() {
    if (!picked) {
      setError("Выберите объект");
      return;
    }
    if (picked.id === sourceId) {
      setError("Объект не может ссылаться сам на себя");
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
      const created = await edgesApi.create(data);
      onCreated(created);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка создания связи");
    } finally {
      setSaving(false);
    }
  }

  const pickedPath = picked ? pathOf(picked) : "";

  return (
    <Modal onClose={onClose} boxStyle={{ width: 440 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 18, color: "#1e293b" }}>{title}</h2>
      <p style={{ margin: "0 0 16px", color: "#64748b", fontSize: 13 }}>{subtitle}</p>

      {/* Маршрут: чип источника ——стрелка——> слот цели. Позиции фиксированы
          (источник всегда слева); направление показывает только сторона стрелки. */}
      <div style={routeRow}>
        <span style={chip}>{sourceLabel}</span>
        <div style={routeLine}>
          {/* стрелка у левого конца при "in" (смотрит в источник) */}
          {direction === "in" && <span style={arrowLeft} />}
          <div style={routeRule} />
          {/* стрелка у правого конца при "out" (смотрит в слот) */}
          {direction === "out" && <span style={arrowRight} />}
          <button
            onClick={() => setDirection((d) => (d === "out" ? "in" : "out"))}
            style={swapBtn}
            title="Поменять направление"
          >⇄</button>
        </div>
        {picked ? (
          <div style={slotFilled} onClick={() => setPicked(null)} title="Снять выбор">
            <span style={slotName}>{picked.name}</span>
            {pickedPath && <span style={slotPath}>{pickedPath}</span>}
          </div>
        ) : (
          <span style={slotEmpty}>{slotPlaceholder}</span>
        )}
      </div>

      {/* Поиск фильтрует дерево на месте (без дропдауна) */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Найти объект…"
        style={{ ...input, marginBottom: 10 }}
        data-autofocus
      />

      {/* Дерево: по умолчанию только прямые дети корня; при поиске — отфильтровано */}
      <div style={listBox}>
        {allNodes === null ? (
          <div style={hint}>Загрузка…</div>
        ) : roots.length === 0 ? (
          <div style={hint}>Нет объектов</div>
        ) : visibleIds && visibleIds.size === 0 ? (
          <div style={hint}>Ничего не найдено</div>
        ) : (
          roots.map((n) => renderNode(n, 0))
        )}
      </div>

      {/* Описание и технология — в одну строку */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div>
          <label style={labelStyle}>Описание</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="запрос, событие…"
            style={{ ...input, marginBottom: 0 }}
          />
        </div>
        <div>
          <label style={labelStyle}>Технология</label>
          <input
            value={technology}
            onChange={(e) => setTechnology(e.target.value)}
            placeholder="REST, Kafka…"
            style={{ ...input, marginBottom: 0 }}
          />
        </div>
      </div>

      {error && <p style={{ color: "#dc2626", margin: "8px 0", fontSize: 13 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={handleCreate} disabled={saving || !picked} style={primaryBtn}>
          {saving ? "Создание…" : "Создать связь"}
        </button>
        <button onClick={onClose} style={secondaryBtn}>Отмена</button>
      </div>
    </Modal>
  );
}

// --- Маршрут (шапка) ---
const routeRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 16,
};
const chip: CSSProperties = {
  flex: "none",
  padding: "7px 13px",
  border: "1.5px solid #cbd5e1",
  borderRadius: 10,
  background: "#fff",
  fontSize: 13,
  fontWeight: 600,
  color: "#475569",
  boxShadow: "0 1px 2px rgba(15,23,42,.08)",
};
const routeLine: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 56,
  height: 24,
  display: "flex",
  alignItems: "center",
};
const routeRule: CSSProperties = {
  flex: 1,
  height: 2,
  background: "#94a3b8",
};
// Треугольники-наконечники на концах линии (CSS-бордеры).
const arrowRight: CSSProperties = {
  width: 0,
  height: 0,
  borderTop: "5px solid transparent",
  borderBottom: "5px solid transparent",
  borderLeft: "8px solid #94a3b8",
  flex: "none",
};
const arrowLeft: CSSProperties = {
  width: 0,
  height: 0,
  borderTop: "5px solid transparent",
  borderBottom: "5px solid transparent",
  borderRight: "8px solid #94a3b8",
  flex: "none",
};
const swapBtn: CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%,-50%)",
  width: 24,
  height: 24,
  borderRadius: "50%",
  border: "1px solid #e2e8f0",
  background: "#fff",
  boxShadow: "0 1px 3px rgba(15,23,42,.15)",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#475569",
  padding: 0,
};
const slotBase: CSSProperties = {
  flex: "none",
  maxWidth: 170,
  borderRadius: 10,
  transition: "border-color .12s ease, background .12s ease",
};
const slotEmpty: CSSProperties = {
  ...slotBase,
  padding: "7px 13px",
  border: "1.5px dashed #60a5fa",
  background: "#eff6ff",
  fontSize: 13,
  fontWeight: 500,
  color: "#60a5fa",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const slotFilled: CSSProperties = {
  ...slotBase,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  padding: "5px 13px",
  border: "1.5px solid #2563eb",
  background: "#dbeafe",
  cursor: "pointer",
};
const slotName: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#1d4ed8",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const slotPath: CSSProperties = {
  fontSize: 10.5,
  color: "#3b82f6",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// --- Дерево ---
const listBox: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
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
  color: "#94a3b8",
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
  color: "#94a3b8",
  marginLeft: 6,
  fontSize: 12,
};
const checkMark: CSSProperties = {
  marginLeft: "auto",
  color: "#2563eb",
  fontWeight: 700,
};
const markStyle: CSSProperties = {
  background: "#dbeafe",
  color: "#1d4ed8",
  borderRadius: 2,
};
const hint: CSSProperties = {
  padding: "12px",
  color: "#64748b",
  fontSize: 13,
  textAlign: "center",
};
