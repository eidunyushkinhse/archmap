// Запрет НАЛОЖЕНИЯ узлов друг на друга.
//
// Два механизма одного инварианта «никакие два отображаемых узла не пересекаются»:
//  - separateOverlappingNodes — конвейерная стадия: взвешенное VPSC-разведение
//    (separateRects) всех отображаемых узлов на финальных позициях. Владеемые
//    двигаются неохотно (большой вес), свежие — свободно; два наложенных
//    владеемых разъезжаются поровну. Узлы разных раскрытых рамок не образуют
//    пар (их рамки уже разведены keep-out'ом), узлы ОДНОЙ рамки разводятся —
//    рамка-bbox растягивается, а её конфликт с соседями добирает следующий
//    раунд keep-out-цикла в pipeline.
//  - clampOutOfNodeRects — живой MTV-кламп при драге/отпускании: субъект
//    скользит вдоль чужих узлов, как вдоль рамок (несколько итераций на каскад).
import { NODE_W, NODE_H } from "../constants";
import { separateRects } from "./separateRects";
import type { Rect } from "./overlapConstraints";
import { pushOut } from "./keepGhostsOut";
import type { LevelPos } from "../../../types";

// Зазор между сторонами узлов после развода/клампа. ЕДИНЫЙ для стадии и клампа:
// то, что сохранил драг, конвейер считает чистым (нет «дыхания» рендер↔БД).
export const NODE_SEP_PAD = 12;

// вес владеемого узла: «почти неподвижен» рядом со свежим (1), но не Infinity —
// два наложенных владеемых обязаны развестись (поровну при равных весах)
const OWNED_WEIGHT = 1000;

// Прищёлк владеемого: VPSC с конечными весами всегда отдаёт тяжёлому КРОШЕЧНУЮ
// долю сдвига (~delta/1001). Без прищёлка это вечный микро-дрейф: свежий узел
// каждый прогон заново кладётся ELK-ом на то же место, разъезд повторяется, а
// микро-сдвиг владеемого персистится — БД «ползёт» и раскладка мигает. Сдвиг
// меньше порога возвращаем на владеемую позицию (микро-заезд в pad безвреден).
const OWNED_SNAP_EPS = 1;

/**
 * Конвейерная стадия: развести все фактически налегающие узлы. `positions`
 * МУТИРУЕТСЯ. Возвращает id сдвинутых узлов (сдвиги владеемых вызывающий
 * персистит интентом — иначе на следующем прогоне развод повторился бы заново).
 */
export function separateOverlappingNodes(params: {
  ids: string[];
  positions: Map<string, { x: number; y: number }>;
  ownedPositions: Record<string, LevelPos>;
}): Set<string> {
  const { ids, positions, ownedPositions } = params;
  const present = ids.filter((id) => positions.has(id));
  const rects: Rect[] = [];
  for (const id of present) {
    const p = positions.get(id);
    if (!p) continue; // present отфильтрован по positions.has — недостижимо
    rects.push({ minX: p.x, minY: p.y, maxX: p.x + NODE_W, maxY: p.y + NODE_H });
  }
  const weights = present.map((id) => (ownedPositions[id] ? OWNED_WEIGHT : 1));
  const out = separateRects(rects, weights, NODE_SEP_PAD);
  const moved = new Set<string>();
  out.forEach((r, i) => {
    const id = present[i];
    const p = positions.get(id);
    if (!p) return; // present отфильтрован по positions.has — недостижимо
    let nx = r.minX;
    let ny = r.minY;
    const owned = ownedPositions[id];
    if (owned && Math.abs(nx - owned.pos_x) < OWNED_SNAP_EPS && Math.abs(ny - owned.pos_y) < OWNED_SNAP_EPS) {
      nx = owned.pos_x;
      ny = owned.pos_y;
    }
    if (Math.abs(nx - p.x) > 1e-6 || Math.abs(ny - p.y) > 1e-6) {
      positions.set(id, { x: nx, y: ny });
      moved.add(id);
    }
  });
  return moved;
}

/**
 * Живой кламп: MTV-скольжение субъекта (pos, w×h) вдоль чужих узлов `others`
 * (прямоугольники в ТОЙ ЖЕ системе координат, что pos). Несколько итераций —
 * выталкивание может каскадно завести на третьего.
 */
export function clampOutOfNodeRects(
  pos: { x: number; y: number },
  w: number,
  h: number,
  others: Rect[],
  pad: number = NODE_SEP_PAD,
): { x: number; y: number } {
  let out = pos;
  for (let iter = 0; iter < 3; iter++) {
    let hit = false;
    for (const o of others) {
      const push = pushOut(
        { minX: out.x, minY: out.y, maxX: out.x + w, maxY: out.y + h },
        o,
        pad,
      );
      if (push) {
        out = { x: out.x + push.dx, y: out.y + push.dy };
        hit = true;
      }
    }
    if (!hit) break;
  }
  return out;
}
