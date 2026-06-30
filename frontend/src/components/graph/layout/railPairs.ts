// Разведение ВСТРЕЧНОЙ пары рёбер на параллельные рельсы (эпик стрелок A11, пересмотр R4-4a).
//
// ПРОБЛЕМА: два ребра между ОДНОЙ парой узлов в противоположных направлениях (A→B и B→A)
// причаливают в центры обращённых сторон (idx=1) → едут по ОДНОМУ плечу → coincidentLegs
// помечает его общим → R4 запрещает плашки на нём → обе подписи уходят в leader (см. BUG B
// в [[arrows-routing-epic]]). Раздвижка узлов (A10) этого не лечит: блокер — совпадение плеч.
//
// РЕШЕНИЕ (вариант B архитектора): развести направления на ДВА параллельных плеча, посадив их
// на КРАЙНИЕ слоты хэндлов обращённых сторон (offsets 0.25 и 0.75 — idx 0 и 2 в SIDE_HANDLES)
// вместо общего центра. Тогда плечи перестают совпадать, у каждого направления свой уникальный
// участок → плашки ложатся инлайн (placeLabels). Машинерия слотов уже есть (handlePoint(p,side,
// idx) + реальные RF-хэндлы на каждом offset) — здесь только ЧИСТОЕ назначение сторон и слотов.
//
// Чистая функция; вход не мутируется. Только точная встречная ПАРА (ровно 2 ребра, A→B и B→A);
// одиночные/однонаправленные/петли не трогаем.

import type { EdgeSide } from "../edgePath";
import { NODE_W, NODE_H } from "../constants";

/** Назначение стороны и слота-рельса для одного конца ребра встречной пары. */
export interface RailAssignment {
  sSide: EdgeSide;
  sIdx: number;
  tSide: EdgeSide;
  tIdx: number;
}

// Крайние слоты хэндлов (offsets 0.25 / 0.75) — две рельсы; центр (idx 1) остаётся обычным рёбрам.
const RAIL_LO = 0; // верхняя (горизонтальный коридор) / левая (вертикальный) рельса
const RAIL_HI = 2; // нижняя / правая рельса

interface GroupRef {
  id: string;
  source: string;
  target: string;
}

const centerX = (p: { x: number; y: number }): number => p.x + NODE_W / 2;
const centerY = (p: { x: number; y: number }): number => p.y + NODE_H / 2;

// Обращённые стороны source→target по доминантной оси разноса центров (как freeCombos, но
// только доминантная пара — рельсы идут вдоль неё, смещаясь перпендикулярно через idx).
function facingSides(
  sp: { x: number; y: number }, tp: { x: number; y: number },
): { sSide: EdgeSide; tSide: EdgeSide } {
  const dx = centerX(tp) - centerX(sp);
  const dy = centerY(tp) - centerY(sp);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { sSide: "right", tSide: "left" } : { sSide: "left", tSide: "right" };
  }
  return dy >= 0 ? { sSide: "bottom", tSide: "top" } : { sSide: "top", tSide: "bottom" };
}

/**
 * Находит встречные пары среди роутируемых групп и назначает им рельсы.
 * `groups` — все группы (читаются source/target/id), `routableIds` — какие роутятся,
 * `positions` — позиции узлов (левый-верх). Возвращает Map: groupId → RailAssignment ТОЛЬКО
 * для рёбер встречных пар; остальные отсутствуют (вызывающий оставляет им обычное поведение).
 * Слот назначается детерминированно: ребро с меньшим id → RAIL_LO, встречное → RAIL_HI (на
 * ОБОИХ концах — рельса прямая). Сторона у обоих рёбер — обращённая (одна ось), idx развязывает.
 */
export function railAssignments(
  groups: ReadonlyArray<GroupRef>,
  routableIds: ReadonlySet<string>,
  positions: ReadonlyMap<string, { x: number; y: number }>,
): Map<string, RailAssignment> {
  // группируем роутируемые рёбра по НЕУПОРЯДОЧЕННОЙ паре узлов
  const byPair = new Map<string, GroupRef[]>();
  for (const g of groups) {
    if (!routableIds.has(g.id)) continue;
    if (g.source === g.target) continue; // петля — не пара
    if (!positions.get(g.source) || !positions.get(g.target)) continue;
    const key = g.source < g.target ? `${g.source}|${g.target}` : `${g.target}|${g.source}`;
    const arr = byPair.get(key);
    if (arr) arr.push(g);
    else byPair.set(key, [g]);
  }

  const out = new Map<string, RailAssignment>();
  for (const arr of byPair.values()) {
    if (arr.length !== 2) continue; // только точная пара
    const [a, b] = arr;
    // строго встречные: source/target зеркальны (мастеринг уже слил однонаправленные в одну группу)
    if (!(a.source === b.target && a.target === b.source)) continue;
    // детерминированный слот: меньший id → верхняя/левая рельса
    const lo = a.id < b.id ? a : b;
    const hi = a.id < b.id ? b : a;
    for (const [grp, idx] of [[lo, RAIL_LO] as const, [hi, RAIL_HI] as const]) {
      const sp = positions.get(grp.source)!;
      const tp = positions.get(grp.target)!;
      const { sSide, tSide } = facingSides(sp, tp);
      out.set(grp.id, { sSide, sIdx: idx, tSide, tIdx: idx });
    }
  }
  return out;
}
