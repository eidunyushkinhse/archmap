// 1D weighted separation-constraint solver (VPSC, вариант merge-to-feasibility).
//
// Задача: даны желаемые координаты d_i, веса w_i и набор ограничений
// x[right] − x[left] ≥ gap. Найти x_i, минимизирующие Σ w_i (x_i − d_i)² при всех
// ограничениях. Раздельно по осям (x, затем y) это и есть постановка «минимально
// сдвинуть, чтобы развести, сохранив порядок» из Ф4 (см. REFACTOR_OWNERSHIP_F4.md):
//   • цель Σ w(x−d)²            = минимум суммарного (взвешенного) смещения [R2];
//   • ограничения из текущего порядка = относительный порядок не переворачивается [R3];
//   • веса w                    = приоритет подвижности (локал — огромный вес ≈ неподвижен,
//                                 сиблинг — малый; раскрытая рамка пиннится desired+вес) [R4].
//
// Обобщает соседний `spread1DSized` (PAV) на ДВА недостающих для Ф4 случая: (а) веса,
// (б) произвольный DAG ограничений вместо одной отсортированной цепочки — в 2D-разведении
// гэпим лишь реально пересекающиеся пары, иначе вышла бы жёсткая решётка (нарушение R2).
//
// Алгоритм (Dwyer–Marriott–Stuckey, «Fast Node Overlap Removal»): каждая переменная
// стартует своим блоком в desired; пока есть нарушенное ограничение с МАКС. нарушением —
// сливаем блоки его концов, делая ограничение тугим, и пересчитываем оптимум блока как
// взвешенное среднее. Ограничения должны образовывать DAG (генерим только в направлении
// возрастания desired) — тогда цикл сходится к допустимому решению, сохраняющему порядок.
// (Полная VPSC ещё делит блоки по знаку множителей Лагранжа ради точного оптимума; здесь
// merge-only — для overlap-removal это стандартный `satisfy_VPSC`; деление — потенциальное
// уточнение Ф4+, если потребуется качество.)

/** Ограничение: позиция переменной `right` не ближе `gap` справа от `left`. */
export interface SepConstraint {
  left: number;
  right: number;
  gap: number;
}

interface Block {
  vars: Var[];
  /** Σ w·(d − offset) — числитель оптимальной позиции блока */
  wposn: number;
  /** Σ w — знаменатель */
  weight: number;
}

interface Var {
  desired: number;
  weight: number;
  /** смещение переменной относительно опорной позиции её блока */
  offset: number;
  block: Block;
}

// оптимальная опорная позиция блока минимизирует Σ w(posn + offset − d)² → posn = Σw(d−offset)/Σw
const blockPosn = (b: Block): number => b.wposn / b.weight;
const varPosn = (v: Var): number => blockPosn(v.block) + v.offset;

/**
 * Сливает блок переменной `R` в блок переменной `L`, делая ограничение между ними тугим:
 * после слияния varPosn(R) − varPosn(L) = gap. Опору блока L сохраняем, переменные блока R
 * сдвигаем на нужную дельту и переносим; числитель/знаменатель пересчитываем инкрементально.
 */
function mergeBlocks(L: Var, R: Var, gap: number): void {
  const bL = L.block;
  const bR = R.block;
  // дельта смещений переменных bR, чтобы offset(R) стал offset(L) + gap
  const d = L.offset + gap - R.offset;
  for (const v of bR.vars) {
    v.offset += d;
    v.block = bL;
    bL.vars.push(v);
  }
  // вклад bR в числитель после сдвига offset на d: Σw(d_v − offset_v − d) = bR.wposn − d·Σw
  bL.wposn += bR.wposn - d * bR.weight;
  bL.weight += bR.weight;
}

/**
 * Решает 1D-задачу VPSC. `desired[i]`, `weight[i]` — желаемая позиция и вес переменной i
 * (вес > 0; «почти неподвижной» переменной дать большой вес). `constraints` — separation-
 * ограничения (индексы в `desired`); ДОЛЖНЫ образовывать DAG (left.desired ≤ right.desired).
 * Возвращает позиции в исходном порядке индексов. Чистая функция (вход не мутируется).
 */
export function solveSeparation(
  desired: number[],
  weight: number[],
  constraints: SepConstraint[],
): number[] {
  const vars: Var[] = desired.map((d, i) => {
    const w = weight[i];
    const block: Block = { vars: [], wposn: w * d, weight: w };
    const v: Var = { desired: d, weight: w, offset: 0, block };
    block.vars.push(v);
    return v;
  });

  const violation = (c: SepConstraint): number =>
    varPosn(vars[c.left]) + c.gap - varPosn(vars[c.right]);

  // защита от зацикливания: каждое слияние уменьшает число блоков на 1, итераций ≤ |vars|
  for (let guard = 0; guard <= vars.length; guard++) {
    let best = -1;
    let bestViol = 1e-9; // порог: меньше — считаем удовлетворённым
    for (let i = 0; i < constraints.length; i++) {
      const v = violation(constraints[i]);
      if (v > bestViol) {
        bestViol = v;
        best = i;
      }
    }
    if (best < 0) break; // все ограничения удовлетворены
    const c = constraints[best];
    const L = vars[c.left];
    const R = vars[c.right];
    // в DAG-наборе положительного нарушения внутри одного блока быть не должно (концы уже
    // в туго связанной цепочке); если случилось — набор не-DAG/противоречив, выходим
    if (L.block === R.block) break;
    mergeBlocks(L, R, c.gap);
  }

  return vars.map(varPosn);
}
