// «Быстрая связь»: стрелка-кнопка у хэндла узла предлагает связать его с подходящим
// соседним узлом. enter (навели на стрелку) → подбираем цель из геометрии узлов уровня
// (чистая findQuickConnectTarget, уже под юнит-тестами) и рисуем превью; leave → гасим;
// activate (клик) → создаём связь через те же колбэк-пропсы, что и ручное протягивание:
// цель-ЛИСТ (блок без детей / гость) → onCreateEdge; цель-«зона входа» (контейнер ИЛИ
// сервис с детьми) → onConnectInto (выбор потомка, как дроп в тело — E73; прямая связь
// в промежуточный объект рождала бы алерт intermediate_edges, баг 2026-07-16).
//
// latest-refs для стабильного activate: handlers кладём в data узлов, и они НЕ должны
// менять идентичность (иначе пересборка раскладки на каждый ховер). Обновляем рефы в
// эффекте без зависимостей (как cbRef владельца) — activate читает их в обработчике клика,
// после рендера. resolveTarget/displayNameOf общие с useEdgeConnect — владелец передаёт
// их сюда параметрами (не дублируем).
//
// Вынесено из LevelGraph.tsx (Фаза 3б). Возвращает qcCandidate (JSX рисует
// QuickConnectPreview) и quickConnectHandlers (идут в cbRef владельца).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Node as RFNode } from "@xyflow/react";
import type { EdgeSide } from "../edgePath";
import type { QuickConnectHandlers } from "../types";
import { absPositionOf } from "../absPos";
import { findQuickConnectTarget, type QcNode, type QcResult } from "./quickConnect";
import type { ConnectTarget } from "./useEdgeConnect";

interface UseLevelQuickConnectArgs {
  rfNodes: RFNode[];
  // классификация узла-цели (общая с useEdgeConnect — строит владелец по rfNodes)
  resolveTarget: (id: string) => ConnectTarget;
  // имя отображаемого узла по id (для заголовков модалок создания связи)
  displayNameOf: (id: string) => string | undefined;
  onCreateEdge?: (
    sourceId: string, targetId: string,
    sourceHandle: string | null, targetHandle: string | null,
    sourceName?: string, targetName?: string,
  ) => void;
  onConnectInto?: (
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null, sourceName?: string,
  ) => void;
}

export interface LevelQuickConnect {
  /** подобранная цель-сосед (null — нет цели в радиусе / наведение не активно) */
  qcCandidate: QcResult | null;
  /** enter/leave/activate — кладутся в data узлов через cbRef владельца */
  quickConnectHandlers: QuickConnectHandlers;
}

export function useLevelQuickConnect({
  rfNodes,
  resolveTarget,
  displayNameOf,
  onCreateEdge,
  onConnectInto,
}: UseLevelQuickConnectArgs): LevelQuickConnect {
  // Активное наведение: источник + хэндл + сторона/доля (для расчёта цели).
  const [qc, setQc] = useState<{ sourceId: string; sourceHandle: string; side: EdgeSide; frac: number } | null>(null);
  // Кандидат-цель для текущего qc — из геометрии узлов уровня (фикс. размер NODE_W×NODE_H).
  // Позиции — абсолютные: дети compound-рамок несут относительные координаты (R4).
  const qcCandidate = useMemo(() => {
    if (!qc) return null;
    const byId = new Map(rfNodes.map((n) => [n.id, n]));
    const src = byId.get(qc.sourceId);
    if (!src) return null;
    const cands: QcNode[] = rfNodes
      .filter((n) => n.type !== "spacer" && n.type !== "frame" && n.id !== qc.sourceId)
      .map((n) => ({ id: n.id, ...absPositionOf(n, byId) }));
    return findQuickConnectTarget(
      qc.sourceId, qc.side, qc.frac,
      { id: src.id, ...absPositionOf(src, byId) }, cands,
    );
  }, [qc, rfNodes]);
  // latest-refs для стабильного activate: handlers кладём в data узлов, и они НЕ должны
  // менять идентичность (иначе пересборка раскладки на каждый ховер). Обновляем в эффекте
  // без зависимостей (как cbRef владельца) — activate читает их в обработчике клика, после рендера.
  const qcRef = useRef(qc);
  const qcCandidateRef = useRef(qcCandidate);
  const onCreateEdgeRef = useRef(onCreateEdge);
  const onConnectIntoRef = useRef(onConnectInto);
  const resolveTargetRef = useRef(resolveTarget);
  const displayNameOfRef = useRef(displayNameOf);
  useEffect(() => {
    qcRef.current = qc;
    qcCandidateRef.current = qcCandidate;
    onCreateEdgeRef.current = onCreateEdge;
    onConnectIntoRef.current = onConnectInto;
    resolveTargetRef.current = resolveTarget;
    displayNameOfRef.current = displayNameOf;
  });
  const quickConnectHandlers = useMemo<QuickConnectHandlers>(() => ({
    enter: (sourceId, sourceHandle, side, frac) => setQc({ sourceId, sourceHandle, side, frac }),
    leave: () => setQc(null),
    activate: () => {
      const q = qcRef.current, c = qcCandidateRef.current;
      setQc(null);
      if (!q || !c) return;
      const nameOf = displayNameOfRef.current;
      // Цель-«зона входа» (контейнер или сервис с детьми) и у быстрой связи уводит
      // в выбор потомка — как дроп протягивания в тело (E73). Прямая связь в
      // промежуточный объект рождала бы алерт intermediate_edges (баг 2026-07-16).
      const target = resolveTargetRef.current(c.targetId);
      if (target && target.kind === "into") {
        onConnectIntoRef.current?.(
          q.sourceId, c.targetId, target.name, q.sourceHandle, nameOf(q.sourceId),
        );
        return;
      }
      onCreateEdgeRef.current?.(
        q.sourceId, c.targetId, q.sourceHandle, c.targetHandle,
        nameOf(q.sourceId), nameOf(c.targetId),
      );
    },
  }), []);

  return { qcCandidate, quickConnectHandlers };
}
