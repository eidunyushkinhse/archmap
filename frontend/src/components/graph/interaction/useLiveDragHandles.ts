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
import { metaLabelBox } from "../layout/labelBox";
import { edgeLabelMeta } from "../layout/pipeline";
import { NODE_W, NODE_H } from "../constants";
import { absPositionOf } from "../absPos";

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
// ВСЕ позиции сессии — АБСОЛЮТ вида: дети compound-рамок несут rel-позицию к рамке,
// а роутер/препятствия/prev-контекст живут в абсолюте — без конверсии ребро ребёнка
// рисовалось смещённым к началу координат (на -origin рамки) и резало чужие тела.
interface Session {
  base: Map<string, { x: number; y: number }>;
  // снимок узлов старта — для конверсии rel→abs перетаскиваемых: рамки на время
  // жеста статичны (frameFollow двигает только оверлей), цепочка родителей верна
  byId: Map<string, RFNode>;
  inp: LiveHandleInputs;
  routes: Map<string, EdgePoint[]>;      // edge.id → авто-маршрут на старте жеста
  labels: Map<string, LabelPlacement>;   // edge.id → размещение плашки на старте жеста
  // объекты рёбер на старте жеста — для отката живого превью, когда жест не привёл
  // к записи раскладки и пересчёта не будет (restore)
  origEdges: Map<string, RFEdge>;
  // перетаскиваемый набор из последнего кадра move (постоянен весь жест)
  draggedIds?: Set<string>;
  // прямоугольники плашек НЕзатронутых рёбер (препятствия живого размещения) — кэш на
  // жест, считается на первом кадре (набор затронутых постоянен весь жест)
  fixedLabelRects?: NodeRect[];
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

// Абсолютные позиции узлов кадра драга: база старта + живые позиции перетаскиваемых.
// Дети compound-рамок несут rel-позицию — конвертируем цепочкой родителей ИЗ СНИМКА
// старта (рамки на время жеста статичны). Чистая — регрессия rel/abs прибита тестом.
export function gestureAbsPositions(
  base: Map<string, { x: number; y: number }>,
  dragged: RFNode[],
  byId: Map<string, RFNode>,
): Map<string, { x: number; y: number }> {
  const positions = new Map(base);
  for (const n of dragged) positions.set(n.id, absPositionOf(n, byId));
  return positions;
}

// Возврат рёбер жеста к объектам старта: применяется, когда жест не привёл к записи
// раскладки — пересчёта не будет, и без отката живое превью последнего кадра осталось
// бы в rfEdges насовсем (фантомные маршруты/плашки в покое). Незатронутые рёбра — те же
// ссылки (RF их не перерисует). Чистая — тестируется.
export function restoreDragEdges(
  prev: RFEdge[],
  draggedIds: ReadonlySet<string>,
  origEdges: ReadonlyMap<string, RFEdge>,
): RFEdge[] {
  return prev.map((e) =>
    draggedIds.has(e.source) || draggedIds.has(e.target) ? origEdges.get(e.id) ?? e : e,
  );
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

// Плашка затронутого ребра на живой позиции. Живое размещение считается тем же движком и с
// ПОЛНЫМ контекстом (все группы, финальные маршруты прочих) — совпадает с финалом (замер:
// 0px в покое, ~10px в движении из-за нуджинга финала), поэтому берём его как есть, включая
// leader. (Раннее правило «leader не брать — прыгает» относилось к УСЕЧЁННОМУ контексту из
// одних затронутых рёбер: там дискретный поиск места скакал кадр-к-кадру.) Фолбэк, когда
// размещение не посчиталось: СНИМОК плашки + среднее смещение концов ребра — гладко и близко.
function liveLabelFor(e: RFEdge, f: DragFrame): LabelPlacement | undefined {
  const live = f.liveLabels?.get(e.id);
  if (live) return live;
  const snap = f.snapLabels.get(e.id);
  if (!snap) return undefined;
  const ds = f.deltaOf(e.source), dt = f.deltaOf(e.target);
  return shiftPlacement(snap, (ds.dx + dt.dx) / 2, (ds.dy + dt.dy) / 2);
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
    const lp = liveLabelFor(e, f);
    if (lp) data.labelPlacement = lp;
    const lh = f.liveHandles?.get(e.id);
    return lh
      ? { ...e, data, sourceHandle: lh.sourceHandle, targetHandle: lh.targetHandle }
      : { ...e, data };
  }
  // Фолбэк 1 (throttle пропустил кадр): жёсткий сдвиг из snapRoutes + среднее смещение
  // концов (как для "оба конца тащим", но только для затронутого конца). Это даёт плавное
  // движение даже когда роутинг не гонялся (оптимизация 2026-07-21).
  // ВАЖНО: хэндлы обновляем из fallbackHandles (assignEdgeHandles гоняется каждый кадр,
  // независимо от throttle) — иначе хэндлы залипают на старых значениях и разные стрелки
  // могут оказаться на одном хэндле (функциональная регрессия).
  const orig = f.snapRoutes.get(e.id);
  if (orig) {
    const ds = f.deltaOf(e.source), dt = f.deltaOf(e.target);
    const dx = (ds.dx + dt.dx) / 2, dy = (ds.dy + dt.dy) / 2;
    const moved = orig.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const data: WrappedEdgeData = { ...(e.data as WrappedEdgeData), autoRoute: moved };
    const lp0 = f.snapLabels.get(e.id);
    if (lp0) data.labelPlacement = shiftPlacement(lp0, dx, dy);
    const h = f.fallbackHandles.get(e.id);
    return h
      ? { ...e, data, sourceHandle: h.sourceHandle, targetHandle: h.targetHandle }
      : { ...e, data };
  }
  // Фолбэк 2 (живого маршрута нет: контекст-схема или ребро не посчиталось). assignEdgeHandles
  // надёжен только для локально-локальных block-рёбер — гостевые/контекстные оставляем как
  // есть (их сторону старый движок мог бы поставить неверно).
  if (!f.localIds.has(e.source) || !f.localIds.has(e.target)) return e;
  const h = f.fallbackHandles.get(e.id);
  if (!h || (h.sourceHandle === e.sourceHandle && h.targetHandle === e.targetHandle)) return e;
  return { ...e, sourceHandle: h.sourceHandle, targetHandle: h.targetHandle };
}

export function useLiveDragHandles({ inputsRef, setRfEdges }: Params) {
  const session = useRef<Session | null>(null);
  // Адаптивный throttle роутинга по числу затронутых рёбер (оптимизация 2026-07-21):
  // узлы с большим числом связей (16+) роутятся реже, чтобы не ронять FPS.
  // Между прогонами — предыдущие маршруты (слегка устаревшие, но визуально разница
  // минимальна, когда много рёбер двигается одновременно).
  const frameCounter = useRef(0);

  // Старт жеста: фиксируем позиции всех узлов (для неперетаскиваемых они неизменны весь
  // жест), снимок входов раскладки и снимок авто-маршрутов рёбер. Нет снимка раскладки —
  // хук просто бездействует.
  const begin = useCallback((allNodes: RFNode[], allEdges: RFEdge[]) => {
    const inp = inputsRef.current;
    if (!inp) { session.current = null; return; }
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    // база — в АБСОЛЮТЕ вида (rel детей compound-рамок конвертируется цепочкой родителей)
    const base = new Map(allNodes.map((n) => [n.id, absPositionOf(n, byId)]));
    const routes = new Map<string, EdgePoint[]>();
    const labels = new Map<string, LabelPlacement>();
    for (const e of allEdges) {
      const d = e.data as WrappedEdgeData | undefined;
      if (d?.autoRoute) routes.set(e.id, d.autoRoute);
      if (d?.labelPlacement) labels.set(e.id, d.labelPlacement); // снимок плашки — база жёсткого сдвига
    }
    session.current = { base, byId, inp, routes, labels, origEdges: new Map(allEdges.map((e) => [e.id, e])) };
    frameCounter.current = 0; // сброс счётчика на старте жеста
  }, [inputsRef]);

  // Кадр драга. Считаем живые входы, затем решение по каждому ребру — в чистой resolveDragEdge:
  //  • ОБА конца перетаскиваются (мультидраг связанных узлов) → жёстко СДВИГАЕМ весь маршрут
  //    И плашку от СНИМКА старта на общую дельту (без «прилипшей середины» и без дрейфа);
  //  • ОДИН конец → гоняем НАСТОЯЩИЙ роутер (buildAutoRoutes) для затронутых рёбер по живым
  //    позициям — тем же движком, что и финал: превью совпадает с будущим маршрутом (A* по
  //    затронутым, прочие — фиксированный контекст prev). Годится и для гостевых/сквозных;
  //  • нет живого маршрута (контекст / не посчиталось) → фолбэк: сторона хэндла для block-рёбер.
  //
  // Адаптивный throttle (оптимизация 2026-07-21): узлы с большим числом связей роутятся
  // реже (каждые 2-3 кадра), чтобы не ронять FPS. Между прогонами — предыдущие маршруты.
  const move = useCallback((dragged: RFNode[]) => {
    const s = session.current;
    if (!s) return;
    // живые позиции перетаскиваемых — тоже в абсолют (у детей рамок RF отдаёт rel)
    const positions = gestureAbsPositions(s.base, dragged, s.byId);
    const draggedIds = new Set(dragged.map((n) => n.id));
    s.draggedIds = draggedIds;
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
        // Адаптивный throttle: чем больше затронутых рёбер, тем реже роутим.
        // 1-5 рёбер: каждый кадр; 6-15: каждые 2 кадра; 16+: каждые 3 кадра.
        frameCounter.current++;
        const throttleInterval = affected.size <= 5 ? 1 : affected.size <= 15 ? 2 : 3;
        const shouldRoute = frameCounter.current % throttleInterval === 0;

        if (shouldRoute) {
          const sizeMap = r.sizes ? new Map(Object.entries(r.sizes)) : undefined;
          const ar = buildAutoRoutes({
            groups: r.groups, routableIds: affected, positions,
            displayIds: r.displayIds, sizes: sizeMap, frames: r.frames,
            prev: { routes: r.routes, handles: r.handles }, // прочие маршруты — фиксированный контекст
            weld: false, // сварка стволов живьём не гоняется (E62) — доворот прячет drawIn
          });
          liveRoutes = ar.routes;
          liveHandles = ar.handles;
          // Размещение плашек — тем же движком, что финал, и с тем же ВЗАИМНЫМ ДАВЛЕНИЕМ,
          // но размещаем ТОЛЬКО затронутые: плашки прочих рёбер за жест не двигаются, их
          // прямоугольники (снимок старта, кэш на жест) подкладываются как препятствия.
          // Полный пере-прогон всех ~25 плашек каждый кадр ронял FPS (leader-кандидаты ×
          // connectorCrossings по всем плечам), а по гриди-порядку размещения даёт ровно
          // тот же результат: финальное место затронутой плашки не пересекается с чужими,
          // и все кандидаты ближе него остаются заняты теми же чужими плашками.
          const rectOf = (id: string): NodeRect | null => {
            const p = positions.get(id);
            if (!p) return null;
            const sz = sizeMap?.get(id);
            return { x: p.x, y: p.y, w: sz?.w ?? NODE_W, h: sz?.h ?? NODE_H };
          };
          const nodeRects = r.displayIds.map(rectOf).filter((x): x is NodeRect => x != null);
          if (!s.fixedLabelRects) {
            // прямоугольники НЕзатронутых плашек по снимку старта (жёсткие препятствия)
            const fixed: NodeRect[] = [];
            for (const g of r.groups) {
              if (affected.has(g.id)) continue;
              const lp = s.labels.get(g.id);
              const meta = edgeLabelMeta(g);
              if (!lp || !meta) continue;
              const box = metaLabelBox(meta);
              fixed.push({ x: lp.center.x - box.w / 2, y: lp.center.y - box.h / 2, w: box.w, h: box.h });
            }
            s.fixedLabelRects = fixed;
          }
          const routesForLabels = new Map(r.routes);
          for (const [id, rt] of liveRoutes) routesForLabels.set(id, rt);
          liveLabels = buildLabelPlacements({
            routes: routesForLabels, groups: affectedGroups, labelMeta: edgeLabelMeta,
            preferredT: () => undefined, nodeRects,
            obstacleRects: s.fixedLabelRects, // чужие плашки — жёсткие препятствия скоринга
          });
        }
        // Если throttle пропустил кадр — liveRoutes/liveHandles/liveLabels остаются null,
        // и resolveDragEdge использует предыдущие маршруты из snapRoutes (жёсткий сдвиг).
      }
    }

    const frame: DragFrame = {
      draggedIds, deltaOf,
      snapRoutes: s.routes, snapLabels: s.labels,
      liveRoutes, liveHandles, liveLabels,
      localIds: s.inp.localIds, fallbackHandles: handles,
    };
    // Точечный патч (оптимизация 2026-07-21): собираем только изменённые рёбра в Map,
    // затем патчим. Если ни одно ребро не изменилось — возвращаем ту же ссылку на массив
    // (React не перерисует). Раньше: prev.map(...) на каждый кадр — аллокация нового
    // массива из N элементов, даже если большинство рёбер не изменились.
    setRfEdges((prev) => {
      const changed = new Map<string, RFEdge>();
      for (const e of prev) {
        const resolved = resolveDragEdge(e, frame);
        if (resolved !== e) changed.set(e.id, resolved);
      }
      if (changed.size === 0) return prev; // ни одно ребро не изменилось
      return prev.map((e) => changed.get(e.id) ?? e);
    });
  }, [setRfEdges]);

  // Откат живого превью к состоянию старта жеста. Зовётся ПЕРЕД end(), когда отпускание
  // не записало раскладку (нетто-сдвига нет: кламп вернул узел, микродвижение) — смены
  // viewLayout не будет, пересчёт не запустится, и последний кадр превью иначе остался бы
  // на экране насовсем (см. tasks.md «БАГИ ДРАГА ДЕТЕЙ РАСКРЫТЫХ РАМОК», пункт 2).
  const restore = useCallback(() => {
    const s = session.current;
    if (!s?.draggedIds || s.draggedIds.size === 0) return; // move не бегал — превью не трогало рёбра
    const { draggedIds, origEdges } = s;
    setRfEdges((prev) => restoreDragEdges(prev, draggedIds, origEdges));
  }, [setRfEdges]);

  const end = useCallback(() => { session.current = null; }, []);

  return { begin, move, end, restore };
}
