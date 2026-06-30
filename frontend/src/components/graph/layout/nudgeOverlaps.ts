// Расталкивание наложенных плеч из РАЗНЫХ хэндлов (эпик стрелок, A13). Чистая геометрия.
//
// Зачем: A11 (рельсы) развёл встречные пары, A12.4 — встречную пару на детуре, но остаётся
// класс наложений МЕЖДУ РАЗНЫМИ парами/хэндлами. Два ребра, вышедшие из соседних слотов одной
// стороны узла (или вовсе из разных узлов), могут пойти по одной линии: короткий стаб-«джог»
// одного ложится на длинный «хайвэй» другого. Правило архитектора: наложение плеч допустимо
// ТОЛЬКО если оба плеча из ОДНОГО хэндла; из разных хэндлов наложений быть не должно (иначе на
// развилке непонятно, какая стрелка куда идёт).
//
// Этот пост-проход (после autoRoutes + детуров A12) ищет коллинеарные перекрытия плеч из РАЗНЫХ
// хэндлов и сдвигает КОРОТКИЙ из двух сегментов вбок на NUDGE_PX. Двигаем только ИНТЕРЬЕРНЫЙ
// сегмент (обе его точки — не концы ломаной): концы пришпилены к хэндлам, их трогать нельзя,
// иначе стрелка отстыкуется. Сдвиг сохраняет ортогональность (соседние сегменты перпендикулярны,
// их вторая координата не меняется) и переживает edges.tsx (там концы переснимаются с живых
// хэндлов, а cleanup/ensureOutwardStubs не схлопывают честный 12px-джог). Совпадение из ОДНОГО
// хэндла (родственные стрелки) оставляем как есть — это легитимный общий ствол (R4).
import type { EdgePoint } from "../../../types";
import { cleanup, type SegOrient } from "../edgePath";

const EPS = 0.5;
const OVERLAP_MIN = 3; // перекрытие > 3px считаем наложением (касание концами игнорируем)
const NUDGE_PX = 12;   // на сколько сдвигаем плечо вбок от линии партнёра
const MIN_SEP = 6;     // минимально допустимый зазор от линии партнёра после сдвига

// Ортогональный сегмент очищенной ломаной (сегмент с началом в точке i: i → i+1).
interface Seg {
  i: number;          // индекс начала сегмента в ломаной
  orient: SegOrient;
  axis: number;       // постоянная координата (y для «h», x для «v»)
  lo: number;         // меньшая граница меняющейся координаты
  hi: number;         // большая граница меняющейся координаты
  terminal: boolean;  // примыкает к концу ломаной (i==0 или i+1==last) → концы на хэндлах, не двигаем
}

// Ортогональные сегменты ломаной (вырожденные пропускаем). Ломаную считаем уже очищенной.
function segsOf(pts: EdgePoint[]): Seg[] {
  const out: Seg[] = [];
  const last = pts.length - 1;
  for (let i = 0; i < last; i++) {
    const p = pts[i], q = pts[i + 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    if (Math.abs(dx) <= EPS && Math.abs(dy) <= EPS) continue;
    const orient: SegOrient = Math.abs(dy) <= Math.abs(dx) ? "h" : "v";
    const axis = orient === "h" ? p.y : p.x;
    const lo = orient === "h" ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
    const hi = orient === "h" ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
    out.push({ i, orient, axis, lo, hi, terminal: i === 0 || i + 1 === last });
  }
  return out;
}

// Набор id хэндлов ребра (источник+цель). Пустой — если хэндлы не заданы.
function handleSet(h?: { sourceHandle: string; targetHandle: string }): Set<string> {
  return new Set(h ? [h.sourceHandle, h.targetHandle] : []);
}

// Длина коллинеарного перекрытия двух сегментов (≤0 — не на одной линии или лишь касание).
function overlapLen(a: Seg, b: Seg): number {
  if (a.orient !== b.orient) return 0;
  if (Math.abs(a.axis - b.axis) > EPS) return 0;
  return Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
}

// Сдвигает сегмент i→i+1 на новую постоянную координату newAxis (двигает обе его точки).
// Соседние сегменты ортогональны этому, их вторая координата не меняется → остаются прямыми.
function shiftSegment(pts: EdgePoint[], seg: Seg, newAxis: number): void {
  if (seg.orient === "v") { pts[seg.i].x = newAxis; pts[seg.i + 1].x = newAxis; }
  else { pts[seg.i].y = newAxis; pts[seg.i + 1].y = newAxis; }
}

// Новая позиция сдвигаемого сегмента: вбок от текущей оси в сторону БОЛЬШЕГО запаса до соседнего
// излома, на NUDGE_PX, но не дальше половины запаса (чтобы не сесть на соседа). Сосед по оси:
// для «v» — x точек i-1 и i+2, для «h» — их y. null — если в обе стороны теснее MIN_SEP.
function computeNudge(pts: EdgePoint[], seg: Seg): number | null {
  const before = seg.orient === "v" ? pts[seg.i - 1].x : pts[seg.i - 1].y;
  const after = seg.orient === "v" ? pts[seg.i + 2].x : pts[seg.i + 2].y;
  const roomBefore = Math.abs(before - seg.axis);
  const roomAfter = Math.abs(after - seg.axis);
  const opts = roomBefore >= roomAfter
    ? [{ to: before, room: roomBefore }, { to: after, room: roomAfter }]
    : [{ to: after, room: roomAfter }, { to: before, room: roomBefore }];
  for (const o of opts) {
    const sign = Math.sign(o.to - seg.axis) || 1;
    const step = Math.min(NUDGE_PX, o.room * 0.5);
    if (step < MIN_SEP) continue; // в эту сторону впритык — пробуем другую
    return seg.axis + sign * step;
  }
  return null;
}

export interface NudgeResult {
  routes: Map<string, EdgePoint[]>; // id → ломаная (сдвинутые — новые, прочие — исходные)
  nudged: Set<string>;              // id рёбер, чьи маршруты изменились
}

// Находит коллинеарные наложения плеч из РАЗНЫХ хэндлов и сдвигает короткое плечо вбок.
// Чистая функция: исходные ломаные не мутирует (работает на очищенных копиях).
export function nudgeOverlaps(
  routes: Map<string, EdgePoint[]>,
  handles: ReadonlyMap<string, { sourceHandle: string; targetHandle: string }>,
): NudgeResult {
  const pts = new Map<string, EdgePoint[]>();
  for (const [id, r] of routes) pts.set(id, cleanup(r).map((p) => ({ ...p })));
  const hset = new Map<string, Set<string>>();
  for (const id of pts.keys()) hset.set(id, handleSet(handles.get(id)));
  const ids = [...pts.keys()];
  const nudged = new Set<string>();

  // Несколько проходов: один сдвиг может оставить/создать другое наложение. Каждый проход чинит
  // первое найденное и пересчитывает с нуля. MAX_PASSES — страховка от зацикливания (на практике
  // хватает одного-двух: после сдвига зазор ≥ MIN_SEP, та же пара больше не всплывает).
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    scan:
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const idA = ids[a], idB = ids[b];
        // совпадение из ОДНОГО хэндла — легитимный общий ствол, не трогаем
        const hA = hset.get(idA)!, hB = hset.get(idB)!;
        let shared = false;
        for (const h of hA) if (h && hB.has(h)) { shared = true; break; }
        if (shared) continue;
        const segsA = segsOf(pts.get(idA)!), segsB = segsOf(pts.get(idB)!);
        for (const sa of segsA) {
          for (const sb of segsB) {
            if (overlapLen(sa, sb) <= OVERLAP_MIN) continue;
            // кандидаты на сдвиг — только интерьерные сегменты; короче → дешевле двигать
            const cands: Array<{ id: string; seg: Seg; len: number }> = [];
            if (!sa.terminal) cands.push({ id: idA, seg: sa, len: sa.hi - sa.lo });
            if (!sb.terminal) cands.push({ id: idB, seg: sb, len: sb.hi - sb.lo });
            if (cands.length === 0) continue; // оба плеча концевые — без отстыковки не сдвинуть
            cands.sort((x, y) => x.len - y.len || (x.id < y.id ? -1 : 1));
            let applied = false;
            for (const c of cands) {
              const newAxis = computeNudge(pts.get(c.id)!, c.seg);
              if (newAxis == null) continue; // этому сегменту некуда — пробуем второй кандидат
              shiftSegment(pts.get(c.id)!, c.seg, newAxis);
              nudged.add(c.id);
              applied = true;
              break;
            }
            if (!applied) continue; // обоим тесно — оставляем наложение (лучше, чем кривой маршрут)
            changed = true;
            break scan; // индексы/геометрия поехали — пересчитываем набор заново
          }
        }
      }
    }
    if (!changed) break;
  }

  const result = new Map<string, EdgePoint[]>();
  for (const [id, r] of routes) result.set(id, nudged.has(id) ? cleanup(pts.get(id)!) : r);
  return { routes: result, nudged };
}
