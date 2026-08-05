// Детерминированная позиция спавна узла, создаваемого кнопкой «+» в дереве
// редактора. Защита от «случайных» скачков: новый узел получает ВЛАДЕЕМУЮ
// позицию в момент создания, а не выбирается ELK'ом произвольно (невладеемые
// узлы пере-размещаются при каждом изменении графа — например, создании связи).
// Дроп из палитры здесь не участвует — у него есть позиция дропа
// (NodeModal → POST/saveLayout), её нужно лишь отзеркалить в стейт вида.
import type { ViewLayout } from "../types";
import { NODE_W, NODE_H } from "../components/graph/constants";

// Зазор между спавном и ближайшими узлами.
const SPAWN_GAP = 60;

export interface SpawnResult {
  pos: { x: number; y: number };
  // true — позиция принадлежит ТЕКУЩЕМУ виду, хотя узел — ребёнок другого
  // контейнера (дети раскрытых локалов живут в виде уровня, не контейнера):
  // писать через saveLayout в текущий вид. false — позиция принадлежит виду
  // родителя: кладётся в POST создания.
  viaCurrentView: boolean;
}

/**
 * Позиция спавна ребёнка узла parentId на текущем уровне. null — целевой вид
 * не виден (родитель свёрнут/на другом уровне): размещение остаётся ELK'у,
 * засев владения зафиксирует его при первом показе.
 *
 * Правила:
 *  - «+» на контейнере текущего уровня (или корне) — ребёнок локал текущего
 *    вида: спавн ПОД нижним краем нижнего из видимых узлов;
 *  - «+» на локале текущего уровня — спавн РЯДОМ с родителем (справа);
 *    позиция принадлежит текущему виду (дети раскрытых локалов живут в нём);
 *  - иначе — null.
 */
export function spawnPosition(
  viewLayout: ViewLayout,
  localIds: ReadonlySet<string>,
  parentId: string | null,
  currentParentId: string | null,
): SpawnResult | null {
  if (parentId === currentParentId) {
    let minX = Infinity;
    let maxY = -Infinity;
    for (const id of localIds) {
      const p = viewLayout[id];
      if (p?.x == null || p?.y == null) continue;
      if (p.x < minX) minX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxY === -Infinity) return null; // вид без владеемых позиций — пусть сеет ELK
    return { pos: { x: minX, y: maxY + NODE_H + SPAWN_GAP }, viaCurrentView: false };
  }
  if (parentId !== null && localIds.has(parentId)) {
    const p = viewLayout[parentId];
    if (p?.x == null || p?.y == null) return null;
    return { pos: { x: p.x + NODE_W + SPAWN_GAP, y: p.y }, viaCurrentView: true };
  }
  return null;
}
