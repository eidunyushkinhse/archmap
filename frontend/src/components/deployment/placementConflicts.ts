// Контейнер размещается целиком (docs/specs/deployment.md D30, ТЗ §2а п. 9): набор
// площадок получает каждый объект внутри, и чьё-то прежнее размещение перезапишется.
// Перед записью человек видит, чьё именно: «объект: площадки». Чистый модуль — общий
// для режима размещения на холсте (useDeploymentPlacing) и окна «Размещение».
import type { Node } from "../../types";

// Достаточно этих полей узла: дерево по parent_id и размещение (sites — площадки
// объекта; у контейнера — площадки его объектов). Подходят и Node, и DeploymentNode.
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

const parentIds = (nodes: readonly PlacedNode[]): Set<string> =>
  new Set(nodes.flatMap((n) => (n.parent_id ? [n.parent_id] : [])));

/** Объекты узла — те, у кого хранится размещение: сам узел, если он лист (ни у кого в
 *  списке не родитель), иначе листья его поддерева. «Пользователи» здесь безвредны:
 *  площадок у них не бывает. */
export function leavesOf<T extends PlacedNode>(nodes: readonly T[], node: T): T[] {
  const parents = parentIds(nodes);
  if (!parents.has(node.id)) return [node];
  return descendantsOf(nodes, node.id).filter((n) => !parents.has(n.id));
}

/** У узла есть размещение: у объекта — его площадки, у контейнера — хоть у одного
 *  объекта внутри. */
export function hasPlacement<T extends PlacedNode>(nodes: readonly T[], node: T): boolean {
  return leavesOf(nodes, node).some((n) => n.sites.length > 0);
}

export interface PlacementConflict<T extends PlacedNode = PlacedNode> {
  node: T;
  // имена площадок объекта — в порядке ответа сервера (по имени)
  siteNames: string[];
}

/** Объекты контейнера с размещением, отличным от целевого набора площадок (по множеству
 *  id): размещение контейнера целиком его перезапишет. Без размещения и с тем же
 *  набором — не конфликт; пустой целевой набор (снять размещение) — все размещённые
 *  объекты внутри. Порядок — по имени. */
export function placementConflicts<T extends PlacedNode>(
  nodes: readonly T[], containerId: string, targetSiteIds: readonly string[],
): PlacementConflict<T>[] {
  const target = new Set(targetSiteIds);
  const parents = parentIds(nodes);
  const out: PlacementConflict<T>[] = [];
  for (const d of descendantsOf(nodes, containerId)) {
    if (parents.has(d.id) || d.sites.length === 0) continue;
    if (d.sites.length === target.size && d.sites.every((s) => target.has(s.id))) continue;
    out.push({ node: d, siteNames: d.sites.map((s) => s.name) });
  }
  return out.sort((a, b) => a.node.name.localeCompare(b.node.name, "ru"));
}

/** Вопрос подтверждения: «Разместить «X» на «S»?» (площадок несколько — через запятую). */
export function placeQuestion(name: string, siteNames: readonly string[]): string {
  return `Разместить «${name}» на ${siteNames.map((s) => `«${s}»`).join(", ")}?`;
}

// Пояснение под вопросом — перед списком «объект: площадки».
export const PLACE_LEAD = "Все его компоненты будут размещены там же, включая те, что сейчас стоят на других площадках:";

/** Вопрос снятия размещения контейнера: его теряют все объекты внутри. */
export function unplaceQuestion(name: string): string {
  return `Снять размещение «${name}»?`;
}

export const UNPLACE_LEAD = "Размещение всех его компонентов будет снято:";
