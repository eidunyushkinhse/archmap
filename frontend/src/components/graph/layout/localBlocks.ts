// БЛОКИ РАСКРЫТЫХ ЛОКАЛОВ НА СВЕЖЕЙ СЦЕНЕ (Ф4б эпика «стрелки без жёстких хэндлов»,
// шаг 3; docs/plan-arrows-ports.md).
//
// Плоский ELK уровня не знает, что дети раскрытого контейнера — одна группа: на свежей
// сцене (ни один локал не владеет позицией — первое открытие уровня, «Переразложить»)
// он разбрасывает их по слоям вперемешку с соседями, рамка обводит результат и
// растягивается на полсцены, а чужие стрелки обязаны её огибать (E21/E90). На владеемых
// сценах такого нет: там детей кладёт мини-раскладка спавна от закреплённой позиции
// контейнера (C9 v2). Здесь — то же самое для свежей сцены: сначала мини-раскладка
// детей (ТА ЖЕ функция layoutChildrenBlock, что у спавна), затем контейнер идёт в
// раскладку уровня ОДНИМ узлом размера своей нарисованной рамки (C12: bbox детей +
// поля по глубине вложенности), а после раскладки дети ставятся внутрь. Рамка
// компактна по построению и одинакова на свежих и владеемых сценах; это наш ответ
// вложенным коробкам ELK (compound) без второго режима раскладки.
//
// Вложенные раскрытия (контейнер в контейнере, до MAX_INLINE_DEPTH) строятся снизу
// вверх: вложенный блок участвует в мини-раскладке родителя узлом размера СВОЕЙ рамки.
// Размер рамки блока считается ровно так, как её потом нарисует computeFrames: bbox
// ЛИСТЬЕВ-потомков (190×100) + `30 + rings·34` по сторонам и `30 + rings·24` снизу,
// где rings — глубина вложенных раскрытий внутри блока.
//
// Позиция самого контейнера (own-on-expand, C6) = левый-верхний угол bbox его детей —
// её вызывающий засевает вместе с детьми: дальнейший спавн новых детей на уже
// владеемой сцене стартует от неё, как после обычного раскрытия.
import { NODE_W, NODE_H, BOUNDARY_PAD, BOUNDARY_STEP, BOUNDARY_LABEL_PAD, BOUNDARY_LABEL_STEP } from "../constants";
import { layoutChildrenBlock, childParentMap, liftToMember } from "./spawnChildren";
import type { LayoutEdge, Node as AppNode } from "../../../types";

type XY = { x: number; y: number };

/** Блок раскрытого локала: размер рамки и позиции потомков от её левого-верхнего угла. */
export interface LocalBlock {
  /** id контейнера */
  id: string;
  /** размер нарисованной рамки — им блок участвует в раскладке (уровня или родителя) */
  frame: { w: number; h: number };
  /** глубина вложенных раскрытий внутри блока (0 — только листья) */
  rings: number;
  /** поле рамки (BOUNDARY_PAD + rings·BOUNDARY_STEP) */
  pad: number;
  /** отображаемые листья-потомки → позиция относительно левого-верхнего угла рамки */
  leafRel: Map<string, XY>;
  /** вложенные блоки → левый-верхний угол ИХ рамки относительно рамки этого блока */
  nestedRel: Map<string, XY>;
  nested: LocalBlock[];
  /** прямые дети контейнера (листья и вложенные блоки), отсортированы по id */
  direct: string[];
}

export interface LocalBlocks {
  /** верхние блоки (контейнеры, чей родитель — не блок): узлы раскладки уровня */
  top: LocalBlock[];
  /** отображаемый локал (лист блока) → id ВЕРХНЕГО блока */
  blockOf: Map<string, string>;
  /** рёбра уровня с концами, поднятыми к верхним блокам; внутренние рёбра блока выброшены */
  liftEdges(edges: readonly LayoutEdge[]): LayoutEdge[];
  /**
   * Ставит листья по позициям верхних блоков из `positions` (МУТИРУЕТ: пишет листья,
   * удаляет записи блоков) и доводит порядок детей внутри рядов по внешним связям (шаг 4,
   * см. tuneRows). Возвращает позицию каждого контейнера-блока (левый-верх bbox его
   * детей, C6) — для засева владения.
   */
  place(positions: Map<string, XY>): Map<string, XY>;
}

/**
 * Строит блоки раскрытых локалов свежей сцены. `absorbed` — раскрытые локалы, заменённые
 * детьми (все уровни вложенности); `localChildren` — их прямые дети. null — блоков нет
 * либо мини-раскладка не дала позиций (тогда уровень раскладывается плоско, как прежде).
 */
export async function buildLocalBlocks(params: {
  absorbed: ReadonlySet<string>;
  localChildren: Record<string, AppNode[]>;
  layoutEdges: readonly LayoutEdge[];
}): Promise<LocalBlocks | null> {
  const { absorbed, localChildren, layoutEdges } = params;
  if (absorbed.size === 0) return null;
  const parentOf = childParentMap(localChildren);

  // снизу вверх: блок строится после своих вложенных блоков (их рамки — его узлы)
  const built = new Map<string, LocalBlock>();
  const build = async (cid: string): Promise<LocalBlock | null> => {
    const memo = built.get(cid);
    if (memo) return memo;
    const direct = (localChildren[cid] ?? []).map((n) => n.id).sort(); // детерминизм
    if (direct.length === 0) return null;
    const nested: LocalBlock[] = [];
    const nestedById = new Map<string, LocalBlock>();
    for (const d of direct) {
      if (!absorbed.has(d)) continue;
      const nb = await build(d);
      if (!nb) return null;
      nested.push(nb);
      nestedById.set(d, nb);
    }
    const sizeOf = (id: string): { w: number; h: number } => nestedById.get(id)?.frame ?? { w: NODE_W, h: NODE_H };
    const mini = await layoutChildrenBlock({ cid, ids: direct, sizeOf, layoutEdges, parentOf });
    if (!mini) return null;

    // листья-потомки и вложенные рамки в координатах мини-раскладки
    const leaves = new Map<string, XY>();
    const nestedAt = new Map<string, XY>();
    for (const d of direct) {
      const r = mini.rel.get(d);
      if (!r) return null;
      const nb = nestedById.get(d);
      if (nb) {
        nestedAt.set(d, r);
        for (const [l, lr] of nb.leafRel) leaves.set(l, { x: r.x + lr.x, y: r.y + lr.y });
      } else {
        leaves.set(d, r);
      }
    }
    // рамка — как её нарисует computeFrames: bbox ЛИСТЬЕВ + поля по глубине вложенности
    const rings = nested.length ? 1 + Math.max(...nested.map((nb) => nb.rings)) : 0;
    const pad = BOUNDARY_PAD + rings * BOUNDARY_STEP;
    const labelPad = BOUNDARY_LABEL_PAD + rings * BOUNDARY_LABEL_STEP;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of leaves.values()) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    }
    if (!Number.isFinite(minX)) return null;
    // сдвиг: левый-верх bbox листьев → (pad, pad) от угла рамки
    const dx = pad - minX, dy = pad - minY;
    const leafRel = new Map<string, XY>();
    for (const [l, p] of leaves) leafRel.set(l, { x: p.x + dx, y: p.y + dy });
    const nestedRel = new Map<string, XY>();
    for (const [d, p] of nestedAt) nestedRel.set(d, { x: p.x + dx, y: p.y + dy });
    const block: LocalBlock = {
      id: cid,
      frame: { w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad + labelPad },
      rings, pad, leafRel, nestedRel, nested, direct,
    };
    built.set(cid, block);
    return block;
  };

  // верхние блоки — раскрытые локалы, чей родитель не раскрыт (не поглощён)
  const topIds = [...absorbed].filter((cid) => { const p = parentOf.get(cid); return p === undefined || !absorbed.has(p); }).sort();
  const top: LocalBlock[] = [];
  for (const cid of topIds) {
    const b = await build(cid);
    if (!b) return null;
    top.push(b);
  }
  if (top.length === 0) return null;

  const blockOf = new Map<string, string>();
  for (const b of top) for (const l of b.leafRel.keys()) blockOf.set(l, b.id);
  const liftId = (id: string): string => blockOf.get(id) ?? id;

  return {
    top,
    blockOf,
    liftEdges: (edges) => {
      const out: LayoutEdge[] = [];
      for (const e of edges) {
        const s = liftId(e.source_id), t = liftId(e.target_id);
        if (s === t && blockOf.has(e.source_id)) continue; // внутреннее ребро блока
        out.push(s === e.source_id && t === e.target_id ? e : { ...e, source_id: s, target_id: t });
      }
      return out;
    },
    place: (positions) => {
      const origins = new Map<string, XY>();
      // позиция контейнера (C6) = левый-верх bbox его детей = угол рамки + поле;
      // вложенные — рекурсивно от угла своей рамки (после доводки порядка — углы
      // вложенных рамок могли переехать внутри ряда)
      const originsOf = (b: LocalBlock, frameAt: XY, nestedAt: Map<string, XY>): void => {
        origins.set(b.id, { x: frameAt.x + b.pad, y: frameAt.y + b.pad });
        for (const nb of b.nested) {
          const at = nestedAt.get(nb.id);
          if (at) originsOf(nb, at, tuneRows(nb, at, positions, layoutEdges, parentOf));
        }
      };
      // сначала листья ВСЕХ блоков (доводка читает позиции соседей из других блоков),
      // потом доводка и углы
      const frameAt = new Map<string, XY>();
      for (const b of top) {
        const p = positions.get(b.id);
        if (!p) continue;
        frameAt.set(b.id, p);
        for (const [l, r] of b.leafRel) positions.set(l, { x: p.x + r.x, y: p.y + r.y });
        positions.delete(b.id);
      }
      for (const b of top) {
        const p = frameAt.get(b.id);
        if (p) originsOf(b, p, tuneRows(b, p, positions, layoutEdges, parentOf));
      }
      return origins;
    },
  };
}

// ДОВОДКА ПОРЯДКА ДЕТЕЙ ПО ВНЕШНИМ СВЯЗЯМ (Ф4б, шаг 4). Мини-раскладка блока решала
// порядок детей внутри ряда только по внутренним рёбрам — где окажутся их внешние
// соседи, она не знала (цена отказа от compound ELK, где это одна задача). Здесь, когда
// позиции уровня уже известны, ряды блока перебираются как в layered-свипе: барицентр
// ребёнка = среднее центров ВСЕХ его соседей (внутренних — по текущим позициям, внешних —
// по позициям уровня), ряд пересортировывается по барицентру и переупаковывается с
// ПРЕЖНЕЙ последовательностью зазоров: ширина ряда, а с ней рамка блока и место,
// зарезервированное под неё раскладкой уровня, не меняются. Два прохода (сверху вниз и
// снизу вверх) — порядок соседних рядов влияет друг на друга через внутренние рёбра.
// Вложенный блок переставляется вместе со своими листьями; его собственные ряды
// доводятся рекурсивно (вызывающий). Возвращает актуальные углы вложенных рамок.
const ROW_EPS = 1;

function tuneRows(
  b: LocalBlock,
  frameAt: XY,
  positions: Map<string, XY>,
  layoutEdges: readonly LayoutEdge[],
  parentOf: ReadonlyMap<string, string>,
): Map<string, XY> {
  const nestedById = new Map(b.nested.map((nb) => [nb.id, nb] as const));
  // геометрия прямых детей (абсолютная): лист — позиция, вложенный блок — угол его рамки
  interface Item { id: string; x: number; y: number; w: number }
  const items: Item[] = [];
  for (const id of b.direct) {
    const nb = nestedById.get(id);
    if (nb) {
      const r = b.nestedRel.get(id);
      if (r) items.push({ id, x: frameAt.x + r.x, y: frameAt.y + r.y, w: nb.frame.w });
    } else {
      const p = positions.get(id);
      if (p) items.push({ id, x: p.x, y: p.y, w: NODE_W });
    }
  }
  const itemOf = new Map(items.map((it) => [it.id, it] as const));
  const directSet = new Set(b.direct);
  const finishNested = (): Map<string, XY> => {
    const out = new Map<string, XY>();
    for (const nb of b.nested) { const it = itemOf.get(nb.id); if (it) out.set(nb.id, { x: it.x, y: it.y }); }
    return out;
  };
  // ряды — по y верхнего края (ELK выравнивает слой по верху)
  const rows: Item[][] = [];
  for (const it of [...items].sort((p, q) => (p.y - q.y) || (p.x - q.x))) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= ROW_EPS) row.push(it);
    else rows.push([it]);
  }
  if (rows.every((r) => r.length < 2)) return finishNested();

  const centerX = (id: string): number | null => {
    const d = liftToMember(id, directSet, parentOf);
    if (d !== null) { const it = itemOf.get(d); return it ? it.x + it.w / 2 : null; }
    const p = positions.get(id); // внешний сосед: лист другого блока, локал, гость
    return p ? p.x + NODE_W / 2 : null;
  };
  const barycenter = (it: Item): number => {
    let sum = 0, n = 0;
    for (const e of layoutEdges) {
      const s = liftToMember(e.source_id, directSet, parentOf), t = liftToMember(e.target_id, directSet, parentOf);
      if ((s === it.id) === (t === it.id)) continue; // не инцидентно либо петля внутри ребёнка
      const other = centerX(s === it.id ? e.target_id : e.source_id);
      if (other !== null) { sum += other; n++; }
    }
    return n ? sum / n : it.x + it.w / 2;
  };
  const sweep = (row: Item[]): void => {
    if (row.length < 2) return;
    const order = [...row].sort((p, q) => p.x - q.x);
    const gaps = order.slice(1).map((it, i) => it.x - (order[i].x + order[i].w));
    const bary = new Map(order.map((it) => [it.id, barycenter(it)] as const));
    const sorted = [...order].sort((p, q) => ((bary.get(p.id) ?? 0) - (bary.get(q.id) ?? 0)) || (p.x - q.x));
    let x = order[0].x;
    sorted.forEach((it, i) => {
      const dx = x - it.x;
      if (Math.abs(dx) > 1e-6) {
        it.x = x;
        const nb = nestedById.get(it.id);
        if (nb) { for (const l of nb.leafRel.keys()) { const p = positions.get(l); if (p) positions.set(l, { x: p.x + dx, y: p.y }); } }
        else positions.set(it.id, { x, y: it.y });
      }
      x += it.w + (gaps[i] ?? 0);
    });
  };
  for (const row of rows) sweep(row);
  for (let i = rows.length - 1; i >= 0; i--) sweep(rows[i]);
  return finishNested();
}
