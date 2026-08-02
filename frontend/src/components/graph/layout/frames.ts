// Геометрия рамок уровня (C4-boundary) — единый источник правды для рендера
// (boundaries.tsx) и для энфорса запрета проникновения гостей (keepGhostsOut.ts).
// Чистая функция: ничего не мутирует, считает прямоугольники по позициям узлов.
//
// Рамки бывают двух родов:
//  - НАТИВНЫЕ (native) — предки из breadcrumb (F_0 внешний … F_k = текущий контейнер).
//    Член нативной рамки F_i — локальный узел ИЛИ гость с lcaIdx ≥ i (lcaIdx — самый
//    глубокий breadcrumb-предок среди предков гостя). Нативные рамки концентрически
//    вложены: членство F_0 ⊇ … ⊇ F_k, поэтому их нарисованные прямоугольники вложены.
//  - ГОСТЕВЫЕ — контейнеры-предки гостя ниже общего предка (рамки развёрнутых
//    соседних контейнеров). Не нативные. У гостя БЕЗ общего предка с уровнем
//    гостевыми становятся ВСЕ его контейнеры-предки от корня (чужая ветка рисуется
//    своими рамками снаружи родных).
import { NODE_W, NODE_H, BOUNDARY_PAD, BOUNDARY_STEP, BOUNDARY_LABEL_PAD, BOUNDARY_LABEL_STEP } from "../constants";
import type { AncestorRef } from "../../../types";

export interface FrameRect {
  id: string;
  name: string;
  depth: number;           // 0 — самый внешний предок; глубже → меньше отступ
  native: boolean;         // true — рамка из breadcrumb (родная)
  memberIds: Set<string>;  // id отображаемых узлов-членов рамки
  // bbox самих членов (без паддинга)
  content: { minX: number; minY: number; maxX: number; maxY: number };
  // нарисованный прямоугольник (с паддингом и полосой под подпись снизу)
  rect: { x: number; y: number; w: number; h: number };
}

interface FrameDef {
  id: string;
  name: string;
  depth: number;
  native: boolean;
  memberIds: Set<string>;
}

/**
 * Рамки уровня по позициям узлов. `localIds` — локальные узлы (члены всех breadcrumb-
 * рамок); `externals` — гости/контейнеры (членство по их предкам). `pos` отдаёт
 * левый-верхний угол узла (или undefined — узел без позиции исключается из bbox).
 * Возвращает только рамки с валидным bbox, отсортированные по depth (внешние первыми).
 */
export function computeFrames(params: {
  localIds: string[];
  externals: { id: string; ancestors: AncestorRef[] }[];
  pos: (id: string) => { x: number; y: number } | undefined;
  ancestorIds: string[];
  ancestorNames: string[];
}): FrameRect[] {
  const { localIds, externals, pos, ancestorIds, ancestorNames } = params;
  // На корне (breadcrumb пуст) нативных рамок нет, но гостевые строятся: рамки
  // раскрытых ЛОКАЛЬНЫХ контейнеров (R5) живут и на корневом уровне.
  if (localIds.length === 0) return [];

  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));
  const frames = new Map<string, FrameDef>();
  // breadcrumb-рамки (нативные): локальные узлы — члены каждого предка
  ancestorIds.forEach((id, i) => {
    frames.set(id, { id, name: ancestorNames[i], depth: i, native: true, memberIds: new Set(localIds) });
  });

  for (const g of externals) {
    const anc = g.ancestors;
    // общий предок = самый глубокий breadcrumb-предок среди предков гостя
    let lcaIdx = -1, lcaPos = -1;
    anc.forEach((a, pos) => {
      const idx = bcIndex.get(a.id);
      if (idx !== undefined && idx > lcaIdx) { lcaIdx = idx; lcaPos = pos; }
    });
    // член breadcrumb-рамок до общего предка включительно (если общий предок есть)
    for (let i = 0; i <= lcaIdx; i++) {
      const frame = frames.get(ancestorIds[i]);
      if (frame) frame.memberIds.add(g.id);
    }
    // Контейнеры-предки ниже общего предка — гостевые рамки. Для гостя БЕЗ общего
    // предка (lcaPos = −1) это вся его «чужая» ветка от корня (напр. HelixMon ⊃
    // ObsCore вокруг листа): такой раскрытый гость-контейнер тоже обводится своими
    // рамками — снаружи родных, но не голым узлом.
    for (let p = lcaPos + 1; p < anc.length; p++) {
      const a = anc[p];
      const depth = lcaIdx + (p - lcaPos);
      let frame = frames.get(a.id);
      if (!frame) { frame = { id: a.id, name: a.name, depth, native: false, memberIds: new Set() }; frames.set(a.id, frame); }
      frame.memberIds.add(g.id);
    }
  }

  const defs = [...frames.values()];
  // «Кольцевая» глубина каждой рамки — относительно её СОБСТВЕННОГО концентрического
  // стека, а не глобального максимума. Иначе отдельный (не вложенный в родные) стек
  // гостевых рамок наследовал бы крупный отступ внешних РОДНЫХ колец и выглядел бы
  // непропорционально широким (внешний гость-контейнер vs внутренний промежуточный).
  // Рамки одного стека делят хотя бы один узел-член (концентрически вложены), поэтому
  // refMaxDepth(F) = самая глубокая рамка, делящая с F хотя бы один член.
  const refMaxDepth = (f: FrameDef): number => {
    let m = f.depth;
    for (const g of defs) {
      if (g === f || g.depth <= m) continue;
      for (const id of g.memberIds) {
        if (f.memberIds.has(id)) { m = g.depth; break; }
      }
    }
    return m;
  };

  const rects: FrameRect[] = [];
  for (const f of defs) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of f.memberIds) {
      const p = pos(id);
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    }
    if (!isFinite(minX)) continue;
    const rings = refMaxDepth(f) - f.depth;
    const pad = BOUNDARY_PAD + rings * BOUNDARY_STEP;
    // рамку растягиваем вниз сильнее (полоса под подпись); внешним рамкам добавка больше
    const labelPad = BOUNDARY_LABEL_PAD + rings * BOUNDARY_LABEL_STEP;
    rects.push({
      id: f.id, name: f.name, depth: f.depth, native: f.native, memberIds: f.memberIds,
      content: { minX, minY, maxX, maxY },
      rect: { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad + labelPad },
    });
  }
  // внешние рамки (меньший depth) первыми — под внутренними
  rects.sort((a, b) => a.depth - b.depth);
  return rects;
}

// --- Дерево рамок ПО ЧЛЕНСТВУ (единые хелперы; до 2026-07-09 логика жила тремя
// копиями: keepGhostsOut.parentOf/homeOf, separateGuests.parentFrameOf/deepestFrameOf,
// frameOfFrame/frameOfEntity в сборке LevelGraph — и грозила разъехаться).

/**
 * Родитель рамки = минимальная объемлющая: самая ГЛУБОКАЯ рамка с МЕНЬШИМ depth,
 * являющаяся надмножеством её членов. null — рамка верхнего уровня.
 */
export function parentFrameOf(frames: readonly FrameRect[], f: FrameRect): FrameRect | null {
  let best: FrameRect | null = null;
  for (const g of frames) {
    if (g === f || g.depth >= f.depth) continue;
    let superset = true;
    for (const id of f.memberIds) {
      if (!g.memberIds.has(id)) { superset = false; break; }
    }
    if (superset && (!best || g.depth > best.depth)) best = g;
  }
  return best;
}

/** «Домашняя» рамка узла — самая глубокая содержащая его членом; null — вне рамок. */
export function deepestFrameContaining(frames: readonly FrameRect[], id: string): FrameRect | null {
  let best: FrameRect | null = null;
  for (const f of frames) {
    if (f.memberIds.has(id) && (!best || f.depth > best.depth)) best = f;
  }
  return best;
}
