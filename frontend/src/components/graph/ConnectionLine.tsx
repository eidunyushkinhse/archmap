// Превью-линия React Flow: рисуется при протягивании НОВОЙ связи от хэндла и при
// перетаскивании конца существующей (reconnect). Дефолтная линия RF — без наконечника,
// поэтому, перетаскивая конец, пользователь видел «голую» линию и мог решить, что связь
// развёрнута не в ту сторону. Здесь добавляем наконечник на конце, ПРОТИВОПОЛОЖНОМ
// удерживаемому хэндлу (fromHandle — стационарный конец), с auto-ориентацией по пути:
//   • тащим target / создаём новую (fromHandle.type === "source") → наконечник на курсоре
//     (markerEnd, конец пути);
//   • тащим source (fromHandle.type === "target") → наконечник на стационарном target-конце
//     (markerStart с auto-start-reverse, чтобы смотрел В узел, а не из него).
import { getSmoothStepPath, type ConnectionLineComponentProps } from "@xyflow/react";

// тот же серый, что у маркера обычных рёбер (MarkerType.ArrowClosed в LevelGraph)
const COLOR = "#6b7280";

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
  return (
    <g>
      <defs>
        {/* Точная копия маркера MarkerType.ArrowClosed из React Flow (см. LevelGraph),
            чтобы наконечник превью совпал по размеру со статичной стрелкой: те же viewBox,
            размеры и markerUnits="strokeWidth" — наконечник масштабируется от strokeWidth
            линии (у обоих 1.5), а не фиксирован в пикселях. */}
        <marker
          id="lg-conn-arrow"
          markerWidth="12.5"
          markerHeight="12.5"
          viewBox="-10 -10 20 20"
          refX="0"
          refY="0"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <polyline
            points="-5,-4 0,0 -5,4 -5,-4"
            stroke={COLOR}
            fill={COLOR}
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
      <path
        d={path}
        fill="none"
        stroke={COLOR}
        strokeWidth={1.5}
        markerEnd={headAtFrom ? undefined : "url(#lg-conn-arrow)"}
        markerStart={headAtFrom ? "url(#lg-conn-arrow)" : undefined}
      />
    </g>
  );
}
