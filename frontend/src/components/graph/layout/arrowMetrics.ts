// Метрики качества раскладки стрелок и плашек — измерительный инструмент эпика
// (ARROWS_ROUTING_ANALYSIS.md, фаза A0). Чистые функции над ФИНАЛЬНОЙ геометрией уровня:
// считают нарушения требований, чтобы сравнивать «до/после» и держать под тестом качество.
//   • labelOverlaps     — пары наложенных плашек (R2: не наползают друг на друга)
//   • labelsUnderNodes   — плашки, задевающие тело узла (R2: не под узлами)
//   • edgeCrossings      — пересечения стрелок (R3: минимум пересечений)
//
// Определение пересечения стрелок берём из edgeJumps.computeJumps (перпендикулярный
// «крестик» строго внутри обоих сегментов): коллинеарный совместный ход (R4) НЕ считается
// пересечением, общие хэндлы/углы/T-стыки исключены. Так метрика согласована с тем, что
// рисуется мостиками.
import type { EdgePoint } from "../../../types";
import type { NodeRect } from "../edgePath";
import { computeJumps } from "../edgeJumps";

// Допуск: касание «впритык» (общая граница) не считается наложением.
const EPS = 0.5;

// Прямоугольник из центра и габаритов — плашка рендерится центрированной на (labelX,labelY).
export function rectFromCenter(cx: number, cy: number, w: number, h: number): NodeRect {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// Реальное наложение двух прямоугольников (по площади, касание границей — нет).
export function rectsOverlap(a: NodeRect, b: NodeRect): boolean {
  return (
    a.x < b.x + b.w - EPS &&
    b.x < a.x + a.w - EPS &&
    a.y < b.y + b.h - EPS &&
    b.y < a.y + a.h - EPS
  );
}

// Число пар наложенных плашек (R2).
export function countLabelOverlaps(labels: NodeRect[]): number {
  let n = 0;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (rectsOverlap(labels[i], labels[j])) n++;
    }
  }
  return n;
}

// Число плашек, задевающих хотя бы один узел (R2).
export function countLabelsUnderNodes(labels: NodeRect[], nodes: NodeRect[]): number {
  let n = 0;
  for (const lb of labels) {
    if (nodes.some((nd) => rectsOverlap(lb, nd))) n++;
  }
  return n;
}

// Число пересечений стрелок (R3) — сумма «крестиков» по всем рёбрам (каждое геометрическое
// пересечение учитывается один раз, computeJumps приписывает его горизонтальному ребру).
export function countEdgeCrossings(edges: Map<string, EdgePoint[]>): number {
  let n = 0;
  for (const jumps of computeJumps(edges).values()) n += jumps.length;
  return n;
}

export interface LayoutScene {
  nodes: NodeRect[];                    // тела узлов уровня
  labels: NodeRect[];                   // плашки подписей (прямоугольники)
  edges: Map<string, EdgePoint[]>;      // ортогональные ломаные путей по id ребра
}

export interface ArrowMetrics {
  labelOverlaps: number;
  labelsUnderNodes: number;
  edgeCrossings: number;
}

// Сводный замер по сцене.
export function measureArrows(scene: LayoutScene): ArrowMetrics {
  return {
    labelOverlaps: countLabelOverlaps(scene.labels),
    labelsUnderNodes: countLabelsUnderNodes(scene.labels, scene.nodes),
    edgeCrossings: countEdgeCrossings(scene.edges),
  };
}
