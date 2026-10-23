// Контейнер размещается целиком (docs/specs/deployment.md D30, ТЗ §2а п. 9): размещение
// контейнера снимает СОБСТВЕННОЕ размещение объектов внутри (запрос с clearDescendants),
// и они наследуют его площадки. Перед записью человек видит, чьё своё размещение
// перезапишется: «объект: площадки». Чистый модуль — общий для режима размещения на
// холсте (DeploymentPage) и окна «Размещение» (PlacementDialog).
import type { Node } from "../../types";

// Достаточно этих полей узла: дерево по parent_id и действующее размещение (sites —
// своё без inherited_from_id). Подходят и Node, и DeploymentNode.
type PlacedNode = Pick<Node, "id" | "name" | "parent_id" | "sites">;

/** Потомки узла id любой глубины (по parent_id), без него самого. Обход с seen — цикл
 *  в данных не вешает. */
export function descendantsOf<T extends PlacedNode>(nodes: readonly T[], id: string): T[] {
  const kids = new Map<string, T[]>();
  for (const n of nodes) {
    if (n.parent_id === null || n.parent_id === undefined) continue;
    const list = kids.get(n.parent_id);
    if (list) list.push(n);
    else kids.set(n.parent_id, [n]);
  }
  const out: T[] = [];
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const k of kids.get(cur) ?? []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      out.push(k);
      stack.push(k.id);
    }
  }
  return out;
}

/** Своё размещение узла — id площадок без inherited_from_id (у унаследованного он есть). */
export function ownSites(node: Pick<Node, "sites">): string[] {
  return node.sites.filter((s) => !s.inherited_from_id).map((s) => s.id);
}

export interface PlacementConflict<T extends PlacedNode = PlacedNode> {
  node: T;
  // имена площадок своего размещения объекта — в порядке ответа сервера (по имени)
  siteNames: string[];
}

/** Потомки контейнера со СВОИМ размещением, отличным от целевого набора площадок (по
 *  множеству id): размещение контейнера целиком его снимет. Без своего размещения
 *  («не указано» или унаследованное) и с тем же набором — не конфликт. Порядок — по имени. */
export function placementConflicts<T extends PlacedNode>(
  nodes: readonly T[], containerId: string, targetSiteIds: readonly string[],
): PlacementConflict<T>[] {
  const target = new Set(targetSiteIds);
  const out: PlacementConflict<T>[] = [];
  for (const d of descendantsOf(nodes, containerId)) {
    const own = d.sites.filter((s) => !s.inherited_from_id);
    if (own.length === 0) continue;
    if (own.length === target.size && own.every((s) => target.has(s.id))) continue;
    out.push({ node: d, siteNames: own.map((s) => s.name) });
  }
  return out.sort((a, b) => a.node.name.localeCompare(b.node.name, "ru"));
}

/** Вопрос подтверждения: «Разместить «X» на «S»?» (площадок несколько — через запятую). */
export function placeQuestion(name: string, siteNames: readonly string[]): string {
  return `Разместить «${name}» на ${siteNames.map((s) => `«${s}»`).join(", ")}?`;
}

// Пояснение под вопросом — перед списком «объект: площадки».
export const PLACE_LEAD = "Все его компоненты будут размещены там же, включая те, что сейчас стоят на других площадках:";
