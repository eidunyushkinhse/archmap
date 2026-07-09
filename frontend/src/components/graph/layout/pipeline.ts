// Конвейер раскладки вида (R1 эпика вид-центричного движка, C4_ENGINE_AUDIT.md).
//
// ЧИСТАЯ композиция всех стадий раскладки уровня/контекста: проекция гостей → ремап
// рёбер → слияние мастер-стрелок → позиции (ELK/контекст-звезда) → кольца гостей →
// разведение → keep-out → реконструкция изломов → раздвижка под плашки (A10) →
// глобальный роутер (A7/A8/A11) → плашки (A7.2) → детуры плашек (A12) → nudge (A13).
//
// Конвейер НЕ пишет в БД и не трогает React: побочные эффекты прежней async-раскладки
// (засев владения own-on-first-render, миграция якорей изломов) возвращаются наружу
// СПИСКОМ ИНТЕНТОВ — их применяет вызывающий (LevelGraph), если прогон не устарел.
// Так композиция стадий тестируется целиком, а класс багов «раскладка пишет в БД из
// середины рендера» закрыт по построению.
import type { Node as RFNode } from "@xyflow/react";
import type {
  Node as AppNode,
  GhostNode,
  Edge as AppEdge,
  LayoutEdge,
  EdgePoint,
  LevelPos,
  ViewLayout,
  AncestorRef,
} from "../../../types";
import { bundleKey } from "../../../types";
import type { DisplayExternal, EdgeGroup, EdgeShelf, EdgeLoop } from "../types";
import type { LiveHandleInputs } from "../interaction/useLiveDragHandles";
import { NODE_W, NODE_H, hid, EDGE_MANUAL_LAYOUT } from "../constants";
import { edgeText } from "../text";
import { liftEdgesToLevel } from "../projection";
import { projectGhosts } from "./projectGhosts";
import { layoutLevel, layoutContext } from "./engine";
import { assignEdgeHandles } from "./level";
import { placeGhostsOnRings, collectGhostSeeds } from "./ringPlacement";
import { reconstructOwnedWaypoints, type BundleWaypoints } from "./ownedWaypoints";
import { computeFrames, type FrameRect } from "./frames";
import { enforceFramesKeepOut, keepOutOfExpandedFrames } from "./keepGhostsOut";
import { separateOverlappingNodes } from "./separateNodes";
import { separateGuests } from "./separateGuests";
import { buildAutoRoutes } from "./autoRoutes";
import { nudgeChannels } from "./channelNudge";
import { buildLabelPlacements, type LabelPlacement } from "./labelLayout";
import { separateForLabels, type LabelEdge } from "./separateForLabels";
import { labelDetour } from "./labelDetours";
import { labelBoxSize } from "./labelBox";
import type { Rect } from "./overlapConstraints";

// Результат раскладки, который потребляет эффект сборки RF-узлов/рёбер в LevelGraph.
export type LayoutResult = {
  // снимок локальных узлов, по которому посчитана раскладка. Сборка RF-узлов читает
  // позиции/данные ИЗ НЕГО, а не из пропа nodes: иначе при смене nodes эффект сборки
  // успевал отработать со СТАРЫМ layout (позиции ещё прежние) до резолва async-ELK —
  // узел на кадр прыгал на исходную позицию. Снимок держит позиции и данные согласованными.
  nodes: AppNode[];
  entities: DisplayExternal[];
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
  edgeShelves?: Map<string, EdgeShelf>;
  edgeLoops?: Map<string, EdgeLoop>;
  // авто-маршруты глобального роутера (R1+R3): ортоломаная с минимумом пересечений и
  // обходом узлов. Считаются на раскладке для не-customized рёбер (level/main),
  // НЕ персистятся (производные от позиций). Сборка рёбер кладёт их в data.autoRoute.
  autoRoutes?: Map<string, EdgePoint[]>;
  // размещение плашек подписей (R2+R4): по группе — центр/якорь/режим (online|leader).
  // Считается по авто-маршрутам; сборка кладёт в data.labelPlacement.
  labelPlacements?: Map<string, LabelPlacement>;
  // изломы ПУЧКОВ, реконструированные в абсолют (владеемые якорем — anchor + офсет,
  // Ф3/D8; прочие — как пришли). Ключ — ключ пучка. Сборка читает путь отсюда.
  bundleWaypoints: Record<string, EdgePoint[]>;
  // РАСКРЫТЫЕ гостевые рамки на финальных позициях (R4): реальные rect'ы для
  // compound-узлов RF (id рамки = id раскрытого контейнера; дети — memberIds).
  // Отсортированы по depth (внешние первыми) — порядок вложенности parentId.
  // Родные (breadcrumb) рамки сюда не входят — их рисует оверлей LevelBoundary.
  guestFrames: FrameRect[];
  groupArr: EdgeGroup[];
  spacers: RFNode[];
};

// Побочные записи раскладки, вычисленные конвейером как ДАННЫЕ. Применяет вызывающий
// (через commitLayout — единый батч view_layout):
// - seed-positions — засев владения own-on-first-render (гость/контейнер без
//   сохранённой позиции получает текущую навсегда) и персист выдвинутых разведением
//   владеемых соседей (Ф4.4);
// - own-bundle-waypoints — приобретение якоря изломом пучка (абсолютный путь к потомку
//   раскрытой рамки → офсет от узла-якоря, Ф3/D8).
export type PersistIntent =
  | { kind: "seed-positions"; seeds: { id: string; x: number; y: number }[] }
  | {
      kind: "own-bundle-waypoints";
      migrations: { itemId: string; waypoints: EdgePoint[]; anchor: string }[];
    };

export interface PipelineInput {
  nodes: AppNode[];
  // реестр не-локальных концов рёбер (R2): и гости, и глубокие концы внутри
  // поддерева — все с цепочками предков. В контекст-режиме — соседи фокуса.
  endpoints: GhostNode[];
  // рёбра уровня СЫРЫЕ (реальные концы; проекция здесь) — в контекст-режиме
  // концы уже спроецированы сервером на фокус/соседей.
  edges: AppEdge[];
  containerId: string | null;
  // раскладка вида как есть (R3, единое хранилище): item_id → payload. Позиции —
  // по id сущности (локалы, гости, контейнеры единообразно), геометрия рёбер —
  // по ключу пучка "b:<src>><tgt>". В контекст-режиме — пустая (эфемерная звезда).
  viewLayout: ViewLayout;
  ancestorIds: string[];
  // раскрытые инлайн контейнеры: и гостевые, и ЛОКАЛЬНЫЕ (R5) — id уникальны
  expanded: Set<string>;
  // догруженные дети раскрытых ЛОКАЛЬНЫХ контейнеров (R5, Д3: показываются ВСЕ
  // дети): id контейнера → его прямые дети. Пока детей нет в карте — контейнер
  // рисуется свёрнутым (ленивая догрузка, LevelGraph качает по требованию).
  localChildren: Record<string, AppNode[]>;
  isContext: boolean;
  // РЕАЛЬНЫЕ габариты узлов из DOM (node.measured, V2.2b): узлы растут по контенту, и
  // стадии КАЧЕСТВА СТРЕЛОК (роутер/плашки/детуры) обязаны видеть настоящие тела —
  // иначе маршрут ложится «по грани»/поверх реального узла (канон libavoid: препятствия
  // = реальные shape bounds + буфер). Стадии РАСКЛАДКИ УЗЛОВ (кольца/VPSC/рамки/keep-out)
  // сознательно остаются на NODE_W×NODE_H: они двигают и персистят позиции, и завязка их
  // на замер рисковала бы петлёй пере-раскладки. Нет замера (первый прогон) — фолбэк.
  sizes?: Record<string, { w: number; h: number }>;
}

export interface PipelineOutput {
  layout: LayoutResult;
  // снимок входов для живого пересчёта хэндлов при драге (useLiveDragHandles) —
  // те же мастер-рёбра и узлы, по которым посчитан layout
  liveInputs: LiveHandleInputs;
  intents: PersistIntent[];
}

// Текст и число строк плашки подписи группы рёбер (мастер берёт самый длинный member,
// строк = число членов; одиночное ребро — «label · technology» в одну строку). Единый
// источник для оценки габаритов (labelBox) в раздвижке A10 и в размещении плашек.
export function edgeLabelMeta(g: EdgeGroup): { text: string; lines: number } | null {
  if (g.members.length > 1) {
    const longest = g.members.reduce((a, b) => (edgeText(b).length > edgeText(a).length ? b : a));
    return { text: edgeText(longest), lines: g.members.length };
  }
  const m = g.members[0];
  const t = [m.label, m.technology].filter(Boolean).join(" · ");
  return t ? { text: t, lines: 1 } : null;
}

/** Полный расчёт раскладки вида. Async из-за ELK; всё остальное синхронно и чисто. */
export async function computeViewLayout(input: PipelineInput): Promise<PipelineOutput> {
  const {
    nodes: rawNodes, endpoints, edges, containerId, viewLayout, ancestorIds,
    expanded, localChildren, isContext, sizes,
  } = input;
  const intents: PersistIntent[] = [];

  // Владеемые позиции вида (внутренний формат модулей раскладки: кольца/разведение/
  // keep-out/засев). Локалы, гости и контейнеры — единообразно из viewLayout.
  const ownedPositions: Record<string, LevelPos> = {};
  if (!isContext) {
    for (const [itemId, p] of Object.entries(viewLayout)) {
      if (p.x != null && p.y != null) ownedPositions[itemId] = { pos_x: p.x, pos_y: p.y };
    }
  }

  // РАСКРЫТИЕ ЛОКАЛЬНЫХ КОНТЕЙНЕРОВ (R5, Д3): раскрытый локал заменяется ВСЕМИ его
  // догруженными детьми, рекурсивно (вложенные раскрытия). Дети ещё не догружены →
  // узел остаётся свёрнутым. `nodes` дальше по конвейеру — ОТОБРАЖАЕМЫЕ локалы
  // (обычные + вышедшие из раскрытий); все прежние роли («локальный конец подъёма»,
  // ELK-узел, член родных рамок, block-рендер) переходят к ним естественно.
  // localFrames — цепочки контейнеров над вышедшими детьми (ниже уровня): по ним
  // computeFrames строит рамку раскрытого локала той же механикой, что и гостевые.
  const nodes: AppNode[] = [];
  const localFrames: { id: string; ancestors: AncestorRef[] }[] = [];
  // предки уровня как AncestorRef-лайт: для расчёта lca в computeFrames важны
  // только id (имена рамок уровня рисует ancestorNames — не отсюда)
  const bcRefs: AncestorRef[] = ancestorIds.map((id) => ({ id, name: id, is_external: false }));
  const expandLocal = (n: AppNode, path: AncestorRef[]) => {
    const kids = expanded.has(n.id) ? localChildren[n.id] : undefined;
    if (!isContext && kids && kids.length > 0) {
      const deeper = [...path, { id: n.id, name: n.name, is_external: n.is_external }];
      for (const k of kids) expandLocal(k, deeper);
      return;
    }
    nodes.push(n);
    if (path.length > 0) localFrames.push({ id: n.id, ancestors: [...bcRefs, ...path] });
  };
  for (const n of rawNodes) expandLocal(n, []);

  // ПРОЕКЦИЯ, половина 1 (R2): подъём концов сырых рёбер к ближайшему локальному
  // предку уровня; концы вне поддерева остаются гостями. Контекст пре-спроецирован
  // сервером (Д5) — там lift не нужен, реестр целиком трактуется как гости-соседи.
  // localIds — отображаемые локалы: конец внутри РАСКРЫТОГО контейнера поднимается
  // не к нему, а к его видимому потомку (симметрия со сворачиванием гостей).
  const { edges: liftedEdges, ghosts } = isContext
    ? { edges, ghosts: endpoints }
    : liftEdgesToLevel({ edges, endpoints, localIds: new Set(nodes.map((n) => n.id)), containerId });

  // ПРОЕКЦИЯ, половина 2: сворачиваем гостей к их верхним (неразвёрнутым) контейнерам
  const { entities, ghostToEffective, emergedFrom } = projectGhosts(ghosts, ancestorIds, expanded);
  const remap = (id: string) => ghostToEffective.get(id) ?? id;
  // Рёбра с концами, переадресованными на отображаемые сущности, ОБОГАЩЁННЫЕ
  // геометрией своего ПУЧКА (R3): хэндлы/label_t читаются из view_layout по ключу
  // пучка пары отображаемых концов — у каждой проекции своя строка, члены мастера
  // делят её по построению (прежний prefix-резолв и fan-out не нужны).
  const remappedEdges: LayoutEdge[] = liftedEdges.map((e) => {
    const source_id = remap(e.source_id);
    const target_id = remap(e.target_id);
    const b = viewLayout[bundleKey(source_id, target_id)];
    return {
      ...e,
      source_id,
      target_id,
      // фиче-тогл: с выключенным ручным слоем сохранённые хэндлы игнорируются —
      // раскладка назначает все хэндлы сама (label_t — подпись, не положение стрелки)
      source_handle: EDGE_MANUAL_LAYOUT ? (b?.source_handle ?? null) : null,
      target_handle: EDGE_MANUAL_LAYOUT ? (b?.target_handle ?? null) : null,
      label_t: b?.label_t ?? null,
    };
  });

  // В контекст-режиме раскладка эфемерная и единая — сохранённые координаты
  // (фокус двигали на своём уровне) тут из ДРУГОЙ системы координат и дали бы
  // наложение на соседей. Поэтому viewLayout там пуст: чистая авто-раскладка.
  // Позиция берётся по id ОТОБРАЖАЕМОЙ сущности (локал; лист-гость ИЛИ
  // предок-контейнер, в который гость свёрнут) — единый источник для всех.
  const allNodeInfos = [
    ...nodes.map((n) => ({ id: n.id })),
    ...entities.map((ent) => ({ id: ent.id })),
  ].map(({ id }) => {
    const saved = ownedPositions[id];
    return { id, savedPos: saved ? { x: saved.pos_x, y: saved.pos_y } : null };
  });

  const displayedIds = new Set<string>([...nodes.map((n) => n.id), ...entities.map((e) => e.id)]);

  // Слияние связей одного направления между парой отображаемых узлов в мастер-стрелку
  const groupArr: EdgeGroup[] = [];
  const groupMap = new Map<string, EdgeGroup>();
  for (const e of remappedEdges) {
    if (!displayedIds.has(e.source_id) || !displayedIds.has(e.target_id)) continue;
    let g = groupMap.get(`${e.source_id}>${e.target_id}`);
    if (!g) { g = { id: "", source: e.source_id, target: e.target_id, members: [] }; groupMap.set(`${e.source_id}>${e.target_id}`, g); groupArr.push(g); }
    g.members.push(e);
  }
  for (const g of groupArr) {
    g.id = g.members.length === 1 ? g.members[0].id : `merge:${g.source}->${g.target}`;
  }

  // Раскладку/хэндлы считаем на мастер-рёбрах (по одному на направление между парой).
  // Хэндлы у мастера общие для всех членов (одна линия) — берём у первого члена, у
  // которого они заданы (в remappedEdges хэндлы уже разрешены: колонка для локального
  // конца, гостевой по префиксу). Так пересчёт не сбрасывает хэндл мастера на авто.
  const layoutEdges: LayoutEdge[] = groupArr.map((g) => {
    if (g.members.length === 1) return g.members[0];
    const longest = g.members.reduce((a, b) => (edgeText(b).length > edgeText(a).length ? b : a));
    return {
      id: g.id, source_id: g.source, target_id: g.target,
      label: longest.label, technology: longest.technology,
      source_handle: g.members.find((m) => m.source_handle)?.source_handle ?? null,
      target_handle: g.members.find((m) => m.target_handle)?.target_handle ?? null,
      created_at: "",
    };
  });

  // Контекст — звезда: своя детерминированная frame-aware раскладка (фокус в центре,
  // соседи в две колонки, колонки за вылетом рамок фокуса). Обычный уровень — ELK.
  const ctxLayout =
    isContext && nodes[0]
      ? await layoutContext(
          nodes[0].id,
          NODE_H,
          entities,
          layoutEdges,
          ancestorIds,
          expanded,
        )
      : null;
  const baseLayout = ctxLayout ?? (await layoutLevel(allNodeInfos, layoutEdges));
  const positions = baseLayout.positions;
  let edgeHandles = baseLayout.edgeHandles;
  // полки подписей и обходы не родных стрелок считаются только в контекст-раскладке
  const edgeShelves = ctxLayout?.edgeShelves;
  const edgeLoops = ctxLayout?.edgeLoops;
  // изломы ПУЧКОВ, реконструированные в абсолют (владеемые якорем → anchor + офсет,
  // ТЗ D8). Заполняется в блоке выноса гостей; сборка читает путь отсюда (ключ пучка).
  const effectiveWaypoints: Record<string, EdgePoint[]> = {};

  // Дефолтная раскладка гостей на кольца запретных рамок (boundary labeling) —
  // вынесена в ringPlacement под юнит-тесты. МУТИРУЕТ positions
  // (ставит гостей на кольца); их стрелки дальше ведёт глобальный роутер.
  if (!isContext) {
    // Первый показ детей РАСКРЫТОГО ЛОКАЛА (R5, expand-in-place): свежие дети без
    // владеемой позиции раскладываются сеткой от сохранённой позиции контейнера —
    // ELK клал бы их в общий layered-поток, вырывая из места раскрытия. Если
    // контейнер позицией не владел (чисто авто-уровень) — остаются как легли.
    // Владеемые дети (повторное раскрытие) уже сели savedPos-ом. Засев ниже
    // зафиксирует сетку навсегда.
    {
      const freshByContainer = new Map<string, string[]>();
      for (const lf of localFrames) {
        if (ownedPositions[lf.id]) continue;
        const parent = lf.ancestors[lf.ancestors.length - 1]?.id;
        if (!parent) continue;
        (freshByContainer.get(parent) ?? freshByContainer.set(parent, []).get(parent)!).push(lf.id);
      }
      const GRID_GAP_X = 40;
      const GRID_GAP_Y = 40;
      for (const [cid, ids] of freshByContainer) {
        const base = ownedPositions[cid];
        if (!base) continue;
        const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
        ids.forEach((id, i) => {
          positions.set(id, {
            x: base.pos_x + (i % cols) * (NODE_W + GRID_GAP_X),
            y: base.pos_y + Math.floor(i / cols) * (NODE_H + GRID_GAP_Y),
          });
        });
      }
    }

    const og = placeGhostsOnRings({
      nodes, entities, ancestorIds, levelPositions: ownedPositions, layoutEdges, positions, expanded,
    });

    // РАЗВЕДЕНИЕ ГОСТЕЙ МЕЖДУ СОБОЙ (Ф4.3): при раскрытии вложенной гостевой рамки новичок
    // (его группа НЕ авто → кольцо его пропускает) садится поверх владеемых соседей.
    // separateGuests разводит их VPSC-проходом по дереву containment: раскрытая рамка
    // пиннится на месте старого узла (expand-in-place), соседи уступают, локалы неподвижны.
    // No-op, если новичков от вложенного раскрытия нет.
    // ВАЖНО — ДО enforce: пока новичок сидит на ELK-позиции в чужой СК, он раздувает свою
    // рамку, и enforce лишне выталкивает соседей под раздутую рамку. На следующем рендере
    // (после персиста) раскладка считается из чистых позиций → раскладка отличается =
    // видимое дёрганье на доли секунды. Сначала ставим новичка на место и разводим — тогда
    // enforce всегда видит финальные позиции, и оба рендера совпадают.
    const sg = separateGuests({
      nodes, entities, ancestorIds, levelPositions: ownedPositions, layoutEdges,
      positions, emergedFrom, placedOutside: og?.placedOutside ?? new Set<string>(),
    });

    // Страховочная сетка keep-out: кольца держат инвариант по построению, но ручные позиции
    // и рост рамки за ручным гостем ringPlacement не трогает — их добирает enforce. На
    // авто-гостях после ringPlacement он обязан быть no-op. Запускается всегда.
    const enf = enforceFramesKeepOut({
      nodes, entities, ancestorIds, layoutEdges, positions,
    });
    if (enf) edgeHandles = enf.edgeHandles;
    else if (sg) edgeHandles = sg.edgeHandles;
    else if (og) edgeHandles = og.edgeHandles;

    // ИНВАРИАНТ РАСКРЫТЫХ РАМОК (R5-фикс): узел, НЕ относящийся к раскрытой рамке
    // (локальной или гостевой), не лежит внутри неё — симметрия старого запрета
    // для родных рамок. Рамка при раскрытии пиннится, чужие уступают (MTV).
    // ИНВАРИАНТ УЗЛОВ: никакие два отображаемых узла не накладываются —
    // separateOverlappingNodes (взвешенное VPSC-разведение) в том же цикле.
    // Выталкивания могут нарушить родной keep-out → чередуем с повторным enforce
    // до чистоты. displayedIds включают и детей раскрытых рамок (они члены своих
    // рамок — из рамок двигаются группой, между собой разводятся поштучно).
    // Сдвиги ВЛАДЕЕМЫХ узлов копим — их персист (интентом ниже) делает развод
    // устойчивым, иначе каждый прогон разводил бы заново от наложенных строк.
    const movedOwnedByInvariants = new Set<string>();
    {
      const externalsRefs = [
        ...entities.map((e) => ({
          id: e.id,
          ancestors: e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors,
        })),
        ...localFrames,
      ];
      const allDisplayed = [...nodes.map((n) => n.id), ...entities.map((e) => e.id)];
      let anythingMoved = false;
      // Кэп раундов 10 (был 4): при раскрытии ВСЕХ контейнеров уровня рамок много,
      // каскад «вытолкнули → задели третью» не сходился за 4 — рамки оставались
      // наложенными друг на друга.
      for (let round = 0; round < 10; round++) {
        const expFrames = computeFrames({
          localIds: nodes.map((n) => n.id),
          externals: externalsRefs,
          pos: (id) => positions.get(id),
          ancestorIds,
          ancestorNames: ancestorIds,
        }).filter((f) => !f.native);
        const movedOut = keepOutOfExpandedFrames({
          displayedIds: allDisplayed,
          frames: expFrames,
          positions,
        });
        const movedSep = separateOverlappingNodes({
          ids: allDisplayed,
          positions,
          ownedPositions,
        });
        // персистим только ЗАМЕТНЫЕ сдвиги владеемых (>1px от строки): микро-
        // коррекции инвариантов не должны «ползти» в БД и перезапускать раскладку
        const notablyMovedOwned = (id: string): boolean => {
          const o = ownedPositions[id];
          if (!o) return false;
          const p = positions.get(id);
          return !!p && (Math.abs(p.x - o.pos_x) > 1 || Math.abs(p.y - o.pos_y) > 1);
        };
        for (const id of movedOut) if (notablyMovedOwned(id)) movedOwnedByInvariants.add(id);
        for (const id of movedSep) if (notablyMovedOwned(id)) movedOwnedByInvariants.add(id);
        // ничего не двинулось — оба инварианта чисты, выходим; иначе ещё раунд:
        // развод внутри рамки растягивает её bbox, и чужих выталкивает уже
        // СЛЕДУЮЩИЙ пересчёт expFrames
        if (movedOut.size === 0 && movedSep.size === 0) break;
        anythingMoved = true;
        // сдвиги могли нарушить родной keep-out — восстановить его немедленно
        const reEnf = enforceFramesKeepOut({ nodes, entities, ancestorIds, layoutEdges, positions });
        if (reEnf) edgeHandles = reEnf.edgeHandles;
      }
      if (anythingMoved) {
        const displayed = [...nodes.map((n) => ({ id: n.id })), ...entities.map((e) => ({ id: e.id }))];
        edgeHandles = assignEdgeHandles(displayed, layoutEdges, positions);
      }
    }

    // ЗАСЕВ ВЛАДЕНИЯ (own-on-first-render): каждый гость без сохранённой позиции получает
    // её навсегда — на финальных позициях (после колец + enforce + разведения). Покрывает
    // и авто-гостей (кольцо), и новичков от вложенного раскрытия (их разведённую позицию),
    // и детей раскрытых ЛОКАЛОВ (R5: сетку первого показа — иначе прыгали бы на ELK).
    // Здесь — только ИНТЕНТ; применяет вызывающий (архитектор, основной канвас, прогон не
    // устарел). Зеркало кладёт позицию в viewLayout → следующий прогон видит сохранённую,
    // и засев её пропускает.
    const seeds = collectGhostSeeds(
      [...entities, ...localFrames],
      ownedPositions,
      (id) => positions.get(id),
    );
    if (seeds.length > 0) {
      intents.push({
        kind: "seed-positions",
        seeds: seeds.map((s) => ({ id: s.id, x: s.pos_x, y: s.pos_y })),
      });
    }

    // Ф4.4: персист СДВИНУТЫХ ВЛАДЕЕМЫХ. У них уже есть строка позиции, поэтому
    // collectGhostSeeds их пропускает — без персиста новая позиция откатилась бы на
    // следующем рендере (savedPos из БД) и развод повторялся бы заново каждый прогон.
    // Копятся сдвиги из разведения гостей (sg) И из цикла инвариантов (keep-out
    // раскрытых рамок + разведение наложенных узлов).
    {
      const pushedIds = new Set<string>(movedOwnedByInvariants);
      if (sg) for (const id of sg.moved) if (ownedPositions[id]) pushedIds.add(id);
      const pushed = [...pushedIds].map((id) => {
        const p = positions.get(id)!;
        return { id, x: p.x, y: p.y };
      });
      if (pushed.length > 0) intents.push({ kind: "seed-positions", seeds: pushed });
    }

    // Реконструкция изломов ПУЧКОВ к детям раскрытых рамок (ТЗ D8, рев. B / R3):
    // путь привязан к СОБСТВЕННОЙ позиции конца — абсолют = офсет + позиция якоря.
    // Позиции здесь уже финальные (после колец + enforce + сдвига коробки), поэтому
    // излом едет ровно с ребёнком. Легаси/свежий абсолют к потомку раскрытой рамки
    // лениво мигрируем в офсет (интентом own-bundle-waypoints).
    const expandedChildIds = new Set<string>();
    for (const ent of entities) {
      const anc = ent.kind === "leaf" ? (ent.ghost.ancestors ?? []) : ent.ancestors;
      if (anc.some((a) => expanded.has(a.id))) expandedChildIds.add(ent.id);
    }
    // изломы пучков отображаемых пар — из viewLayout по ключу пучка.
    // Фиче-тогл: с выключенным ручным слоем сохранённые изломы не читаются вовсе —
    // effectiveWaypoints пуст, все рёбра идут в авто-роутер (данные в БД живы).
    const bundleWp: Record<string, BundleWaypoints> = {};
    if (EDGE_MANUAL_LAYOUT) for (const g of groupArr) {
      const key = bundleKey(g.source, g.target);
      const b = viewLayout[key];
      if (b?.waypoints && b.waypoints.length > 0) {
        bundleWp[key] = { source: g.source, target: g.target, waypoints: b.waypoints, anchor: b.anchor ?? null };
      }
    }
    const { effective: ownedWp, migrations: wpMigrations } = reconstructOwnedWaypoints({
      bundles: bundleWp, pos: (id) => positions.get(id), expandedChildIds,
    });
    Object.assign(effectiveWaypoints, ownedWp);
    if (wpMigrations.length > 0) intents.push({ kind: "own-bundle-waypoints", migrations: wpMigrations });
  }

  // Раздвижка узлов под плашку короткого ребра (эпик стрелок A10, R2). Связь между
  // СОСЕДНИМИ узлами бывает короче своей плашки — инлайн она не лезет и отскакивает
  // мимо стрелки/под узел (BUG B из A9.0). Раздвигаем концы такого ребра по доминантной
  // оси, чтобы плечо стало длиннее текста. КРИТ (own-on-first-render): двигаем ТОЛЬКО
  // свежие ELK-локалы (нет в levelPositions, никем не присвоены, конвейером не
  // персистятся) — владеемые позиции (локал из levelPositions, ЛЮБОЙ гость: его место
  // персистит засев выше, сдвиг разъехался бы с сохранённым → дёрганье) прибиты намертво.
  // На финальных позициях (кольца+enforce+разведение), ДО routeAll/плашек — раздвинули,
  // и маршрут с плашкой лягут инлайн. Оба конца прибиты → ребро не трогаем (останется
  // leader). Мутируем positions на месте — downstream-роутер видит новые места.
  if (!isContext) {
    const SEP_MARGIN = 8; // клиренс вдоль плеча с каждой стороны плашки
    const SEP_PAD = 12;   // зазор при каскадной зачистке наложений (как separateGuests)
    const displayIds = [...nodes.map((n) => n.id), ...entities.map((e) => e.id)];
    const localIds = new Set(nodes.map((n) => n.id)); // владение double-check: только локалы двигаем
    const idxOf = new Map<string, number>();
    const rects: Rect[] = [];
    const weights: number[] = [];
    for (const id of displayIds) {
      const p = positions.get(id);
      if (!p) continue;
      idxOf.set(id, rects.length);
      rects.push({ minX: p.x, minY: p.y, maxX: p.x + NODE_W, maxY: p.y + NODE_H });
      const movable = localIds.has(id) && !ownedPositions[id];
      weights.push(movable ? 1 : Infinity);
    }
    // Сколько рёбер на каждой НЕУПОРЯДОЧЕННОЙ паре узлов — встречную/много-рёберную пару
    // раздвигать бессмысленно: их плечи совпадают (R4), инлайн на прямом коридоре всё равно
    // запрещён → за это отвечают рельсы (A11) и детур (A12), а не раздвижка. Иначе A10 зря
    // выселял бы узел (см. дамп A10.2: ObsCore уезжал, плашка всё равно leader).
    const pairCount = new Map<string, number>();
    for (const g of groupArr) {
      const k = g.source < g.target ? `${g.source}|${g.target}` : `${g.target}|${g.source}`;
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    }
    const labelEdges: LabelEdge[] = [];
    for (const g of groupArr) {
      const pk = g.source < g.target ? `${g.source}|${g.target}` : `${g.target}|${g.source}`;
      if ((pairCount.get(pk) ?? 0) > 1) continue; // встречная/много-рёберная пара → не раздвигаем
      const si = idxOf.get(g.source);
      const ti = idxOf.get(g.target);
      if (si == null || ti == null) continue;
      // оба конца прибиты — раздвинуть нечем без нарушения ownership, оставляем leader
      if (weights[si] === Infinity && weights[ti] === Infinity) continue;
      // ручной путь (waypoints) → ребро не авто-маршрутизируем (тот же слой, что роутер ниже)
      if ((effectiveWaypoints[bundleKey(g.source, g.target)]?.length ?? 0) > 0) continue;
      const meta = edgeLabelMeta(g);
      if (!meta) continue;
      const box = labelBoxSize(meta.text, { lines: meta.lines });
      // голодное ли ребро: инлайн-зазор по доминантной оси короче плашки + 2·margin?
      const s = rects[si];
      const t = rects[ti];
      const dx = Math.abs((s.minX + s.maxX - t.minX - t.maxX) / 2);
      const dy = Math.abs((s.minY + s.maxY - t.minY - t.maxY) / 2);
      const axisX = dx >= dy;
      const gap = axisX
        ? dx - (s.maxX - s.minX + t.maxX - t.minX) / 2
        : dy - (s.maxY - s.minY + t.maxY - t.minY) / 2;
      const need = (axisX ? box.w : box.h) + 2 * SEP_MARGIN;
      if (gap >= need) continue; // места хватает — не раздвигаем
      labelEdges.push({ source: si, target: ti, box });
    }
    if (labelEdges.length > 0) {
      const widened = separateForLabels(rects, weights, labelEdges, { pad: SEP_PAD, margin: SEP_MARGIN });
      // пишем новые позиции только подвижным узлам (прибитые VPSC не двигает — но не
      // трогаем их координаты вовсе, чтобы исключить дрейф владеемых позиций).
      for (const [id, i] of idxOf) {
        if (weights[i] === Infinity) continue;
        const p = positions.get(id)!;
        positions.set(id, { ...p, x: widened[i].minX, y: widened[i].minY });
      }
    }
  }

  // Авто-маршруты (эпик стрелок A7.1, R1+R3): глобальный роутер на раскладке для рёбер
  // level/main-схемы, которые пользователь НЕ правил вручную (waypoints).
  // Контекст-схему не трогаем (R2/R4 решены в её собственной модели).
  let autoRoutes: Map<string, EdgePoint[]> | undefined;
  let labelPlacements: Map<string, LabelPlacement> | undefined;
  if (!isContext) {
    const displayIds = [...nodes.map((n) => n.id), ...entities.map((e) => e.id)];
    // реальные габариты для стадий качества стрелок (роутер/плашки/детуры)
    const sizeMap = new Map<string, { w: number; h: number }>(
      sizes ? Object.entries(sizes) : [],
    );
    const realRectOf = (id: string): { x: number; y: number; w: number; h: number } | null => {
      const p = positions.get(id);
      if (!p) return null;
      const s = sizeMap.get(id);
      return { x: p.x, y: p.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H };
    };

    // ВАЛИДНОСТЬ ручного пути (V2.2b, канон libavoid/yFiles: ручной маршрут, ставший
    // невалидным после сдвигов/пере-раскладок, пере-маршрутизируется). Сохранённые изломы
    // могли устареть: путь по ним режет ТЕЛА узлов (жалоба «Сбор метрик JMX/SNMP лежат на
    // HTTP-объектах»). Такой путь для ЭТОГО прогона игнорируем — ребро уходит в авто-роутер.
    // Данные НЕ удаляем (недеструктивно): подвинет узлы обратно — ручной путь оживёт.
    {
      const bodies = displayIds
        .map((id) => ({ id, r: realRectOf(id) }))
        .filter((b): b is { id: string; r: NonNullable<ReturnType<typeof realRectOf>> } => b.r != null);
      const inBody = (p: EdgePoint, r: { x: number; y: number; w: number; h: number }): boolean =>
        p.x > r.x + 2 && p.x < r.x + r.w - 2 && p.y > r.y + 2 && p.y < r.y + r.h - 2;
      // Пенетрация bbox сегмента в тело: точен для осевых сегментов, консервативен для
      // диагональных (pathCrossesRects диагонали не понимает — мимо него и жили пути-зомби).
      const segCutsBody = (p1: EdgePoint, p2: EdgePoint, r: { x: number; y: number; w: number; h: number }): boolean =>
        Math.min(p1.x, p2.x) < r.x + r.w - 2 && Math.max(p1.x, p2.x) > r.x + 2 &&
        Math.min(p1.y, p2.y) < r.y + r.h - 2 && Math.max(p1.y, p2.y) > r.y + 2;
      for (const g of groupArr) {
        const key = bundleKey(g.source, g.target);
        const wp = effectiveWaypoints[key];
        if (!wp || wp.length === 0) continue;
        const foreign = bodies.filter((b) => b.id !== g.source && b.id !== g.target);
        const invalid =
          // соседние изломы по диагонали: в ортогональной модели не бывает — данные
          // из прошлой координатной эпохи (рендер рисовал бы диагональ поверх узлов)
          wp.slice(1).some((p, i) => Math.abs(p.x - wp[i].x) > 1 && Math.abs(p.y - wp[i].y) > 1) ||
          wp.some((p) => foreign.some((b) => inBody(p, b.r))) ||
          wp.slice(1).some((p, i) => foreign.some((b) => segCutsBody(wp[i], p, b.r)));
        if (invalid) delete effectiveWaypoints[key];
      }
    }

    const routableIds = new Set<string>();
    // pairableIds — рёбра уровня, участвующие в раскладке (авто + ручные-waypoints). По ним
    // ищем встречные рельс-пары (A12.5): рельса соседа не должна зависеть от того, ручное это
    // ребро или авто — иначе правка изломов одного рушит маршрут встречного («двигаю одно —
    // смещается другое»). См. railAssignments.
    const pairableIds = new Set<string>();
    const lockedIds = new Set<string>(); // routable, но сторону зафиксировал пользователь
    for (const g of groupArr) {
      if (!positions.get(g.source) || !positions.get(g.target)) continue;
      pairableIds.add(g.id); // участвует в раскладке уровня (до фильтра ручного пути)
      // Ручной ПУТЬ (waypoints) → ребро целиком ручное, не авто-маршрутизируем (приоритет).
      // Источник РОВНО тот же, что рисует edges.tsx: изломы пучка по ключу пары (R3).
      if ((effectiveWaypoints[bundleKey(g.source, g.target)]?.length ?? 0) > 0) continue;
      routableIds.add(g.id);
      // Ручной ХЭНДЛ без ручного пути → сторону уважаем (lockedIds), но путь к ней роутер
      // всё равно строит. Так смена хэндла одного ребра не выкидывает его из набора и не
      // пере-раскладывает остальные авто-маршруты (стабильность, A7.4).
      const bh = viewLayout[bundleKey(g.source, g.target)];
      if (EDGE_MANUAL_LAYOUT && (bh?.source_handle != null || bh?.target_handle != null)) lockedIds.add(g.id);
    }
    // Раскрытые рамки для роутера (V2.4, container-aware): граница рамки — штраф за
    // переход (чужие рёбра обходят, внутренние не выскакивают, ребро внутрь платит один
    // переход — «ворота» выбирает A*), плашка подписи — жёсткое препятствие. Позиции
    // здесь финальные — rect тот же, что у compound-рамок сборки.
    const routerFrames = computeFrames({
      localIds: nodes.map((n) => n.id),
      externals: [
        ...entities.map((e) => ({
          id: e.id,
          ancestors: e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors,
        })),
        ...localFrames,
      ],
      pos: (id) => positions.get(id),
      ancestorIds,
      ancestorNames: ancestorIds,
    })
      .filter((f) => !f.native)
      .map((f) => ({
        rect: f.rect,
        // плашка подписи: слева-внизу рамки (nodes.tsx FrameNode), ширина — моноширинная
        // оценка «🔍 имя ✕» с паддингами
        plaque: {
          x: f.rect.x + 10,
          y: f.rect.y + f.rect.h - 30,
          w: Math.min(f.rect.w - 20, 56 + 6.5 * f.name.length),
          h: 22,
        },
        memberIds: f.memberIds,
      }));
    const ar = buildAutoRoutes({ groups: groupArr, routableIds, pairableIds, lockedIds, positions, edgeHandles, displayIds, sizes: sizeMap, frames: routerFrames });
    autoRoutes = ar.routes;
    // A8: выбранные роутером стороны → хэндлы (RF состыкует стрелку там). Только свободные
    // рёбра (у locked хэндл уже стоит, buildAutoRoutes их в ar.handles не кладёт).
    for (const [id, hh] of ar.handles) edgeHandles.set(id, hh);

    // Плашки подписей (эпик стрелок A7.2, R2+R4): по авто-маршрутам размещаем плашки без
    // взаимных наложений и не под узлами (R2), запрещая их на совпавших плечах (R4); где
    // на линии чисто не встаёт — выноска-leader (A7.3). Только для авто-маршрутов; рёбра с
    // ручным путём сохраняют прежнее поведение подписи (центр/label_t).
    const nodeRects = displayIds
      .map(realRectOf)
      .filter((r): r is { x: number; y: number; w: number; h: number } => r != null);
    labelPlacements = buildLabelPlacements({
      routes: autoRoutes,
      groups: groupArr,
      labelMeta: edgeLabelMeta,
      preferredT: (g) => g.members.find((m) => m.label_t != null)?.label_t ?? undefined,
      nodeRects,
    });

    // Альт-маршрут грузного ребра (эпик стрелок A12, ПОСЛЕДНЕЕ средство): если плашка ушла в
    // leader (инлайн не влез даже после рельсов/раздвижки), уводим ЭТО ребро по минимальному
    // детуру в чистую полосу рядом с рядом узлов, где плашка ложится инлайн. Двигаем только
    // маршрут (own-on-first-render цел). Детур детерминирован (lane из габаритов этого ребра),
    // не учитывает чужие пересечения (как A7.4-residual). После детуров — ОДИН пере-проход
    // плашек на обновлённых маршрутах (пересчитает coincidentLegs и вернёт напарника по
    // рельсе к центру). Только авто-рёбра, не locked; кэп длины → иначе остаётся leader.
    const detourPreferred = new Map<string, number>();
    const rectOf = realRectOf;
    // кандидаты на детур — leader-рёбра (плашка не влезла), только свободные авто-рёбра
    const detourCands: Array<{ g: EdgeGroup; box: ReturnType<typeof labelBoxSize> }> = [];
    for (const g of groupArr) {
      if (labelPlacements.get(g.id)?.mode !== "leader") continue;
      if (!routableIds.has(g.id) || lockedIds.has(g.id)) continue;
      const meta = edgeLabelMeta(g);
      if (!meta) continue;
      detourCands.push({ g, box: labelBoxSize(meta.text, { lines: meta.lines }) });
    }
    // КООРДИНАЦИЯ СТЕКА: несколько leader-рёбер (напр. встречная пара) уходят в детур в одну
    // сторону (часто вниз, если сверху другие узлы) — их плашки наложились бы (на дампе A12 так и
    // вышло: 1-строчная на y=389 перекрыла место 5-строчной → та осталась leader). Копим уже
    // размещённые плашки-детуры как доп.препятствия и идём от НИЗКИХ боксов к ВЫСОКИМ: высокая
    // ляжет на lane НИЖЕ чужой, без наложения (кэп длины ограничит стек → совсем глубокий бокс
    // останется leader). Плашка-препятствие двигает lane глубже и не даёт маршруту её пересечь.
    const placedLabelRects: { x: number; y: number; w: number; h: number }[] = [];
    detourCands.sort((a, b) => a.box.h - b.box.h);
    // РАЗВОДКА ХЭНДЛОВ ВСТРЕЧНОЙ ПАРЫ НА ДЕТУРЕ (A12.4): если оба ребра двунаправленной пары
    // ушли в детур в одну сторону, по умолчанию они вышли бы из ОДНОГО хэндла (центр, idx=1) и
    // наложились бы плечами. Раскладка — вложенные «П»: грузное ребро (плашка выше, идёт ГЛУБЖЕ)
    // ведём по ВНЕШНИМ слотам стороны → его «П» шире и охватывает плашку напарника, не пересекая
    // её; напарник остаётся в центре (idx=1, прежнее место). Внешний слот — по геометрии узла:
    // на горизонтальном плече левый узел→слот 0, правый→слот 2 (на вертикальном верхний→0,
    // нижний→2). Так разводятся и хэндлы, и плечи, и нет наложения плашек.
    const detourSlot = new Map<string, { sIdx: number; tIdx: number }>();
    for (const { g, box } of detourCands) {
      const partner = detourCands.find((c) => c.g.source === g.target && c.g.target === g.source);
      if (!partner) continue;
      // глубже ляжет более грузное ребро (выше плашка; при равенстве — больший id)
      const deeper = box.h > partner.box.h || (box.h === partner.box.h && g.id > partner.g.id);
      if (!deeper) continue; // напарник остаётся в центре (слот 1/1 по умолчанию)
      const sp = positions.get(g.source), tp = positions.get(g.target);
      if (!sp || !tp) continue;
      const horiz = Math.abs(tp.x - sp.x) >= Math.abs(tp.y - sp.y);
      const sIdx = horiz ? (sp.x <= tp.x ? 0 : 2) : (sp.y <= tp.y ? 0 : 2);
      const tIdx = horiz ? (tp.x < sp.x ? 0 : 2) : (tp.y < sp.y ? 0 : 2);
      detourSlot.set(g.id, { sIdx, tIdx });
    }
    for (const { g, box } of detourCands) {
      const source = rectOf(g.source), target = rectOf(g.target);
      if (!source || !target) continue;
      const obstacles = [
        ...displayIds
          .filter((id) => id !== g.source && id !== g.target)
          .map(rectOf)
          .filter((r): r is { x: number; y: number; w: number; h: number } => r != null),
        ...placedLabelRects,
      ];
      const slot = detourSlot.get(g.id) ?? { sIdx: 1, tIdx: 1 };
      const det = labelDetour({
        source, target, obstacles, box, margin: 8, maxExtraLen: 2 * NODE_H + box.h + 16,
        sIdx: slot.sIdx, tIdx: slot.tIdx,
      });
      if (!det) continue;
      autoRoutes.set(g.id, det.route);
      edgeHandles.set(g.id, { sourceHandle: hid(g.source, det.sSide, slot.sIdx), targetHandle: hid(g.target, det.tSide, slot.tIdx) });
      detourPreferred.set(g.id, det.preferredT);
      // оценочный прямоугольник лёгшей плашки — препятствие для последующих (более высоких)
      placedLabelRects.push({ x: det.center.x - box.w / 2, y: det.center.y - box.h / 2, w: box.w, h: box.h });
    }
    // после детуров плашки НЕ пере-считываем: между детурами и каналом размещения никто
    // не читает, финальная геометрия ещё изменится — один проход в конце (V2.5)
    let labelsStale = detourPreferred.size > 0;

    // КАНАЛЬНЫЙ NUDGING (V2.3, замена точечного A13): все коллинеарно наложенные плечи из
    // РАЗНЫХ хэндлов собираются в «каналы», упорядочиваются по подходам маршрутов и
    // разводятся равными зазорами вокруг исходной линии (канон GD'09 ordered nudging).
    // Стволы из ОДНОГО хэндла остаются слитыми (Т4). Рельсы встречных пар (A11) остаются —
    // это раздача ПОРТОВ, каналу порты двигать нельзя. Чистый пост-проход на финальных
    // маршрутах.
    if (autoRoutes) {
      const nu = nudgeChannels({ routes: autoRoutes, handles: edgeHandles, obstacles: nodeRects });
      if (nu.nudged.size > 0) {
        autoRoutes = nu.routes;
        labelsStale = true;
      }
    }

    // ПЛАШКИ — ОДИН ФИНАЛЬНЫЙ ПРОХОД (V2.5): если детуры/канал меняли геометрию, размещение
    // пересчитывается один раз по ФИНАЛЬНЫМ маршрутам (раньше — после каждой стадии, до
    // трёх полных проходов; первый проход выше остаётся — по нему детуры находят leader-ов).
    if (labelsStale) {
      labelPlacements = buildLabelPlacements({
        routes: autoRoutes,
        groups: groupArr,
        labelMeta: edgeLabelMeta,
        preferredT: (g) => detourPreferred.get(g.id) ?? g.members.find((m) => m.label_t != null)?.label_t ?? undefined,
        nodeRects,
      });
    }
  }

  // Распорки: обходы не родных стрелок выходят за bbox узлов → крайними точками
  // контента (loopX/clearY обходов + запас под полку с подписью) расширяем область,
  // которую увидит fitView. Только контекст и только если есть обходы.
  const spacers: RFNode[] = [];
  if (isContext && edgeLoops && edgeLoops.size > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    }
    const PAD = 130; // запас под дальнюю полку/подпись не родной стрелки
    for (const lp of edgeLoops.values()) {
      minX = Math.min(minX, lp.loopX - PAD); maxX = Math.max(maxX, lp.loopX + PAD);
      minY = Math.min(minY, lp.clearY - 20); maxY = Math.max(maxY, lp.clearY + 20);
    }
    spacers.push(
      { id: "__spacer_min", type: "spacer", position: { x: minX, y: minY }, data: {}, draggable: false, selectable: false },
      { id: "__spacer_max", type: "spacer", position: { x: maxX, y: maxY }, data: {}, draggable: false, selectable: false },
    );
  }

  // РАСКРЫТЫЕ рамки на финальных позициях (R4/R5): их rect'ы становятся
  // compound-узлами RF в сборке. Гостевые рамки строятся по предкам гостей,
  // рамки раскрытых ЛОКАЛОВ — по цепочкам localFrames (та же механика: контейнер
  // ниже lca → не-native рамка вокруг членов). Родные рамки (native) не берём —
  // они остаются живым оверлеем LevelBoundary (bbox-follow за драгом).
  const guestFrames: FrameRect[] = [];
  if (!isContext) {
    const frames = computeFrames({
      localIds: nodes.map((n) => n.id),
      externals: [
        ...entities.map((e) => ({
          id: e.id,
          ancestors: e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors,
        })),
        ...localFrames,
      ],
      pos: (id) => positions.get(id),
      ancestorIds,
      ancestorNames: ancestorIds, // имена нативных не нужны — их отфильтровываем
    });
    guestFrames.push(...frames.filter((f) => !f.native));
  }

  return {
    layout: {
      nodes, entities, positions, edgeHandles, edgeShelves, edgeLoops,
      autoRoutes, labelPlacements, bundleWaypoints: effectiveWaypoints, guestFrames, groupArr, spacers,
    },
    liveInputs: {
      layoutEdges,
      nodeIds: [...nodes.map((n) => ({ id: n.id })), ...entities.map((e) => ({ id: e.id }))],
      localIds: new Set(nodes.map((n) => n.id)),
    },
    intents,
  };
}
