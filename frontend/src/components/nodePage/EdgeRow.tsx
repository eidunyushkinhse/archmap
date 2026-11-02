// Строка таблицы «Связи» страницы объекта (аудит F-5: вынесена из NodePage).
import type { NodeEdgeInfo } from "../../types";
import { plural } from "../../ui/plural";

// Строка таблицы связей: компактный read-only-вид. Архитектору клик по строке
// открывает модалку-редактор связи (концы, направление, описание, технология) или,
// если в строке несколько одноимённых связей, окно выбора одной из них; наблюдателю
// строки не кликабельны. Колонки «Вызывающий»/«Вызываемый» (вместо
// «Направление»/«Объект»): источник и цель связи из direction + other_node
// (outgoing → текущий узел источник, incoming → цель). Чужой узел — ссылка
// (переход), текущий — текст. count > 1 — приглушённый счётчик «×N» после описания.
export default function EdgeRow({
  edge,
  count,
  nodeName,
  isArchitect,
  onNavigateNode,
  onOpen,
}: {
  edge: NodeEdgeInfo;
  count: number;
  nodeName: string;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onOpen: () => void;
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
  const many = count > 1;

  return (
    <tr
      className={isArchitect ? "np-edge-rowclick" : undefined}
      onClick={isArchitect ? onOpen : undefined}
      title={isArchitect ? (many ? "Выбрать связь" : "Редактировать связь") : undefined}
    >
      <td>{caller}</td>
      <td className="np-edge-arrowcol">→</td>
      <td>{callee}</td>
      <td>
        {edge.label || <span className="np-value--empty">–</span>}
        {many && (
          <span className="np-edge-count" title={`${count} ${plural(count, ["связь", "связи", "связей"])}`}>
            ×{count}
          </span>
        )}
      </td>
      <td>{edge.technology || <span className="np-value--empty">–</span>}</td>
    </tr>
  );
}
