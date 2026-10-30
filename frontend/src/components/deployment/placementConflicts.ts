// Система размещается целиком (docs/specs/deployment.md D30, D33; Р16 эпика
// docs/plan-c4-elements.md): набор площадок получает каждая её единица — контейнер (лист
// или контейнер с компонентами), и чьё-то прежнее размещение перезапишется. Перед
// записью человек видит, чьё именно: «объект: площадки». Контейнер с компонентами —
// единица: набор пишется ему самому, как листу, без подтверждения; у компонента
// размещения нет. Чистый модуль — общий для режима размещения на холсте
// (useDeploymentPlacing) и окна «Размещение».
import type { Node } from "../../types";

// Достаточно этих полей узла: дерево по parent_id, элемент архитектуры (его считает
// сервер — element_effective) и размещение (sites — площадки единицы; у системы —
// площадки её единиц). Подходят и Node, и DeploymentNode.
type PlacedNode = Pick<Node, "id" | "name" | "parent_id" | "sites" | "element_effective">;

/** Единицы под узлом id, без него самого: обход вниз сквозь системы до первой единицы
 *  (её компоненты не обходятся), «Пользователи» и компоненты — мимо. Порядок — обход в
 *  глубину в порядке списка; обход с seen — цикл в данных не вешает. */
function unitsBelow<T extends PlacedNode>(nodes: readonly T[], id: string): T[] {
  const kids = new Map<string, T[]>();
  for (const n of nodes) {
    if (n.parent_id === null || n.parent_id === undefined) continue;
    const list = kids.get(n.parent_id);
    if (list) list.push(n);
    else kids.set(n.parent_id, [n]);
  }
  const out: T[] = [];
  const seen = new Set<string>([id]);
  const stack = [...(kids.get(id) ?? [])].reverse();
  while (stack.length > 0) {
    const cur = stack.pop() as T;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    if (cur.element_effective === "container") out.push(cur);
    else if (cur.element_effective === "system") stack.push(...[...(kids.get(cur.id) ?? [])].reverse());
  }
  return out;
}

/** Единицы размещения узла — те, у кого хранится размещение: контейнер (лист или с
 *  компонентами) — он сам; система — её единицы; компонент и «Пользователь» — никто,
 *  размещения у них не бывает. */
export function unitsOf<T extends PlacedNode>(nodes: readonly T[], node: T): T[] {
  if (node.element_effective === "container") return [node];
  if (node.element_effective === "system") return unitsBelow(nodes, node.id);
  return [];
}

/** У узла есть размещение: у единицы — её площадки, у системы — хоть у одной единицы
 *  внутри. */
export function hasPlacement<T extends PlacedNode>(nodes: readonly T[], node: T): boolean {
  return unitsOf(nodes, node).some((n) => n.sites.length > 0);
}

export interface PlacementConflict<T extends PlacedNode = PlacedNode> {
  node: T;
  // имена площадок объекта — в порядке ответа сервера (по имени)
  siteNames: string[];
}

/** Единицы системы с размещением, отличным от целевого набора площадок (по множеству
 *  id): размещение системы целиком его перезапишет. Без размещения и с тем же набором —
 *  не конфликт; пустой целевой набор (снять размещение) — все размещённые единицы
 *  внутри. У единицы конфликтов нет: внутри неё только компоненты. Порядок — по имени. */
export function placementConflicts<T extends PlacedNode>(
  nodes: readonly T[], systemId: string, targetSiteIds: readonly string[],
): PlacementConflict<T>[] {
  const target = new Set(targetSiteIds);
  const out: PlacementConflict<T>[] = [];
  for (const u of unitsBelow(nodes, systemId)) {
    if (u.sites.length === 0) continue;
    if (u.sites.length === target.size && u.sites.every((s) => target.has(s.id))) continue;
    out.push({ node: u, siteNames: u.sites.map((s) => s.name) });
  }
  return out.sort((a, b) => a.node.name.localeCompare(b.node.name, "ru"));
}

/** Вопрос подтверждения: «Разместить «X» на «S»?» (площадок несколько — через запятую). */
export function placeQuestion(name: string, siteNames: readonly string[]): string {
  return `Разместить «${name}» на ${siteNames.map((s) => `«${s}»`).join(", ")}?`;
}

// Пояснение под вопросом — перед списком «объект: площадки».
export const PLACE_LEAD = "Все контейнеры системы будут размещены там же, включая те, что сейчас стоят на других площадках:";

/** Вопрос снятия размещения системы: его теряют все её единицы. */
export function unplaceQuestion(name: string): string {
  return `Снять размещение «${name}»?`;
}

export const UNPLACE_LEAD = "Размещение всех контейнеров системы будет снято:";
