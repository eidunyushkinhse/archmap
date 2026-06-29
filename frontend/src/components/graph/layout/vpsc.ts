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
  /** Σ w·(d − offset) по переменным с КОНЕЧНЫМ весом — числитель оптимума */
  wposn: number;
  /** Σ w по конечным весам — знаменатель */
  weight: number;
  /** Σ (d − offset) по «прибитым» переменным (вес = Infinity) — их среднее задаёт опору */
  fwposn: number;
  /** число прибитых переменных в блоке */
  fcount: number;
}

interface Var {
  desired: number;
  weight: number;
  /** смещение переменной относительно опорной позиции её блока */
  offset: number;
  block: Block;
}

// Опора блока минимизирует Σ w(posn + offset − d)². При наличии прибитых переменных
// (вес = Infinity) опору задают ТОЛЬКО они (их среднее) — конечные веса не влияют; иначе
// posn = Σw(d−offset)/Σw. Прибитая переменная не двигается (локал/пин из R4).
const blockPosn = (b: Block): number =>
  b.fcount > 0 ? b.fwposn / b.fcount : b.wposn / b.weight;
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
  // вклад bR после сдвига offset на d: Σ(d_v − offset_v − d) = (исходная сумма) − d·count.
  // Конечные веса и прибитые накапливаем раздельно (см. blockPosn).
  bL.wposn += bR.wposn - d * bR.weight;
  bL.weight += bR.weight;
  bL.fwposn += bR.fwposn - d * bR.fcount;
  bL.fcount += bR.fcount;
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
    const fixed = w === Infinity;
    const block: Block = {
      vars: [], weight: fixed ? 0 : w, wposn: fixed ? 0 : w * d,
      fwposn: fixed ? d : 0, fcount: fixed ? 1 : 0,
    };
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
