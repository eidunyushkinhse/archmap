// Создание связи протягиванием новой стрелки от хэндла узла A.
//
// Жест (только архитектор, не контекст-режим):
//   • отпустил на ЛИСТОВОМ узле (нет детей)  → связь A→B создаётся сразу;
//   • отпустил на узле С ДЕТЬМИ (контейнер / has_children) — это «зона входа»:
//       связь нельзя замкнуть на него самого (алерт-кейс), поэтому открываем выбор
//       его потомка (поиск скоупится поддеревом) → связь A→потомок (станет сквозной);
//   • отпустил на пустом холсте → стрелка просто исчезает.
//
// Реконнект концов существующих рёбер — ОТДЕЛЬНЫЙ поток (onReconnect*), сюда не
// заходит: onConnectStart/onConnectEnd срабатывают только для НОВОЙ связи.
import { useCallback, useRef, useState } from "react";
import type { OnConnectStartParams } from "@xyflow/react";

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
  // лист: создать связь sourceId→targetId
  onCreate?: (sourceId: string, targetId: string) => void;
  // узел с детьми: открыть выбор потомка контейнера containerId как дальнего конца
  onInto?: (sourceId: string, containerId: string, containerName: string) => void;
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
  isArchitect, isContext, resolveTarget, onCreate, onInto,
}: Params) {
  const enabled = isArchitect && !isContext;
  // id узла, от которого начато протягивание (null — протягивания нет)
  const sourceRef = useRef<string | null>(null);
  // идёт протягивание новой связи — для подсветки «зон входа» (CSS-класс на холсте)
  const [connecting, setConnecting] = useState(false);

  const handleConnectStart = useCallback(
    (_e: unknown, params: OnConnectStartParams) => {
      if (!enabled || !params.nodeId) return;
      sourceRef.current = params.nodeId;
      setConnecting(true);
    },
    [enabled],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      setConnecting(false);
      const source = sourceRef.current;
      sourceRef.current = null;
      if (!enabled || !source) return;

      // Цель определяем по узлу ПОД КУРСОРОМ (надёжнее радиуса хэндлов — «бросай
      // куда угодно по телу узла»): elementFromPoint → ближайший .react-flow__node →
      // его data-id. Линия-превью имеет pointer-events:none, поэтому не перехватывает.
      const pt = endPoint(event);
      if (!pt) return;
      const el = document.elementFromPoint(pt.x, pt.y);
      const nodeEl = el?.closest<HTMLElement>(".react-flow__node");
      const targetId = nodeEl?.getAttribute("data-id");
      if (!targetId) return; // пустой холст — связь не создаём

      const info = resolveTarget(targetId);
      if (!info) return;
      if (info.kind === "into") {
        onInto?.(source, targetId, info.name);
      } else {
        if (targetId === source) return; // петля сам-на-себя — игнор
        onCreate?.(source, targetId);
      }
    },
    [enabled, resolveTarget, onCreate, onInto],
  );

  return { connecting, handleConnectStart, handleConnectEnd };
}
