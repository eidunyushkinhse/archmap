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
import type { FrameElement } from "../types";

// Элемент архитектуры объекта с вложенными по ответу сервера (element_effective): нет
// значения — система (норма эпика «Элемент архитектуры»; так читался любой узел с детьми
// до него). Одна точка нормы для рамок, свёрнутых контейнеров и бейджа детей.
export function frameElement(e: AncestorRef["element_effective"] | undefined): FrameElement {
  return e ?? "system";
}

// ПУСТОЙ УРОВЕНЬ (эпик «связи, упирающиеся в рамку»). Слой — это внутренность
// родителя, и это должно быть видно СРАЗУ, даже когда детей ещё нет: рамка родителя
// рисуется всегда, размером «как будто внутри один узел», и служит одновременно
// целью для дропа первого узла и концом для собственных связей контейнера.
// У рамки без членов нет bbox, поэтому роль единственного члена играет синтетический
// бокс в детерминированной точке. Константы живут ЗДЕСЬ, потому что рамку считают
// двое — конвейер раскладки и оверлей LevelBoundary; разъедься они, стрелка упёрлась
// бы не в ту границу, что нарисована.
export const EMPTY_LEVEL_MEMBER = "__пустой-уровень__";
export const EMPTY_LEVEL_ORIGIN = { x: 0, y: 0 };

/** Члены рамок уровня: на пустом уровне — один синтетический бокс. */
export function frameLocalIds(localIds: string[], ancestorIds: string[]): string[] {
  return localIds.length === 0 && ancestorIds.length > 0 ? [EMPTY_LEVEL_MEMBER] : localIds;
}

// ПЛАШКА ПОДПИСИ РАМКИ («🔍 имя ✕», слева-внизу рамки — graph/FramePlaque.tsx) для
// роутера НЕ препятствие (с 2026-10-27, edge.md E21): линия проходит под плашкой, а
// плашка лежит в слое подписей над линиями (canvas.md CV33). Полоса под подпись внизу
// рамки (BOUNDARY_LABEL_PAD) остаётся — это место самой плашки, а не запрет для линий.
// До этого плашка была жёстким препятствием с оценкой ширины по длине имени
// (framePlaqueRect, реестр ROUTER_VERSION); геометрия маршрутов изменилась — v19.

export interface FrameRect {
  id: string;
  name: string;
  depth: number;           // 0 — самый внешний предок; глубже → меньше отступ
  native: boolean;         // true — рамка из breadcrumb (родная)
  memberIds: Set<string>;  // id отображаемых узлов-членов рамки
  // Элемент архитектуры объекта, нарисованного рамкой (вид — frameStyle.ts, Р20):
  // гостевые рамки и рамки раскрытых локалов — из element_effective звена цепочки (у
  // гостя её строит сервер, у раскрытого локала — expandLocal конвейера); нативные — из
  // входа ancestorElements (элементы крошек). Нет значения — система (frameElement).
  element: FrameElement;
  // Внешний ли объект рамки — палитра заливки контейнера (своя или внешняя, getNodeColors).
  // Гостевые — из звена цепочки; нативные — false: внешность предков крошек холст не
  // получает (проп предков несёт имена, id и элементы).
  is_external: boolean;
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
  element: FrameElement;
  is_external: boolean;
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
  // Элементы архитектуры предков крошек (параллельно ancestorIds) — только для вида
  // нативных рамок (LevelBoundary). Конвейер и стадии геометрии вход не передают: на
  // членство и прямоугольники элемент не влияет, их нативные рамки — системы.
  ancestorElements?: readonly AncestorRef["element_effective"][];
}): FrameRect[] {
  const { localIds, externals, pos, ancestorIds, ancestorNames, ancestorElements } = params;
  // На корне (breadcrumb пуст) нативных рамок нет, но гостевые строятся: рамки
  // раскрытых ЛОКАЛЬНЫХ контейнеров (R5) живут и на корневом уровне.
  if (localIds.length === 0) return [];

  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));
  const frames = new Map<string, FrameDef>();
  // breadcrumb-рамки (нативные): локальные узлы — члены каждого предка
  ancestorIds.forEach((id, i) => {
    frames.set(id, {
      id, name: ancestorNames[i], depth: i, native: true, memberIds: new Set(localIds),
      element: frameElement(ancestorElements?.[i]), is_external: false,
    });
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
      if (!frame) {
        frame = {
          id: a.id, name: a.name, depth, native: false, memberIds: new Set(),
          element: frameElement(a.element_effective), is_external: a.is_external,
        };
        frames.set(a.id, frame);
      }
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
      element: f.element, is_external: f.is_external,
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
