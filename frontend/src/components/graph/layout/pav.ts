// Одномерное «раздвижение» точек на прямой с минимальным суммарным квадратичным
// смещением: даны желаемые координаты d_i, нужно расставить p_i так, чтобы соседи
// (по порядку) отстояли не ближе зазора `gap`, при min Σ(p_i − d_i)². Это точная
// постановка «полки гостей»: вместо стопки «только вниз» (верхний прибит, нижние
// уезжают) — симметричное раздвигание вокруг центра масс желаемых позиций.
//
// Решается ТОЧНО за O(n log n) методом pool-adjacent-violators (PAV, изотоническая
// регрессия). Подстановка q_i = p_i − i·gap превращает ограничение p_{i+1} − p_i ≥ gap
// в монотонность q_{i+1} ≥ q_i, а цель — в изотоническую регрессию значений
// e_i = d_i − i·gap по L2. PAV сливает соседние «пулы»-нарушители в их среднее.

/**
 * Расставляет точки разного «размера» на прямой возле желаемых позиций `desired` (это
 * ЦЕНТРЫ), гарантируя зазор между центрами соседей ≥ полусумма их полуразмеров + `pad`,
 * при минимальном суммарном квадратичном смещении. `halfExtent[i]` — половина габарита
 * элемента i вдоль оси (для узла высоты H по вертикали — H/2). Возвращает координаты В
 * ИСХОДНОМ ПОРЯДКЕ входа. Чистая функция. Это общий случай spread1D (равные размеры).
 */
export function spread1DSized(desired: number[], halfExtent: number[], pad: number): number[] {
  const n = desired.length;
  if (n === 0) return [];
  if (n === 1) return [desired[0]];

  // порядок по желаемой координате; стабильный тай-брейк по исходному индексу
  const order = [...desired.keys()].sort((a, b) => desired[a] - desired[b] || a - b);
  // кумулятивный минимальный сдвиг G_i = Σ_{j<i} (half_{j} + half_{j+1} + pad);
  // подстановка q_i = p_i − G_i превращает зазор-ограничение в монотонность q
  const G = new Array<number>(n);
  G[0] = 0;
  for (let i = 1; i < n; i++) {
    G[i] = G[i - 1] + halfExtent[order[i - 1]] + halfExtent[order[i]] + pad;
  }
  // e_i = desired_i − G_i → изотоническая (неубывающая) регрессия методом PAV
  type Pool = { sum: number; count: number; mean: number };
  const pools: Pool[] = [];
  for (let i = 0; i < n; i++) {
    const e = desired[order[i]] - G[i];
    let pool: Pool = { sum: e, count: 1, mean: e };
    // пока предыдущий пул «выше» текущего (нарушает неубывание) — сливаем в среднее
    while (pools.length && pools[pools.length - 1].mean > pool.mean) {
      const prev = pools.pop()!;
      const sum = prev.sum + pool.sum;
      const count = prev.count + pool.count;
      pool = { sum, count, mean: sum / count };
    }
    pools.push(pool);
  }

  // развернуть пулы в q_i, затем p_i = q_i + G_i, вернуть в исходном порядке
  const result = new Array<number>(n);
  let i = 0;
  for (const pool of pools) {
    for (let k = 0; k < pool.count; k++) {
      result[order[i]] = pool.mean + G[i];
      i++;
    }
  }
  return result;
}

/**
 * Равномерный случай: все элементы точечные, требуемый зазор между соседями ровно `gap`.
 * Возвращает координаты В ИСХОДНОМ ПОРЯДКЕ входа. Чистая функция.
 */
export function spread1D(desired: number[], gap: number): number[] {
  return spread1DSized(desired, desired.map(() => 0), gap);
}
