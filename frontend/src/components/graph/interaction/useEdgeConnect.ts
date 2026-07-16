// Создание связи протягиванием новой стрелки от хэндла узла A.
//
// Жест (только архитектор, не контекст-режим). Куда отпустил конец:
//   • на ХЭНДЛ любого узла (защёлка в радиусе connectionRadius — onConnect) → прямая
//       связь к ЭТОМУ узлу, даже если у него есть дети (явно целились в его хэндл);
//   • на ТЕЛО узла С ДЕТЬМИ (мимо хэндлов — onConnectEnd) — это «зона входа»:
//       открываем выбор его потомка (поиск скоупится поддеревом) → связь A→потомок
//       (станет сквозной);
//   • на ТЕЛО ЛИСТОВОГО узла → прямая связь (прощаем непопадание в хэндл);
//   • на пустой холст → стрелка просто исчезает.
//
// Хэндл выигрывает у «зоны входа»: его обрабатывает onConnect ещё до onConnectEnd
// (madeRef глушит дубль). Реконнект концов существующих рёбер умер вместе с ручным
// слоем стрелок (2026-07-09) — этот поток единственный.
import { useCallback, useEffect, useRef, useState } from "react";
import type { OnConnectStartParams, Connection, Edge as RFEdge } from "@xyflow/react";

// Что делать с узлом, на который отпустили конец стрелки.
export type ConnectTarget =
  | { kind: "direct" }                 // лист — связать напрямую
  | { kind: "into"; name: string }     // узел с детьми — выбрать его потомка
  | null;                              // распорка/неизвестный — игнор

interface Params {
  isArchitect: boolean;
  isContext: boolean;
  // классификация узла-цели по его id (строит вызывающий по rfNodes)
  resolveTarget: (nodeId: string) => ConnectTarget;
  // лист/хэндл: создать связь sourceId→targetId. Хэндлы берём из жеста: при дропе
  // на ХЭНДЛ известны оба (sourceHandle+targetHandle), при дропе на ТЕЛО листа —
  // только исходный (targetHandle=null → дефолт).
  onCreate?: (
    sourceId: string, targetId: string,
    sourceHandle: string | null, targetHandle: string | null,
  ) => void;
  // узел с детьми: открыть выбор потомка контейнера containerId как дальнего конца
  // межуровневой связи; sourceHandle — хэндл, из которого тянули (дальний — дефолт)
  onInto?: (
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null,
  ) => void;
  // конец отпущен на плитку «вне уровня» (элемент с data-exit-up): открыть выбор
  // дальнего конца из всей схемы (узла, которого нет на текущем холсте).
  onExitUp?: (sourceId: string, sourceHandle: string | null) => void;
}

// Координаты точки отпускания (мышь или тач).
function endPoint(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ("changedTouches" in event && event.changedTouches.length > 0) {
    const t = event.changedTouches[0];
    return { x: t.clientX, y: t.clientY };
  }
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  return null;
}

export function useEdgeConnect({
  isArchitect, isContext, resolveTarget, onCreate, onInto, onExitUp,
}: Params) {
  const enabled = isArchitect && !isContext;
  // id узла, от которого начато протягивание (null — протягивания нет)
  const sourceRef = useRef<string | null>(null);
  // хэндл, из которого начато протягивание (для дропа на тело/в зону входа, где
  // целевого хэндла нет — а исходный известен из onConnectStart)
  const sourceHandleRef = useRef<string | null>(null);
  // в текущем протягивании конец защёлкнулся на хэндл (onConnect уже создал связь) —
  // тогда onConnectEnd не должен трактовать дроп ещё и как «зону входа»
  const madeRef = useRef(false);
  // идёт протягивание новой связи — для подсветки «зон входа» (CSS-класс на холсте)
  const [connecting, setConnecting] = useState(false);

  // Узел ПОД КУРСОРОМ во время протягивания. Подсветку (зона входа + хэндлы) вешаем
  // на него, а не на «зону активации хэндла» (.connectingto): иначе в центре тела
  // узла, где хэндла рядом нет, визуал пропадал. :hover при pointer-capture драга
  // ненадёжен, поэтому ведём цель сами — pointermove + elementFromPoint, класс
  // lg-into-target вешаем прямо на DOM .react-flow__node (узлы во время драга не
  // перерисовываются, RF класс не затирает; снимаем по завершении).
  const targetElRef = useRef<HTMLElement | null>(null);
  // плитка «вне уровня» под курсором (подсветка при наведении конца стрелки)
  const bannerElRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const clearTarget = useCallback(() => {
    if (targetElRef.current) {
      targetElRef.current.classList.remove("lg-into-target");
      targetElRef.current = null;
    }
  }, []);

  const clearBanner = useCallback(() => {
    if (bannerElRef.current) {
      bannerElRef.current.classList.remove("lg-exit-up--active");
      bannerElRef.current = null;
    }
  }, []);

  const updateTarget = useCallback(
    (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      // Курсор над плиткой «вне уровня» — подсвечиваем её, подсветку узла снимаем.
      const banner = el?.closest<HTMLElement>("[data-exit-up]") ?? null;
      if (banner) {
        clearTarget();
        if (banner !== bannerElRef.current) {
          clearBanner();
          banner.classList.add("lg-exit-up--active");
          bannerElRef.current = banner;
        }
        return;
      }
      clearBanner();
      const nodeEl = el?.closest<HTMLElement>(".react-flow__node") ?? null;
      const id = nodeEl?.getAttribute("data-id");
      // узел-источник не подсвечиваем — связь на самого себя не ведём
      const next = nodeEl && id !== sourceRef.current ? nodeEl : null;
      if (next === targetElRef.current) return;
      clearTarget();
      if (next) {
        next.classList.add("lg-into-target");
        targetElRef.current = next;
      }
    },
    [clearTarget, clearBanner],
  );

  // pointermove частый — пересчёт цели троттлим по кадру
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (rafRef.current != null) return;
      const { clientX, clientY } = e;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateTarget(clientX, clientY);
      });
    },
    [updateTarget],
  );

  const stopTracking = useCallback(() => {
    document.removeEventListener("pointermove", handlePointerMove);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    clearTarget();
    clearBanner();
  }, [handlePointerMove, clearTarget, clearBanner]);

  // размонтирование посреди драга — снять слушатель и подсветку
  useEffect(() => stopTracking, [stopTracking]);

  const handleConnectStart = useCallback(
    (_e: unknown, params: OnConnectStartParams) => {
      if (!enabled || !params.nodeId) return;
      sourceRef.current = params.nodeId;
      sourceHandleRef.current = params.handleId ?? null;
      madeRef.current = false;
      setConnecting(true);
      document.addEventListener("pointermove", handlePointerMove);
    },
    [enabled, handlePointerMove],
  );

  // Конец защёлкнулся на хэндл узла (в радиусе connectionRadius) — прямая связь к нему.
  const handleConnect = useCallback(
    (conn: Connection) => {
      madeRef.current = true; // глушим «зону входа» в onConnectEnd даже при петле
      const { source, target, sourceHandle, targetHandle } = conn;
      if (!enabled || !source || !target || source === target) return;
      // дроп на хэндл — оба конца известны, оба хэндла из жеста
      onCreate?.(source, target, sourceHandle ?? null, targetHandle ?? null);
    },
    [enabled, onCreate],
  );

  // Разрешённость НОВОЙ связи: нужна, чтобы onConnect защёлкивался на хэндл и
  // подсвечивал валидную цель.
  const isValidNewConnection = useCallback(
    (conn: Connection | RFEdge) =>
      enabled && conn.source != null && conn.target != null && conn.source !== conn.target,
    [enabled],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      stopTracking();
      const made = madeRef.current;
      madeRef.current = false;
      setConnecting(false);
      const source = sourceRef.current;
      sourceRef.current = null;
      const sourceHandle = sourceHandleRef.current;
      sourceHandleRef.current = null;
      if (made) return; // хэндл уже обработан в onConnect
      if (!enabled || !source) return;

      // Цель определяем по узлу ПОД КУРСОРОМ (надёжнее радиуса хэндлов — «бросай
      // куда угодно по телу узла»): elementFromPoint → ближайший .react-flow__node →
      // его data-id. Линия-превью имеет pointer-events:none, поэтому не перехватывает.
      const pt = endPoint(event);
      if (!pt) return;
      const el = document.elementFromPoint(pt.x, pt.y);
      // Отпустили на плитку «вне уровня» — выбор дальнего конца из всей схемы.
      // Плитка перекрывает узлы (она выше по z-index), поэтому проверяем её первой.
      if (el?.closest("[data-exit-up]")) {
        onExitUp?.(source, sourceHandle);
        return;
      }
      const nodeEl = el?.closest<HTMLElement>(".react-flow__node");
      const targetId = nodeEl?.getAttribute("data-id");
      if (!targetId) return; // пустой холст — связь не создаём

      const info = resolveTarget(targetId);
      if (!info) return;
      if (info.kind === "into") {
        // межуровневая: исходный хэндл сохраняем, дальний — дефолт (выберется потомок)
        onInto?.(source, targetId, info.name, sourceHandle);
      } else {
        if (targetId === source) return; // петля сам-на-себя — игнор
        // дроп на тело листа: исходный хэндл известен, целевой — дефолт
        onCreate?.(source, targetId, sourceHandle, null);
      }
    },
    [enabled, resolveTarget, onCreate, onInto, onExitUp, stopTracking],
  );

  return { connecting, handleConnectStart, handleConnect, handleConnectEnd, isValidNewConnection };
}
