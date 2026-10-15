// Строка таблицы «Связи» страницы объекта (аудит F-5: вынесена из NodePage).
import type { NodeEdgeInfo } from "../../types";

// Строка таблицы связей: компактный read-only-вид. Архитектору клик по строке
// открывает модалку-редактор связи (концы, направление, описание, технология);
// наблюдателю строки не кликабельны. Колонки «Вызывающий»/«Вызываемый» (вместо
// «Направление»/«Объект»): источник и цель связи из direction + other_node
// (outgoing → текущий узел источник, incoming → цель). Чужой узел — ссылка
// (переход), текущий — текст.
export default function EdgeRow({
  edge,
  nodeName,
  isArchitect,
  onNavigateNode,
  onEdit,
}: {
  edge: NodeEdgeInfo;
  nodeName: string;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onEdit: (edgeId: string) => void;
}) {
  const isOut = edge.direction === "outgoing";

  // stopPropagation: переход на чужой узел не должен открывать модалку строки
  const otherLink = (
    <button
      className="np-edge-link"
      onClick={(e) => { e.stopPropagation(); onNavigateNode(edge.other_node_id); }}
    >
      {edge.other_node_name}
    </button>
  );
  const selfName = <span className="np-edge-self">{nodeName}</span>;
  const caller = isOut ? selfName : otherLink;
  const callee = isOut ? otherLink : selfName;

  return (
    <tr
      className={isArchitect ? "np-edge-rowclick" : undefined}
      onClick={isArchitect ? () => onEdit(edge.id) : undefined}
      title={isArchitect ? "Редактировать связь" : undefined}
    >
      <td>{caller}</td>
      <td className="np-edge-arrowcol">→</td>
      <td>{callee}</td>
      <td>{edge.label || <span className="np-value--empty">–</span>}</td>
      <td>{edge.technology || <span className="np-value--empty">–</span>}</td>
    </tr>
  );
}
