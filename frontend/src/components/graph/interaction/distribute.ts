// Чистый 1-D хелпер distribution-снапа: РАВНЫЕ ЗАЗОРЫ между соседями одной линии.
// Если два узла стоят на одной оси (горизонтальной/вертикальной) с просветом g между
// краями, перетаскиваемый узел «примагничивается» к позиции, где его зазор до края
// ряда тоже равен g — продолжение равномерного ряда (как distribution-снап в Figma).
// Функция работает в нормализованной системе main/cross (main — вдоль линии, cross —
// поперёк); проекцию узлов на оси делает вызывающий (snap.ts).

// Узел в нормализованной 1-D системе одной оси снапа.
export interface LineBox {
  main: number; // центр узла вдоль главной оси (направление ряда)
  size: number; // размер узла вдоль главной оси
  cross: number; // центр узла вдоль перпендикулярной оси (определяет «линию»)
}

// Отрезок-индикатор зазора (в координатах главной оси).
export interface GapSegment {
  start: number;
  end: number;
}

export interface SpacingHit {
  snap: number; // притянутый центр узла по главной оси
  gap: number; // величина зазора (edge-to-edge)
  ref: GapSegment; // эталонный зазор пары соседей
  fresh: GapSegment; // новый зазор у перетаскиваемого узла (равен ref)
}

// Индикатор равных зазоров в координатах ГРАФА (axis — направление ряда, cross —
// постоянная координата линии по перпендикулярной оси). Собирается в snap.ts.
export interface SpacingGuide {
  axis: "x" | "y";
  cross: number;
  gap: number;
  segments: GapSegment[]; // [эталонный зазор пары, новый зазор у узла]
}

// Притягиваем центр узла (pos, size по главной оси) к позиции, где его зазор до края
// ряда равен зазору крайней пары ряда. Ряд = узлы с близким cross (та же линия).
// Продолжаем ряд тем же шагом за правый край (зазор последней пары) или за левый
// (зазор первой пары). Возвращаем ближайшего кандидата в пределах threshold или null.
export function distributeAxis(
  pos: number,
  size: number,
  cross: number,
  boxes: LineBox[],
  threshold: number,
): SpacingHit | null {
  // Члены линии — узлы, чей центр по перп. оси близок (тот же ряд)
  const members = boxes.filter((b) => Math.abs(b.cross - cross) <= threshold);
  if (members.length < 2) return null; // нужна пара, задающая интервал

  const sorted = [...members].sort((a, b) => a.main - b.main);
  const left = (b: LineBox) => b.main - b.size / 2;
  const right = (b: LineBox) => b.main + b.size / 2;
  const n = sorted.length;

  const candidates: SpacingHit[] = [];
  // Продолжить ряд справа зазором последней пары
  const rightGap = left(sorted[n - 1]) - right(sorted[n - 2]);
  if (rightGap > 0) {
    const edge = right(sorted[n - 1]);
    candidates.push({
      snap: edge + rightGap + size / 2,
      gap: rightGap,
      ref: { start: right(sorted[n - 2]), end: left(sorted[n - 1]) },
      fresh: { start: edge, end: edge + rightGap },
    });
  }
  // Продолжить ряд слева зазором первой пары
  const leftGap = left(sorted[1]) - right(sorted[0]);
  if (leftGap > 0) {
    const edge = left(sorted[0]);
    candidates.push({
      snap: edge - leftGap - size / 2,
      gap: leftGap,
      ref: { start: right(sorted[0]), end: left(sorted[1]) },
      fresh: { start: edge - leftGap, end: edge },
    });
  }

  let best: SpacingHit | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c.snap - pos);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
