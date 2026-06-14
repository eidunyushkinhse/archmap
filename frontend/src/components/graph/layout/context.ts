// Раскладка контекстной схемы (звезда фокус↔соседи): позиции колонок, хэндлы,
// полки подписей и обходы «не родных» стрелок bidi. Под характеризационными
// тестами Фазы 1. Зовёт hid напрямую, autoHandles НЕ использует → не зависит от level.ts.
import {
  NODE_W, NODE_H, hid,
  BOUNDARY_PAD, BOUNDARY_STEP, MIN_SHELF, SHELF_PAD, CTX_LABEL_W,
} from "../constants";
import type { DisplayExternal, EdgeShelf, EdgeLoop } from "../types";
import type { Edge as AppEdge } from "../../../types";

// Приблизительная ширина плашки подписи (контекст) под шрифт 11px: моноширинная оценка,
// капится по CTX_LABEL_W (длинная подпись переносится по словам). Точную ширину знает
// только DOM в WrappedLabelEdge — здесь нужна лишь оценка для длины полки колонки.
function ctxLabelWidth(text: string): number {
  return Math.min(CTX_LABEL_W, Math.round(text.length * 6.3) + 16);
}

// Раскладка контекстной схемы. Контекстный граф — ЗВЕЗДА: фокус + его прямые соседи,
// каждое ребро (после проекции) идёт фокус↔сосед. Общий dagre гонял звезду как
// сложный граф → длинные гнутые пути, наложения узлов и рамок, подписи под узлами.
// Тут раскладываем детерминированно и frame-aware:
//  • фокус в центре, входящие соседи — колонкой слева, исходящие/двунаправленные — справа;
//  • каждое ребро — один прыжок к ближней стороне соседа, хэндлы назначаются напрямую;
//  • колонку соседа отодвигаем за вылет «приватных» рамок фокуса (рамок предков,
//    членом которых сосед НЕ является), чтобы сосед/его рамка их не пересекали. Рамки,
//    которые сосед делит с фокусом, остаются его членами — bbox сам обнимет обоих;
//  • раскрытый контейнер-сосед = своя рамка вокруг детей: его дети группируются
//    вплотную, а между группами кладём зазор ≥ паддинга рамки (нет вертикальных наложений).
export function computeContextLayout(
  focusId: string,
  focusHeight: number,
  entities: DisplayExternal[],
  edges: AppEdge[],
  ancestorIds: string[],
  expanded: Set<string>,
): {
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
  edgeShelves: Map<string, EdgeShelf>;
  edgeLoops: Map<string, EdgeLoop>;
} {
  const lastDepth = ancestorIds.length - 1;
  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));

  // 1. Метаданные соседа: глубина общего предка-рамки (lcaIdx), ключ группы (рамка
  //    раскрытого контейнера, если сосед раскрыт), флаг «обёрнут собственной рамкой».
  //    Заодно считаем maxDepth — как в LevelBoundary (нужен для величины паддинга).
  interface NMeta { lcaIdx: number; groupKey: string; framed: boolean }
  const meta = new Map<string, NMeta>();
  let maxDepth = Math.max(0, lastDepth);
  for (const ent of entities) {
    const anc = ent.kind === "leaf" ? (ent.ghost.ancestors ?? []) : ent.ancestors;
    let lcaIdx = -1, lcaPos = -1;
    anc.forEach((a, pos) => {
      const idx = bcIndex.get(a.id);
      if (idx !== undefined && idx > lcaIdx) { lcaIdx = idx; lcaPos = pos; }
    });
    let groupKey = ent.id;
    let framed = false;
    if (ent.kind === "leaf" && lcaIdx !== -1) {
      // раскрытые контейнеры-рамки ниже общего предка (первый — внешняя рамка группы)
      for (let pos = lcaPos + 1; pos < anc.length; pos++) {
        if (expanded.has(anc[pos].id)) {
          if (!framed) { groupKey = anc[pos].id; framed = true; }
          maxDepth = Math.max(maxDepth, lcaIdx + (pos - lcaPos));
        }
      }
    }
    meta.set(ent.id, { lcaIdx, groupKey, framed });
  }

  // Горизонтальный вылет приватных рамок фокуса для соседа с данным lcaIdx: сосед —
  // не член рамок глубже его lcaIdx, поэтому должен оказаться за самой внешней из них.
  const reachFor = (lcaIdx: number): number => {
    if (lcaIdx >= lastDepth) return 0;             // делит даже прямого родителя — приватных рамок нет
    const outerPrivateDepth = lcaIdx < 0 ? 0 : lcaIdx + 1; // самая внешняя приватная рамка
    return BOUNDARY_PAD + (maxDepth - outerPrivateDepth) * BOUNDARY_STEP;
  };
  const MARGIN = 48;
  const clearanceOf = (id: string): number => {
    const m = meta.get(id)!;
    return reachFor(m.lcaIdx) + (m.framed ? BOUNDARY_PAD : 0) + MARGIN;
  };

  // 2. Классификация соседей. Чистые: in-only → левая колонка, out-only → правая.
  //    Двунаправленные кладём в колонку, где МЕНЬШЕ чистых соседей (равенство или только
  //    bidi → справа). Тогда «родная» стрелка bidi идёт в естественном направлении колонки
  //    (право=исходящая, лево=входящая), а «не родная» уходит в обход (см. секцию 3).
  const hasOut = new Set<string>(); // есть ребро фокус → сосед
  const hasIn = new Set<string>();  // есть ребро сосед → фокус
  for (const e of edges) {
    if (e.source_id === focusId && e.target_id !== focusId) hasOut.add(e.target_id);
    else if (e.target_id === focusId && e.source_id !== focusId) hasIn.add(e.source_id);
  }
  const isBidi = (id: string): boolean => hasOut.has(id) && hasIn.has(id);
  const pureRight: string[] = [], pureLeft: string[] = [], bidi: string[] = [];
  for (const ent of entities) {
    if (isBidi(ent.id)) bidi.push(ent.id);
    else if (hasOut.has(ent.id)) pureRight.push(ent.id);
    else if (hasIn.has(ent.id)) pureLeft.push(ent.id);
    else pureRight.push(ent.id); // сосед без ребра к фокусу (теоретически) — пусть справа
  }
  const bidiSide: "left" | "right" = pureRight.length <= pureLeft.length ? "right" : "left";
  const right = [...pureRight, ...(bidiSide === "right" ? bidi : [])]; // исходящие (+bidi сюда?)
  const left = [...pureLeft, ...(bidiSide === "left" ? bidi : [])];    // входящие (+bidi сюда?)
  const onRightSet = new Set(right);

  const ROW = NODE_H + 60;
  const positions = new Map<string, { x: number; y: number }>();

  // Группа = соседи под одной рамкой раскрытого контейнера (groupKey), иначе одиночка.
  interface Grp { members: string[]; lcaIdx: number; framed: boolean }
  const buildGroups = (ids: string[]): Grp[] => {
    const map = new Map<string, Grp>();
    const order: string[] = [];
    for (const id of ids) {
      const m = meta.get(id)!;
      if (!map.has(m.groupKey)) {
        map.set(m.groupKey, { members: [], lcaIdx: m.lcaIdx, framed: m.framed });
        order.push(m.groupKey);
      }
      map.get(m.groupKey)!.members.push(id);
    }
    // Ключевой инвариант против наложения рамок: группы, делящие с фокусом более ГЛУБОКУЮ
    // рамку (больший lcaIdx), ставим БЛИЖЕ к центру. Тогда каждая общая рамка — компактная
    // полоса у фокуса, а сосед, который ей не член, гарантированно снаружи (дальше по y).
    return order.map((k) => map.get(k)!).sort((a, b) => b.lcaIdx - a.lcaIdx);
  };

  // Раскладка одной стороны. Двухфазная, чтобы раскрытие контейнера НЕ пересобирало
  // колонку (иначе дети «убегают» в другую часть схемы):
  //   фаза 1 — СЛОТ-центры: «свёрнутая» раскладка, каждая группа считается ЕДИНИЦЕЙ
  //     высотой NODE_H. Слот стабилен независимо от раскрытия (число членов на него не
  //     влияет). Группы расходятся вверх/вниз — каждая на менее заполненную сторону, по
  //     lcaIdx (глубже-делящие рамку — ближе к фокусу). При нечётном числе ГРУПП одна
  //     (groups[0], самая глубоко-делящая) центрируется на горизонтали фокуса (slot 0),
  //     иначе колонка «провисает». Зазор у границы рамки добавляем, когда lcaIdx падает.
  //   фаза 2 — раскрытие НА МЕСТЕ: члены группы расходятся симметрично вокруг её слота,
  //     затем наружный проход от центра убирает наложения — ближние к фокусу группы (и
  //     центрированный слот) держат место, внешние уступают, отъезжая ДАЛЬШЕ от фокуса.
  //     Так центр раскрытой рамки остаётся там, где стоял свёрнутый узел, а соседи лишь
  //     сдвигаются наружу. И исключение «дети не лезут в чужую рамку» соблюдается само:
  //     более глубоко-делящая (ближняя) группа обрабатывается раньше и не двигается, а
  //     растущая группа может только уехать наружу, на свою сторону от фокуса.
  // Свёрнутая раскладка (1 член/группа) — фаза 2 это no-op, позиции те же, что и раньше.
  const layoutSide = (sideIds: string[], dir: 1 | -1): void => {
    if (sideIds.length === 0) return;
    // базовый зазор учитывает место под подпись ребра (CTX_LABEL_W) + поля, чтобы плашка
    // влезала между фокусом и колонкой и не наезжала на узлы
    const sideGap = Math.max(CTX_LABEL_W + 60, ...sideIds.map(clearanceOf));
    const x = dir === 1 ? NODE_W + sideGap : -(sideGap + NODE_W);
    const groups = buildGroups(sideIds);
    const baseGap = ROW - NODE_H; // базовый зазор между соседними узлами

    // паддинг рамки на глубине группы (её члены — внутренние соседи/фокус, но не эта
    // группа) + собственный паддинг, если группа обёрнута своей рамкой (раскрытый контейнер)
    const framePadOf = (g: Grp): number =>
      BOUNDARY_PAD + Math.max(0, maxDepth - (g.lcaIdx + 1)) * BOUNDARY_STEP +
      (g.framed ? BOUNDARY_PAD : 0);
    // половина вертикального размера группы (членов) с учётом собственной рамки — для зазоров
    const halfOf = (g: Grp): number =>
      ((g.members.length - 1) * ROW) / 2 + NODE_H / 2 + (g.framed ? BOUNDARY_PAD : 0);

    // --- фаза 1: слот-центры (каждая группа как единица высотой NODE_H) ---
    const slot = new Map<Grp, number>();
    const centered = groups.length % 2 === 1 ? groups[0] : null;
    let downBot = focusHeight / 2;  // нижняя занятая граница (центр фокуса = 0)
    let upTop = -focusHeight / 2;   // верхняя занятая граница
    let prevDownLca = lastDepth;    // фокус — член всех рамок предков (эффективный lca)
    let prevUpLca = lastDepth;
    let startIdx = 0;
    if (centered) {
      slot.set(centered, 0);
      upTop = -NODE_H / 2;
      downBot = NODE_H / 2;
      prevDownLca = prevUpLca = centered.lcaIdx;
      startIdx = 1;
    }
    for (let gi = startIdx; gi < groups.length; gi++) {
      const g = groups[gi];
      if (downBot <= -upTop) {
        const gap = baseGap + (g.lcaIdx < prevDownLca ? framePadOf(g) : 0);
        const c = downBot + gap + NODE_H / 2;
        slot.set(g, c); downBot = c + NODE_H / 2; prevDownLca = g.lcaIdx;
      } else {
        const gap = baseGap + (g.lcaIdx < prevUpLca ? framePadOf(g) : 0);
        const c = upTop - gap - NODE_H / 2;
        slot.set(g, c); upTop = c - NODE_H / 2; prevUpLca = g.lcaIdx;
      }
    }

    // --- фаза 2: раскрытие на месте + наружный проход против наложений ---
    const center = new Map<Grp, number>();
    if (centered) center.set(centered, 0);
    // нижняя сторона: слоты >= 0 (кроме центрированного), снизу вверх по слоту;
    // верхняя: слоты < 0, сверху вниз по |слоту|. Стартовая граница прохода — край
    // центрированной группы (с её ростом) либо фокуса.
    const belowGroups = groups
      .filter((g) => g !== centered && slot.get(g)! >= 0)
      .sort((a, b) => slot.get(a)! - slot.get(b)!);
    const aboveGroups = groups
      .filter((g) => g !== centered && slot.get(g)! < 0)
      .sort((a, b) => slot.get(b)! - slot.get(a)!);
    let prevBot = centered ? halfOf(centered) : focusHeight / 2;
    let prevBotLca = centered ? centered.lcaIdx : lastDepth;
    for (const g of belowGroups) {
      const half = halfOf(g);
      const gap = baseGap + (g.lcaIdx < prevBotLca ? framePadOf(g) : 0);
      const c = Math.max(slot.get(g)!, prevBot + gap + half);
      center.set(g, c); prevBot = c + half; prevBotLca = g.lcaIdx;
    }
    let prevTop = centered ? -halfOf(centered) : -focusHeight / 2;
    let prevTopLca = centered ? centered.lcaIdx : lastDepth;
    for (const g of aboveGroups) {
      const half = halfOf(g);
      const gap = baseGap + (g.lcaIdx < prevTopLca ? framePadOf(g) : 0);
      const c = Math.min(slot.get(g)!, prevTop - gap - half);
      center.set(g, c); prevTop = c - half; prevTopLca = g.lcaIdx;
    }

    // позиции членов: симметрично вокруг центра группы
    for (const g of groups) {
      const c = center.get(g)!;
      const mid = (g.members.length - 1) / 2;
      g.members.forEach((id, i) => positions.set(id, { x, y: c + (i - mid) * ROW - NODE_H / 2 }));
    }
  };
  layoutSide(left, -1);
  layoutSide(right, 1);
  positions.set(focusId, { x: 0, y: -focusHeight / 2 });

  // 3. Хэндлы и маршруты. У ребра bidi-соседа есть «родная» стрелка (в естественном
  //    направлении колонки) и «не родная» (обратная). Родные и все обычные одно-направленные
  //    идут через единый центральный хэндл стороны фокуса (left/right, slot 1) к ближней
  //    стороне соседа. Не родная цепляется за ДАЛЬНЮЮ сторону соседа, огибает колонку сверху
  //    или снизу и входит в верхний/нижний центральный хэндл фокуса.
  const ids = new Set([focusId, ...entities.map((e) => e.id)]);
  // родная стрелка: право-колоночная — исходящая (центр→сосед), лево-колоночная — входящая
  const isNativeEdge = (e: AppEdge): boolean => {
    const outgoing = e.source_id === focusId;
    const neighborId = outgoing ? e.target_id : e.source_id;
    return onRightSet.has(neighborId) ? outgoing : !outgoing;
  };

  // Полки подписей: ближняя лента (near, у стороны соседа к фокусу — родные/обычные стрелки)
  // и дальняя лента (far, с противоположной стороны соседа — не родные стрелки). Длина ленты
  // = макс. оценочная ширина подписи в ней (минимум MIN_SHELF) → полки выстраиваются ровно.
  const nearW = { left: [MIN_SHELF], right: [MIN_SHELF] };
  const farW = { left: [MIN_SHELF], right: [MIN_SHELF] };
  for (const e of edges) {
    if (!ids.has(e.source_id) || !ids.has(e.target_id)) continue;
    const neighborId = e.source_id === focusId ? e.target_id : e.source_id;
    const side = onRightSet.has(neighborId) ? "right" : "left";
    const text = [e.label, e.technology].filter(Boolean).join(" · ") || "связь";
    (isNativeEdge(e) ? nearW : farW)[side].push(ctxLabelWidth(text));
  }
  const nearLen = { left: Math.max(...nearW.left) + SHELF_PAD, right: Math.max(...nearW.right) + SHELF_PAD };
  const farLen = { left: Math.max(...farW.left) + SHELF_PAD, right: Math.max(...farW.right) + SHELF_PAD };

  // bbox колонки (по её узлам) — чтобы обход не родной стрелки гарантированно охватил все узлы
  const colBox = (colIds: string[]) => {
    let top = Infinity, bot = -Infinity, l = Infinity, r = -Infinity;
    for (const id of colIds) {
      const p = positions.get(id); if (!p) continue;
      top = Math.min(top, p.y); bot = Math.max(bot, p.y + NODE_H);
      l = Math.min(l, p.x); r = Math.max(r, p.x + NODE_W);
    }
    return { top, bot, l, r };
  };
  const focusTop = -focusHeight / 2, focusBot = focusHeight / 2;
  const LOOP_MARGIN = 40; // зазор обхода над/под колонкой
  const RING_STEP = 26;   // разнос вложенных обходов, если на стороне несколько bidi

  // Параметры обхода (loopX — дальняя вертикаль, clearY — уровень обхода над/под) на каждого
  // bidi-соседа. Несколько bidi на стороне нанизываем вложенными кольцами, чтобы не пересекались.
  const loopParam = new Map<string, { loopX: number; clearY: number }>();
  const assignLoops = (side: "left" | "right") => {
    const members = (side === "right" ? right : left).filter(isBidi);
    if (members.length === 0) return;
    const box = colBox(side === "right" ? right : left);
    const cy = (id: string) => positions.get(id)!.y + NODE_H / 2;
    const farBaseX = side === "right" ? box.r + farLen.right : box.l - farLen.left;
    const dirX = side === "right" ? 1 : -1;
    const topBase = Math.min(box.top, focusTop) - LOOP_MARGIN; // обход сверху
    const botBase = Math.max(box.bot, focusBot) + LOOP_MARGIN;  // обход снизу
    // верх: сосед выше центра фокуса; ближе к верху → внутреннее (меньшее) кольцо
    const over = members.filter((id) => cy(id) < 0).sort((a, b) => cy(a) - cy(b));
    const under = members.filter((id) => cy(id) >= 0).sort((a, b) => cy(b) - cy(a));
    over.forEach((id, k) => loopParam.set(id, { loopX: farBaseX + dirX * k * RING_STEP, clearY: topBase - k * RING_STEP }));
    under.forEach((id, k) => loopParam.set(id, { loopX: farBaseX + dirX * k * RING_STEP, clearY: botBase + k * RING_STEP }));
  };
  assignLoops("right"); assignLoops("left");

  const edgeHandles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  const edgeShelves = new Map<string, EdgeShelf>();
  const edgeLoops = new Map<string, EdgeLoop>();
  for (const e of edges) {
    if (!ids.has(e.source_id) || !ids.has(e.target_id)) continue;
    const outgoing = e.source_id === focusId;
    const neighborId = outgoing ? e.target_id : e.source_id;
    const onRight = onRightSet.has(neighborId);
    const focusSide = onRight ? "right" : "left";

    if (isNativeEdge(e) || !isBidi(neighborId)) {
      // родная / обычная стрелка: центр стороны фокуса ↔ ближняя сторона соседа, полка у соседа
      const neighborSide = onRight ? "left" : "right";
      const focusHandle = hid(focusId, focusSide, 1);
      const neighborHandle = hid(neighborId, neighborSide, 1);
      edgeHandles.set(e.id, outgoing
        ? { sourceHandle: focusHandle, targetHandle: neighborHandle }
        : { sourceHandle: neighborHandle, targetHandle: focusHandle });
      edgeShelves.set(e.id, {
        end: outgoing ? "target" : "source",
        len: onRight ? nearLen.right : nearLen.left,
      });
    } else {
      // НЕ родная стрелка bidi: дальняя сторона соседа → обход сверху/снизу → верх/низ-центр фокуса
      const p = loopParam.get(neighborId)!;
      const over = p.clearY < 0;
      const farSide = onRight ? "right" : "left";          // дальняя от фокуса сторона соседа
      const neighborHandle = hid(neighborId, farSide, 1);
      const focusHandle = hid(focusId, over ? "top" : "bottom", 1);
      edgeHandles.set(e.id, outgoing
        ? { sourceHandle: focusHandle, targetHandle: neighborHandle }
        : { sourceHandle: neighborHandle, targetHandle: focusHandle });
      edgeLoops.set(e.id, { neighborEnd: outgoing ? "target" : "source", loopX: p.loopX, clearY: p.clearY });
    }
  }

  return { positions, edgeHandles, edgeShelves, edgeLoops };
}
