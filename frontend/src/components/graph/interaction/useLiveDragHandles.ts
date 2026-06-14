// Живой пересчёт хэндлов стрелок во время драга узлов. После отпускания раскладка
// заново назначает авто-хэндлы по новым позициям (assignEdgeHandles в layoutLevel) —
// сторона входа/выхода стрелки может смениться, путь оптимизируется. Но во время самого
// драга стрелка висела на ПРЕЖНИХ хэндлах, и был разрыв WYSIWYG: видно одно, по
// отпускании — другое. Этот хук закрывает разрыв: каждый кадр драга прогоняет ТУ ЖЕ
// assignEdgeHandles по живым позициям и применяет результат к rfEdges. Используем тот же
// движок, что и пост-драговая раскладка, — значит превью совпадает с итогом по построению.
//
// Скоуп — рёбра, у которых ОБА конца локальны (block) и нет дефолтного обвода (detour):
// для них итоговый хэндл = ровно выход assignEdgeHandles (обводы/кольца гостей его не
// перетирают). Гостевые/сквозные стрелки и обводы во время драга не трогаем — они
// доедут по отпускании (редкий случай, для них WYSIWYG-разрыв незаметен). Сохранённые
// вручную хэндлы assignEdgeHandles и так оставляет на месте — драг их не двигает.
import { useCallback, useRef } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge as AppEdge } from "../../../types";
import { assignEdgeHandles } from "../layout/level";

// Снимок входов раскладки, нужных для пересчёта хэндлов. LevelGraph кладёт его в ref
// в конце async-раскладки — те же layoutEdges/узлы, по которым считался текущий layout.
export interface LiveHandleInputs {
  // мастер-рёбра уровня (по одному на направление пары) — ключи совпадают с rfEdge.id
  layoutEdges: AppEdge[];
  // все отображаемые узлы (локальные + гости/контейнеры) — вход assignEdgeHandles
  nodeIds: Array<{ id: string }>;
  // id локальных узлов уровня (block): пересчитываем только рёбра, оба конца которых тут
  localIds: Set<string>;
  // id рёбер с дефолтным обводом — их хэндлы перетёр бы computeDetours, в драге пропускаем
  detourIds: Set<string>;
}

interface Params {
  inputsRef: React.RefObject<LiveHandleInputs | null>;
  setRfEdges: Dispatch<SetStateAction<RFEdge[]>>;
}

// Сессия одного жеста: базовые позиции всех узлов на старте (двигаются только
// перетаскиваемые) и снимок входов раскладки на момент старта.
interface Session {
  base: Map<string, { x: number; y: number }>;
  inp: LiveHandleInputs;
}

export function useLiveDragHandles({ inputsRef, setRfEdges }: Params) {
  const session = useRef<Session | null>(null);

  // Старт жеста: фиксируем позиции всех узлов (для неперетаскиваемых они неизменны весь
  // жест) и снимок входов раскладки. Нет снимка раскладки — хук просто бездействует.
  const begin = useCallback((allNodes: RFNode[]) => {
    const inp = inputsRef.current;
    if (!inp) { session.current = null; return; }
    const base = new Map(allNodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    session.current = { base, inp };
  }, [inputsRef]);

  // Кадр драга: позиции = база с подменой перетаскиваемых на живые, прогоняем
  // assignEdgeHandles и применяем хэндлы к подходящим рёбрам. Неизменные рёбра
  // возвращаем тем же объектом — RF их не перерисует (сравнение по ссылке).
  const move = useCallback((dragged: RFNode[]) => {
    const s = session.current;
    if (!s) return;
    const positions = new Map(s.base);
    for (const n of dragged) positions.set(n.id, { x: n.position.x, y: n.position.y });
    const draggedIds = new Set(dragged.map((n) => n.id));
    const handles = assignEdgeHandles(s.inp.nodeIds, s.inp.layoutEdges, positions);
    setRfEdges((prev) =>
      prev.map((e) => {
        // только локально-локальные рёбра без обвода и хотя бы одним концом в перетаскиваемых
        if (!s.inp.localIds.has(e.source) || !s.inp.localIds.has(e.target)) return e;
        if (s.inp.detourIds.has(e.id)) return e;
        if (!draggedIds.has(e.source) && !draggedIds.has(e.target)) return e;
        const h = handles.get(e.id);
        if (!h || (h.sourceHandle === e.sourceHandle && h.targetHandle === e.targetHandle)) return e;
        return { ...e, sourceHandle: h.sourceHandle, targetHandle: h.targetHandle };
      }),
    );
  }, [setRfEdges]);

  const end = useCallback(() => { session.current = null; }, []);

  return { begin, move, end };
}
