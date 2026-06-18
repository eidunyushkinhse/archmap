// Автоопределение цели для «быстрой связи»: пользователь навёл курсор на стрелку-кнопку,
// торчащую из хэндла, — система сама подбирает узел С ПОДХОДЯЩЕЙ СТОРОНЫ относительно этого
// хэндла и относительно НЕДАЛЕКО, чтобы предложить связь без ручного протягивания.
//
// Логика (та, что в drawio/miro): из хэндла «выпускаем коридор» вдоль внешней нормали его
// стороны. Узел-кандидат должен (1) лежать ВПЕРЕДИ по этому направлению и (2) перекрывать
// коридор по перпендикулярной оси — тогда стрелка идёт почти прямо, а не наискось через весь
// холст. Кандидаты дальше лимита отбрасываем (никаких «километровых» стрелок). Из оставшихся
// берём лучший по «зазор вдоль + штраф за поперечный сдвиг» (ближе и ровнее — лучше).
//
// Чистый модуль без React — под юнит-тесты. Геометрия в координатах графа уровня.
import { NODE_W, NODE_H, hid } from "../constants";
import { orthogonalPointsForHandles, type EdgeSide } from "../edgePath";
import type { EdgePoint } from "../../../types";

// Узел-кандидат: левый-верхний угол; размеры всех узлов фиксированы (NODE_W×NODE_H).
export interface QcNode { id: string; x: number; y: number; }

export interface QcResult {
  targetId: string;
  sourcePoint: EdgePoint;
  sourceSide: EdgeSide;
  targetPoint: EdgePoint;
  targetSide: EdgeSide;
  targetHandle: string;       // hid(targetId, side, idx) — конкретный хэндл цели
  points: EdgePoint[];        // готовый ортогональный путь превью (дефолтные изломы)
}

// Доступные смещения хэндлов вдоль стороны (как SIDE_HANDLES в constants) и их индексы.
const OFFSETS = [0.25, 0.5, 0.75];

// Предельный зазор «вдоль» направления коридора (в координатах графа): за ним связь не
// предлагаем. По горизонтали допускаем дальше (узлы обычно растянуты в ряд), по вертикали —
// строже, иначе предложения «прыгали» бы через много рядов.
const MAX_ALONG_X = NODE_W * 2.4;
const MAX_ALONG_Y = NODE_H * 3;
// Полуширина коридора по перпендикулярной оси: насколько узел может быть смещён вбок от луча
// хэндла и всё ещё считаться «с этой стороны». Чуть больше половины габарита — допускаем
// разумный сдвиг ряда/колонки, но не узлы «по диагонали».
const CORRIDOR_X = NODE_H * 1.1; // для горизонтальных лучей терпим вертикальный сдвиг
const CORRIDOR_Y = NODE_W * 0.7; // для вертикальных лучей терпим горизонтальный сдвиг

// Внешняя нормаль стороны (направление выхода стрелки) и противоположная сторона у цели.
const OPPOSITE: Record<EdgeSide, EdgeSide> = {
  left: "right", right: "left", top: "bottom", bottom: "top",
};

// Якорь хэндла стороны side со смещением frac на узле с левым-верхним углом (x,y).
function anchor(x: number, y: number, side: EdgeSide, frac: number): EdgePoint {
  switch (side) {
    case "left":   return { x, y: y + frac * NODE_H };
    case "right":  return { x: x + NODE_W, y: y + frac * NODE_H };
    case "top":    return { x: x + frac * NODE_W, y };
    default:       return { x: x + frac * NODE_W, y: y + NODE_H }; // bottom
  }
}

// Подобрать узел-цель для быстрой связи от хэндла источника. Возвращает null, если
// подходящего узла рядом с нужной стороны нет.
export function findQuickConnectTarget(
  sourceId: string, sourceSide: EdgeSide, sourceFrac: number,
  sourceNode: QcNode, candidates: QcNode[],
): QcResult | null {
  const P = anchor(sourceNode.x, sourceNode.y, sourceSide, sourceFrac);
  const horizontal = sourceSide === "left" || sourceSide === "right";
  const dir = sourceSide === "right" || sourceSide === "bottom" ? 1 : -1;
  const maxAlong = horizontal ? MAX_ALONG_X : MAX_ALONG_Y;
  const corridor = horizontal ? CORRIDOR_X : CORRIDOR_Y;

  let best: QcNode | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c.id === sourceId) continue;
    // Габариты кандидата по обеим осям.
    const left = c.x, right = c.x + NODE_W, top = c.y, bottom = c.y + NODE_H;

    // Зазор «вдоль» направления: расстояние от хэндла до БЛИЖНЕЙ грани кандидата по оси луча.
    // Грань должна быть впереди (по знаку dir), иначе узел «за спиной» — пропускаем.
    let along: number;
    if (horizontal) {
      along = dir > 0 ? left - P.x : P.x - right;
    } else {
      along = dir > 0 ? top - P.y : P.y - bottom;
    }
    if (along < -1 || along > maxAlong) continue;

    // Поперечный сдвиг: насколько перпендикулярная координата хэндла выходит за пределы
    // кандидата по поперечной оси (0 — луч проходит сквозь тело кандидата).
    let perp: number;
    if (horizontal) {
      perp = P.y < top ? top - P.y : P.y > bottom ? P.y - bottom : 0;
    } else {
      perp = P.x < left ? left - P.x : P.x > right ? P.x - right : 0;
    }
    if (perp > corridor) continue;

    // Ближе и ровнее — лучше; поперечный сдвиг штрафуем сильнее зазора вдоль.
    const score = Math.max(0, along) + 1.5 * perp;
    if (score < bestScore) { bestScore = score; best = c; }
  }

  if (!best) return null;

  const targetSide = OPPOSITE[sourceSide];
  // Хэндл цели: смещение, чья якорная координата ближе всего к перпендикулярной координате
  // хэндла источника — стрелка входит в цель максимально напротив источника.
  let bestIdx = 1;
  let bestDist = Infinity;
  for (let i = 0; i < OFFSETS.length; i++) {
    const a = anchor(best.x, best.y, targetSide, OFFSETS[i]);
    const d = horizontal ? Math.abs(a.y - P.y) : Math.abs(a.x - P.x);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  const targetPoint = anchor(best.x, best.y, targetSide, OFFSETS[bestIdx]);
  const points = orthogonalPointsForHandles(
    P.x, P.y, sourceSide, targetPoint.x, targetPoint.y, targetSide,
  );

  return {
    targetId: best.id,
    sourcePoint: P,
    sourceSide,
    targetPoint,
    targetSide,
    targetHandle: hid(best.id, targetSide, bestIdx),
    points,
  };
}
