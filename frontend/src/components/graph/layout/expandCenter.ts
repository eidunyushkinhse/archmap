// Дефолтная раскладка детей раскрытого контейнера: при раскрытии контейнера его дети
// должны «спавниться» в той же относительной раскладке, какую задал пользователь, но
// сдвинутые так, чтобы центр их общего bbox лёг в точку, где стоял свёрнутый контейнер
// (origin — центр узла на момент раскрытия). Так раскрытая группа встаёт туда же, где
// был свёрнутый узел, и схема не «прыгает».
//
// Тонкости (почему не «пересчитывать центр каждый layout»):
//   • Сдвиг группы ЗАМОРАЖИВАЕМ на первом layout после раскрытия (frozenDelta). Иначе
//     перетаскивание одного ребёнка меняло бы центр bbox и тянуло за собой соседей.
//   • Ребёнок, которого пользователь подвинул ПОСЛЕ раскрытия (settled), выпадает из
//     центрирования и держит свою позицию. Без этого персист отображаемой (уже
//     сдвинутой) координаты + повторный сдвиг давали бы двойное смещение/дёрганье.
// Берём ВСЕХ детей контейнера — и авто, и с ручными координатами (их относительную
// раскладку и надо сохранить), кроме settled.
import { NODE_W, NODE_H } from "../constants";

type XY = { x: number; y: number };
type Delta = { dx: number; dy: number };

/**
 * Центрирует группы детей раскрытых контейнеров на запомненный центр родителя.
 * Мутирует `positions` (сдвигает детей) и `frozenDelta` (фиксирует сдвиг на первом
 * валидном проходе на контейнер). Чистая в остальном — под юнит-тесты.
 */
export function centerEmergedChildren(params: {
  /** отображаемые сущности уровня (id достаточно) */
  entities: { id: string }[];
  /** id сущности → id раскрытого контейнера-предка прямо над ней (projectGhosts) */
  emergedFrom: Map<string, string>;
  /** id контейнера → центр свёрнутого узла на момент раскрытия */
  origins: Map<string, XY>;
  /** id контейнера → замороженный сдвиг группы (МУТИРУЕТСЯ: фиксируется здесь) */
  frozenDelta: Map<string, Delta>;
  /** id детей, подвинутых пользователем после раскрытия — не центрируем */
  settled: Set<string>;
  /** позиции узлов (МУТИРУЮТСЯ) */
  positions: Map<string, XY>;
}): void {
  const { entities, emergedFrom, origins, frozenDelta, settled, positions } = params;

  // группируем детей по контейнеру, из которого они вышли
  const groups = new Map<string, string[]>();
  for (const ent of entities) {
    const from = emergedFrom.get(ent.id);
    if (from && origins.has(from) && !settled.has(ent.id)) {
      (groups.get(from) ?? groups.set(from, []).get(from)!).push(ent.id);
    }
  }

  for (const [from, ids] of groups) {
    const origin = origins.get(from)!;
    // bbox по текущим позициям группы (ручные = saved, авто = dagre)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = positions.get(id);
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    }
    if (!isFinite(minX)) continue; // позиции ещё не готовы — не центрируем и не замораживаем

    // delta замораживаем на первом валидном проходе: дальнейшие layout’ы и драг соседей
    // его не меняют — недвинутые дети стоят на месте спавна.
    let d = frozenDelta.get(from);
    if (!d) {
      d = { dx: origin.x - (minX + maxX) / 2, dy: origin.y - (minY + maxY) / 2 };
      frozenDelta.set(from, d);
    }
    for (const id of ids) {
      const p = positions.get(id);
      if (p) positions.set(id, { x: p.x + d.dx, y: p.y + d.dy });
    }
  }
}
