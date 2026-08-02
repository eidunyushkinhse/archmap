// Релевантные дети раскрытого контейнера (read-only схемы страниц, X16 v2).
//
// Принцип «отображаемое = связанное рёбрами» — тот же, что у гостей: проекция
// (projectGhosts) материализует гостевые сущности из реестра КОНЦОВ РЁБЕР, поэтому
// раскрытие гостя не спавнит лишних детей. Для ЛОКАЛЬНЫХ детей правило то же:
// ребёнок K релевантен на текущей схеме, если у его поддерева есть ГРАНИЧНОЕ
// ребро текущего набора рёбер — ребро с одним концом в поддереве K и другим
// ВНЕ его, причём «вне» не считается раскрытый контейнер (рёбра «прямо в рамку»
// проекция всё равно дропает — они не делают ребёнка видимым).
//
// Принадлежность конца поддереву K — по реестру концов (цепочки предков — тот же
// источник данных, что использует проекция): конец E ∈ поддерево K ⟺ E == K или
// K в цепочке предков E. Отображаемые локалы (фокус/представители) лежать внутри
// поддерева K не могут по построению виртуального корня, поэтому реестра достаточно.

import type { GhostNode } from "../../types";

interface EdgeEnds {
  source_id: string;
  target_id: string;
}

// Цепочка предков по id конца (из реестра).
function ancestorIndex(endpoints: GhostNode[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const ep of endpoints) m.set(ep.id, (ep.ancestors ?? []).map((a) => a.id));
  return m;
}

// E ∈ поддерево K ⟺ E == K или K в предках E.
function inSubtree(endId: string, kidId: string, anc: Map<string, string[]>): boolean {
  return endId === kidId || (anc.get(endId)?.includes(kidId) ?? false);
}

// Другой конец ребра «вне поддерева K»: не сам K и K не в его предках.
function outsideSubtree(otherId: string, kidId: string, anc: Map<string, string[]>): boolean {
  return otherId !== kidId && !(anc.get(otherId)?.includes(kidId) ?? false);
}

/**
 * Фильтр детей контейнера: остаются только релевантные текущей схеме (с границей
 * поддерева по рёбрам). `expanded` — раскрытые сейчас контейнеры, ВКЛЮЧАЯ сам
 * раскрываемый: рёбра «в его рамку» границу не образуют.
 */
export function relevantChildren<T extends { id: string }>(
  kids: T[],
  edges: EdgeEnds[],
  endpoints: GhostNode[],
  expanded: ReadonlySet<string>,
): T[] {
  const anc = ancestorIndex(endpoints);
  return kids.filter((k) =>
    edges.some((e) => {
      const sIn = inSubtree(e.source_id, k.id, anc);
      const tIn = inSubtree(e.target_id, k.id, anc);
      if (sIn === tIn) return false; // оба внутри (внутреннее) или оба снаружи
      const other = sIn ? e.target_id : e.source_id;
      return !expanded.has(other); // другой конец не в раскрытой рамке
    }),
  );
}

/**
 * Число релевантных детей по id контейнера — по рёбрам и реестру, БЕЗ фетча
 * списков детей (бейдж «есть дети (N)» и гейт лупы на read-only странице).
 * Ключи — все встреченные в цепочках предки; потребитель читает свой id
 * (отсутствие = ноль релевантных детей). Правило идентично relevantChildren,
 * поэтому счётчик сходится с составом реального раскрытия.
 */
export function relevantChildCounts(
  edges: EdgeEnds[],
  endpoints: GhostNode[],
  expanded: ReadonlySet<string>,
): Map<string, number> {
  const anc = ancestorIndex(endpoints);
  const sets = new Map<string, Set<string>>();
  const add = (parentId: string, kidId: string): void => {
    // get-or-create без «!»: явная проверка и создание
    let s = sets.get(parentId);
    if (!s) { s = new Set(); sets.set(parentId, s); }
    s.add(kidId);
  };
  for (const e of edges) {
    const ends: Array<[string, string]> = [
      [e.source_id, e.target_id],
      [e.target_id, e.source_id],
    ];
    for (const [end, other] of ends) {
      if (expanded.has(other)) continue; // ребро «в рамку» границу не образует
      const chain = [...(anc.get(end) ?? []), end];
      // каждая смежная пара (предок → потомок) в цепочке конца: потомок K
      // релевантен для предка M, если другой конец вне поддерева K
      for (let i = 1; i < chain.length; i++) {
        const k = chain[i];
        if (outsideSubtree(other, k, anc)) add(chain[i - 1], k);
      }
    }
  }
  const out = new Map<string, number>();
  for (const [id, s] of sets) out.set(id, s.size);
  return out;
}
