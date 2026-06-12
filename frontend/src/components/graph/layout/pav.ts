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
 * Расставляет точки на прямой возле желаемых позиций `desired`, гарантируя зазор
 * между соседями ≥ `gap`, с минимальным суммарным квадратичным смещением. Возвращает
 * координаты В ИСХОДНОМ ПОРЯДКЕ входа (порядок упорядочивания — внутренняя деталь).
 * Чистая функция: вход не мутирует. Пустой вход → пустой выход.
 */
export function spread1D(desired: number[], gap: number): number[] {
  const n = desired.length;
  if (n === 0) return [];
  if (n === 1) return [desired[0]];

  // порядок по желаемой координате; стабильный тай-брейк по исходному индексу
  const order = [...desired.keys()].sort((a, b) => desired[a] - desired[b] || a - b);
  // e_i = d_i − i·gap → изотоническая (неубывающая) регрессия методом PAV
  type Pool = { sum: number; count: number; mean: number };
  const pools: Pool[] = [];
  order.forEach((idx, i) => {
    let pool: Pool = { sum: desired[idx] - i * gap, count: 1, mean: desired[idx] - i * gap };
    // пока предыдущий пул «выше» текущего (нарушает неубывание) — сливаем в среднее
    while (pools.length && pools[pools.length - 1].mean > pool.mean) {
      const prev = pools.pop()!;
      const sum = prev.sum + pool.sum;
      const count = prev.count + pool.count;
      pool = { sum, count, mean: sum / count };
    }
    pools.push(pool);
  });

  // развернуть пулы в q_i, затем p_i = q_i + i·gap, вернуть в исходном порядке
  const result = new Array<number>(n);
  let i = 0;
  for (const pool of pools) {
    for (let k = 0; k < pool.count; k++) {
      result[order[i]] = pool.mean + i * gap;
      i++;
    }
  }
  return result;
}
