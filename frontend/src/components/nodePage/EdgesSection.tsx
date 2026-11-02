// Карточка «Связи» страницы объекта (вынесена из NodePage 2026-11-02 вместе с идеей
// владельца «связи без повторов»). Таблица — внешние связи поддерева объекта
// (GET /nodes/{id}/edges). Одноимённые связи с одним соседом в одном направлении — одна
// строка со счётчиком «×N»: десять «Пользователь → Заказы · пользуется» к разным объектам
// внутри — одна строка, а не десять одинаковых. Архитектору клик по такой строке открывает
// окно выбора, где каждая связь названа своим концом внутри объекта; одиночная строка, как
// и раньше, сразу открывает редактор связи. Карточка сворачивается; состояние одно на все
// страницы объектов и живёт в браузере.
import { useCallback, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import type { NodeEdgeInfo } from "../../types";
import { safeLocal } from "../../lib/safeStorage";
import EdgeChoiceModal from "../EdgeChoiceModal";
import { useShrinkAnchor } from "../useShrinkAnchor";
import { GroupChevron } from "./DescendantGroups";
import EdgeRow from "./EdgeRow";

// "1" — карточка свёрнута; развёрнутая (дефолт) ключа не хранит.
const COLLAPSED_KEY = "archmap-node-edges-collapsed";

// Строки таблицы: связи по ключу (направление, сосед, подпись, технология) в порядке
// первого появления. Пустая подпись и её отсутствие — одна подпись (обе рисуются «–»).
function groupRows(edges: NodeEdgeInfo[]): NodeEdgeInfo[][] {
  const rows = new Map<string, NodeEdgeInfo[]>();
  for (const e of edges) {
    const key = JSON.stringify([e.direction, e.other_node_id, e.label || "", e.technology || ""]);
    const row = rows.get(key);
    if (row) row.push(e);
    else rows.set(key, [e]);
  }
  return [...rows.values()];
}

export default function EdgesSection({ edges, nodeName, isArchitect, onNavigateNode, onEdit }: {
  edges: NodeEdgeInfo[];
  nodeName: string;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  // Открыть редактор одной связи (архитектор).
  onEdit: (edgeId: string) => void;
}) {
  const rows = useMemo(() => groupRows(edges), [edges]);
  const [open, setOpen] = useState(() => safeLocal.getItem(COLLAPSED_KEY) !== "1");
  const [choice, setChoice] = useState<NodeEdgeInfo[] | null>(null);
  const holdScroll = useShrinkAnchor();
  const toggle = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    if (open) holdScroll(e.currentTarget);
    const next = !open;
    if (next) safeLocal.removeItem(COLLAPSED_KEY);
    else safeLocal.setItem(COLLAPSED_KEY, "1");
    setOpen(next);
  }, [open, holdScroll]);

  // Пустая карточка не сворачивается: сворачивать нечего.
  if (edges.length === 0) {
    return (
      <div className="np-card">
        <h3 className="np-card-title">Связи</h3>
        <p className="np-empty">Связей нет</p>
      </div>
    );
  }

  const first = choice?.[0];
  const isOut = first?.direction === "outgoing";
  return (
    <div className="np-card">
      <h3 className="np-card-title" style={open ? undefined : { marginBottom: 0 }}>
        <button type="button" className="np-card-toggle" onClick={toggle} aria-expanded={open}>
          <GroupChevron open={open} />
          Связи
          <span className="np-card-count">· {rows.length}</span>
        </button>
      </h3>
      {open && (
        <table className="np-edges-table">
          <thead>
            <tr>
              <th>Вызывающий</th>
              <th className="np-edge-arrowcol" aria-hidden="true" />
              <th>Вызываемый</th>
              <th>Описание</th>
              <th style={{ width: 140 }}>Технология</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <EdgeRow
                key={row[0].id}
                edge={row[0]}
                count={row.length}
                nodeName={nodeName}
                isArchitect={isArchitect}
                onNavigateNode={onNavigateNode}
                onOpen={() => (row.length > 1 ? setChoice(row) : onEdit(row[0].id))}
              />
            ))}
          </tbody>
        </table>
      )}
      {/* Выбор одной из одноимённых связей строки: каждая названа своим концом внутри
          объекта (сам объект или вложенный в него). Выбор открывает редактор связи. */}
      {choice && first && (
        <EdgeChoiceModal
          edges={choice}
          sourceLabel={isOut ? nodeName : first.other_node_name}
          targetLabel={isOut ? first.other_node_name : nodeName}
          endOf={(e) => (isOut ? `${e.inner_node_name} →` : `→ ${e.inner_node_name}`)}
          onPick={(e) => { setChoice(null); onEdit(e.id); }}
          onClose={() => setChoice(null)}
        />
      )}
    </div>
  );
}
