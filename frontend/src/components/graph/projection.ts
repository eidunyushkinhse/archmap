// Проекция концов рёбер на уровень (R2 вид-центричного движка, C4_ENGINE_AUDIT.md).
//
// Сервер отдаёт рёбра СЫРЫМИ (реальные концы) + реестр не-локальных концов с цепочками
// предков (endpoints). Здесь — первая половина проекции, бывший серверный find_effective:
// конец поднимается к БЛИЖАЙШЕМУ ЛОКАЛЬНОМУ ПРЕДКУ уровня; конец вне поддерева остаётся
// своей identity (гость) — его дальше сворачивает projectGhosts (вторая половина,
// зависящая от expand/collapse). Правила отбрасывания — как у прежнего бэкенда:
//  • конец = сам контейнер уровня → ребро не показывается;
//  • оба конца поднялись в ОДНУ сущность (внутреннее ребро ребёнка) → скрыто;
//  • ни один конец не локален → скрыто (страховка; сервер такие не шлёт).
//
// СВЯЗЬ, УПИРАЮЩАЯСЯ В РАМКУ (2026-08-11): конец = РАСКРЫТЫЙ контейнер, который на этом
// уровне нарисован РАМКОЙ (frameIds), больше не отбрасывается — он остаётся собой, и
// стрелка стыкуется с границей рамки. До этого такой конец пропадал по построению (в
// localIds его нет — заменён детьми, в реестре endpoints тоже — для сервера он локал), и
// связь была видна только алертом «связь в промежуточный объект»: на схеме от неё
// оставался висящий без стрелок сосед. id рамки = id самого контейнера, поэтому никакой
// новой сущности здесь не появляется.
import type { GhostNode } from "../../types";

export interface LiftInput<E extends { source_id: string; target_id: string }> {
  edges: E[];
  /** реестр не-локальных концов рёбер (с цепочками предков) */
  endpoints: GhostNode[];
  localIds: Set<string>;
  containerId: string | null;
  /**
   * Контейнеры, отображаемые на уровне РАМКОЙ (раскрытые локалы). Конец ребра в таком
   * контейнере — законный конец: стрелка упирается в границу рамки. Не задан — прежнее
   * поведение (такой конец отбрасывается).
   */
  frameIds?: ReadonlySet<string>;
}

export interface LiftResult<E> {
  /** рёбра с поднятыми концами (отброшенные по правилам — исключены) */
  edges: E[];
  /** концы, оставшиеся гостями (identity вне поддерева) — вход projectGhosts */
  ghosts: GhostNode[];
}

export function liftEdgesToLevel<E extends { source_id: string; target_id: string }>(
  input: LiftInput<E>,
): LiftResult<E> {
  const { edges, endpoints, localIds, containerId, frameIds } = input;
  const registry = new Map(endpoints.map((ep) => [ep.id, ep]));

  // Подъём конца: локал → сам; рамка раскрытого контейнера → сама рамка (конец-в-рамку);
  // глубокий внутри поддерева → ближайший предок-локал (самый глубокий элемент цепочки,
  // входящий в localIds); контейнер уровня → drop; прочее → гость (identity сохраняется).
  // null = ребро с этим концом не показывается.
  const lift = (id: string): { id: string; ghost: boolean } | null => {
    if (localIds.has(id)) return { id, ghost: false };
    // Рамка проверяется ДО контейнера уровня и до реестра: раскрытый локал в реестр не
    // попадает вовсе (для сервера он локал), и без этой ветки его бы отсеял `!info`.
    if (frameIds?.has(id)) return { id, ghost: false };
    if (containerId !== null && id === containerId) return null;
    const info = registry.get(id);
    if (!info) return null; // конец без инфо в реестре (защита; сервер такие не шлёт)
    const anc = info.ancestors ?? [];
    for (let i = anc.length - 1; i >= 0; i--) {
      if (localIds.has(anc[i].id)) return { id: anc[i].id, ghost: false };
    }
    return { id, ghost: true };
  };

  const out: E[] = [];
  const ghostIds = new Set<string>();
  for (const e of edges) {
    const s = lift(e.source_id);
    const t = lift(e.target_id);
    if (!s || !t) {
      // Ребро отброшено (конец — контейнер уровня/раскрытый контейнер/неизвестно).
      // Гостевой конец всё равно собираем: внешний узел, связанный с контейнером,
      // не должен исчезать со схемы при его раскрытии/сворачивании (single-schema).
      if (s?.ghost) ghostIds.add(s.id);
      if (t?.ghost) ghostIds.add(t.id);
      continue;
    }
    if (s.id === t.id) continue; // оба конца в одной сущности — внутреннее ребро
    if (s.ghost && t.ghost) continue; // ни один конец не локален (защита; не собираем)
    out.push({ ...e, source_id: s.id, target_id: t.id });
    if (s.ghost) ghostIds.add(s.id);
    if (t.ghost) ghostIds.add(t.id);
  }
  const ghosts = [...ghostIds]
    .map((id) => registry.get(id))
    .filter((g): g is GhostNode => g != null);
  return { edges: out, ghosts };
}
