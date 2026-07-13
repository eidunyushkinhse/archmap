// Живой пересчёт хэндлов стрелок во время драга узлов. После отпускания раскладка
// заново назначает авто-хэндлы по новым позициям (assignEdgeHandles в layoutLevel) —
// сторона входа/выхода стрелки может смениться, путь оптимизируется. Но во время самого
// драга стрелка висела на ПРЕЖНИХ хэндлах, и был разрыв WYSIWYG: видно одно, по
// отпускании — другое. Этот хук закрывает разрыв: каждый кадр драга прогоняет ТУ ЖЕ
// assignEdgeHandles по живым позициям и применяет результат к rfEdges. Используем тот же
// движок, что и пост-драговая раскладка, — значит превью совпадает с итогом по построению.
//
// Скоуп — рёбра, у которых ОБА конца локальны (block): для них итоговый хэндл = ровно
// выход assignEdgeHandles (кольца гостей его не перетирают). Гостевые/сквозные стрелки
// во время драга не трогаем — они доедут по отпускании (редкий случай, для них
// WYSIWYG-разрыв незаметен). Сохранённые вручную хэндлы assignEdgeHandles и так
// оставляет на месте — драг их не двигает.
import { useCallback, useRef } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { Dispatch, SetStateAction } from "react";
import type { EdgePoint, LayoutEdge } from "../../../types";
import type { EdgeGroup, WrappedEdgeData } from "../types";
import { assignEdgeHandles } from "../layout/level";
import { buildAutoRoutes } from "../layout/autoRoutes";
import { buildLabelPlacements } from "../layout/labelLayout";
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
  routes: Map<string, EdgePoint[]>; // edge.id → авто-маршрут на старте жеста
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
    for (const e of allEdges) {
      const ar = (e.data as WrappedEdgeData | undefined)?.autoRoute;
      if (ar) routes.set(e.id, ar);
    }
    session.current = { base, inp, routes };
  }, [inputsRef]);

  // Кадр драга. Для каждого затронутого локально-локального ребра:
  //  • ОБА конца перетаскиваются (мультидраг связанных узлов) → жёстко СДВИГАЕМ весь
  //    маршрут (снимок стартовой ломаной + общая дельта группы) и держим хэндлы старта:
  //    ребро едет с узлами как есть, без «прилипшей середины» и без смены сторон;
  //  • ОДИН конец → гоняем НАСТОЯЩИЙ роутер (buildAutoRoutes) для этих рёбер по живым
  //    позициям — тем же движком, что и финал: превью нутра совпадает с будущим маршрутом
  //    (A* ограничен затронутыми рёбрами, остальные — фиксированный контекст prev, дёшево).
  //    Нет входов роутера/маршрут не посчитался → фолбэк: только сторона хэндла (как раньше).
  // Неизменные рёбра возвращаем тем же объектом — RF их не перерисует (сравнение по ссылке).
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
        const placements = buildLabelPlacements({
          routes: liveRoutes, groups: affectedGroups, labelMeta: edgeLabelMeta,
          preferredT: () => undefined, nodeRects,
        });
        applyLabelDetours({
          groupArr: affectedGroups, labelPlacements: placements, routableIds: affected,
          positions, displayIds: r.displayIds, rectOf, labelMeta: edgeLabelMeta,
          autoRoutes: liveRoutes, edgeHandles: liveHandles, // мутируются для детурнутых рёбер
        });
      }
    }

    setRfEdges((prev) =>
      prev.map((e) => {
        // только локально-локальные рёбра и хотя бы одним концом в перетаскиваемых
        if (!s.inp.localIds.has(e.source) || !s.inp.localIds.has(e.target)) return e;
        const srcDragged = draggedIds.has(e.source), tgtDragged = draggedIds.has(e.target);
        if (!srcDragged && !tgtDragged) return e;
        if (srcDragged && tgtDragged) {
          // жёсткий сдвиг: маршрут стартового снимка + дельта (у группы концы едут вместе).
          const orig = s.routes.get(e.id);
          if (!orig) return e; // нет снимка маршрута (smoothstep-фолбэк) — оставляем как есть
          const { dx, dy } = deltaOf(e.source);
          const moved = orig.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          return { ...e, data: { ...(e.data as WrappedEdgeData), autoRoute: moved } };
        }
        // один конец: живой маршрут роутера (нутро + сторона хэндла) — превью = будущее
        const lr = liveRoutes?.get(e.id);
        if (lr) {
          const data = { ...(e.data as WrappedEdgeData), autoRoute: lr };
          const lh = liveHandles?.get(e.id);
          return lh
            ? { ...e, data, sourceHandle: lh.sourceHandle, targetHandle: lh.targetHandle }
            : { ...e, data };
        }
        // фолбэк (нет входов роутера): обновляем только сторону хэндла, если сменилась
        const h = handles.get(e.id);
        if (!h || (h.sourceHandle === e.sourceHandle && h.targetHandle === e.targetHandle)) return e;
        return { ...e, sourceHandle: h.sourceHandle, targetHandle: h.targetHandle };
      }),
    );
  }, [setRfEdges]);

  const end = useCallback(() => { session.current = null; }, []);

  return { begin, move, end };
}
