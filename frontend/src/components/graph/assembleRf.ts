// Сборка RF-узлов/рёбер из результата раскладки (вынесена из эффекта LevelGraph
// при распиле Ф2 аудита 2026-07-09). ЧИСТАЯ функция: layout → массивы для
// setRfNodes/setRfEdges. Колбэки приходят ЧИТАЛКОЙ latest-ref (getCb), а
// обработчики в data зовут getCb() В МОМЕНТ КЛИКА, не при сборке: собранный
// объект может жить дольше одного прогона (скип идентичных применений Ф1,
// реконсиляция Ф2), и снимок колбэков в замыкании протухал бы — клик по старому
// объекту шёл бы через старый commitLayout (merge против устаревшего viewLayout).
import { MarkerType, type Node as RFNode, type Edge as RFEdge } from "@xyflow/react";
import type { Node as AppNode, NodeStatus, AncestorRef } from "../../types";
import { canHaveChildren } from "../../types";
import { MAX_INLINE_DEPTH } from "./constants";
import type {
  WrappedEdgeData, BlockData, GhostData, ContainerData, FrameData, QuickConnectHandlers,
} from "./types";
import { edgeText } from "./text";
import { getNodeColors, STATUS_META } from "./colors";
import { viewShows, type SchemaView } from "../schemaView";
import type { LayoutResult } from "./layout/pipeline";
import { parentFrameOf, deepestFrameContaining } from "./layout/frames";

// Стиль приглушения узла, скрытого фильтром «Вид схемы» (мгновенно, без transition —
// см. ТЗ: fade на opacity в наших прогонах вёл себя нестабильно).
const DIM_STYLE = { opacity: 0.12, pointerEvents: "none" as const };

// Снимок колбэков узлов/рёбер (latest-ref cbRef в LevelGraph).
export interface AssembleCallbacks {
  drillWithPath: (n: AppNode) => void;
  onEnterNode?: (path: AncestorRef[]) => void;
  expandContainer: (id: string) => void;
  expandLocalContainer: (id: string) => void;
  collapseContainer: (id: string) => void;
  openEdgeMembers: (memberIds: string[]) => void;
  quickConnect: QuickConnectHandlers;
}

export function assembleRfGraph(params: {
  layout: LayoutResult;
  isArchitect: boolean;
  // read-only блок (встроенные схемы на страницах): без структурной правки —
  // хэндлы/быстрая связь скрыты (лупа и просмотрные механики остаются).
  isReadOnly: boolean;
  // drill-навигация (кнопки «Войти» на узлах/гостях/контейнерах): редактор
  // передаёт onEnterNode, страница объекта — нет (там навигация двойным кликом
  // на страницу объекта + лупа). Гейтит все кнопки «Войти».
  drillNav: boolean;
  // read-only (страница): число РЕЛЕВАНТНЫХ детей по id узла (X16 v2: ребёнок
  // видим, только если у его поддерева есть граничное ребро на схеме). Гейтит
  // лупу и бейдж локалов; undefined (редактор) — все дети по child_count (Д3).
  relevantCounts?: Map<string, number>;
  depth: number;
  schemaView: SchemaView;
  getCb: () => AssembleCallbacks;
}): { nextNodes: RFNode[]; nextEdges: RFEdge[] } {
  const { layout, isArchitect, isReadOnly, drillNav, relevantCounts, depth, schemaView, getCb } = params;
  const {
    nodes: layoutNodes, entities, positions, edgeHandles,
    autoRoutes, labelPlacements, guestFrames, levelFrame, groupArr, spacers,
  } = layout;

  // R4: раскрытые гостевые рамки — compound-узлы RF. Родитель сущности — САМАЯ
  // ГЛУБОКАЯ рамка, содержащая её членом; родитель рамки — самая глубокая внешняя
  // рамка, накрывающая всех её членов. Дети получают position ОТНОСИТЕЛЬНО родителя.
  // Дерево рамок по членству — единые хелперы frames.ts.
  const frameOfEntity = (id: string) => deepestFrameContaining(guestFrames, id);
  const frameOfFrame = (f: (typeof guestFrames)[number]) => parentFrameOf(guestFrames, f);
  // Вложенность рамки ОТНОСИТЕЛЬНО УРОВНЯ (1 = верхняя раскрытая, 2 = раскрытая
  // внутри раскрытой, …) — длина цепочки объемлющих рамок. Именно она, а не
  // f.depth: depth рамок нумеруется вслед за breadcrumb, и на дриллнутых уровнях
  // верхняя рамка несёт depth = глубине уровня — прибавка depth+f.depth двоила бы
  // глубину и дети красились на ступень светлее положенного.
  const frameNesting = (f0: (typeof guestFrames)[number]): number => {
    let n = 0;
    for (let f: (typeof guestFrames)[number] | null = f0; f; f = frameOfFrame(f)) n++;
    return n;
  };
  // Статус каждой ОТОБРАЖАЕМОЙ сущности (для цвета рёбер и фильтра вида). Блок —
  // свой status; гость-лист — статус реального узла; свёрнутый контейнер статуса
  // не носит → existing. Ключ — id отображаемой сущности (как в g.source/g.target).
  const statusOf = new Map<string, NodeStatus>();
  for (const n of layoutNodes) statusOf.set(n.id, n.status);
  for (const ent of entities) {
    statusOf.set(ent.id, ent.kind === "leaf" ? ent.ghost.status : "existing");
  }
  // Самый «сильный» статус конца ребра: deprecated > planned > existing.
  const edgeStatus = (s: string, t: string): NodeStatus => {
    const a = statusOf.get(s) ?? "existing";
    const b = statusOf.get(t) ?? "existing";
    if (a === "deprecated" || b === "deprecated") return "deprecated";
    if (a === "planned" || b === "planned") return "planned";
    return "existing";
  };
  // Приглушён ли узел статуса st фильтром вида. Скрытый узел НЕ удаляем — гасим
  // opacity, сохраняя пространственную память раскладки.
  const dimNode = (st: NodeStatus): boolean => !viewShows(schemaView, st);

  const nextNodes: RFNode[] = [
    // Якорь родной рамки уровня: невидимый прямоугольник ровно по её rect, несущий
    // только точки стыковки. Нужен, чтобы RF было к чему пристыковать связь, чей конец —
    // сам контейнер уровня; рисует рамку по-прежнему оверлей LevelBoundary (ему нужен
    // живой bbox-follow за драгом, а фиксированный rect его бы потерял).
    ...(levelFrame
      ? [{
          id: levelFrame.id,
          type: "framedock" as const,
          position: { x: levelFrame.rect.x, y: levelFrame.rect.y },
          width: levelFrame.rect.w,
          height: levelFrame.rect.h,
          draggable: false,
          selectable: false,
          zIndex: -2, // под рамками раскрытий и под узлами
          data: {},
        }]
      : []),
    // Рамки — первыми (RF требует родителя в массиве раньше детей; guestFrames
    // отсортированы по depth, поэтому и вложенные рамки идут после объемлющих).
    // Реальный rect из раскладки; тело прозрачно для мыши (см. FrameNode).
    ...guestFrames.map((f) => {
      const pf = frameOfFrame(f);
      // Рамки НЕ таскаются (запрет движения рамок, 2026-07-08): rect рамки всегда
      // производен от детей — двигаются только сами узлы.
      return {
        id: f.id,
        type: "frame" as const,
        position: pf
          ? { x: f.rect.x - pf.rect.x, y: f.rect.y - pf.rect.y }
          : { x: f.rect.x, y: f.rect.y },
        ...(pf ? { parentId: pf.id } : null),
        width: f.rect.w,
        height: f.rect.h,
        draggable: false,
        selectable: false,
        zIndex: -1, // под узлами (и под их рёбрами внутри рамки)
        data: {
          name: f.name,
          onCollapse: () => getCb().collapseContainer(f.id),
        } satisfies FrameData,
      };
    }),
    ...layoutNodes.map((n) => {
      const abs = positions.get(n.id) ?? { x: 0, y: 0 };
      // блок внутри раскрытого ЛОКАЛА (R5) — ребёнок compound-рамки
      const pf = frameOfEntity(n.id);
      const compound = pf
        ? { parentId: pf.id, position: { x: abs.x - pf.rect.x, y: abs.y - pf.rect.y } }
        : { position: abs };
      // Дети для бейджа/лупы: read-only (страница) — РЕЛЕВАНТНЫЕ (с границей
      // поддерева по рёбрам, X16 v2); редактор — все по child_count (Д3).
      const childCount = relevantCounts ? (relevantCounts.get(n.id) ?? 0) : n.child_count;
      return {
        id: n.id,
        type: "block" as const,
        ...compound,
        ...(dimNode(n.status) ? { style: DIM_STYLE } : null),
        data: {
          appNode: n,
          // «Войти» — только в редакторе (drillNav); на странице кнопки нет
          onDrillDown: drillNav ? (node) => getCb().drillWithPath(node) : undefined,
          isArchitect,
          // C4: дети раскрытых инлайн контейнеров светлее родительского уровня —
          // к глубине уровня прибавляется вложенность рамки относительно уровня
          colors: getNodeColors(n.is_external, depth + (pf ? frameNesting(pf) : 0), n.status),
          hideActions: false,
          connectable: isArchitect && !isReadOnly,
          // quickConnect — объект-снимок: он стабилен по построению (useMemo []
          // в LevelGraph, внутри только latest-ref'ы), лениво оборачивать нечего
          quickConnect: isArchitect && !isReadOnly ? getCb().quickConnect : undefined,
          // Раскрытие ЛОКАЛЬНОГО контейнера инлайн (R5): лупа у сервиса с детьми.
          // Работает и в read-only блоке (схема на странице) — это просмотр,
          // не правка; расстановка компонентов — только в карте. Глубже
          // MAX_INLINE_DEPTH слоёв от уровня лупы нет — только «Войти» (C8).
          // На странице лупа — только при РЕЛЕВАНТНЫХ детях (childCount, X16 v2):
          // узел без связанных детей ведёт себя как лист.
          onExpand: (relevantCounts ? childCount > 0 : n.has_children) && canHaveChildren(n.shape)
            && (pf ? frameNesting(pf) : 0) < MAX_INLINE_DEPTH
            ? (id) => getCb().expandLocalContainer(id)
            : undefined,
          badgeCount: childCount,
        } satisfies BlockData,
      };
    }),
    ...entities.map((ent) => {
      const abs = positions.get(ent.id) ?? { x: 0, y: 0 };
      // сущность внутри раскрытой рамки — ребёнок compound-узла (координаты рамки)
      const pf = frameOfEntity(ent.id);
      const compound = pf
        ? {
            parentId: pf.id,
            position: { x: abs.x - pf.rect.x, y: abs.y - pf.rect.y },
          }
        : { position: abs };
      if (ent.kind === "leaf") {
        return {
          id: ent.id,
          type: "ghost" as const,
          ...compound,
          ...(dimNode(ent.ghost.status) ? { style: DIM_STYLE } : null),
          data: {
            appNode: ent.ghost,
            colors: getNodeColors(ent.ghost.is_external, ent.ghost.node_depth, ent.ghost.status),
            connectable: isArchitect && !isReadOnly,
            quickConnect: isArchitect && !isReadOnly ? getCb().quickConnect : undefined,
            // Путь гостя = его предки + он сам (другая ветка дерева).
            // «Войти к компонентам» — только в редакторе (drillNav).
            onEnter: drillNav
              ? () => getCb().onEnterNode?.([...(ent.ghost.ancestors ?? []), { id: ent.ghost.id, name: ent.ghost.name, is_external: ent.ghost.is_external }])
              : undefined,
          } satisfies GhostData,
        };
      }
      return {
        id: ent.id,
        type: "container" as const,
        ...compound,
        data: {
          id: ent.id,
          name: ent.name,
          depth: ent.depth,
          ancestors: ent.ancestors,
          colors: getNodeColors(ent.is_external, ent.depth),
          // Лупа гостевого контейнера — как у локала, не глубже MAX_INLINE_DEPTH
          // слоёв от уровня (C8); на пределе глубины — только «Войти к компонентам».
          onExpand: (pf ? frameNesting(pf) : 0) < MAX_INLINE_DEPTH
            ? (id) => getCb().expandContainer(id)
            : undefined,
          // Путь контейнера = его предки + он сам. Контейнер всегда промежуточный.
          // «Войти к компонентам» — только в редакторе (drillNav).
          onEnter: drillNav
            ? () => getCb().onEnterNode?.([...ent.ancestors, { id: ent.id, name: ent.name, is_external: ent.is_external }])
            : undefined,
          connectable: isArchitect && !isReadOnly,
          quickConnect: isArchitect && !isReadOnly ? getCb().quickConnect : undefined,
        } satisfies ContainerData,
      };
    }),
    ...spacers,
  ];

  const nextEdges: RFEdge[] = groupArr.map((g) => {
    const h = edgeHandles.get(g.id);
    const isMaster = g.members.length > 1;
    const single = g.members[0];
    const singleText = [single.label, single.technology].filter(Boolean).join(" · ") || undefined;
    const data: WrappedEdgeData = isMaster
      ? { items: g.members.map((m) => edgeText(m)), memberIds: g.members.map((m) => m.id) }
      : { label: singleText, memberIds: [single.id] };
    // Признак архитекторского канваса: плейсхолдер-плашка «•••» у безымянных
    // связей (см. edges.tsx). Ручной правки геометрии стрелок больше нет.
    if (isArchitect) data.editable = true;
    // Триггер детализации связи на плашке с описанием.
    data.onOpenDetails = () => getCb().openEdgeMembers(data.memberIds);
    // Авто-маршрут (R1+R3): edges.tsx рисует его ортоломаной с минимумом пересечений.
    const ar = autoRoutes?.get(g.id);
    if (ar) data.autoRoute = ar;
    // Авто-размещение плашки (R2+R4): центр/якорь/режим. edges.tsx ставит плашку в
    // center, а в режиме leader рисует поводок center↔anchor.
    const lp = labelPlacements?.get(g.id);
    if (lp) data.labelPlacement = lp;
    // Цвет ребра по статусу сильнейшего конца; deprecated — пунктир («связь уходит»).
    const est = edgeStatus(g.source, g.target);
    const eColor = STATUS_META[est].edge;
    // Приглушаем ребро, если приглушён ЛЮБОЙ его конец (фильтр вида).
    const eDimmed = dimNode(statusOf.get(g.source) ?? "existing")
      || dimNode(statusOf.get(g.target) ?? "existing");
    if (eDimmed) data.dimmed = true;
    return {
      id: g.id,
      source: g.source,
      target: g.target,
      sourceHandle: h?.sourceHandle,
      targetHandle: h?.targetHandle,
      type: "wrapped",
      data,
      markerEnd: { type: MarkerType.ArrowClosed, color: eColor },
      style: {
        stroke: eColor,
        strokeWidth: 1.5,
        ...(est === "deprecated" ? { strokeDasharray: "6 4" } : null),
        ...(eDimmed ? { opacity: 0.12 } : null),
      },
      // реконнект концов умер вместе с ручным слоем стрелок (2026-07-09)
      reconnectable: false,
    };
  });

  return { nextNodes, nextEdges };
}
