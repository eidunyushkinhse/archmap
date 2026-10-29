// Путь от корня до узла по плоскому списку узлов проекта: крошки страницы объекта
// (NodePage), крошки редактора-карты и цепочка предков гостя в инспекторе
// (MapEditorPage). Обход был написан трижды (аудит F-12); здесь он один и с защитой от
// цикла — данные снимков и импорта бывают циклическими (урок аудита 2026-10), а
// зависшая вкладка хуже обрезанных крошек.
import type { AncestorRef, Node } from "../types";

// Узлы от корня до id включительно; [] — id null или узла нет в списке.
export function chainTo(all: readonly Node[], id: string | null): Node[] {
  if (id === null) return [];
  const byId = new Map(all.map((n) => [n.id, n]));
  const path: Node[] = [];
  const seen = new Set<string>();
  for (
    let cur = byId.get(id);
    cur && !seen.has(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  ) {
    seen.add(cur.id);
    path.unshift(cur);
  }
  return path;
}

// Звено крошек: только то, что нужно подписи и переходу.
export const ancestorRef = (n: Node): AncestorRef => ({
  id: n.id, name: n.name, is_external: n.is_external, element_effective: n.element_effective,
});
