// ПЕРЕПРИВЯЗКА КОНЦА-В-РАМКУ на холсте уровня (эпик «связи, упирающиеся в рамку»,
// edge.md E1a). Вынесено из LevelGraph (аудит F-1): правила попадания, перевес и признак
// «идёт перевес» для класса холста.
//
// Тянуть можно только конец, упёршийся в рамку (сборка помечает такие рёбра
// data.reconnectEnds), и только на узел ВНУТРИ ЭТОЙ ЖЕ рамки: её дети — единственные,
// кому связь может принадлежать «точнее». Промах мимо такого узла = жест отменён:
// ничего не пишем, рендер идёт из прежней раскладки, и конец возвращается на рамку
// (связь никогда не остаётся с одним концом). Ручку рисует само ребро на точке роутера
// (RehangAnchor, Ф5) и зовёт эти правила через ReconnectProvider.
import { useCallback, useMemo, useState } from "react";
import type { LayoutResult } from "../layout/pipeline";
import type { RehangEdge, RehangEnd, RehangHandlers } from "../ReconnectContext";
import type { LevelEdgeCallbacks } from "../types";

export function useLevelRehang({
  layoutLatestRef, canStructure, onReconnectFrameEnd, handleReconnectStart, handleReconnectEnd,
}: {
  // ПОСЛЕДНЯЯ раскладка: колбэки живут дольше одного прогона.
  layoutLatestRef: { current: LayoutResult | null };
  canStructure: boolean;
  onReconnectFrameEnd: LevelEdgeCallbacks["onReconnectFrameEnd"];
  // Метка перевеса для потока протяжки (useEdgeConnect) — та же, что ставила RF-ручка:
  // иначе отпускание конца на узле открывало бы ещё и окно «Новая связь».
  handleReconnectStart: () => void;
  handleReconnectEnd: () => void;
}): { rehanging: boolean; rehangHandlers: RehangHandlers } {
  const isValidTarget = useCallback((edge: RehangEdge, end: RehangEnd, nodeId: string): boolean => {
    const l = layoutLatestRef.current;
    if (!l || !canStructure) return false;
    const frameId = end === "source" ? edge.source : edge.target;
    if (!l.frameEnds.includes(frameId)) return false;
    const other = end === "source" ? edge.target : edge.source;
    if (nodeId === other) return false; // сам на себя — не связь
    const frames = [...l.guestFrames, ...(l.levelFrame ? [l.levelFrame] : [])];
    const frame = frames.find((f) => f.id === frameId);
    return frame != null && frame.memberIds.has(nodeId); // цель вне рамки — промах
  }, [layoutLatestRef, canStructure]);
  const reconnect = useCallback((edge: RehangEdge, end: RehangEnd, toNodeId: string) => {
    if (!isValidTarget(edge, end, toNodeId)) return;
    if (edge.memberIds.length === 0) return;
    const frameId = end === "source" ? edge.source : edge.target;
    onReconnectFrameEnd?.(edge.memberIds, end, frameId, toNodeId);
  }, [isValidTarget, onReconnectFrameEnd]);

  // Идёт перевес конца (ручка на ребре): класс холста прячет стрелки-глифы протяжки и
  // включает подсветку допустимой цели.
  const [rehanging, setRehanging] = useState(false);
  const rehangHandlers = useMemo<RehangHandlers>(() => ({
    isValidTarget,
    reconnect,
    onStart: () => { handleReconnectStart(); setRehanging(true); },
    onEnd: () => { handleReconnectEnd(); setRehanging(false); },
  }), [isValidTarget, reconnect, handleReconnectStart, handleReconnectEnd]);

  return { rehanging, rehangHandlers };
}
