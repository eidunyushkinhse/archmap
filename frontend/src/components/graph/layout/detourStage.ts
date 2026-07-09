// Альт-маршрут грузного ребра (эпик стрелок A12, ПОСЛЕДНЕЕ средство; вынесено из
// pipeline при распиле Ф2 аудита 2026-07-09).
//
// Если плашка ушла в leader (инлайн не влез даже после рельсов/раздвижки), уводим
// ЭТО ребро по минимальному детуру в чистую полосу рядом с рядом узлов, где плашка
// ложится инлайн. Двигаем только маршрут (own-on-first-render цел). Детур
// детерминирован (lane из габаритов этого ребра), не учитывает чужие пересечения
// (как A7.4-residual). Кэп длины → иначе остаётся leader.
import { NODE_H, hid } from "../constants";
import type { EdgePoint } from "../../../types";
import type { EdgeGroup } from "../types";
import { labelDetour } from "./labelDetours";
import { labelBoxSize, type Size } from "./labelBox";
import { separateInOutDocks } from "./autoRoutes";
import type { LabelPlacement, LabelMeta } from "./labelLayout";

type NodeRect = { x: number; y: number; w: number; h: number };

/**
 * Уводит leader-рёбра в детуры. МУТИРУЕТ autoRoutes и edgeHandles (маршрут и хэндлы
 * детурнутых рёбер). Возвращает detourPreferred: groupId → желаемая доля плашки на
 * новом маршруте (для финального пере-прохода размещения).
 */
export function applyLabelDetours(params: {
  groupArr: EdgeGroup[];
  labelPlacements: Map<string, LabelPlacement>;
  routableIds: Set<string>;
  positions: Map<string, { x: number; y: number }>;
  displayIds: string[];
  rectOf: (id: string) => NodeRect | null;
  labelMeta: (g: EdgeGroup) => LabelMeta | null;
  autoRoutes: Map<string, EdgePoint[]>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
}): Map<string, number> {
  const {
    groupArr, labelPlacements, routableIds, positions, displayIds,
    rectOf, labelMeta, autoRoutes, edgeHandles,
  } = params;

  const detourPreferred = new Map<string, number>();
  // кандидаты на детур — leader-рёбра (плашка не влезла) из маршрутизируемых
  const detourCands: Array<{ g: EdgeGroup; box: Size }> = [];
  for (const g of groupArr) {
    if (labelPlacements.get(g.id)?.mode !== "leader") continue;
    if (!routableIds.has(g.id)) continue;
    const meta = labelMeta(g);
    if (!meta) continue;
    detourCands.push({ g, box: labelBoxSize(meta.text, { lines: meta.lines }) });
  }
  // КООРДИНАЦИЯ СТЕКА: несколько leader-рёбер (напр. встречная пара) уходят в детур в одну
  // сторону (часто вниз, если сверху другие узлы) — их плашки наложились бы (на дампе A12 так и
  // вышло: 1-строчная на y=389 перекрыла место 5-строчной → та осталась leader). Копим уже
  // размещённые плашки-детуры как доп.препятствия и идём от НИЗКИХ боксов к ВЫСОКИМ: высокая
  // ляжет на lane НИЖЕ чужой, без наложения (кэп длины ограничит стек → совсем глубокий бокс
  // останется leader). Плашка-препятствие двигает lane глубже и не даёт маршруту её пересечь.
  const placedLabelRects: NodeRect[] = [];
  detourCands.sort((a, b) => a.box.h - b.box.h);
  // РАЗВОДКА ХЭНДЛОВ ВСТРЕЧНОЙ ПАРЫ НА ДЕТУРЕ (A12.4): если оба ребра двунаправленной пары
  // ушли в детур в одну сторону, по умолчанию они вышли бы из ОДНОГО хэндла (центр, idx=1) и
  // наложились бы плечами. Раскладка — вложенные «П»: грузное ребро (плашка выше, идёт ГЛУБЖЕ)
  // ведём по ВНЕШНИМ слотам стороны → его «П» шире и охватывает плашку напарника, не пересекая
  // её; напарник остаётся в центре (idx=1, прежнее место). Внешний слот — по геометрии узла:
  // на горизонтальном плече левый узел→слот 0, правый→слот 2 (на вертикальном верхний→0,
  // нижний→2). Так разводятся и хэндлы, и плечи, и нет наложения плашек.
  const detourSlot = new Map<string, { sIdx: number; tIdx: number }>();
  for (const { g, box } of detourCands) {
    const partner = detourCands.find((c) => c.g.source === g.target && c.g.target === g.source);
    if (!partner) continue;
    // глубже ляжет более грузное ребро (выше плашка; при равенстве — больший id)
    const deeper = box.h > partner.box.h || (box.h === partner.box.h && g.id > partner.g.id);
    if (!deeper) continue; // напарник остаётся в центре (слот 1/1 по умолчанию)
    const sp = positions.get(g.source), tp = positions.get(g.target);
    if (!sp || !tp) continue;
    const horiz = Math.abs(tp.x - sp.x) >= Math.abs(tp.y - sp.y);
    const sIdx = horiz ? (sp.x <= tp.x ? 0 : 2) : (sp.y <= tp.y ? 0 : 2);
    const tIdx = horiz ? (tp.x < sp.x ? 0 : 2) : (tp.y < sp.y ? 0 : 2);
    detourSlot.set(g.id, { sIdx, tIdx });
  }
  // концы, посаженные детуром на ДЕФОЛТНЫЙ центральный слот — их потом можно
  // латерально развести (внешние слоты пар A12.4 выбраны осознанно — пин)
  const detourMovable = new Map<string, { s: boolean; t: boolean }>();
  for (const { g, box } of detourCands) {
    const source = rectOf(g.source), target = rectOf(g.target);
    if (!source || !target) continue;
    const obstacles = [
      ...displayIds
        .filter((id) => id !== g.source && id !== g.target)
        .map(rectOf)
        .filter((r): r is NodeRect => r != null),
      ...placedLabelRects,
    ];
    const slot = detourSlot.get(g.id) ?? { sIdx: 1, tIdx: 1 };
    const det = labelDetour({
      source, target, obstacles, box, margin: 8, maxExtraLen: 2 * NODE_H + box.h + 16,
      sIdx: slot.sIdx, tIdx: slot.tIdx,
    });
    if (!det) continue;
    autoRoutes.set(g.id, det.route);
    edgeHandles.set(g.id, { sourceHandle: hid(g.source, det.sSide, slot.sIdx), targetHandle: hid(g.target, det.tSide, slot.tIdx) });
    detourPreferred.set(g.id, det.preferredT);
    detourMovable.set(g.id, { s: slot.sIdx === 1, t: slot.tIdx === 1 });
    // оценочный прямоугольник лёгшей плашки — препятствие для последующих (более высоких)
    placedLabelRects.push({ x: det.center.x - box.w / 2, y: det.center.y - box.h / 2, w: box.w, h: box.h });
  }

  // Рецидив Т4 (2026-07-09): детур сажает концы в ЦЕНТР стороны УЖЕ ПОСЛЕ раздачи
  // слотов distributeSlots — вход и выход разных рёбер склеивались в одной точке
  // (AlertDashboard: «Запрос данных» входил в тот же хэндл, откуда выходила
  // «Запись и чтение»). Повторная разводка: двигаются ТОЛЬКО детурные концы с
  // дефолтным слотом, все прочие стыковки пинятся своим текущим слотом.
  if (detourMovable.size > 0) {
    const rects = new Map<string, NodeRect>();
    for (const id of displayIds) {
      const r = rectOf(id);
      if (r) rects.set(id, r);
    }
    separateInOutDocks({
      routes: autoRoutes,
      edgeHandles,
      rects,
      movable: detourMovable,
      endpoints: new Map(groupArr.map((g) => [g.id, { source: g.source, target: g.target }])),
    });
  }
  return detourPreferred;
}
