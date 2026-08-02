// Конвейер раскладки вида (R1 эпика вид-центричного движка, C4_ENGINE_AUDIT.md).
//
// ЧИСТАЯ композиция всех стадий раскладки уровня: проекция гостей → ремап
// рёбер → слияние мастер-стрелок → позиции (ELK) → кольца гостей →
// разведение → инварианты (keep-out рамок + наложения) → раздвижка под плашки (A10)
// → инварианты повторно → засев владения →
// глобальный роутер (A7/A8/A11) → плашки (A7.2) → детуры плашек (A12) → nudge (A13).
// A10 — СТРОГО до засева и с добивкой инвариантов: раздвижка не знает о рамках, а
// засев фиксирует именно показанные позиции (см. комментарий у блока A10).
// Геометрия стрелок — целиком авто: ручной слой (изломы/хэндлы/label_t) удалён
// 2026-07-09 вместе с фиче-тоглом EDGE_MANUAL_LAYOUT.
//
// Конвейер НЕ пишет в БД и не трогает React: побочные эффекты прежней async-раскладки
// (засев владения own-on-first-render) возвращаются наружу СПИСКОМ ИНТЕНТОВ — их
// применяет вызывающий (LevelGraph), если прогон не устарел. Так композиция стадий
// тестируется целиком, а класс багов «раскладка пишет в БД из середины рендера»
// закрыт по построению.
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
import type { DisplayExternal, EdgeGroup, EdgeShelf, EdgeLoop } from "../types";
import type { LiveHandleInputs, LiveRouteInputs } from "../interaction/useLiveDragHandles";
import { NODE_W, NODE_H, MAX_INLINE_DEPTH } from "../constants";
import { edgeText } from "../text";
import { liftEdgesToLevel } from "../projection";
import { projectGhosts } from "./projectGhosts";
import { layoutLevel } from "./engine";
import { assignEdgeHandles } from "./level";
import { placeGhostsOnRings, collectGhostSeeds } from "./ringPlacement";
import { computeFrames, type FrameRect } from "./frames";
import { enforceFramesKeepOut, keepOutOfExpandedFrames } from "./keepGhostsOut";
import { separateOverlappingNodes } from "./separateNodes";
import { separateGuests } from "./separateGuests";
import { spawnFreshChildren } from "./spawnChildren";
import { buildAutoRoutes } from "./autoRoutes";
import { nudgeChannels } from "./channelNudge";
import { straightenJogs, toPlacedSegs, type PlacedSeg } from "./routeAll";
import { buildLabelPlacements, type LabelPlacement } from "./labelLayout";
import { metaLabelBox } from "./labelBox";
import { pathCrossesRects } from "../edgePath";
import { widenNodesForLabels } from "./widenForLabels";

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
  // РАСКРЫТЫЕ гостевые рамки на финальных позициях (R4): реальные rect'ы для
  // compound-узлов RF (id рамки = id раскрытого контейнера; дети — memberIds).
  // Отсортированы по depth (внешние первыми) — порядок вложенности parentId.
  // Родные (breadcrumb) рамки сюда не входят — их рисует оверлей LevelBoundary.
  guestFrames: FrameRect[];
  groupArr: EdgeGroup[];
  spacers: RFNode[];
};

// Побочные записи раскладки, вычисленные конвейером как ДАННЫЕ. Применяет вызывающий
// (через commitLayout — единый батч view_layout): seed-positions — засев владения
// own-on-first-render (гость/контейнер без сохранённой позиции получает текущую
// навсегда) и персист выдвинутых разведением владеемых соседей (Ф4.4).
export type PersistIntent = {
  kind: "seed-positions";
  seeds: { id: string; x: number; y: number }[];
};

export interface PipelineInput {
  nodes: AppNode[];
  // реестр не-локальных концов рёбер (R2): и гости, и глубокие концы внутри
  // поддерева — все с цепочками предков.
  endpoints: GhostNode[];
  // рёбра уровня СЫРЫЕ (реальные концы; проекция здесь).
  edges: AppEdge[];
  containerId: string | null;
  // раскладка вида как есть (R3, единое хранилище): item_id → payload. Позиции —
  // по id сущности (локалы, гости, контейнеры единообразно).
  viewLayout: ViewLayout;
  ancestorIds: string[];
  // раскрытые инлайн контейнеры: и гостевые, и ЛОКАЛЬНЫЕ (R5) — id уникальны
  expanded: Set<string>;
  // догруженные дети раскрытых ЛОКАЛЬНЫХ контейнеров (R5, Д3: показываются ВСЕ
  // дети): id контейнера → его прямые дети. Пока детей нет в карте — контейнер
  // рисуется свёрнутым (ленивая догрузка, LevelGraph качает по требованию).
  localChildren: Record<string, AppNode[]>;
  // РЕАЛЬНЫЕ габариты узлов из DOM (node.measured, V2.2b): узлы растут по контенту, и
  // стадии КАЧЕСТВА СТРЕЛОК (роутер/плашки/детуры) обязаны видеть настоящие тела —
  // иначе маршрут ложится «по грани»/поверх реального узла (канон libavoid: препятствия
  // = реальные shape bounds + буфер). Стадии РАСКЛАДКИ УЗЛОВ (кольца/VPSC/рамки/keep-out)
  // сознательно остаются на NODE_W×NODE_H: они двигают и персистят позиции, и завязка их
  // на замер рисковала бы петлёй пере-раскладки. Нет замера (первый прогон) — фолбэк.
  sizes?: Record<string, { w: number; h: number }>;
  // ГИСТЕРЕЗИС МАРШРУТОВ (2026-07-09): финальные autoRoutes/edgeHandles прошлого
  // прогона. Валидные прежние маршруты удерживаются, пока не хуже свежих на порог
  // (см. buildAutoRoutes.prev / ROUTE_STICKINESS) — стрелки не перекладываются от
  // чужих микро-сдвигов. Вызывающий обязан передавать их только между прогонами
  // ОДНОГО класса замеров (оба с реальными sizes): маршруты первого прогона на
  // фолбэке NODE_W×NODE_H не должны «прилипать» после прихода настоящих замеров.
  prevRoutes?: Map<string, EdgePoint[]>;
  prevEdgeHandles?: Map<string, { sourceHandle: string; targetHandle: string }>;
  // СКОУП ПЕРЕСЧЁТА ПОСЛЕ ДРАГА (фикс дрейфа 2026-07-22): id узлов, которые только что
  // перетащили. Когда задан (и есть prevRoutes), роутятся ТОЛЬКО рёбра, инцидентные этим
  // узлам; остальные берутся из prevRoutes как preplaced (фиксированный контекст). Это
  // обрывает каскад rip-up, из-за которого полный пересчёт на каждый дроп «дышал» — менял
  // 18–26 из 32 маршрутов и не сходил к фикспойнту (дрейф гистерезисных прогонов). Полный
  // пересчёт всех рёбер остаётся на открытие уровня и «Переразложить» (scopeNodeIds не задан).
  scopeNodeIds?: string[];
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
    expanded, localChildren, sizes, prevRoutes, prevEdgeHandles, scopeNodeIds,
  } = input;
  const intents: PersistIntent[] = [];

  // Владеемые позиции вида (внутренний формат модулей раскладки: кольца/разведение/
  // keep-out/засев). Локалы, гости и контейнеры — единообразно из viewLayout.
  const ownedPositions: Record<string, LevelPos> = {};
  for (const [itemId, p] of Object.entries(viewLayout)) {
    if (p.x != null && p.y != null) ownedPositions[itemId] = { pos_x: p.x, pos_y: p.y };
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
  // Контейнеры, поглощённые раскрытием (заменены детьми): их рамка гарантирована,
  // а конец ребра «прямо в такой контейнер» не должен материализоваться гостем-
  // дублем (см. фильтр сущностей после projectGhosts).
  const absorbed = new Set<string>();
  // предки уровня как AncestorRef-лайт: для расчёта lca в computeFrames важны
  // только id (имена рамок уровня рисует ancestorNames — не отсюда)
  const bcRefs: AncestorRef[] = ancestorIds.map((id) => ({ id, name: id, is_external: false }));
  const expandLocal = (n: AppNode, path: AncestorRef[]) => {
    const kids = expanded.has(n.id) ? localChildren[n.id] : undefined;
    // R5 с пределом глубины (C8): инлайн раскрываем, пока узел НЕ глубже
    // MAX_INLINE_DEPTH слоёв от уровня (path.length = число раскрытых предков над
    // узлом). Узел на пределе остаётся свёрнутым, даже если expanded персистно —
    // рендерер не строит рамки глубже лимита (глубже — только «Войти»).
    if (kids && kids.length > 0 && path.length < MAX_INLINE_DEPTH) {
      absorbed.add(n.id);
      const deeper = [...path, { id: n.id, name: n.name, is_external: n.is_external }];
      for (const k of kids) expandLocal(k, deeper);
      return;
    }
    nodes.push(n);
    if (path.length > 0) localFrames.push({ id: n.id, ancestors: [...bcRefs, ...path] });
  };
  for (const n of rawNodes) expandLocal(n, []);

  // ПРОЕКЦИЯ, половина 1 (R2): подъём концов сырых рёбер к ближайшему локальному
  // предку уровня; концы вне поддерева остаются гостями.
  // localIds — отображаемые локалы: конец внутри РАСКРЫТОГО контейнера поднимается
  // не к нему, а к его видимому потомку (симметрия со сворачиванием гостей).
  const { edges: liftedEdges, ghosts } = liftEdgesToLevel({ edges, endpoints, localIds: new Set(nodes.map((n) => n.id)), containerId });

  // ПРОЕКЦИЯ, половина 2: сворачиваем гостей к их верхним (неразвёрнутым) контейнерам
  const { entities: entitiesRaw, ghostToEffective, emergedFrom } = projectGhosts(ghosts, ancestorIds, expanded);
  // СВЯЗЬ «ПРЯМО В РАСКРЫТЫЙ КОНТЕЙНЕР» (двойник алерт-кейса локалов, 2026-07-15):
  // на уровнях, где контейнер — глубокий конец из реестра (корень; вложенные
  // раскрытия), lift не находит ему локального предка и отдаёт гостем, а
  // projectGhosts материализовал бы его УЗЛОМ — рядом с его же РАМКОЙ (duplicate
  // id в RF ломал драг: «фантомный» узел поверх рамки). Гость-лист, чей id —
  // контейнер, уже отображаемый рамкой (поглощён локальным раскрытием либо
  // раскрытый гость, из-под которого проекция вывела другую сущность), узлом не
  // становится; ребро с таким концом отсеет группировка по displayedIds — связь
  // скрыта, как у раскрытого локала (алерт intermediate_edges её подсвечивает).
  // Гость-контейнер, раскрытый «вхолостую» (глубоких концов нет, рамки нет),
  // остаётся узлом — иначе связь пропала бы без замены.
  const emergesFrom = (cid: string): boolean =>
    entitiesRaw.some(
      (e) =>
        e.id !== cid &&
        (e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors).some((x) => x.id === cid),
    );
  const entities = entitiesRaw.filter(
    (e) => !(e.kind === "leaf" && (absorbed.has(e.id) || (expanded.has(e.id) && emergesFrom(e.id)))),
  );
  const remap = (id: string) => ghostToEffective.get(id) ?? id;
  // Рёбра с концами, переадресованными на отображаемые сущности. Геометрии на
  // рёбрах нет (ручной слой удалён 2026-07-09) — всю её назначает авто-раскладка.
  const remappedEdges: LayoutEdge[] = liftedEdges.map((e) => ({
    ...e,
    source_id: remap(e.source_id),
    target_id: remap(e.target_id),
  }));

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
  const layoutEdges: LayoutEdge[] = groupArr.map((g) => {
    if (g.members.length === 1) return g.members[0];
    const longest = g.members.reduce((a, b) => (edgeText(b).length > edgeText(a).length ? b : a));
    return {
      id: g.id, source_id: g.source, target_id: g.target,
      label: longest.label, technology: longest.technology,
      version: longest.version,
      created_at: "",
    };
  });

  // Раскладка позиций/хэндлов — всегда ELK level-конвейер. Контекстный движок
  // (звезда) удалён 2026-07-30: все схемы рендерит один level-конвейер.
  const baseLayout = await layoutLevel(allNodeInfos, layoutEdges);
  const positions = baseLayout.positions;
  let edgeHandles = baseLayout.edgeHandles;
  // Полки подписей и обходы не родных стрелок считались только в контекст-звезде
  // (удалена) — на level-конвейере их нет.
  const edgeShelves: Map<string, EdgeShelf> | undefined = undefined;
  const edgeLoops: Map<string, EdgeLoop> | undefined = undefined;

  // Дефолтная раскладка гостей на кольца запретных рамок (boundary labeling) —
  // вынесена в ringPlacement под юнит-тесты. МУТИРУЕТ positions
  // (ставит гостей на кольца); их стрелки дальше ведёт глобальный роутер.
  // Первый показ детей РАСКРЫТОГО ЛОКАЛА (R5, expand-in-place; C9 v2): свежие
  // дети без владеемой позиции раскладываются мини-ELK прогоном ПОДГРАФА
  // (дети + рёбра между ними) от сохранённой позиции контейнера — общий
  // layered-поток уровня вырывал бы их из места раскрытия, а слепая сетка
  // (доэпиковый вариант) игнорировала связи и подписи (docs/archive/plan-spawn-spacing.md).
  // Позицию контейнера гарантирует own-on-expand (LevelGraph.commitExpanded
  // закрепляет её в момент клика); без неё дети остаются как легли (наблюдатель
  // на никем не раскрывавшемся контейнере — его коммит гейтится). Владеемые дети
  // (повторное раскрытие) уже сели savedPos-ом. Засев ниже зафиксирует позиции
  // навсегда.
  await spawnFreshChildren({ localFrames, ownedPositions, layoutEdges, positions, localChildren });

  const og = placeGhostsOnRings({
    nodes, entities, ancestorIds, levelPositions: ownedPositions, layoutEdges, positions, expanded, localFrames,
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
    positions, emergedFrom, placedOutside: og?.placedOutside ?? new Set<string>(), localFrames,
  });

  // Страховочная сетка keep-out: кольца держат инвариант по построению, но ручные позиции
  // и рост рамки за ручным гостем ringPlacement не трогает — их добирает enforce. На
  // авто-гостях после ringPlacement он обязан быть no-op. Запускается всегда.
  const enf = enforceFramesKeepOut({
    nodes, entities, ancestorIds, layoutEdges, positions, localFrames,
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
  const runExpandedInvariants = () => {
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
      const reEnf = enforceFramesKeepOut({ nodes, entities, ancestorIds, layoutEdges, positions, localFrames });
      if (reEnf) edgeHandles = reEnf.edgeHandles;
    }
    if (anythingMoved) {
      const displayed = [...nodes.map((n) => ({ id: n.id })), ...entities.map((e) => ({ id: e.id }))];
      edgeHandles = assignEdgeHandles(displayed, layoutEdges, positions);
    }
  };
  runExpandedInvariants();

  // Раздвижка узлов под плашку короткого ребра (эпик стрелок A10, R2 — вынесена
  // в widenForLabels). МЕСТО В КОНВЕЙЕРЕ: ПОСЛЕ цикла инвариантов и ДО засева
  // владения (обоснование — в шапке модуля). Если раздвижка двигала — инварианты
  // прогоняются ПОВТОРНО (заезды в рамки зачищаются; keep-out и разведение не
  // сжимают зазоры, поэтому раздвинутое место они не отбирают).
  const a10moved = widenNodesForLabels({
    groupArr,
    displayIds: [...nodes.map((n) => n.id), ...entities.map((e) => e.id)],
    localIds: new Set(nodes.map((n) => n.id)),
    ownedPositions,
    positions,
    labelMeta: edgeLabelMeta,
  });
  if (a10moved) runExpandedInvariants();

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
    const pushed = [...pushedIds].flatMap((id) => {
      const p = positions.get(id);
      return p ? [{ id, x: p.x, y: p.y }] : [];
    });
    if (pushed.length > 0) intents.push({ kind: "seed-positions", seeds: pushed });
  }

  // Авто-маршруты (эпик стрелок A7.1, R1+R3): глобальный роутер на раскладке для всех
  // рёбер level/main-схемы.
  let autoRoutes: Map<string, EdgePoint[]> | undefined;
  let labelPlacements: Map<string, LabelPlacement> | undefined;
  const displayIds = [...nodes.map((n) => n.id), ...entities.map((e) => e.id)];
  // реальные габариты для стадий качества стрелок (роутер/плашки)
  const sizeMap = new Map<string, { w: number; h: number }>(
    sizes ? Object.entries(sizes) : [],
  );
  const realRectOf = (id: string): { x: number; y: number; w: number; h: number } | null => {
    const p = positions.get(id);
    if (!p) return null;
    const s = sizeMap.get(id);
    return { x: p.x, y: p.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H };
  };

  // Все рёбра с позиционированными концами маршрутизирует роутер (ручного слоя нет).
  // СКОУП ПОСЛЕ ДРАГА: когда задан scopeNodeIds и есть prevRoutes, роутим только рёбра,
  // инцидентные перетащенным узлам; остальные buildAutoRoutes возьмёт из prevRoutes как
  // preplaced (фиксированный контекст) — это обрывает каскад rip-up и дрейф (см. вход).
  const scopeSet = scopeNodeIds && scopeNodeIds.length > 0 && prevRoutes
    ? new Set(scopeNodeIds)
    : null;
  const routableIds = new Set<string>();
  for (const g of groupArr) {
    if (!positions.get(g.source) || !positions.get(g.target)) continue;
    if (scopeSet && !scopeSet.has(g.source) && !scopeSet.has(g.target)) continue;
    routableIds.add(g.id);
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
  const ar = buildAutoRoutes({
    groups: groupArr, routableIds, positions,
    displayIds, sizes: sizeMap, frames: routerFrames,
    // гистерезис: финальные маршруты/хэндлы прошлого прогона (если вызывающий дал)
    prev: prevRoutes && prevEdgeHandles ? { routes: prevRoutes, handles: prevEdgeHandles } : undefined,
  });
  autoRoutes = ar.routes;
  // СКОУП: buildAutoRoutes вернул маршруты только заскоупленных рёбер; незаскоупленные
  // (инцидентные прочим узлам) берём из prevRoutes — они зафиксированы как preplaced и
  // сохраняют прежнюю геометрию (иначе потеряли бы маршрут и отвалились на smoothstep).
  if (scopeSet && prevRoutes) {
    for (const g of groupArr) {
      if (routableIds.has(g.id) || autoRoutes.has(g.id)) continue;
      const pr = prevRoutes.get(g.id);
      if (pr && pr.length >= 2) autoRoutes.set(g.id, pr.map((p) => ({ x: p.x, y: p.y })));
    }
  }
  // A8: выбранные роутером стороны → хэндлы (RF состыкует стрелку там).
  for (const [id, hh] of ar.handles) edgeHandles.set(id, hh);
  // хэндлы незаскоупленных рёбер — из прошлого прогона (их маршрут не менялся)
  if (scopeSet && prevEdgeHandles) {
    for (const g of groupArr) {
      if (routableIds.has(g.id) || edgeHandles.has(g.id)) continue;
      const ph = prevEdgeHandles.get(g.id);
      if (ph) edgeHandles.set(g.id, ph);
    }
  }
  // СКОУП: фиксируем геометрию незаскоупленных рёбер — пост-обработка (нуджинг, полировка
  // джогов, T4) не должна её двигать, иначе дрейф возвращается (зонд: чурн ~6/поколение).
  // Восстанавливаем после каждого прохода, который переписывает autoRoutes.
  const frozenRoutes = new Map<string, EdgePoint[]>();
  if (scopeSet) {
    for (const g of groupArr) {
      if (routableIds.has(g.id)) continue;
      const rt = autoRoutes.get(g.id);
      if (rt) frozenRoutes.set(g.id, rt.map((p) => ({ x: p.x, y: p.y })));
    }
  }
  const restoreFrozen = (): void => {
    // autoRoutes всегда определён к этому месту (присвоен ar.routes выше и далее
    // только переприсваивается в Map); tsc не видит этого сквозь замыкание.
    const target = autoRoutes;
    if (!target) return;
    for (const [id, rt] of frozenRoutes) target.set(id, rt.map((p) => ({ x: p.x, y: p.y })));
  };

  const nodeRects = displayIds
    .map(realRectOf)
    .filter((r): r is { x: number; y: number; w: number; h: number } => r != null);

  // КАНАЛЬНЫЙ NUDGING (V2.3, замена точечного A13): все коллинеарно наложенные плечи из
  // РАЗНЫХ хэндлов собираются в «каналы», упорядочиваются по подходам маршрутов и
  // разводятся равными зазорами вокруг исходной линии (канон GD'09 ordered nudging).
  // Стволы из ОДНОГО хэндла остаются слитыми (Т4). Рельсы встречных пар (A11) остаются —
  // это раздача ПОРТОВ, каналу порты двигать нельзя. Чистый пост-проход на финальных
  // маршрутах.
  const nu = nudgeChannels({ routes: autoRoutes, obstacles: nodeRects });
  if (nu.nudged.size > 0) autoRoutes = nu.routes;
  restoreFrozen(); // нуджинг мог сдвинуть незаскоупленные плечи — вернуть

  // ПОЛИРОВКА ДЖОГОВ ПОСЛЕ НУДЖИНГА (T2 «читаемые пучки»): и роутер (перескок из-за
  // штрафа езды), и канальная разводка умеют оставить короткую «ступеньку» посреди
  // коридора. straightenJogs гоняем по финальной геометрии: те же гарантии — не режет
  // тела/плашки рамок, не прижимается (JOG_CLEAR), не дорожает по крестам/езде.
  {
    const jogObstacles = [...nodeRects, ...routerFrames.map((f) => f.plaque)];
    const segsById = new Map<string, PlacedSeg[]>();
    for (const [id, rt] of autoRoutes) segsById.set(id, toPlacedSegs(rt));
    const polished = new Map<string, EdgePoint[]>();
    for (const g of groupArr) {
      const rt = autoRoutes.get(g.id);
      if (!rt || rt.length < 4) continue;
      const others: PlacedSeg[] = [];
      const fellowRoutes: EdgePoint[][] = []; // стволовой контекст оценки (E25 v2)
      for (const [id, s] of segsById) {
        if (id === g.id) continue;
        others.push(...s);
        const r = polished.get(id) ?? autoRoutes.get(id);
        if (r) fellowRoutes.push(r);
      }
      const own = { starts: [rt[0]], ends: [rt[rt.length - 1]] };
      const str = straightenJogs(rt, jogObstacles, others, 200, 40, undefined, own, fellowRoutes);
      if (str.length !== rt.length) {
        polished.set(g.id, str);
        segsById.set(g.id, toPlacedSegs(str));
      }
    }
    if (polished.size > 0) {
      autoRoutes = new Map(autoRoutes);
      for (const [id, rt] of polished) autoRoutes.set(id, rt);
    }
    restoreFrozen(); // полировка могла изменить незаскоупленные маршруты — вернуть
  }

  // Плашки подписей (эпик стрелок A7.2, R2+R4) — один проход по ФИНАЛЬНЫМ маршрутам:
  // без взаимных наложений и не под узлами (R2), не на совпавших плечах (R4); где на
  // линии чисто не встаёт — выноска-leader с поводком (A7.3). Позиция целиком авто.
  // Детур-стадия A12 («изогнуть стрелку, чтобы плашка легла инлайн») УДАЛЕНА 2026-07-13:
  // она превращала прямые маршруты в необъяснимые объезды (жалоба: стрелка при свободном
  // прямом коридоре идёт полкой сверху/снизу) и дестабилизировала живое превью драга.
  // Маршрут — только у роутера; невлезающая подпись решается leader-выноской.
  labelPlacements = buildLabelPlacements({
    routes: autoRoutes,
    groups: groupArr,
    labelMeta: edgeLabelMeta,
    preferredT: () => undefined,
    nodeRects,
  });

  // ПЛАШКИ → ПРЕПЯТСТВИЯ МАРШРУТОВ (T4 «читаемые пучки», один мини-проход): линия
  // сквозь чужой текст нечитаема. «Грязные» рёбра (маршрут режет прямоугольник ЧУЖОЙ
  // плашки) перепрокладываются со штрафом LABEL_CROSS_COST за переход границы плашки
  // (своя не отталкивает); прочие маршруты — фиксированный контекст prev. После —
  // одно пере-размещение плашек по изменённой геометрии. Второй итерации нет
  // осознанно: сдвинутая плашка теоретически может лечь на другую линию — редкий
  // остаток, не стоит цикла.
  {
    const labelRectOf = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const g of groupArr) {
      const lp = labelPlacements.get(g.id);
      const meta = edgeLabelMeta(g);
      if (!lp || !meta) continue;
      const box = metaLabelBox(meta);
      labelRectOf.set(g.id, {
        x: lp.center.x - box.w / 2, y: lp.center.y - box.h / 2, w: box.w, h: box.h,
      });
    }
    const dirty = new Set<string>();
    for (const g of groupArr) {
      // СКОУП: незаскоупленные рёбра заморожены — не перепрокладываем (иначе дрейф)
      if (scopeSet && !routableIds.has(g.id)) continue;
      const rt = autoRoutes.get(g.id);
      if (!rt) continue;
      for (const [gid, r] of labelRectOf) {
        if (gid === g.id) continue;
        if (pathCrossesRects(rt, [r])) { dirty.add(g.id); break; }
      }
    }
    if (dirty.size > 0) {
      const ar2 = buildAutoRoutes({
        groups: groupArr, routableIds: dirty, positions,
        displayIds, sizes: sizeMap, frames: routerFrames,
        prev: { routes: autoRoutes, handles: edgeHandles },
        labelObstacles: labelRectOf,
      });
      let changed = false;
      for (const id of dirty) {
        const rt = ar2.routes.get(id);
        const hh = ar2.handles.get(id);
        if (!rt) continue;
        autoRoutes.set(id, rt);
        if (hh) edgeHandles.set(id, hh);
        changed = true;
      }
      if (changed) {
        // ДОВОДКА НУДЖИНГА (регрессия 2026-07-15): перепроложенный здесь маршрут
        // минует канальную разводку (она отработала ВЫШЕ) и мог лечь коллинеарно
        // на чужое плечо — наложение оставалось до конца прогона. Повторный
        // nudgeChannels идемпотентен для уже разведённых каналов и дешёв.
        const nu2 = nudgeChannels({ routes: autoRoutes, obstacles: nodeRects });
        if (nu2.nudged.size > 0) autoRoutes = nu2.routes;
        restoreFrozen(); // доводка нуджинга могла сдвинуть незаскоупленные — вернуть
        // пере-размещение по финальной геометрии (маршруты грязных изменились)
        labelPlacements = buildLabelPlacements({
          routes: autoRoutes,
          groups: groupArr,
          labelMeta: edgeLabelMeta,
          preferredT: () => undefined,
          nodeRects,
        });
      }
    }
  }

  // Снимок входов роутера для живого ре-роута затронутых стрелок при драге (issue 1):
  // те же groups/frames/sizes и ФИНАЛЬНЫЕ маршруты/хэндлы (контекст prev). Позиции драг
  // подставит живые. Роутим только затронутые — прочие маршруты идут фиксированным prev.
  // Входы роутера для живого ре-роута при драге (issue 1).
  const liveRoute: LiveRouteInputs = {
    groups: groupArr,
    displayIds,
    sizes,
    frames: routerFrames,
    routes: autoRoutes ?? new Map(),
    handles: edgeHandles,
  };

  // Распорки (fitView-экстендер) считались только для контекст-звезды с обходами
  // не родных стрелок (loopX/clearY). Контекстный движок удалён (2026-07-30) —
  // распорок нет.
  const spacers: RFNode[] = [];

  // РАСКРЫТЫЕ рамки на финальных позициях (R4/R5): их rect'ы становятся
  // compound-узлами RF в сборке. Гостевые рамки строятся по предкам гостей,
  // рамки раскрытых ЛОКАЛОВ — по цепочкам localFrames (та же механика: контейнер
  // ниже lca → не-native рамка вокруг членов). Родные рамки (native) не берём —
  // они остаются живым оверлеем LevelBoundary (bbox-follow за драгом).
  const guestFrames: FrameRect[] = [];
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

  return {
    layout: {
      nodes, entities, positions, edgeHandles, edgeShelves, edgeLoops,
      autoRoutes, labelPlacements, guestFrames, groupArr, spacers,
    },
    liveInputs: {
      layoutEdges,
      nodeIds: [...nodes.map((n) => ({ id: n.id })), ...entities.map((e) => ({ id: e.id }))],
      localIds: new Set(nodes.map((n) => n.id)),
      route: liveRoute,
    },
    intents,
  };
}
