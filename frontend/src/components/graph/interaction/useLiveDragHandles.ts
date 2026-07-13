// Живой пересчёт хэндлов стрелок во время драга узлов. После отпускания раскладка
// заново назначает авто-хэндлы по новым позициям (assignEdgeHandles в layoutLevel) —
// сторона входа/выхода стрелки может смениться, путь оптимизируется. Но во время самого
// драга стрелка висела на ПРЕЖНИХ хэндлах, и был разрыв WYSIWYG: видно одно, по
// отпускании — другое. Этот хук закрывает разрыв: каждый кадр драга прогоняет ТОТ ЖЕ движок
// раскладки (buildAutoRoutes + размещение плашек) по живым позициям и применяет результат к
// rfEdges. Движок тот же, что и пост-драговая раскладка, — значит превью совпадает с итогом.
//
// Скоуп живого ре-роута (buildAutoRoutes) — ЛЮБЫЕ level-рёбра с одним перетаскиваемым
// концом, включая гостевые/сквозные (конец в раскрытом контейнере): ручного слоя «колец
// гостей» больше нет, assembleRf кладёт всем рёбрам хэндл/маршрут/плашку из ОДНОГО источника
// (buildAutoRoutes), поэтому превью гостя совпадает с финалом так же, как у локального ребра.
// Старый assignEdgeHandles остаётся лишь ФОЛБЭКОМ (контекст-схема / ребро не посчиталось
// роутером) и надёжен только для локально-локальных block-рёбер — там его и применяем.
import { useCallback, useRef } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { Dispatch, SetStateAction } from "react";
import type { EdgePoint, LayoutEdge } from "../../../types";
import type { EdgeGroup, WrappedEdgeData } from "../types";
import { assignEdgeHandles } from "../layout/level";
import { buildAutoRoutes } from "../layout/autoRoutes";
import { buildLabelPlacements, type LabelPlacement } from "../layout/labelLayout";
import { applyLabelDetours } from "../layout/detourStage";
import { edgeLabelMeta } from "../layout/pipeline";
import { NODE_W, NODE_H } from "../constants";

type NodeRect = { x: number; y: number; w: number; h: number };

// Rect + плашка + члены раскрытой рамки для роутера (тот же формат, что buildAutoRoutes.frames).
type RouterFrame = {
  rect: { x: number; y: number; w: number; h: number };
  plaque: { x: number; y: number; w: number; h: number };
  memberIds: ReadonlySet<string>;
};

// Входы НАСТОЯЩЕГО роутера для живого ре-роута во время драга (issue 1): те же, по которым
// финал считает маршруты. Снимаются на конец async-раскладки. Позиции подставляются живые.
export interface LiveRouteInputs {
  groups: EdgeGroup[];
  displayIds: string[];
  sizes?: Record<string, { w: number; h: number }>;
  frames: RouterFrame[];
  routes: Map<string, EdgePoint[]>;                                     // финальные маршруты (контекст prev)
  handles: Map<string, { sourceHandle: string; targetHandle: string }>; // финальные хэндлы (контекст prev)
}

// Снимок входов раскладки, нужных для пересчёта хэндлов. LevelGraph кладёт его в ref
// в конце async-раскладки — те же layoutEdges/узлы, по которым считался текущий layout.
export interface LiveHandleInputs {
  // мастер-рёбра уровня (по одному на направление пары) — ключи совпадают с rfEdge.id
  layoutEdges: LayoutEdge[];
  // все отображаемые узлы (локальные + гости/контейнеры) — вход assignEdgeHandles
  nodeIds: Array<{ id: string }>;
  // id локальных узлов уровня (block): пересчитываем только рёбра, оба конца которых тут
  localIds: Set<string>;
  // входы роутера для живого ре-роута затронутых стрелок (issue 1). undefined — контекст-схема.
  route?: LiveRouteInputs;
}

interface Params {
  inputsRef: React.RefObject<LiveHandleInputs | null>;
  setRfEdges: Dispatch<SetStateAction<RFEdge[]>>;
}

// Сессия одного жеста: базовые позиции всех узлов на старте (двигаются только
// перетаскиваемые), снимок входов раскладки и снимок авто-маршрутов рёбер на старте
// (для жёсткого сдвига рёбер, у которых ОБА конца перетаскиваются).
interface Session {
  base: Map<string, { x: number; y: number }>;
  inp: LiveHandleInputs;
  routes: Map<string, EdgePoint[]>;      // edge.id → авто-маршрут на старте жеста
  labels: Map<string, LabelPlacement>;   // edge.id → размещение плашки на старте жеста
}

type EdgeHandlePair = { sourceHandle: string; targetHandle: string };

// Контекст одного кадра драга для решения по каждому ребру. Вынесен в чистую функцию
// resolveDragEdge (ниже) — тестируется без React/RF и защищает от регрессий (напр. дрейф
// плашки при мультидраге). Все геометрические базы — из СНИМКА старта жеста (snapRoutes/
// snapLabels), а не из прошлого кадра: иначе накопление дельты уводит плашку за экран.
interface DragFrame {
  draggedIds: Set<string>;
  deltaOf: (id: string) => { dx: number; dy: number };
  snapRoutes: Map<string, EdgePoint[]>;
  snapLabels: Map<string, LabelPlacement>;
  liveRoutes: Map<string, EdgePoint[]> | null;
  liveHandles: Map<string, EdgeHandlePair> | null;
  liveLabels: Map<string, LabelPlacement> | null;
  localIds: Set<string>;
  fallbackHandles: Map<string, EdgeHandlePair>;
}

// Сдвиг размещения плашки на (dx,dy) — центр, якорь и конец поводка едут вместе с ребром.
function shiftPlacement(lp: LabelPlacement, dx: number, dy: number): LabelPlacement {
  return {
    mode: lp.mode,
    center: { x: lp.center.x + dx, y: lp.center.y + dy },
    anchor: { x: lp.anchor.x + dx, y: lp.anchor.y + dy },
    leaderEnd: { x: lp.leaderEnd.x + dx, y: lp.leaderEnd.y + dy },
  };
}

// Решение по одному ребру за кадр драга (чистая функция). Возвращает НОВЫЙ объект ребра
// либо тот же e (RF не перерисует не изменённое — сравнение по ссылке).
export function resolveDragEdge(e: RFEdge, f: DragFrame): RFEdge {
  const srcDragged = f.draggedIds.has(e.source), tgtDragged = f.draggedIds.has(e.target);
  if (!srcDragged && !tgtDragged) return e; // ни один конец не тащим — не трогаем
  if (srcDragged && tgtDragged) {
    // ЖЁСТКИЙ сдвиг (оба конца в выделении — мультидраг связанных узлов): маршрут И плашку
    // берём из СНИМКА старта и двигаем на общую дельту. Ключевое: база — снимок, а НЕ прошлый
    // кадр, иначе плашка накапливала бы дельту каждый кадр и «улетала» за экран. Хэндлы не
    // трогаем — концы едут синхронно, сторона не меняется. Годится для любых рёбер (чистая
    // геометрия, гость/локал без разницы).
    const orig = f.snapRoutes.get(e.id);
    if (!orig) return e; // нет снимка маршрута (smoothstep-фолбэк) — оставляем как есть
    const { dx, dy } = f.deltaOf(e.source);
    const moved = orig.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const data: WrappedEdgeData = { ...(e.data as WrappedEdgeData), autoRoute: moved };
    const lp0 = f.snapLabels.get(e.id);
    if (lp0) data.labelPlacement = shiftPlacement(lp0, dx, dy);
    return { ...e, data };
  }
  // РОВНО ОДИН конец тащим. Живой маршрут настоящего роутера (buildAutoRoutes) — превью =
  // будущее. Применяем к ЛЮБОМУ ребру, где он посчитан: гость/сквозняк роутится тем же
  // движком, что и финал (колец гостей нет), значит и его плашка едет с линией и не «слетает».
  const lr = f.liveRoutes?.get(e.id);
  if (lr) {
    const data: WrappedEdgeData = { ...(e.data as WrappedEdgeData), autoRoute: lr };
    const lp = f.liveLabels?.get(e.id);
    if (lp) data.labelPlacement = lp;
    const lh = f.liveHandles?.get(e.id);
    return lh
      ? { ...e, data, sourceHandle: lh.sourceHandle, targetHandle: lh.targetHandle }
      : { ...e, data };
  }
  // Фолбэк (живого маршрута нет: контекст-схема или ребро не посчиталось). assignEdgeHandles
  // надёжен только для локально-локальных block-рёбер — гостевые/контекстные оставляем как
  // есть (их сторону старый движок мог бы поставить неверно).
  if (!f.localIds.has(e.source) || !f.localIds.has(e.target)) return e;
  const h = f.fallbackHandles.get(e.id);
  if (!h || (h.sourceHandle === e.sourceHandle && h.targetHandle === e.targetHandle)) return e;
  return { ...e, sourceHandle: h.sourceHandle, targetHandle: h.targetHandle };
}

export function useLiveDragHandles({ inputsRef, setRfEdges }: Params) {
  const session = useRef<Session | null>(null);

  // Старт жеста: фиксируем позиции всех узлов (для неперетаскиваемых они неизменны весь
  // жест), снимок входов раскладки и снимок авто-маршрутов рёбер. Нет снимка раскладки —
  // хук просто бездействует.
  const begin = useCallback((allNodes: RFNode[], allEdges: RFEdge[]) => {
    const inp = inputsRef.current;
    if (!inp) { session.current = null; return; }
    const base = new Map(allNodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    const routes = new Map<string, EdgePoint[]>();
    const labels = new Map<string, LabelPlacement>();
    for (const e of allEdges) {
      const d = e.data as WrappedEdgeData | undefined;
      if (d?.autoRoute) routes.set(e.id, d.autoRoute);
      if (d?.labelPlacement) labels.set(e.id, d.labelPlacement); // снимок плашки — база жёсткого сдвига
    }
    session.current = { base, inp, routes, labels };
  }, [inputsRef]);

  // Кадр драга. Считаем живые входы, затем решение по каждому ребру — в чистой resolveDragEdge:
  //  • ОБА конца перетаскиваются (мультидраг связанных узлов) → жёстко СДВИГАЕМ весь маршрут
  //    И плашку от СНИМКА старта на общую дельту (без «прилипшей середины» и без дрейфа);
  //  • ОДИН конец → гоняем НАСТОЯЩИЙ роутер (buildAutoRoutes) для затронутых рёбер по живым
  //    позициям — тем же движком, что и финал: превью совпадает с будущим маршрутом (A* по
  //    затронутым, прочие — фиксированный контекст prev). Годится и для гостевых/сквозных;
  //  • нет живого маршрута (контекст / не посчиталось) → фолбэк: сторона хэндла для block-рёбер.
  const move = useCallback((dragged: RFNode[]) => {
    const s = session.current;
    if (!s) return;
    const positions = new Map(s.base);
    for (const n of dragged) positions.set(n.id, { x: n.position.x, y: n.position.y });
    const draggedIds = new Set(dragged.map((n) => n.id));
    const deltaOf = (id: string): { dx: number; dy: number } => {
      const b = s.base.get(id), p = positions.get(id);
      return b && p ? { dx: p.x - b.x, dy: p.y - b.y } : { dx: 0, dy: 0 };
    };
    const handles = assignEdgeHandles(s.inp.nodeIds, s.inp.layoutEdges, positions);

    // Живой ре-роут стрелок с ОДНИМ перетаскиваемым концом настоящим роутером.
    let liveRoutes: Map<string, EdgePoint[]> | null = null;
    let liveHandles: Map<string, { sourceHandle: string; targetHandle: string }> | null = null;
    let liveLabels: Map<string, LabelPlacement> | null = null;
    const r = s.inp.route;
    if (r) {
      const affected = new Set<string>();
      const affectedGroups: EdgeGroup[] = [];
      for (const g of r.groups) {
        if (!r.routes.has(g.id)) continue;
        const src = draggedIds.has(g.source), tgt = draggedIds.has(g.target);
        if (src !== tgt) { affected.add(g.id); affectedGroups.push(g); } // ровно один конец
      }
      if (affected.size > 0) {
        const sizeMap = r.sizes ? new Map(Object.entries(r.sizes)) : undefined;
        const ar = buildAutoRoutes({
          groups: r.groups, routableIds: affected, positions,
          displayIds: r.displayIds, sizes: sizeMap, frames: r.frames,
          prev: { routes: r.routes, handles: r.handles }, // прочие маршруты — фиксированный контекст
        });
        liveRoutes = ar.routes;
        liveHandles = ar.handles;
        // Учёт текстовой плашки: если подпись не влезает инлайн (leader) — уводим ребро в
        // ДЕТУР (меняет маршрут И хэндлы), ровно как финал (applyLabelDetours). Без этого
        // превью оставалось бы прямым, а финал изгибался бы под плашку. Placement/детур —
        // тоже по затронутым (перф-безопасно), нутро уже посчитано.
        const rectOf = (id: string): NodeRect | null => {
          const p = positions.get(id);
          if (!p) return null;
          const sz = sizeMap?.get(id);
          return { x: p.x, y: p.y, w: sz?.w ?? NODE_W, h: sz?.h ?? NODE_H };
        };
        const nodeRects = r.displayIds.map(rectOf).filter((x): x is NodeRect => x != null);
        let placements = buildLabelPlacements({
          routes: liveRoutes, groups: affectedGroups, labelMeta: edgeLabelMeta,
          preferredT: () => undefined, nodeRects,
        });
        const detourPreferred = applyLabelDetours({
          groupArr: affectedGroups, labelPlacements: placements, routableIds: affected,
          positions, displayIds: r.displayIds, rectOf, labelMeta: edgeLabelMeta,
          autoRoutes: liveRoutes, edgeHandles: liveHandles, // мутируются для детурнутых рёбер
        });
        // ФИНАЛЬНЫЙ пере-проход размещения на детурнутых маршрутах (шаг V2.5 pipeline):
        // после детура геометрия изменилась — плашку кладём на ИТОГОВУЮ линию, иначе центр
        // остался бы на до-детурном маршруте и текст «уезжал» бы от стрелки.
        if (detourPreferred.size > 0) {
          placements = buildLabelPlacements({
            routes: liveRoutes, groups: affectedGroups, labelMeta: edgeLabelMeta,
            preferredT: (g) => detourPreferred.get(g.id), nodeRects,
          });
        }
        liveLabels = placements; // позиции плашек затронутых рёбер → едут с ребром живьём
      }
    }

    const frame: DragFrame = {
      draggedIds, deltaOf,
      snapRoutes: s.routes, snapLabels: s.labels,
      liveRoutes, liveHandles, liveLabels,
      localIds: s.inp.localIds, fallbackHandles: handles,
    };
    setRfEdges((prev) => prev.map((e) => resolveDragEdge(e, frame)));
  }, [setRfEdges]);

  const end = useCallback(() => { session.current = null; }, []);

  return { begin, move, end };
}
