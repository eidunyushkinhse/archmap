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
import { computeFrames, frameLocalIds, framePlaqueRect, EMPTY_LEVEL_MEMBER, EMPTY_LEVEL_ORIGIN, type FrameRect } from "./frames";
import { enforceFramesKeepOut, keepOutOfExpandedFrames } from "./keepGhostsOut";
import { separateOverlappingNodes } from "./separateNodes";
import { separateGuests } from "./separateGuests";
import { spawnFreshChildren } from "./spawnChildren";
import { buildAutoRoutes } from "./autoRoutes";
import {
  createRouteBudget, type BudgetDegraded, type RouteBudget, type RouteBudgetConfig,
} from "./routeBudget";
import { nudgeChannels } from "./channelNudge";
import { straightenJogs, toPlacedSegs, type PlacedSeg } from "./routeAll";
import { buildLabelPlacements, type LabelPlacement } from "./labelLayout";
import { metaLabelBox } from "./labelBox";
import { pathCrossesRects } from "../edgePath";
import { computeIncrementalScope, type PrevScene } from "./incrementalScope";
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
  // РОДНАЯ рамка контейнера уровня — только когда в неё упирается хотя бы одна связь
  // (собственные связи контейнера, увиденные изнутри его уровня). Сборка вешает на этот
  // rect невидимый узел-якорь: рисует рамку по-прежнему оверлей LevelBoundary, но RF
  // нужен УЗЕЛ с этим id, иначе ребро с таким концом не отрисуется вовсе.
  levelFrame?: FrameRect;
  // id рамок, реально служащих концом связи на этом уровне. По ним сборка помечает
  // ребро reconnectable (перепривязка конца-в-рамку — единственное исключение из E1),
  // а холст проверяет, что новый конец лежит ВНУТРИ той же рамки.
  frameEnds: string[];
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
  // ЛЕНИВАЯ ДОГРУЗКА ДЕТЕЙ раскрытых ЛОКАЛОВ активна у вызывающего (редактор:
  // useLevelDrill фетчит состав по мере надобности). Тогда раскрытый локал БЕЗ записи
  // в localChildren — «ещё не приехал»: состав сцены НЕПОЛОН, прогон гарантированно
  // повторится (см. hasPendingChildren ниже). В read-only догрузки нет вообще
  // (страничные схемы), и там отсутствие детей — состояние ПОСТОЯННОЕ: считать такой
  // состав неполным нельзя, иначе стрелки не посчитались бы никогда. Не задан — false
  // (прежнее поведение: реплей/полигоны/тесты гоняют полные составы).
  childrenLazyLoad?: boolean;
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
  // СНИМОК ФИНАЛЬНОЙ СЦЕНЫ ПРОШЛОГО ПРОГОНА (Ф3 эпика router-opt, спека edge.md E84):
  // позиции и габариты, по которым посчитаны prevRoutes. Когда он задан, явного скоупа
  // драга нет и prev-маршруты есть, конвейер вычисляет скоуп САМ — диффом своих
  // ФИНАЛЬНЫХ позиций против этого снимка (computeIncrementalScope): роутятся только
  // рёбра окрестности изменений, остальные замораживаются той же механикой, что у драга.
  // Так раскрытие/сворачивание контейнера перестаёт платить полным пересчётом сцены.
  // Вызывающий обязан давать снимок ТОЛЬКО вместе с СООТВЕТСТВУЮЩИМИ ему prevRoutes
  // (тот же прогон, тот же комплект замеров) — иначе дифф врёт. Персистный кэш вида
  // (P11) снимка сцены не несёт: с кэш-prev авто-скоуп не работает — там либо кэш-хит
  // по routeSig, либо честный полный прогон.
  prevScene?: PrevScene;
  // ГАШЕНИЕ ОСЦИЛЛЯЦИЙ МАРШРУТОВ (2026-08-06): сигнатура входов роутинга прошлого
  // прогона и его плашки. Если входы роутинга ТЕКУЩЕГО прогона совпадают с сигнатурой
  // ПО БИТАМ, результат берётся ЦЕЛИКОМ из prev (маршруты/хэндлы/плашки): роутер
  // не идемпотентен относительно prev — гистерезис осциллирует (асимметрия раздачи
  // слотов free/pinned + обратная связь маршрут↔плашка T4), и удержание prev —
  // единственный фикспойнт. Стрелки не двигаются, пока не изменилось ничего,
  // роутинг определяющего (см. buildRouteSig).
  prevRouteSig?: string;
  prevLabelPlacements?: Map<string, LabelPlacement>;
  // Ф3 перф-эпика (2026-08-20): управление стадиями КАЧЕСТВА СТРЕЛОК (роутер,
  // нуджинг, джоги, плашки, T4 — ~98% цены конвейера). "skip" — пропустить,
  // "full" — считать всегда. НЕ ЗАДАНО — АВТО: пропуск, когда в сцене крупная
  // пачка незамеренных узлов (первый показ, раскрытие с новыми детьми, импорт):
  // такой прогон гарантированно повторится по приходу замеров, и его маршруты
  // выбрасываются. РАСКЛАДКА УЗЛОВ, рамки и засев владения не пропускаются
  // никогда (интенты персистятся с первого прогона). При пропуске
  // autoRoutes/labelPlacements в результате отсутствуют — сборка рисует рёбра
  // простыми (smoothstep) до пере-прогона.
  edgeQuality?: "full" | "skip";
  // ПЕРЕОПРЕДЕЛЕНИЕ БЮДЖЕТА РАБОТ (Ф5 эпика router-opt, спека perf.md P12/P13).
  // В ПРОДЕ НЕ ЗАДАЁТСЯ — там работают дефолт-константы routeBudget.ts (они же в реестре
  // ROUTER_VERSION). Ручка существует ради ТЕСТОВ и полигонов: форс-бюджет с крошечными
  // лимитами прогоняет ступени деградации на обычной сцене, не выдумывая патологическую.
  // Место и семантика — те же, что у edgeQuality: пер-прогонная ручка ПОВЕДЕНИЯ стадий,
  // а не глобальный мутабельный синглтон (тот сделал бы тесты порядкозависимыми).
  routeBudget?: RouteBudgetConfig;
}

export interface PipelineOutput {
  layout: LayoutResult;
  // снимок входов для живого пересчёта хэндлов при драге (useLiveDragHandles) —
  // те же мастер-рёбра и узлы, по которым посчитан layout
  liveInputs: LiveHandleInputs;
  intents: PersistIntent[];
  // сигнатура входов роутинга этого прогона: вызывающий кладёт её рядом с prev
  // маршрутами и возвращает в следующем прогоне — гашение осцилляций
  // (см. PipelineInput.prevRouteSig).
  routeSig: string;
  // АВТОРИТЕТНЫЙ ПРОГОН (Ф2 эпика router-opt, спека perf.md P11) — гейт записи
  // ПЕРСИСТНОГО кэша маршрутов вида. true ⇔ (стадии качества стрелок отработали
  // полноценно ИЛИ результат взят целиком из prev по совпавшей routeSig) И в сцене
  // НЕТ незамеренных узлов И прогон НЕ скоуплен — ни драг-скоупом (scopeNodeIds), ни
  // инкрементальным авто-скоупом (prevScene, E84). Только такой результат равен
  // байт-в-байт полному холодному прогону — прочие (пропуск P10, частичные замеры,
  // любой скоуп) в кэш не кладутся: они по построению временные и отравили бы кэш
  // геометрией фолбэк-габаритов или замороженного prev-контекста.
  authoritative: boolean;
  // СТУПЕНИ БЮДЖЕТА РАБОТ, СРАБОТАВШИЕ В ЭТОМ ПРОГОНЕ (Ф5, спека perf.md P12/P13).
  // null — обычный случай: бюджета хватило, ни одна ступень не включалась, результат
  // полноценный. Не-null означает, что часть стадий качества принесена в жертву
  // потолку работ: такой прогон НЕ авторитетен (деградированную геометрию в кэш P11 не
  // пишем) и обязан быть объявлен пользователю разовым тостом (P13).
  budgetDegraded: BudgetDegraded | null;
}

// ЭКСПЕРИМЕНТ г1 (Ф4-II того же эпика): отдавать ли T4-мини-проходу грид-подсказки от
// портов ВСЕХ рёбер сцены, а не только перепрокладываемых. Мотив (Ф0): T4 роутит на
// БЕДНОЙ сетке и тратит 12.3 маргин-ретрая на ребро против 10.9 у полного прохода.
// ВЫКЛЮЧЕН ПО ЗАМЕРУ: сетка плотнее → шаг дороже, время T4 растёт, а качество не
// выигрывает (числа — в журнале Ф4-II, docs/plan-router-deep-opt.md). Флаг оставлен в
// дереве, чтобы эксперимент воспроизводился одной правкой, а не археологией.
const T4_FULL_GRID_HINTS: boolean = false;

// ДИАГНОСТИКА T4 (Ф0 эпика «глубокая оптимизация роутера», 2026-08-21): полезная
// нагрузка необязательного хука __ARCHMAP_T4_DIAG на globalThis — им реплей снимает
// метрики, решающие судьбу кандидатов Б3 и цену дыры В8.1 (см. блок T4 ниже).
export interface T4Diag {
  // «грязные» рёбра мини-прохода: маршрут режет прямоугольник ЧУЖОЙ плашки. С Ф4-II
  // (Б3б) это ОСТАТОК ПОСЛЕ ПОЧИНКИ ПЛАШЕК — те, кого действительно перепрокладывают
  dirtyIds: string[];
  // из них те, чей конец — РАМКА. ИСТОРИЯ: до Ф4 эпика router-opt T4-вызов не получал
  // frameEndpoints, и такие рёбра молча не перепрокладывались никогда (дыра В8.1
  // плана); дыра закрыта, счётчик оставлен как метрика доли этого класса
  frameEndDirtyIds: string[];
  // ГЛУБИНА ВРЕЗА: минимальный inset k ∈ {2,4,6,8,10}, при котором маршрут уже НЕ
  // режет ни одной чужой плашки, сжатой на k со всех сторон; 12 — «режет и при 10»
  // (касание краем против глубокого реза — выбор варианта Б3)
  cutDepths: { id: string; depth: number }[];
  // Б3б («сначала подвинь плашку», Ф4-II): что сняла с роутера починка плашек.
  labelFirst: {
    conflicts: number;    // пар «маршрут A режет плашку B» ДО починки
    dirtyBefore: number;  // рёбер, которых пришлось бы перепрокладывать без Б3б
    victims: number;      // плашек-жертв (их пытались переставить)
    moved: number;        // из них уехали в БЕЗУПРЕЧНОЕ место
    solvedEdges: number;  // рёбер снято с перепрокладки починкой плашек
  };
  // Б3б, финальный проход: та же починка ПОСЛЕ пере-размещения плашек по новой
  // геометрии (финальный гриди не имеет права откатить решения Б3б на линии)
  finalRepair?: { conflicts: number; victims: number; moved: number };
}

// ДИАГНОСТИКА ИНКРЕМЕНТАЛЬНОГО СКОУПА (Ф3 того же эпика): полезная нагрузка
// необязательного хука __ARCHMAP_SCOPE_DIAG на globalThis — им реплей и полевой зонд
// видят, сколько рёбер реально ушло в пересчёт. Без хука — мёртвый no-op.
export interface ScopeDiag {
  // рёбра-кандидаты роутинга (оба конца с геометрией)
  candidates: number;
  // сколько отображаемых сущностей переехало/появилось/исчезло против прошлой сцены
  changedNodes: number;
  // размер скоупа ДО порога отказа: близко к candidates — сцена изменилась целиком
  rawScope: number;
  // размер авто-скоупа; null — «не применён» (скоуп драга, нет prevScene/prevRoutes,
  // изменений нет вовсе либо их больше порога SCOPE_FULL_RECALC_SHARE)
  autoScope: number | null;
  // id рёбер авто-скоупа (отсортированы) — для разбора границы скоупа
  autoScopeIds: string[];
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

// Сигнатура входов роутинга (гашение осцилляций): всё, что видит роутер и
// плашки — позиции/габариты отображаемых сущностей, мастер-рёбра с подписями
// и скоупом, раскрытые рамки с плашками и составом. Детерминированная сборка:
// одинаковые входы → одинаковая сигнатура; любое изменение, влияющее на
// маршруты/хэндлы/плашки, её меняет (позиции, габариты, состав узлов/рёбер,
// подписи, скоуп, рамки).
export function buildRouteSig(
  displayIds: readonly string[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  sizeMap: ReadonlyMap<string, { w: number; h: number }>,
  groups: readonly EdgeGroup[],
  routableIds: ReadonlySet<string>,
  frames: ReadonlyArray<{
    rect: { x: number; y: number; w: number; h: number };
    plaque: { x: number; y: number; w: number; h: number };
    memberIds: ReadonlySet<string>;
  }>,
): string {
  const parts: string[] = [];
  for (const id of displayIds) {
    const p = positions.get(id);
    const s = sizeMap.get(id);
    parts.push(`n${id}:${p ? `${p.x},${p.y}` : "-"}:${s ? `${s.w},${s.h}` : `${NODE_W},${NODE_H}`}`);
  }
  for (const g of groups) {
    const m = edgeLabelMeta(g);
    parts.push(`e${g.id}:${g.source}>${g.target}:${m ? `${m.text}#${m.lines}` : ""}:${routableIds.has(g.id) ? 1 : 0}`);
  }
  for (const f of frames) {
    parts.push(`f:${f.rect.x},${f.rect.y},${f.rect.w},${f.rect.h}|${f.plaque.x},${f.plaque.y},${f.plaque.w},${f.plaque.h}|${[...f.memberIds].sort().join(",")}`);
  }
  return parts.join(";");
}

/** Полный расчёт раскладки вида. Async из-за ELK; всё остальное синхронно и чисто. */
export async function computeViewLayout(input: PipelineInput): Promise<PipelineOutput> {
  const {
    nodes: rawNodes, endpoints, edges, containerId, viewLayout, ancestorIds,
    expanded, localChildren, childrenLazyLoad, sizes, prevRoutes, prevEdgeHandles, scopeNodeIds,
    prevRouteSig, prevLabelPlacements, prevScene,
  } = input;
  const intents: PersistIntent[] = [];

  // ТРАССИРОВКА СТАДИЙ (перф-эпик 2026-08-20): необязательный хук __ARCHMAP_TRACE на
  // globalThis получает пары «стадия → мс» (оффлайн-реплей профилирования, см.
  // __tests__/pipelineReplay.perf.test.ts). Без хука mark — мёртвый no-op.
  const traceG = globalThis as unknown as { __ARCHMAP_TRACE?: (stage: string, ms: number) => void };
  const trace = traceG.__ARCHMAP_TRACE;
  let traceT = trace ? performance.now() : 0;
  const mark = (stage: string): void => {
    if (!trace) return;
    const now = performance.now();
    trace(stage, now - traceT);
    traceT = now;
  };

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
  // НЕПОЛНЫЙ СОСТАВ СЦЕНЫ (Ф2 эпика router-opt, полевая находка приёмки): корень
  // догружается ПОРЦИЯМИ (0 → 17 → 26 → 34 узла), и промежуточные прогоны имеют
  // unmeasured = 0 (свои узлы замерены) — P10 их не ловит. Такой прогон гонял полный
  // роутер, а его маршруты всё равно выбрасывались приходом детей; хуже того, он
  // проходил как авторитетный и ПЕРЕЗАПИСЫВАЛ кэш полной сцены частичным.
  let hasPendingChildren = false;
  const expandLocal = (n: AppNode, path: AncestorRef[]) => {
    const kids = expanded.has(n.id) ? localChildren[n.id] : undefined;
    // раскрытый локал, чьи дети ещё не приехали (запись в localChildren отсутствует —
    // пустой массив означает «загружено, детей нет» и неполнотой не является)
    if (childrenLazyLoad && expanded.has(n.id) && localChildren[n.id] === undefined
      && path.length < MAX_INLINE_DEPTH) hasPendingChildren = true;
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

  // КОНТЕЙНЕРЫ, НАРИСОВАННЫЕ РАМКОЙ. Их два рода, и связь «прямо в такой контейнер»
  // у обоих упирается в границу его рамки вместо того, чтобы пропасть:
  //  • поглощённые раскрытием локалы (absorbed) — не-нативная рамка внутри уровня;
  //  • САМ КОНТЕЙНЕР УРОВНЯ — его рамка это внешнее кольцо breadcrumb. Это и есть
  //    двойник кейса «раскрытый контейнер», увиденный ИЗНУТРИ: на уровне miss-cluster
  //    его собственные 6 связей раньше исчезали, а соседи оставались висеть без стрелок.
  const frameIds = new Set<string>(absorbed);
  if (containerId !== null) frameIds.add(containerId);

  // ПРОЕКЦИЯ, половина 1 (R2): подъём концов сырых рёбер к ближайшему локальному
  // предку уровня; концы вне поддерева остаются гостями.
  // localIds — отображаемые локалы: конец внутри РАСКРЫТОГО контейнера поднимается
  // не к нему, а к его видимому потомку (симметрия со сворачиванием гостей).
  const { edges: liftedEdges, ghosts } = liftEdgesToLevel({
    edges, endpoints, localIds: new Set(nodes.map((n) => n.id)), containerId, frameIds,
  });

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

  // Отображаемые концы рёбер: узлы, сущности И РАМКИ (раскрытых локалов и уровня).
  // Рамка — конец «по-настоящему»: стрелка стыкуется с её границей (id рамки = id
  // контейнера).
  const displayedIds = new Set<string>([
    ...nodes.map((n) => n.id), ...entities.map((e) => e.id), ...frameIds,
  ]);
  // Конец ребра — рамка, а не узел. Такие рёбра исключены из стадий РАСКЛАДКИ УЗЛОВ
  // (у рамки нет представителя в ELK, её геометрия производна от детей) и ведутся
  // только роутером — по прямоугольнику рамки.
  const isFrameEnd = (g: { source: string; target: string }): boolean =>
    frameIds.has(g.source) || frameIds.has(g.target);

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
  // Связи-в-рамку сюда не входят: ELK/кольца/разведение/assignEdgeHandles оперируют
  // УЗЛАМИ, а рамка узлом не является — её rect появляется только после раскладки.
  const layoutEdges: LayoutEdge[] = groupArr.filter((g) => !isFrameEnd(g)).map((g) => {
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
  mark("проекция+группировка");
  const baseLayout = await layoutLevel(allNodeInfos, layoutEdges);
  mark("ELK уровня");
  const positions = baseLayout.positions;
  let edgeHandles = baseLayout.edgeHandles;
  // ПУСТОЙ УРОВЕНЬ: рамка контейнера рисуется всегда, но членов у неё нет — их роль
  // играет синтетический бокс «как под один узел» (frames.ts). Он существует ТОЛЬКО
  // для геометрии рамок: в displayIds/entities/засев/роутер не попадает, узлом не
  // рендерится. Позиция кладётся в общую карту — все стадии рамок читают её оттуда.
  const frameLocals = frameLocalIds(nodes.map((n) => n.id), ancestorIds);
  const emptyLevel = nodes.length === 0 && ancestorIds.length > 0;
  if (emptyLevel) positions.set(EMPTY_LEVEL_MEMBER, { ...EMPTY_LEVEL_ORIGIN });
  // «Локалы» для стадий, работающих с рамками (кольца, keep-out, разведение, computeFrames)
  const framedNodes = frameLocals.map((id) => ({ id }));
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
  mark("спавн детей");

  const og = placeGhostsOnRings({
    nodes: framedNodes, entities, ancestorIds, levelPositions: ownedPositions, layoutEdges, positions, expanded, localFrames,
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
    nodes: framedNodes, entities, ancestorIds, levelPositions: ownedPositions, layoutEdges,
    positions, emergedFrom, placedOutside: og?.placedOutside ?? new Set<string>(), localFrames,
  });

  // Страховочная сетка keep-out: кольца держат инвариант по построению, но ручные позиции
  // и рост рамки за ручным гостем ringPlacement не трогает — их добирает enforce. На
  // авто-гостях после ringPlacement он обязан быть no-op. Запускается всегда.
  const enf = enforceFramesKeepOut({
    nodes: framedNodes, entities, ancestorIds, layoutEdges, positions, localFrames,
  });
  if (enf) edgeHandles = enf.edgeHandles;
  else if (sg) edgeHandles = sg.edgeHandles;
  else if (og) edgeHandles = og.edgeHandles;
  mark("кольца+разведение+keep-out");

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
        localIds: frameLocals,
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
      const reEnf = enforceFramesKeepOut({ nodes: framedNodes, entities, ancestorIds, layoutEdges, positions, localFrames });
      if (reEnf) edgeHandles = reEnf.edgeHandles;
    }
    if (anythingMoved) {
      const displayed = [...nodes.map((n) => ({ id: n.id })), ...entities.map((e) => ({ id: e.id }))];
      edgeHandles = assignEdgeHandles(displayed, layoutEdges, positions);
    }
  };
  runExpandedInvariants();
  mark("инварианты раскрытий");

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
  mark("раздвижка под плашки (A10)");

  // ЗАСЕВ ВЛАДЕНИЯ (own-on-first-render): каждая отображаемая сущность без
  // сохранённой позиции получает её навсегда — на финальных позициях (после
  // колец + enforce + разведения). Засеиваются ЛОКАЛЫ уровня (2026-08-05:
  // стабильность холста — невладеемые локалы ELK пере-размещал при КАЖДОМ
  // изменении графа, и схема «съезжала» при создании узла/связи), гости
  // (авто-кольцо, новички вложенного раскрытия — их разведённая позиция),
  // дети раскрытых ЛОКАЛОВ (R5: сетка первого показа) и рамки раскрытий.
  // Здесь — только ИНТЕНТ; применяет вызывающий (архитектор, основной канвас, прогон не
  // устарел). Зеркало кладёт позицию в viewLayout → следующий прогон видит сохранённую,
  // и засев её пропускает.
  const seeds = collectGhostSeeds(
    [...nodes, ...entities, ...localFrames],
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
  // Отработали ли стадии качества по-настоящему (не пропуск P10 и не кэш-хит) —
  // слагаемое гейта авторитетности прогона (см. authoritative ниже).
  let ranQualityStages = false;
  // Бюджет работ роутера (P12): создаётся В МОМЕНТ старта стадий качества — его отметка
  // расхода снимается со счётчика экспансий, и всё, что натикает дальше, есть расход
  // ЭТОГО прогона. null — стадии не запускались (пропуск P10 / кэш-хит): бюджету нечего
  // мерить, ступеней нет. Значение ВОЗВРАЩАЕТ сам runEdgeQualityStages (а не пишет в
  // замыкание): присваивание внутри замыкания tsc в поток управления не заводит, и
  // чтение ниже сузилось бы до never.
  let runBudget: RouteBudget | null = null;
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
  // Рамки на финальных позициях. Нативные (breadcrumb) нужны только как ГЕОМЕТРИЯ
  // КОНЦА — препятствием/воротами они не были и не становятся (всё содержимое уровня
  // лежит внутри них).
  const finalFrames = computeFrames({
    localIds: frameLocals,
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
  });
  mark("рамки+засев");
  // Раскрытые рамки для роутера (V2.4, container-aware): граница рамки — штраф за
  // переход (чужие рёбра обходят, внутренние не выскакивают, ребро внутрь платит один
  // переход — «ворота» выбирает A*), плашка подписи — жёсткое препятствие. Позиции
  // здесь финальные — rect тот же, что у compound-рамок сборки.
  const routerFrames = finalFrames
    .filter((f) => !f.native)
    .map((f) => ({
      id: f.id,
      rect: f.rect,
      // плашка подписи: слева-внизу рамки (nodes.tsx FrameNode), ширина — моноширинная
      // оценка «🔍 имя ✕» с паддингами. Формула — в frames.ts (framePlaqueRect):
      // она константа контракта маршрутов и обязана быть видима реестру ROUTER_VERSION.
      plaque: framePlaqueRect(f.rect, f.name),
      memberIds: f.memberIds,
    }));

  // КОНЦЫ-РАМКИ: прямоугольник рамки становится телом стыковки — роутер раздаёт по нему
  // те же 12 портов, что по узлу. В препятствия рамка при этом НЕ идёт (внутри неё живут
  // её же узлы, и жёсткое тело заперло бы их связи) — она остаётся мягкой границей со
  // штрафом перехода, как и была.
  const frameEndpoints = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const f of finalFrames) {
    if (frameIds.has(f.id)) frameEndpoints.set(f.id, f.rect);
  }
  const hasGeometry = (id: string): boolean => !!positions.get(id) || frameEndpoints.has(id);

  // КАНДИДАТЫ РОУТИНГА — рёбра с позиционированными концами, ДО применения скоупа:
  // это знаменатель порога отказа авто-скоупа и область его замыкания по стволам.
  const routeCandidates = new Set<string>();
  for (const g of groupArr) {
    if (!hasGeometry(g.source) || !hasGeometry(g.target)) continue;
    routeCandidates.add(g.id);
  }
  // АВТО-СКОУП (Ф3 эпика router-opt, спека edge.md E84): явного скоупа драга нет, но
  // есть снимок прошлой сцены и её маршруты → конвейер вычисляет скоуп САМ, диффом
  // ФИНАЛЬНЫХ позиций (здесь они уже финальны: инварианты, A10 и рамки отработали).
  // В отличие от скоупа драга это множество РЁБЕР, а не узлов. null — «инкрементальный
  // путь не применим» (нечего пересчитывать либо изменений слишком много): дальше всё
  // идёт прежним полным путём.
  const scopeStats = { changedNodes: 0, rawScope: 0 };
  const autoScopeEdges = scopeSet === null && prevScene && prevRoutes
    ? computeIncrementalScope({
      positions, sizes: sizeMap, prevScene, groups: groupArr,
      candidates: routeCandidates, prevRoutes, stats: scopeStats,
      // рамки-ОБЛАСТИ (раскрытые, они же routerFrames) + родные рамки, служащие ТЕЛОМ
      // СТЫКОВКИ (frameEndpoints): у вторых region = false — их rect охватывает всю
      // сцену, в грязную зону ему нельзя, но сдвиг их членов обязан перепроложить
      // рёбра, состыкованные в саму рамку (E40).
      frames: finalFrames
        .filter((f) => !f.native || frameEndpoints.has(f.id))
        .map((f) => ({ id: f.id, rect: f.rect, memberIds: f.memberIds, region: !f.native })),
    })
    : null;
  // ЕСТЬ ЛИ СКОУП ВООБЩЕ: любая из двух механик включает заморозку незаскоупленных
  // рёбер (preplaced-контекст + restoreFrozen после каждого прохода) и снимает
  // авторитетность прогона. Ветви ниже смотрят СЮДА, а не на scopeSet — путь драга при
  // этом байт-в-байт прежний (при заданном scopeNodeIds авто-скоуп не считается вовсе).
  const scoped = scopeSet !== null || autoScopeEdges !== null;
  {
    const diagG = globalThis as unknown as { __ARCHMAP_SCOPE_DIAG?: (d: ScopeDiag) => void };
    diagG.__ARCHMAP_SCOPE_DIAG?.({
      candidates: routeCandidates.size,
      changedNodes: scopeStats.changedNodes,
      rawScope: scopeStats.rawScope,
      autoScope: autoScopeEdges ? autoScopeEdges.size : null,
      autoScopeIds: autoScopeEdges ? [...autoScopeEdges] : [],
    });
  }
  const routableIds = new Set<string>();
  for (const g of groupArr) {
    if (!routeCandidates.has(g.id)) continue;
    if (scopeSet && !scopeSet.has(g.source) && !scopeSet.has(g.target)) continue;
    if (autoScopeEdges && !autoScopeEdges.has(g.id)) continue;
    routableIds.add(g.id);
  }
  // СИГНАТУРА ВХОДОВ РОУТИНГА. Считается ЗДЕСЬ — ДО стадий качества (Ф2 эпика
  // router-opt): все её входы (позиции, габариты, группы, скоуп, рамки) уже готовы,
  // а совпадение с prev делает сами стадии лишними (см. дальше). До Ф2 сверка стояла
  // ПОСЛЕ стадий и только гасила осцилляции — результат был тот же, а счёт полный.
  const routeSig = buildRouteSig(displayIds, positions, sizeMap, groupArr, routableIds, routerFrames);
  // КЭШ-ХИТ ПО СИГНАТУРЕ (он же — прежнее ГАШЕНИЕ ОСЦИЛЛЯЦИЙ, 2026-08-06). Входы
  // роутинга совпали с прошлым прогоном ПО БИТАМ → результат берётся ЦЕЛИКОМ из prev.
  // ЭКВИВАЛЕНТНОСТЬ: sig покрывает ВСЁ, что видят роутер и плашки (позиции/габариты
  // отображаемых, мастер-рёбра с подписями и routable-флагом, рамки с плашками), а
  // константы алгоритмов сторожит ROUTER_VERSION (routerVersion.ts) — значит полный
  // прогон вернул бы ровно prev, и подстановка байт-в-байт равна счёту. Более того,
  // удержание prev — ЕДИНСТВЕННЫЙ фикспойнт: роутер не идемпотентен относительно prev
  // (гистерезис осциллирует — асимметрия раздачи слотов free/pinned + обратная связь
  // маршрут↔плашка T4), и без этой ветки пара рёбер по очереди отжимала бы слоты.
  const cacheHit = prevRouteSig === routeSig && !!prevRoutes && !!prevEdgeHandles && !!prevLabelPlacements;
  // СТАДИИ КАЧЕСТВА СТРЕЛОК (роутер → нуджинг → джоги → плашки → T4) — локальный
  // блок, чтобы фолбэк-прогон двухфазного замера (edgeQuality: "skip") мог
  // пропустить их целиком (Ф3). Пишут во внешние autoRoutes/labelPlacements/
  // edgeHandles; await внутри нет.
  const runEdgeQualityStages = (): RouteBudget => {
  // БЮДЖЕТ РАБОТ — ПЕРВЫМ ДЕЙСТВИЕМ СТАДИЙ (P12): отметка расхода снимается здесь, класс
  // сцены — по P1 (отображаемые узлы против мастер-рёбер). Априорный контур решает всё
  // тут же, до первой экспансии: прогноз работ по размеру сцены выше лимита класса →
  // ступени включены с самого старта, а не после сжигания бюджета до первой границы.
  const budget = createRouteBudget({
    nodes: displayIds.length, edges: groupArr.length, config: input.routeBudget,
  });
  const ar = buildAutoRoutes({
    groups: groupArr, routableIds, positions,
    displayIds, sizes: sizeMap, frames: routerFrames, frameEndpoints,
    // гистерезис: финальные маршруты/хэндлы прошлого прогона (если вызывающий дал)
    prev: prevRoutes && prevEdgeHandles ? { routes: prevRoutes, handles: prevEdgeHandles } : undefined,
    budget,
  });
  autoRoutes = ar.routes;
  mark("роутер: A*+rip-up+слоты+сварка (проход 1)");
  // СКОУП: buildAutoRoutes вернул маршруты только заскоупленных рёбер; незаскоупленные
  // (инцидентные прочим узлам) берём из prevRoutes — они зафиксированы как preplaced и
  // сохраняют прежнюю геометрию (иначе потеряли бы маршрут и отвалились на smoothstep).
  if (scoped && prevRoutes) {
    for (const g of groupArr) {
      if (routableIds.has(g.id) || autoRoutes.has(g.id)) continue;
      const pr = prevRoutes.get(g.id);
      if (pr && pr.length >= 2) autoRoutes.set(g.id, pr.map((p) => ({ x: p.x, y: p.y })));
    }
  }
  // A8: выбранные роутером стороны → хэндлы (RF состыкует стрелку там).
  for (const [id, hh] of ar.handles) edgeHandles.set(id, hh);
  // хэндлы незаскоупленных рёбер — из прошлого прогона (их маршрут не менялся)
  if (scoped && prevEdgeHandles) {
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
  if (scoped) {
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
  mark("нуджинг каналов");

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
  mark("спрямление джогов");

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
  mark("плашки подписей (проход 1)");

  // ПЛАШКИ → ПРЕПЯТСТВИЯ МАРШРУТОВ (T4 «читаемые пучки», один мини-проход): линия
  // сквозь чужой текст нечитаема. ПОРЯДОК УСТУПКИ (E40 v2, Ф4-II эпика «глубокая
  // оптимизация роутера»): конфликт сначала пробуют снять ПЛАШКОЙ — переставить её
  // стоит миллисекунды перебора, а перепроложить ребро — полноценный A* по штрафному
  // ландшафту (половина цены конвейера). Остаток — прежним путём: «грязные» рёбра
  // перепрокладываются со штрафом LABEL_CROSS_COST за переход границы чужой плашки
  // (своя не отталкивает), прочие маршруты — фиксированный контекст prev; после —
  // доводка нуджинга, пере-размещение плашек по изменённой геометрии и ТА ЖЕ починка
  // поверх него (финальный гриди мягок и имеет право снова сесть на линию).
  // Второй итерации МИНИ-ПРОХОДА (перепрокладка → плашки → перепрокладка) нет
  // осознанно: сдвинутая плашка теоретически может лечь на другую линию — редкий
  // остаток, не стоит цикла.
  //
  // СТУПЕНЬ ДЕГРАДАЦИИ «ПРОПУСК T4» (P13, ступень 4). Точка осуществимости — ровно
  // здесь, ПЕРЕД блоком: мини-прохода ещё не было, а сцена без него полностью валидна
  // (так она и жила до эпика «читаемые пучки»). Цена ступени названа честно: линии
  // остаются сквозь чужие плашки — теряется читаемость подписей, и вместе с
  // перепрокладкой уходит дешёвый слой Б3б «плашка уступает первой» (он живёт внутри
  // этого же блока). Ступень последняя: её точка — та, где почти вся цена ещё впереди
  // (T4 держит ~48% прогона).
  const skipT4 = budget.takeT4();
  if (!skipT4) {
    // ПРЯМОУГОЛЬНИКИ ПЛАШЕК по ТЕКУЩЕМУ размещению (пересчитывается после починки).
    const labelRectsNow = (): Map<string, { x: number; y: number; w: number; h: number }> => {
      const out = new Map<string, { x: number; y: number; w: number; h: number }>();
      for (const g of groupArr) {
        const lp = labelPlacements?.get(g.id);
        const meta = edgeLabelMeta(g);
        if (!lp || !meta) continue;
        const box = metaLabelBox(meta);
        out.set(g.id, {
          x: lp.center.x - box.w / 2, y: lp.center.y - box.h / 2, w: box.w, h: box.h,
        });
      }
      return out;
    };
    // КОНФЛИКТЫ «маршрут ребра A режет плашку группы B» — пары (A, B) в детерминированном
    // порядке (id ребра, затем id плашки). СКОУП: перепрокладывать можно только
    // заскоупленные (незаскоупленные заморожены, иначе дрейф — E82/E84), но ПОЧИНИТЬ
    // ПЛАШКУ можно и от замороженной линии: плашки и так размещаются по всей сцене
    // каждый прогон (компромисс 4 в E84) — поэтому источником конфликта служит ЛЮБОЙ
    // маршрут, а в перепрокладку идут только заскоупленные виновники.
    const collectConflicts = (
      rects: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>,
    ): { pairs: [string, string][]; dirty: Set<string>; victims: Set<string> } => {
      const pairs: [string, string][] = [];
      const dirty = new Set<string>();
      const victims = new Set<string>();
      const ids = groupArr.map((g) => g.id).sort();
      const labelIds = [...rects.keys()].sort();
      for (const id of ids) {
        const rt = autoRoutes?.get(id);
        if (!rt) continue;
        for (const gid of labelIds) {
          if (gid === id) continue;
          const r = rects.get(gid);
          if (!r || !pathCrossesRects(rt, [r])) continue;
          pairs.push([id, gid]);
          victims.add(gid);
          if (!scoped || routableIds.has(id)) dirty.add(id);
        }
      }
      return { pairs, dirty, victims };
    };
    // Б3б («СНАЧАЛА ПОДВИНЬ ПЛАШКУ», E40 v2). Плашка-жертва пробует УСТУПИТЬ режущим её
    // стрелкам: переезд принимается, только если режущих стало строго меньше, а жёстких
    // наложений (узлы/чужие плашки) не прибавилось (placeLabels repair). Ушла из-под всех
    // — рёбра, грязные только из-за неё, снимаются с перепрокладки; не вышло — остаётся
    // где была, и виновники идут прежним путём (дорогой A* по штрафному ландшафту).
    // Порядок пере-размещения — канонический E53 (стеснённые первыми, тай-брейк id):
    // переехавшая плашка немедленно становится препятствием следующим.
    // МУТАЦИЯ, А НЕ ПРОБА: финальный гриди переразмещает плашки по СВОИМ мягким
    // правилам (E52 — чужое плечо лишь второй компонент ключа), поэтому «B умеет
    // встать чисто» само по себе плашку не двигает; см. финальную починку ниже.
    const repairLabels = (
      rects: Map<string, { x: number; y: number; w: number; h: number }>,
      victims: ReadonlySet<string>,
    ): number => {
      if (victims.size === 0 || !autoRoutes) return 0;
      const others: { x: number; y: number; w: number; h: number }[] = [];
      for (const [gid, r] of rects) if (!victims.has(gid)) others.push(r);
      const moved = buildLabelPlacements({
        routes: autoRoutes,
        groups: groupArr,
        labelMeta: edgeLabelMeta,
        preferredT: () => undefined,
        nodeRects,
        obstacleRects: others,
        repair: { only: victims, keepRectOf: rects },
      });
      if (moved.size === 0) return 0;
      const merged = new Map(labelPlacements);
      for (const [id, lp] of moved) merged.set(id, lp);
      labelPlacements = merged;
      return moved.size;
    };
    // ВТОРОЙ ИТЕРАЦИИ ПОЧИНКИ НЕТ: она сошлась бы (переезд обязан строго уменьшать число
    // режущих стрелок, маршруты внутри починки не двигаются — счёт монотонно убывает), но
    // ЗАМЕР показал фикспойнт уже на первом проходе (4 эталонные сцены: 5/14/3/0 переездов
    // на первой итерации, 0 на второй) — отказавшей плашке освободившееся место соседки не
    // помогает. Лишний проход по 60–128 плашкам ради нуля не берём.
    let labelRectOf = labelRectsNow();
    const before = collectConflicts(labelRectOf);
    const movedCount = repairLabels(labelRectOf, before.victims);
    if (movedCount > 0) labelRectOf = labelRectsNow();
    // Пересчёт грязных ПО ПОЧИНЕННЫМ плашкам — полным сканом: переезд обязан лишь
    // УМЕНЬШИТЬ число режущих стрелок, а не обнулить его, поэтому уехавшая плашка
    // теоретически может подставиться под другую линию. Скан по прямоугольникам дёшев
    // (доли миллисекунды против секунд A*), гадать тут незачем.
    const dirty = movedCount > 0 ? collectConflicts(labelRectOf).dirty : before.dirty;
    // ДИАГНОСТИЧЕСКИЙ ХУК T4 (Ф0): по образцу __ARCHMAP_TRACE — без выставленного
    // хука мёртвый no-op, ни одного лишнего вычисления в проде. Всё содержимое
    // (в т.ч. лестница inset'ов глубины вреза) считается только здесь.
    const diagG = globalThis as unknown as { __ARCHMAP_T4_DIAG?: (d: T4Diag) => void };
    const t4diag = diagG.__ARCHMAP_T4_DIAG;
    // Хук зовётся ОДИН раз в конце блока — числа финальной починки известны только там.
    let diagPayload: T4Diag | null = null;
    if (t4diag) {
      const dirtyIds = [...dirty];
      const frameEndDirtyIds: string[] = [];
      for (const g of groupArr) {
        if (!dirty.has(g.id)) continue;
        if (frameIds.has(g.source) || frameIds.has(g.target)) frameEndDirtyIds.push(g.id);
      }
      const INSETS = [2, 4, 6, 8, 10];
      const cutDepths = dirtyIds.map((id) => {
        const rt = autoRoutes?.get(id) ?? [];
        const foreign: { x: number; y: number; w: number; h: number }[] = [];
        for (const [gid, r] of labelRectOf) if (gid !== id) foreign.push(r);
        let depth = 12; // режет даже плашку, сжатую на 10 — «глубже 10»
        for (const k of INSETS) {
          const shrunk = foreign
            .map((r) => ({ x: r.x + k, y: r.y + k, w: r.w - 2 * k, h: r.h - 2 * k }))
            .filter((r) => r.w > 0 && r.h > 0);
          if (!pathCrossesRects(rt, shrunk)) { depth = k; break; }
        }
        return { id, depth };
      });
      diagPayload = {
        dirtyIds, frameEndDirtyIds, cutDepths,
        labelFirst: {
          conflicts: before.pairs.length,
          dirtyBefore: before.dirty.size,
          victims: before.victims.size,
          moved: movedCount,
          solvedEdges: before.dirty.size - dirty.size,
        },
      };
    }
    if (dirty.size > 0) {
      const ar2 = buildAutoRoutes({
        groups: groupArr, routableIds: dirty, positions,
        // КОНЦЫ-РАМКИ — ТЕМ ЖЕ ЗНАЧЕНИЕМ, ЧТО В ПРОХОДЕ 1 (закрытие дыры В8.1, Ф4
        // эпика router-opt): без них у ребра, состыкованного в рамку, нет тела
        // стыковки — buildAutoRoutes отбраковывает его терминал (`if (!sr || !tr)
        // continue`) и молча возвращает мини-проход без этого ребра. Дыра означала,
        // что E40 к рёбрам с концом-рамкой не применялся НИКОГДА: их линия сквозь
        // чужую плашку оставалась навсегда.
        displayIds, sizes: sizeMap, frames: routerFrames, frameEndpoints,
        prev: { routes: autoRoutes, handles: edgeHandles },
        labelObstacles: labelRectOf,
        gridHintGroups: T4_FULL_GRID_HINTS ? groupArr : undefined,
        // Тот же бюджет: внутри мини-прохода живут СВОИ rip-up и сварка, и их ступени
        // (P13 №2 и №3) обязаны действовать здесь так же, как в проходе 1.
        budget,
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
        // ФИНАЛЬНАЯ ПОЧИНКА (Б3б). Гриди выше — ИСТОЧНИК ПРАВДЫ размещения, и он честно
        // переразмещает ВСЁ по мягким правилам E52: плашка, которую Б3б увёл с линии,
        // могла вернуться на линию (уже другую — маршруты грязных изменились). Тот же
        // проход починки поверх финала держит инвариант E40 v2 «плашка уступает первой»
        // и на финальной геометрии. Перепрокладки за ним НЕТ — второй итерации T4
        // по-прежнему нет осознанно (E40); чинится только слой плашек, и он
        // идемпотентен (переехавшая плашка чиста, повторный проход — no-op).
        const finalRects = labelRectsNow();
        const fin = collectConflicts(finalRects);
        const finMoved = repairLabels(finalRects, fin.victims);
        if (diagPayload) {
          diagPayload.finalRepair = {
            conflicts: fin.pairs.length, victims: fin.victims.size, moved: finMoved,
          };
        }
      }
    }
    if (t4diag && diagPayload) t4diag(diagPayload);
  }
  // Марка одна в обеих ветвях: трасса реплея/теста обязана ЯВНО показывать, что
  // мини-прохода не было и почему (иначе «у пользователя сработало, у нас нет»).
  mark(skipT4
    ? "T4 мини-проход: ПРОПУЩЕН (ступень бюджета работ, P13)"
    : "T4 мини-проход (плашки-препятствия)");
  return budget;
  };
  // АВТО-порог пропуска (edgeQuality не задан): И минимум штук, И доля сцены —
  // единичные новые узлы (создание из палитры) не роняют все стрелки в
  // smoothstep (мигание сцены хуже секундного лага), а bulk-спавн (раскрытие,
  // первый показ) пропускает заведомо выбрасываемый прогон.
  const UNMEASURED_SKIP_MIN = 3;
  const UNMEASURED_SKIP_SHARE = 0.05;
  const unmeasured = displayIds.reduce((k, id) => k + (sizeMap.has(id) ? 0 : 1), 0);
  const skipByUnmeasured = input.edgeQuality === "skip" || (
    input.edgeQuality === undefined &&
    unmeasured >= UNMEASURED_SKIP_MIN &&
    unmeasured >= UNMEASURED_SKIP_SHARE * Math.max(1, displayIds.length)
  );
  // ВТОРОЕ ОСНОВАНИЕ ПРОПУСКА (расширение P10): состав сцены неполон — раскрытия ждут
  // своих детей. Прогон повторится по их приходу, и его маршруты будут выброшены ровно
  // так же, как маршруты незамеренного прогона; жертва промежуточного кадра smoothstep
  // санкционирована тем же решением. Явные "full"/"skip" не переопределяем.
  const skipByPending = input.edgeQuality === undefined && hasPendingChildren;
  const skipQuality = skipByUnmeasured || skipByPending;
  // Порядок ветвей: КЭШ-ХИТ СИЛЬНЕЕ ПРОПУСКА P10. Совпадение sig доказывает, что
  // геометрия, которую увидел бы роутер, тождественна прежней (незамеренный узел и
  // узел, замеренный ровно в NODE_W×NODE_H, дают один токен sig — и один и тот же
  // realRectOf), поэтому prev здесь не «протухшие маршруты фолбэк-прогона», а
  // законный результат. Цель P10 (не жечь счёт, который выбросят) соблюдена: стадии
  // не исполняются ни в одной из двух ветвей. Выигрыш — сцена открывается сразу со
  // стрелками, а не с промежуточным кадром smoothstep.
  if (cacheHit && prevRoutes && prevEdgeHandles && prevLabelPlacements) {
    autoRoutes = prevRoutes;
    edgeHandles = new Map(prevEdgeHandles);
    labelPlacements = prevLabelPlacements;
    mark("стадии качества стрелок: кэш-хит по routeSig");
  } else if (!skipQuality) {
    runBudget = runEdgeQualityStages();
    ranQualityStages = true;
  } else {
    mark(skipByUnmeasured
      ? "стадии качества стрелок: пропущены (незамеренная сцена, авто/skip)"
      : "стадии качества стрелок: пропущены (недогруженные дети раскрытий)");
  }

  // АВТОРИТЕТНОСТЬ ПРОГОНА (гейт записи персистного кэша маршрутов вида, P11):
  // результат годится в кэш, только если он равен тому, что дал бы ПОЛНЫЙ прогон на
  // полных замерах и полном составе. Условия: стадии качества реально отработали ИЛИ
  // пришёл кэш-хит по sig (обе ветви дают финальную геометрию); НЕТ незамеренных узлов
  // (фолбэк NODE_W×NODE_H — не те тела, что увидит рендер); прогон НЕ скоуплен НИ ОДНОЙ
  // из двух механик — ни драгом, ни авто-скоупом Ф3 (при скоупе часть маршрутов —
  // замороженный prev-контекст); СОСТАВ ПОЛОН — раскрытия не
  // ждут детей (полевая находка приёмки Ф2: частичный 17-узловой прогон корня имел
  // unmeasured = 0 и затирал кэш полной 34-узловой сцены); состав НЕ ПУСТ (нулевой
  // прогон до прихода данных — не «сцена без стрелок», а «данных ещё нет»).
  // СТУПЕНИ БЮДЖЕТА ЭТОГО ПРОГОНА (P13): null — ни одна не срабатывала.
  const budgetDegraded = runBudget?.result() ?? null;
  const authoritative = (ranQualityStages || cacheHit)
    && unmeasured === 0 && !scoped
    && !hasPendingChildren && displayIds.length > 0
    // ДЕГРАДИРОВАННЫЙ ПРОГОН НЕ АВТОРИТЕТЕН (P13): его геометрия — не то, что дал бы
    // полный прогон, и в кэше вида (P11) она жила бы, пока не изменится сама сцена.
    // Прогон со ступенями показывается, но не консервируется.
    && budgetDegraded === null;

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
  // Это те же finalFrames, что видел роутер: позиции с тех пор не менялись (роутинг,
  // нуджинг и плашки их не трогают), и второй пересчёт давал бы ровно то же самое.
  const guestFrames: FrameRect[] = finalFrames.filter((f) => !f.native);

  // ЯКОРЬ РОДНОЙ РАМКИ УРОВНЯ: отдаём rect наружу, только если в него реально что-то
  // упирается. Сборка повесит на него невидимый RF-узел — RF нужен узел с этим id,
  // иначе связь молча не отрисуется. Сама рамка остаётся оверлеем.
  // На ПУСТОМ уровне рамка отдаётся ВСЕГДА, даже если своих связей у контейнера нет:
  // слой — это внутренность родителя, и это видно сразу; заодно рамка служит внятной
  // целью для дропа первого узла.
  const levelFrame = containerId !== null
      && (emptyLevel || groupArr.some((g) => g.source === containerId || g.target === containerId))
    ? finalFrames.find((f) => f.id === containerId && f.native)
    : undefined;

  // Рамки, в которые реально что-то упирается (вход перепривязки конца).
  const frameEnds = [...new Set(
    groupArr.flatMap((g) => [g.source, g.target]).filter((id) => frameIds.has(id)),
  )];

  return {
    layout: {
      nodes, entities, positions, edgeHandles, edgeShelves, edgeLoops,
      autoRoutes, labelPlacements, guestFrames, levelFrame, frameEnds, groupArr, spacers,
    },
    liveInputs: {
      layoutEdges,
      nodeIds: [...nodes.map((n) => ({ id: n.id })), ...entities.map((e) => ({ id: e.id }))],
      localIds: new Set(nodes.map((n) => n.id)),
      route: liveRoute,
    },
    intents,
    routeSig,
    authoritative,
    budgetDegraded,
  };
}
