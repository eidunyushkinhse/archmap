// Реестр геометрии стрелок для «мостиков» (line jumps). Каждое ребро рендерится
// независимо и не знает ломаных соседей — поэтому: рёбра ПУБЛИКУЮТ свою ломаную сюда,
// центральный memo считает пересечения (computeJumps), рёбра ЧИТАЮТ свои точки-мостики
// и рисуют дуги. Источник координат — авторитетный React Flow (sourceX/Y у ребра),
// поэтому реестр верен и во время драга (с лагом в один кадр — линия при этом цела).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { EdgePoint } from "../../types";
import { computeJumps, type JumpPoint } from "./edgeJumps";

interface Ctx {
  publish: (id: string, poly: EdgePoint[] | null) => void;
  jumpsFor: (id: string) => JumpPoint[];
}

const EMPTY: JumpPoint[] = [];
const EMPTY_JUMPS = new Map<string, JumpPoint[]>();
const EdgeJumpContext = createContext<Ctx | null>(null);

function samePoly(a: EdgePoint[] | undefined, b: EdgePoint[] | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
}

// enabled=false (контекст-схема) — реестр спит: publish игнорит, прыжков нет.
export function EdgeJumpProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  // Геометрия всех рёбер уровня (id → ломаная). Новый Map создаём ТОЛЬКО при реальном
  // изменении (функциональный апдейтер возвращает prev без изменений → нет ререндера).
  const [polys, setPolys] = useState<Map<string, EdgePoint[]>>(() => new Map());

  const publish = useCallback(
    (id: string, poly: EdgePoint[] | null) => {
      if (!enabled) return;
      setPolys((prev) => {
        const cur = prev.get(id);
        if (poly == null) {
          if (cur == null) return prev; // нечего удалять
          const next = new Map(prev);
          next.delete(id);
          return next;
        }
        if (samePoly(cur, poly)) return prev; // без изменений — тот же Map, нет ререндера
        const next = new Map(prev);
        next.set(id, poly);
        return next;
      });
    },
    [enabled],
  );

  const jumps = useMemo(() => (enabled ? computeJumps(polys) : EMPTY_JUMPS), [polys, enabled]);
  const jumpsFor = useCallback((id: string) => jumps.get(id) ?? EMPTY, [jumps]);
  const value = useMemo<Ctx>(() => ({ publish, jumpsFor }), [publish, jumpsFor]);

  return <EdgeJumpContext.Provider value={value}>{children}</EdgeJumpContext.Provider>;
}

// Вне провайдера — заглушка (мостики выключены): publish no-op, прыжков нет.
const NOOP: Ctx = { publish: () => {}, jumpsFor: () => EMPTY };

export function useEdgeJumps(): Ctx {
  return useContext(EdgeJumpContext) ?? NOOP;
}
