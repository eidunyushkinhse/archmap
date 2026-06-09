// Превью-линия React Flow: рисуется при протягивании НОВОЙ связи от хэндла и при
// перетаскивании конца существующей (reconnect). Дефолтная линия RF — без наконечника,
// поэтому, перетаскивая конец, пользователь видел «голую» линию и мог решить, что связь
// развёрнута не в ту сторону. Здесь добавляем наконечник на конце, ПРОТИВОПОЛОЖНОМ
// удерживаемому хэндлу (fromHandle — стационарный конец):
//   • тащим target / создаём новую (fromHandle.type === "source") → наконечник на курсоре;
//   • тащим source (fromHandle.type === "target") → наконечник на стационарном target-конце.
// В ОБОИХ случаях наконечник ставим через markerEnd (а не markerStart): у markerEnd тело
// маркера уходит ОТ границы узла наружу, наконечник смотрит внутрь и сидит ровно на хэндле —
// та же геометрия, что у штатной стрелки. При markerStart с reverse-ориентацией тело маркера
// уходило по ходу пути, т.е. ВНУТРЬ узла, отчего наконечник «проваливался» в стационарный узел.
// Чтобы всегда пользоваться markerEnd, когда голова на стационарном конце, строим путь в
// обратную сторону: курсор → стационарный конец (стационарный конец становится концом пути).
import { getSmoothStepPath, type ConnectionLineComponentProps } from "@xyflow/react";

// тот же серый, что у маркера обычных рёбер (MarkerType.ArrowClosed в LevelGraph)
const COLOR = "#6b7280";

export default function ConnectionLine({
  fromX, fromY, toX, toY, fromPosition, toPosition, fromHandle,
}: ConnectionLineComponentProps) {
  // Удерживаем target-конец → наконечник на стационарном (from), иначе — на курсоре (to).
  const headAtFrom = fromHandle?.type === "target";
  // Путь всегда оканчивается на конце с наконечником (для единой геометрии markerEnd):
  // headAtFrom → строим от курсора к стационарному концу; иначе — от стационарного к курсору.
  const [path] = headAtFrom
    ? getSmoothStepPath({
        sourceX: toX, sourceY: toY, sourcePosition: toPosition,
        targetX: fromX, targetY: fromY, targetPosition: fromPosition,
        borderRadius: 12,
      })
    : getSmoothStepPath({
        sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition,
        targetX: toX, targetY: toY, targetPosition: toPosition,
        borderRadius: 12,
      });
  return (
    <g>
      <defs>
        <marker
          id="lg-conn-arrow"
          markerWidth="12"
          markerHeight="12"
          refX="8"
          refY="5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L9,5 L0,10 z" fill={COLOR} />
        </marker>
      </defs>
      <path
        d={path}
        fill="none"
        stroke={COLOR}
        strokeWidth={1.5}
        markerEnd="url(#lg-conn-arrow)"
      />
    </g>
  );
}
