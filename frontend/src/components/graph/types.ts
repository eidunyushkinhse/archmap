// Общие типы графа уровня. Импортирует только типы — ни от чего не зависит во
// время выполнения. FrameDef намеренно НЕ здесь: он локален для boundaries.tsx.
import type { Node as RFNode } from "@xyflow/react";
import type { Node as AppNode, GhostNode, AncestorRef, EdgePoint, Edge as AppEdge } from "../../types";

// Группа связей одного направления между парой отображаемых узлов, слитая в одну
// «мастер-стрелку» (members.length > 1) либо одиночная связь (members.length === 1).
// id — id одиночной связи или синтетический `merge:src->tgt`. Раскладку/хэндлы
// считаем на мастер-рёбрах (по одной на направление между парой).
export interface EdgeGroup {
  id: string;
  source: string;
  target: string;
  members: AppEdge[];
}

// сегмент с подписью (сосед) и его длина в px. end="target" — сосед это target
// (исходящее фокус→сосед), end="source" — сосед это source (входящее сосед→фокус).
export type EdgeShelf = { end: "source" | "target"; len: number };

// Обход «не родной» стрелки bidi-пары (контекст-схема): дальняя сторона соседа →
// полка наружу до loopX → вертикаль до clearY (обход над/под колонкой) → к центру →
// верх/низ-центр фокуса. neighborEnd — какой конец ребра у соседа.
export type EdgeLoop = { neighborEnd: "source" | "target"; loopX: number; clearY: number };

export interface WrappedEdgeData extends Record<string, unknown> {
  // одиночная связь — текст метки; мастер-стрелка — список текстов связей
  label?: string;
  items?: string[];
  memberIds: string[];
  // макс. ширина плашки подписи (контекст-схема: чтобы подпись влезала в зазор между
  // фокусом и колонкой и не наезжала на узлы); если не задано — поведение как раньше
  maxWidth?: number;
  // контекст-схема: подпись кладётся на горизонтальную «полку» у соседа (если задано)
  shelf?: EdgeShelf;
  // контекст-схема: «не родная» стрелка bidi — обход колонки (если задано, вместо shelf)
  loop?: EdgeLoop;
  // основная схема: дефолтный «обвод» — прямой маршрут гостевой стрелки пересёк бы чужие
  // узлы, поэтому путь огибает рамку поверху/понизу на высоте clearY. Применяется только
  // когда у ребра нет своих waypoints (пользователь не правил путь вручную). Концы при этом
  // переназначены на верх/низ-центр (см. раскладку), чтобы стрелка входила/выходила вертикально.
  detour?: { clearY: number };
  // кастомные точки-сгибы пути (ручные «обходы» узлов на основной схеме)
  waypoints?: EdgePoint[];
  // можно ли редактировать путь жестом (архитектор, level, одиночная стрелка, оба конца локальны)
  editable?: boolean;
  // зафиксировать новый набор waypoints (пустой — сброс в авто); зовётся по отпусканию драга
  onWaypointsCommit?: (waypoints: EdgePoint[]) => void;
  // открыть поповер информации о связи (клик по плашке с описанием). Клик по самой линии
  // на основной схеме перехватывают грипы изломов, поэтому триггер — плашка. Задаётся
  // только для level-рёбер (в контексте схема только для просмотра).
  onOpenDetails?: () => void;
}

export interface NodeColors { bg: string; border: string; text: string }

export interface BlockData extends Record<string, unknown> {
  appNode: AppNode;
  onDrillDown: (node: AppNode) => void;
  onEdit: (node: AppNode) => void;
  isArchitect: boolean;
  colors: NodeColors;
  // в контекст-режиме у фокусного блока нет кнопок «Войти»/правки (схема — только просмотр)
  hideActions?: boolean;
  // можно ли НАЧАТЬ связь с хэндлов узла (архитектор, не контекст-режим) — раскрытие
  // хэндлов по ховеру для протягивания новой стрелки
  connectable?: boolean;
}

export interface GhostData extends Record<string, unknown> {
  appNode: GhostNode;
  colors: NodeColors;
  connectable?: boolean;
}

// Свёрнутый узел-контейнер соседней ветки (напр. ProdMon) — с кнопкой-лупой.
export interface ContainerData extends Record<string, unknown> {
  id: string;
  name: string;
  depth: number;
  ancestors: AncestorRef[];
  colors: NodeColors;
  onExpand: (id: string) => void;
  connectable?: boolean;
}

export type BlockRFNode = RFNode<BlockData, "block">;
export type GhostRFNode = RFNode<GhostData, "ghost">;
export type ContainerRFNode = RFNode<ContainerData, "container">;

// --- Проекция гостей с учётом свёрнутых контейнеров ---

export interface DisplayContainer { kind: "container"; id: string; name: string; depth: number; ancestors: AncestorRef[]; }
export interface DisplayLeaf { kind: "leaf"; id: string; ghost: GhostNode; }
export type DisplayExternal = DisplayContainer | DisplayLeaf;
