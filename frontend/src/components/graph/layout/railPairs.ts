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
// одиночные/однонаправленные/петли не трогаем. После смерти ручного слоя (2026-07-09)
// pairableIds == routableIds — все рёбра уровня в раскладке авто (историческая
// развилка A12.5 «пара из авто+ручных» схлопнулась).

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
 * Находит встречные пары среди участвующих в раскладке групп и назначает им рельсы.
 * `groups` — все группы (читаются source/target/id), `pairableIds` — рёбра уровня,
 * участвующие в раскладке (после смерти ручного слоя — все routable),
 * `positions` — позиции узлов (левый-верх). Возвращает Map: groupId → RailAssignment ТОЛЬКО
 * для рёбер встречных пар; остальные отсутствуют (вызывающий оставляет им обычное поведение).
 * Канонический слот детерминирован: ребро с меньшим id → RAIL_LO, встречное → RAIL_HI (на
 * ОБОИХ концах — рельса прямая). Сторона у обоих рёбер — обращённая (одна ось), idx развязывает.
 *
 * КООРДИНАЦИЯ ПАР (E12, фикс 2026-08-19): две пары, стыкующиеся на ОДНОЙ грани одного
 * узла, канонической раздачей «по id» могли посадить ВХОД одной пары и ВЫХОД другой на
 * один слот — вход в чужой выход, который E12 запрещает всему остальному роутингу
 * (репро: две пары «сервис ↔ брокер» на левой грани Kafka). Лечение: на каждой грани
 * все рельсовые ВЫХОДЫ должны делить один слот, все ВХОДЫ — другой (веер одной роли
 * легален, E11/E12). Пара — двоичная переменная «перевёрнута ли раздача по id»;
 * общая грань двух пар даёт xor-уравнение между их переменными; система решается
 * union-find с чётностью. Противоречие (нечётный цикл граней) — конфликтное уравнение
 * пропускается: одна грань с конфликтом лучше, чем отказ от рельс вовсе.
 */
export function railAssignments(
  groups: ReadonlyArray<GroupRef>,
  pairableIds: ReadonlySet<string>,
  positions: ReadonlyMap<string, { x: number; y: number }>,
): Map<string, RailAssignment> {
  // группируем участвующие в раскладке рёбра по НЕУПОРЯДОЧЕННОЙ паре узлов
  const byPair = new Map<string, GroupRef[]>();
  for (const g of groups) {
    if (!pairableIds.has(g.id)) continue;
    if (g.source === g.target) continue; // петля — не пара
    if (!positions.get(g.source) || !positions.get(g.target)) continue;
    const key = g.source < g.target ? `${g.source}|${g.target}` : `${g.target}|${g.source}`;
    const arr = byPair.get(key);
    if (arr) arr.push(g);
    else byPair.set(key, [g]);
  }

  // отбор точных встречных пар в детерминированном порядке (ключ пары)
  interface Pair {
    lo: GroupRef;  // меньший id — канонически RAIL_LO
    hi: GroupRef;
    sSide: EdgeSide; // сторона у source(lo)
    tSide: EdgeSide; // сторона у target(lo); у встречного ребра стороны зеркальны
  }
  const pairs: Pair[] = [];
  for (const [, arr] of [...byPair.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (arr.length !== 2) continue; // только точная пара
    const [a, b] = arr;
    // строго встречные: source/target зеркальны (мастеринг уже слил однонаправленные в одну группу)
    if (!(a.source === b.target && a.target === b.source)) continue;
    const lo = a.id < b.id ? a : b;
    const hi = a.id < b.id ? b : a;
    const sp = positions.get(lo.source);
    const tp = positions.get(lo.target);
    if (!sp || !tp) continue; // пара прошла фильтр позиций выше — недостижимо
    // facingSides симметрична: у встречного ребра те же грани, поменянные ролями —
    // считаем один раз от lo, у hi стороны зеркальны по построению.
    const { sSide, tSide } = facingSides(sp, tp);
    pairs.push({ lo, hi, sSide, tSide });
  }

  // union-find с чётностью: parity[k] — перевёрнута ли пара k относительно корня
  const parent = pairs.map((_, k) => k);
  const parity = pairs.map(() => 0);
  const find = (k: number): { root: number; par: number } => {
    if (parent[k] === k) return { root: k, par: parity[k] };
    const r = find(parent[k]);
    parent[k] = r.root;
    parity[k] = parity[k] ^ r.par;
    return { root: r.root, par: parity[k] };
  };
  const union = (a: number, b: number, rel: number): void => {
    const ra = find(a), rb = find(b);
    if (ra.root === rb.root) return; // совпало или нечётный цикл — уравнение пропускаем
    parent[ra.root] = rb.root;
    parity[ra.root] = ra.par ^ rb.par ^ rel;
  };

  // Ориентация пары на грани: 0 — ВЫХОД из узла грани лежит на RAIL_LO при канонической
  // раздаче. У source(lo)-узла исходящее — lo (слот LO → 0); у target(lo)-узла исходящее —
  // hi (слот HI → 1).
  const facesOf = (p: Pair): Array<{ key: string; base: number }> => [
    { key: `${p.lo.source}|${p.sSide}`, base: 0 },
    { key: `${p.lo.target}|${p.tSide}`, base: 1 },
  ];
  const seen = new Map<string, { idx: number; base: number }>();
  pairs.forEach((p, k) => {
    for (const f of facesOf(p)) {
      const prev = seen.get(f.key);
      if (prev) {
        // на общей грани ориентации обязаны совпасть: flip(k) ^ flip(prev) = base(k) ^ base(prev)
        union(k, prev.idx, f.base ^ prev.base);
      } else {
        seen.set(f.key, { idx: k, base: f.base });
      }
    }
  });

  const out = new Map<string, RailAssignment>();
  pairs.forEach((p, k) => {
    const flipped = find(k).par === 1;
    const loIdx = flipped ? RAIL_HI : RAIL_LO;
    const hiIdx = flipped ? RAIL_LO : RAIL_HI;
    for (const [grp, idx] of [[p.lo, loIdx] as const, [p.hi, hiIdx] as const]) {
      const sp = positions.get(grp.source);
      const tp = positions.get(grp.target);
      if (!sp || !tp) continue; // пара прошла фильтр позиций выше — недостижимо
      const { sSide, tSide } = facingSides(sp, tp);
      out.set(grp.id, { sSide, sIdx: idx, tSide, tIdx: idx });
    }
  });
  return out;
}
