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
import type { WrappedEdgeData } from "../types";
import { assignEdgeHandles } from "../layout/level";

// Снимок входов раскладки, нужных для пересчёта хэндлов. LevelGraph кладёт его в ref
// в конце async-раскладки — те же layoutEdges/узлы, по которым считался текущий layout.
export interface LiveHandleInputs {
  // мастер-рёбра уровня (по одному на направление пары) — ключи совпадают с rfEdge.id
  layoutEdges: LayoutEdge[];
  // все отображаемые узлы (локальные + гости/контейнеры) — вход assignEdgeHandles
  nodeIds: Array<{ id: string }>;
  // id локальных узлов уровня (block): пересчитываем только рёбра, оба конца которых тут
  localIds: Set<string>;
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
  //  • иначе (один конец) → как раньше: пересчитываем сторону хэндла тем же
  //    assignEdgeHandles, что и финал (нутро маршрута доедет по отпускании).
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
          const data = { ...(e.data as WrappedEdgeData), autoRoute: moved };
          return { ...e, data };
        }
        // один конец: обновляем только сторону хэндла, если сменилась
        const h = handles.get(e.id);
        if (!h || (h.sourceHandle === e.sourceHandle && h.targetHandle === e.targetHandle)) return e;
        return { ...e, sourceHandle: h.sourceHandle, targetHandle: h.targetHandle };
      }),
    );
  }, [setRfEdges]);

  const end = useCallback(() => { session.current = null; }, []);

  return { begin, move, end };
}
