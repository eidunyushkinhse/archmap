// Превью-линия React Flow: рисуется при протягивании НОВОЙ связи от хэндла и при
// перетаскивании конца существующей (reconnect). Дефолтная линия RF — без наконечника,
// поэтому, перетаскивая конец, пользователь видел «голую» линию и мог решить, что связь
// развёрнута не в ту сторону. Здесь добавляем наконечник на конце, ПРОТИВОПОЛОЖНОМ
// удерживаемому хэндлу (fromHandle — стационарный конец):
//   • тащим target / создаём новую (fromHandle.type === "source") → наконечник на курсоре;
//   • тащим source (fromHandle.type === "target") → наконечник на стационарном target-конце.
//
// Наконечник рисуем ЯВНЫМ треугольником, а не SVG-маркером (markerStart/End). У маркера
// положение и ориентация зависят от направления пути и refX, и при некоторых ракурсах он
// телом «проваливался» внутрь стационарного узла. Тут вершина треугольника ставится точно
// на конец (хэндл), а тело уходит НАРУЖУ по нормали стороны хэндла — наконечник всегда сидит
// снаружи границы и смотрит внутрь, провалиться внутрь узла физически не может.
import { getSmoothStepPath, Position, type ConnectionLineComponentProps } from "@xyflow/react";

// тот же серый, что у маркера обычных рёбер (MarkerType.ArrowClosed в LevelGraph)
const COLOR = "#6b7280";
const HEAD_LEN = 9;   // длина наконечника вдоль линии
const HEAD_HALF = 5;  // полуширина основания наконечника

// Единичная нормаль, направленная ВНУТРЬ узла от хэндла на стороне pos (куда смотрит стрелка).
function inwardNormal(pos: Position): { x: number; y: number } {
  switch (pos) {
    case Position.Left:   return { x: 1, y: 0 };   // хэндл слева → узел справа
    case Position.Right:  return { x: -1, y: 0 };
    case Position.Top:    return { x: 0, y: 1 };    // хэндл сверху → узел снизу
    default:              return { x: 0, y: -1 };   // Bottom
  }
}

// Треугольник-наконечник: вершина в (tipX,tipY) на хэндле, тело отведено НАРУЖУ (−нормаль),
// смотрит внутрь узла. Перпендикуляр даёт основание шириной 2*HEAD_HALF.
function arrowHeadPath(tipX: number, tipY: number, pos: Position): string {
  const n = inwardNormal(pos);
  const baseX = tipX - n.x * HEAD_LEN, baseY = tipY - n.y * HEAD_LEN;
  const px = -n.y, py = n.x; // перпендикуляр к нормали
  const b1x = baseX + px * HEAD_HALF, b1y = baseY + py * HEAD_HALF;
  const b2x = baseX - px * HEAD_HALF, b2y = baseY - py * HEAD_HALF;
  return `M ${tipX},${tipY} L ${b1x},${b1y} L ${b2x},${b2y} z`;
}

export default function ConnectionLine({
  fromX, fromY, toX, toY, fromPosition, toPosition, fromHandle,
}: ConnectionLineComponentProps) {
  const [path] = getSmoothStepPath({
    sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition,
    targetX: toX, targetY: toY, targetPosition: toPosition,
    borderRadius: 12,
  });
  // Удерживаем target-конец → наконечник на стационарном (from), иначе — на курсоре (to).
  const headAtFrom = fromHandle?.type === "target";
  const head = headAtFrom
    ? arrowHeadPath(fromX, fromY, fromPosition)
    : arrowHeadPath(toX, toY, toPosition);
  return (
    <g>
      <path d={path} fill="none" stroke={COLOR} strokeWidth={1.5} />
      <path d={head} fill={COLOR} stroke="none" />
    </g>
  );
}
