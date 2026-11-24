// Строка таблицы «Связи» страницы объекта (аудит F-5: вынесена из NodePage).
import type { NodeEdgeInfo } from "../../types";
import { plural } from "../../ui/plural";
import "../../ui/ds.css";
import "./edges.css";

// Строка таблицы связей. Колонка «Объект» — стрелка направления и сосед: «→ Kafka» —
// объект вызывает Kafka, «← API Gateway» — вызывается из него (слово — в подсказке
// стрелки). Сосед — ссылка на его страницу. Архитектору клик по строке открывает
// редактор связи или, если в строке несколько одноимённых связей, окно выбора одной из
// них; наблюдателю строки не кликабельны. count > 1 — тихий счётчик «×N» после описания.
export default function EdgeRow({
  edge,
  count,
  isArchitect,
  onNavigateNode,
  onOpen,
}: {
  edge: NodeEdgeInfo;
  count: number;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onOpen: () => void;
}) {
  const isOut = edge.direction === "outgoing";
  const many = count > 1;

  return (
    <tr
      className={isArchitect ? "np-edge-rowclick" : undefined}
      onClick={isArchitect ? onOpen : undefined}
      title={isArchitect ? (many ? "Выбрать связь" : "Редактировать связь") : undefined}
    >
      <td>
        <span className="np-edge-dir" title={isOut ? "вызывает" : "вызывается из"}>
          {isOut ? "→" : "←"}
        </span>
        {/* stopPropagation: переход на соседа не должен открывать редактор строки */}
        <button
          type="button"
          className="np-edge-link"
          onClick={(e) => { e.stopPropagation(); onNavigateNode(edge.other_node_id); }}
        >
          {edge.other_node_name}
        </button>
      </td>
      <td>
        {edge.label || <span className="ds-empty">—</span>}
        {many && (
          <span className="np-edge-count" title={`${count} ${plural(count, ["связь", "связи", "связей"])}`}>
            ×{count}
          </span>
        )}
      </td>
      <td>{edge.technology || <span className="ds-empty">—</span>}</td>
    </tr>
  );
}
