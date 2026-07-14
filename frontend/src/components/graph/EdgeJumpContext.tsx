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
// paused=true (идёт драг узлов ЛИБО фаза move анимации раскрытия) — реестр ЗАМОРОЖЕН:
// publish игнорит ОБНОВЛЕНИЯ геометрии (polys не меняется, пересчёта пересечений на
// кадр нет — иначе смена value реестра перерисовывала бы ВСЕ рёбра по два прохода на
// кадр, источник лагов и краша на мультидраге), но ПОСЛЕДНИЕ посчитанные мостики
// ОСТАЮТСЯ на экране (2026-07-09; раньше пауза гасила все дуги → каждый жест «мигал»
// дугами всей схемы, даже у стрелок, не связанных с таскаемым узлом). У рёбер
// таскаемого узла устаревший мостик прячет фильтр отрисовки (straightWithJumps рисует
// хоп, только если тот лежит на фактическом сегменте).
// УДАЛЕНИЯ (publish(id, null)) проходят СКВОЗЬ паузу: ребро, чей последний рендер
// пришёлся на паузу (своп сворачивания убивает рёбра раскрытого мира), прощается
// publish'ем-замыканием этой паузы — глотание удаления оставляло бы в реестре полигон
// мёртвого ребра, и живые рисовали бы дуги «над призраком» вечно (ловится гейтом
// «финал == перезагрузка»). Смерть рёбер — редкое структурное событие, один батч.
// По снятию paused идентичность publish меняется → эффекты-публикаторы рёбер
// срабатывают заново и реестр пересобирается со свежей геометрией.
export function EdgeJumpProvider({ enabled, paused = false, children }: { enabled: boolean; paused?: boolean; children: ReactNode }) {
  const active = enabled && !paused;
  // Геометрия всех рёбер уровня (id → ломаная). Новый Map создаём ТОЛЬКО при реальном
  // изменении (функциональный апдейтер возвращает prev без изменений → нет ререндера).
  const [polys, setPolys] = useState<Map<string, EdgePoint[]>>(() => new Map());

  const publish = useCallback(
    (id: string, poly: EdgePoint[] | null) => {
      if (!enabled) return;
      if (!active && poly != null) return; // пауза глотает только обновления геометрии
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
    [enabled, active],
  );

  // считаем по enabled, НЕ по active: на паузе polys заморожен → memo не пересчитывается,
  // прежние мостики продолжают отдаваться (заморозка вместо гашения)
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
