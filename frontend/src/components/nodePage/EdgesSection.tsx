// Раздел «Связи» страницы объекта (вынесен из NodePage 2026-11-02 вместе с идеей
// владельца «связи без повторов»). Таблица — внешние связи поддерева объекта
// (GET /nodes/{id}/edges). Одноимённые связи с одним соседом в одном направлении — одна
// строка с тихим счётчиком «×N»: десять «Пользователь → Заказы · пользуется» к разным
// объектам внутри — одна строка, а не десять одинаковых. Архитектору клик по такой строке
// открывает окно выбора, где каждая связь названа своим концом внутри объекта; одиночная
// строка сразу открывает редактор связи.
//
// Вид (редизайн, направление А «Документ»): тихая таблица из трёх колонок — «Объект»
// (стрелка направления и сосед), «Описание», «Технология»; без счётчика и свёртки. Связей
// нет — раздела нет.
import { useMemo, useState } from "react";
import type { NodeEdgeInfo } from "../../types";
import EdgeChoiceModal from "../EdgeChoiceModal";
import EdgeRow from "./EdgeRow";
import Section from "../../ui/Section";
import "../../ui/ds.css";
import "./edges.css";

// Строки таблицы: связи по ключу (направление, сосед, подпись, технология) в порядке
// первого появления. Пустая подпись и её отсутствие — одна подпись (обе рисуются «—»).
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
  const [choice, setChoice] = useState<NodeEdgeInfo[] | null>(null);

  if (edges.length === 0) return null;

  const first = choice?.[0];
  const isOut = first?.direction === "outgoing";
  return (
    <Section title="Связи">
      <table className="ds-table np-edges">
        <thead>
          <tr>
            <th>Объект</th>
            <th>Описание</th>
            <th className="np-edges-tech">Технология</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <EdgeRow
              key={row[0].id}
              edge={row[0]}
              count={row.length}
              isArchitect={isArchitect}
              onNavigateNode={onNavigateNode}
              onOpen={() => (row.length > 1 ? setChoice(row) : onEdit(row[0].id))}
            />
          ))}
        </tbody>
      </table>
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
    </Section>
  );
}
