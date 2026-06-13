// Жёсткий перенос стрелок при мультидраге. Когда тащат сразу несколько выделенных
// узлов, стрелка МЕЖДУ ДВУМЯ перетаскиваемыми узлами должна переехать целиком,
// неизменной формы — то есть её изломы (waypoints) сдвигаются на тот же вектор, что и
// узлы, а не остаются на месте, растягивая хвосты. Стрелки с одним концом в выделении
// ведут себя как раньше (конец следует за хэндлом, изломы стоят).
//
// Прямым (без waypoints) и smoothstep-стрелкам перенос не нужен: их путь полностью
// определяется концами, и если оба конца сдвинулись на δ, линия сама переезжает на δ.
// Поэтому трогаем только рёбра с собственными изломами.
//
// При мультидраге снап выключен (см. useSnapAlignment), поэтому отрисованная позиция
// узла = сырой позиции драга RF, и вектор δ из onNodeDrag совпадает со сдвигом хэндлов —
// перенос изломов на тот же δ даёт строго жёсткую трансляцию всей стрелки.
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { EdgePoint } from "../../../types";
import type { WrappedEdgeData } from "../types";

interface Params {
  rfEdges: RFEdge[];
  setRfEdges: Dispatch<SetStateAction<RFEdge[]>>;
}

// Сессия одного жеста драга: стартовые позиции перетаскиваемых узлов (для вектора δ) и
// исходные изломы подходящих рёбер (база, к которой каждый кадр прибавляем δ).
interface DragSession {
  start: Map<string, { x: number; y: number }>;
  edges: Array<{ id: string; base: EdgePoint[] }>;
}

export function useGroupEdgeDrag({ rfEdges, setRfEdges }: Params) {
  const session = useRef<DragSession | null>(null);

  // Старт жеста: фиксируем стартовые позиции узлов и изломы рёбер, у которых ОБА конца
  // в перетаскиваемом наборе (и у ребра есть свои waypoints — иначе переносить нечего).
  const begin = useCallback(
    (dragged: RFNode[]) => {
      const ids = new Set(dragged.map((n) => n.id));
      const start = new Map(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
      const edges: DragSession["edges"] = [];
      for (const e of rfEdges) {
        if (!ids.has(e.source) || !ids.has(e.target)) continue;
        const wp = (e.data as WrappedEdgeData | undefined)?.waypoints;
        if (wp && wp.length > 0) edges.push({ id: e.id, base: wp.map((p) => ({ x: p.x, y: p.y })) });
      }
      session.current = { start, edges };
    },
    [rfEdges],
  );

  // Вектор сдвига от старта по любому перетаскиваемому узлу (все двигаются жёстко на
  // один и тот же δ). null — сессии нет или узел вне неё.
  const deltaOf = (dragged: RFNode[], s: DragSession): { dx: number; dy: number } | null => {
    const n = dragged[0];
    const st = n && s.start.get(n.id);
    if (!n || !st) return null;
    return { dx: n.position.x - st.x, dy: n.position.y - st.y };
  };

  // Кадр драга: переносим изломы подходящих рёбер на текущий δ. Неподходящие рёбра
  // возвращаем тем же объектом — RF не перерисует их (сравнение по ссылке).
  const move = useCallback(
    (dragged: RFNode[]) => {
      const s = session.current;
      if (!s || s.edges.length === 0) return;
      const d = deltaOf(dragged, s);
      if (!d) return;
      setRfEdges((prev) =>
        prev.map((e) => {
          const q = s.edges.find((x) => x.id === e.id);
          if (!q) return e;
          const data = e.data as WrappedEdgeData;
          return { ...e, data: { ...data, waypoints: q.base.map((p) => ({ x: p.x + d.dx, y: p.y + d.dy })) } };
        }),
      );
    },
    [setRfEdges],
  );

  // Отпускание: персистим перенесённые изломы через onWaypointsCommit ребра (он уже
  // знает memberIds и слой хранения — колонка ребра или пер-уровневый слой). Нулевой
  // сдвиг (клик без движения) игнорируем.
  const end = useCallback(
    (dragged: RFNode[]) => {
      const s = session.current;
      session.current = null;
      if (!s || s.edges.length === 0) return;
      const d = deltaOf(dragged, s);
      if (!d || (d.dx === 0 && d.dy === 0)) return;
      for (const q of s.edges) {
        const e = rfEdges.find((x) => x.id === q.id);
        const commit = (e?.data as WrappedEdgeData | undefined)?.onWaypointsCommit;
        commit?.(q.base.map((p) => ({ x: p.x + d.dx, y: p.y + d.dy })));
      }
    },
    [rfEdges],
  );

  return { begin, move, end };
}
