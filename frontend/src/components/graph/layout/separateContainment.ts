// Разведение наложений по дереву containment изнутри наружу (Ф4.2b).
//
// Рамка = bbox её членов, поэтому разводить нужно ПО СЛОЯМ вложенности: внутри каждой
// рамки развести её прямых детей, затем саму рамку (как жёсткий супер-узел = bbox детей)
// развести среди её сиблингов на уровень выше. Иначе сдвиг одного члена раздул бы рамку и
// сломал бы соседние (каскад). Так вложенный гость (И в рамке Ж) расходится с владеемым
// соседом (З) через сдвиг супер-узла Ж — рамка движется жёстко, дети едут с ней.
//
// Обход пост-ордером (дети раньше родителя): settle(frame) сначала рекурсивно укладывает
// детей, потом separateRects (Ф4.2a) разводит их bbox-ы с учётом весов [R4], сдвинутые
// дети транслируются ВСЕМ поддеревом, и рамка возвращает свой новый bbox наверх.
//
// Чистая функция, развязана от модели сущностей (вход — абстрактный лес). НЕ делает:
//  • native keep-out (узел вне родной рамки) — Ф4.3 (фиксир.-сторона / существующий enforce);
//  • expand-in-place (центр раскрытой рамки = центр узла) — обеспечивается ДО прохода (Ф4.3);
//    здесь раскрытую рамку «пиннит» большой вес в её листе/рамке → расходятся соседи.
// См. REFACTOR_OWNERSHIP_F4.md.

import { separateRects } from "./separateRects";
import type { Rect } from "./overlapConstraints";

/** Лист дерева — отображаемый узел с собственным прямоугольником и весом подвижности. */
export interface CLeaf {
  kind: "leaf";
  id: string;
  rect: Rect;
  /** вес при разведении среди сиблингов (больше = меньше двигается; локал/пин — огромный) */
  weight: number;
}

/** Рамка — супер-узел: жёсткая группа детей + паддинг до нарисованного bbox. */
export interface CFrame {
  kind: "frame";
  /** вес самой рамки при разведении среди ЕЁ сиблингов */
  weight: number;
  /** паддинг от bbox детей до прямоугольника рамки (симметричный) */
  pad: number;
  children: CNode[];
}

export type CNode = CLeaf | CFrame;

interface Settled {
  /** прямоугольник узла/рамки после укладки поддерева */
  rect: Rect;
  /** финальные позиции (прямоугольники) всех листьев поддерева, по id */
  positions: Map<string, Rect>;
}

const translate = (r: Rect, dx: number, dy: number): Rect => ({
  minX: r.minX + dx, minY: r.minY + dy, maxX: r.maxX + dx, maxY: r.maxY + dy,
});

const bboxOf = (rects: Rect[]): Rect => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.minX); minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX); maxY = Math.max(maxY, r.maxY);
  }
  return { minX, minY, maxX, maxY };
};

// укладывает узел: лист — как есть; рамка — рекурсивно дети, потом разводит их, собирает bbox
function settle(node: CNode, gap: number): Settled {
  if (node.kind === "leaf") {
    return { rect: node.rect, positions: new Map([[node.id, node.rect]]) };
  }
  // дети сначала укладываются внутри себя
  const settledChildren = node.children.map((c) => settle(c, gap));
  const childRects = settledChildren.map((s) => s.rect);
  const weights = node.children.map((c) => c.weight);
  // разводим bbox-ы прямых детей среди сиблингов
  const newRects = separateRects(childRects, weights, gap);
  // транслируем каждое поддерево ребёнка на его сдвиг и собираем позиции листьев
  const positions = new Map<string, Rect>();
  settledChildren.forEach((s, i) => {
    const dx = newRects[i].minX - childRects[i].minX;
    const dy = newRects[i].minY - childRects[i].minY;
    for (const [id, r] of s.positions) positions.set(id, translate(r, dx, dy));
  });
  // прямоугольник рамки = bbox разведённых детей + симметричный паддинг
  const bb = bboxOf(newRects);
  const rect: Rect = {
    minX: bb.minX - node.pad, minY: bb.minY - node.pad,
    maxX: bb.maxX + node.pad, maxY: bb.maxY + node.pad,
  };
  return { rect, positions };
}

/**
 * Разводит наложения по дереву containment изнутри наружу. `root` — синтетическая рамка
 * уровня (дети: локалы как тяжёлые листья + гостевые группы); её собственный паддинг
 * игнорируется (берётся уровень детей). `gap` — зазор между сторонами при разведении.
 * Возвращает финальные позиции (левый-верхний угол) всех листьев по id. Чистая функция.
 */
export function separateContainment(root: CFrame, gap: number): Map<string, { x: number; y: number }> {
  const settled = settle(root, gap);
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, r] of settled.positions) out.set(id, { x: r.minX, y: r.minY });
  return out;
}
