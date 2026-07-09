// Общие типы графа уровня. Импортирует только типы — ни от чего не зависит во
// время выполнения. FrameDef намеренно НЕ здесь: он локален для boundaries.tsx.
import type { Node as RFNode } from "@xyflow/react";
import type { Node as AppNode, GhostNode, AncestorRef, EdgePoint, LayoutEdge } from "../../types";
import type { EdgeSide } from "./edgePath";

// Группа связей одного направления между парой отображаемых узлов, слитая в одну
// «мастер-стрелку» (members.length > 1) либо одиночная связь (members.length === 1).
// id — id одиночной связи или синтетический `merge:src->tgt`. Раскладку/хэндлы
// считаем на мастер-рёбрах (по одной на направление между парой). Члены обогащены
// геометрией пучка (R3): хэндлы/label_t у всех одинаковы (одна строка view_layout).
export interface EdgeGroup {
  id: string;
  source: string;
  target: string;
  members: LayoutEdge[];
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
  // основная/level схема: авто-маршрут глобального роутера (R1+R3) — ортоломаная с минимумом
  // пересечений и обходом узлов, посчитанная на раскладке. Применяется только когда у ребра
  // нет своих waypoints (ручные правки в приоритете). Концы edges.tsx переснимает с живых
  // хэндлов, интерьерные изломы — из этого снимка.
  autoRoute?: EdgePoint[];
  // авто-размещение плашки подписи (эпик стрелок, R2+R4): center — куда ставить плашку,
  // anchor — точка на линии (в режиме leader от неё рисуется поводок к вынесенной плашке;
  // в режиме online anchor совпадает с center). leaderEnd — конец поводка у края плашки (A15,
  // чтобы пунктир не прятался под плашкой). Считается по авто-маршруту на раскладке.
  labelPlacement?: { mode: "online" | "leader"; center: EdgePoint; anchor: EdgePoint; leaderEnd: EdgePoint };
  // кастомные точки-сгибы пути (ручные «обходы» узлов на основной схеме)
  waypoints?: EdgePoint[];
  // можно ли редактировать путь жестом (архитектор, level, одиночная стрелка, оба конца локальны)
  editable?: boolean;
  // зафиксировать новый набор waypoints (пустой — сброс в авто); зовётся по отпусканию драга
  onWaypointsCommit?: (waypoints: EdgePoint[]) => void;
  // позиция плашки вдоль стрелки: доля arc-length пути 0..1 (undefined — по центру).
  // Доля геометрия-независима: при смене хэндлов/изломов плашка остаётся на той же
  // доле к тому же концу (пересчитывается от текущего пути).
  labelT?: number;
  // зафиксировать новую позицию плашки (доля 0..1); зовётся по отпусканию её драга.
  // Задаётся только для редактируемых level-рёбер — он же включает перетаскивание.
  onLabelTCommit?: (t: number | null) => void;
  // открыть поповер информации о связи (клик по плашке с описанием). Клик по самой линии
  // на основной схеме перехватывают грипы изломов, поэтому триггер — плашка. Задаётся
  // только для level-рёбер (в контексте схема только для просмотра).
  onOpenDetails?: () => void;
  // приглушено фильтром «Вид схемы»: конец ребра в скрытом статусе. Линия рисуется
  // полупрозрачной (style.opacity ставит LevelGraph), а здесь гасим ещё и плашку подписи.
  dimmed?: boolean;
  // идёт анимированная ОТРИСОВКА стрелки после раскрытия/сворачивания (useLayoutAnimation):
  // линия рисуется штрихом от исходного хэндла к целевому (CSS lg-edge-drawin,
  // pathLength=1 + stroke-dashoffset), маркер-наконечник и плашка скрыты до конца
  // отрисовки. Флаг ставит и снимает оркестратор анимации по таймеру ANIM_DRAW_MS.
  drawIn?: boolean;
}

export interface NodeColors { bg: string; border: string; text: string }

// Колбэки «быстрой связи» (стрелка-кнопка у хэндла). enter — навели курсор на стрелку
// хэндла (side+frac), система подбирает цель и рисует превью; leave — увели курсор (превью
// гаснет); activate — клик по стрелке (создать предложенную связь через модалку). Стабильны
// (useCallback в LevelGraph) — кладём в data узлов, не пересобирая раскладку на каждый ховер.
export interface QuickConnectHandlers {
  enter: (sourceId: string, sourceHandle: string, side: EdgeSide, frac: number) => void;
  leave: () => void;
  activate: () => void;
}

export interface BlockData extends Record<string, unknown> {
  appNode: AppNode;
  onDrillDown: (node: AppNode) => void;
  isArchitect: boolean;
  colors: NodeColors;
  // в контекст-режиме у фокусного блока нет кнопок «Войти»/правки (схема — только просмотр)
  hideActions?: boolean;
  // можно ли НАЧАТЬ связь с хэндлов узла (архитектор, не контекст-режим) — раскрытие
  // хэндлов по ховеру для протягивания новой стрелки
  connectable?: boolean;
  // «быстрая связь» по стрелке-кнопке у хэндла (только когда connectable)
  quickConnect?: QuickConnectHandlers;
  // раскрыть содержимое ЛОКАЛЬНОГО контейнера инлайн (R5): лупа у сервиса с
  // детьми — узел заменяется рамкой со всеми детьми. undefined — кнопки нет.
  onExpand?: (id: string) => void;
}

export interface GhostData extends Record<string, unknown> {
  appNode: GhostNode;
  colors: NodeColors;
  connectable?: boolean;
  quickConnect?: QuickConnectHandlers;
  // войти к компонентам гостя: открыть его слой-схему (колбэк уже замкнут на путь
  // гостя). Задаётся только в основной схеме; undefined (контекст-режим) → кнопки нет.
  // Показ кнопки дополнительно гейтится appNode.has_children (атомарному некуда входить).
  onEnter?: () => void;
}

// Свёрнутый узел-контейнер соседней ветки (напр. ProdMon) — с кнопкой-лупой.
export interface ContainerData extends Record<string, unknown> {
  id: string;
  name: string;
  depth: number;
  ancestors: AncestorRef[];
  colors: NodeColors;
  onExpand: (id: string) => void;
  // войти к компонентам контейнера: открыть его слой-схему (колбэк замкнут на его
  // путь). Контейнер всегда промежуточный (содержит спроецированного гостя), поэтому
  // кнопка показывается всегда, когда задан колбэк. undefined (контекст) → кнопки нет.
  onEnter?: () => void;
  connectable?: boolean;
  quickConnect?: QuickConnectHandlers;
}

// РАСКРЫТАЯ гостевая рамка как настоящий RF-узел (R4, compound): реальный rect
// (позиция+размер из раскладки), дети сидят внутри через parentId с координатами
// в системе рамки. Родные (breadcrumb) рамки остаются оверлеем LevelBoundary —
// им нужен живой bbox-follow, а не фиксированный rect.
export interface FrameData extends Record<string, unknown> {
  name: string;
  // свернуть контейнер (клик по подписи «🔍 name ✕») — undefined в read-only
  onCollapse?: () => void;
}

export type BlockRFNode = RFNode<BlockData, "block">;
export type GhostRFNode = RFNode<GhostData, "ghost">;
export type ContainerRFNode = RFNode<ContainerData, "container">;
export type FrameRFNode = RFNode<FrameData, "frame">;

// --- Проекция гостей с учётом свёрнутых контейнеров ---

export interface DisplayContainer { kind: "container"; id: string; name: string; depth: number; ancestors: AncestorRef[]; is_external: boolean; }
export interface DisplayLeaf { kind: "leaf"; id: string; ghost: GhostNode; }
export type DisplayExternal = DisplayContainer | DisplayLeaf;
