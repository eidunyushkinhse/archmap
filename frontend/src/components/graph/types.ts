// Общие типы графа уровня. Импортирует только типы — ни от чего не зависит во
// время выполнения. FrameDef намеренно НЕ здесь: он локален для boundaries.tsx.
import type { Node as RFNode } from "@xyflow/react";
import type {
  Node as AppNode, GhostNode, Edge as AppEdge, AncestorRef, EdgePoint, LayoutEdge,
  NodeShape, ViewLayoutPayload,
} from "../../types";
import type { EdgeSide } from "./edgePath";
import type { SchemaView } from "../schemaView";
import type { History } from "./interaction/useHistory";

// Живой снимок версий конкурентности (этап 0/1, docs/archive/plan-concurrency.md):
// version — fence вида, graphRev — курсор изменений проекта.
export type ViewMetaState = { version: number; graphRev: number; metaRev?: number };

// Запрос фокуса на объекте/связи/группе. ids: для node — [nodeId]; для edge — [edgeId];
// для group — id всех узлов кластера. token — монотонный счётчик из MapEditorPage.
export type LocateRequest = {
  kind: "node" | "edge" | "group";
  ids: string[];
  // Для kind="edge": сырые концы связи из алерта. Фолбэк, когда самой связи нет
  // среди отрисованных (конец = раскрытый контейнер — проекция её скрывает,
  // E6/C19): фокусируем ПРЕДСТАВИТЕЛЕЙ концов (узел или рамку — id совпадает).
  endIds?: string[];
  token: number;
};

// Группа связей одного направления между парой отображаемых узлов, слитая в одну
// «мастер-стрелку» (members.length > 1) либо одиночная связь (members.length === 1).
// id — id одиночной связи или синтетический `merge:src->tgt`. Раскладку/хэндлы
// считаем на мастер-рёбрах (по одной на направление между парой).
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
  // основная/level схема: авто-маршрут глобального роутера (R1+R3) — ортоломаная с
  // минимумом пересечений и обходом узлов, посчитанная на раскладке. Концы edges.tsx
  // переснимает с живых хэндлов, интерьерные изломы — из этого снимка.
  autoRoute?: EdgePoint[];
  // авто-размещение плашки подписи (эпик стрелок, R2+R4): center — куда ставить плашку,
  // anchor — точка на линии (в режиме leader от неё рисуется поводок к вынесенной плашке;
  // в режиме online anchor совпадает с center). leaderEnd — конец поводка у края плашки (A15,
  // чтобы пунктир не прятался под плашкой). Считается по авто-маршруту на раскладке.
  // Плашка НЕ двигается руками (заморожена вместе с удалением ручного слоя, 2026-07-09).
  labelPlacement?: { mode: "online" | "leader"; center: EdgePoint; anchor: EdgePoint; leaderEnd: EdgePoint };
  // архитекторский канвас: у безымянной связи рисуется плейсхолдер-плашка «•••»
  // (точка входа в детали); сама геометрия стрелок руками не правится
  editable?: boolean;
  // открыть поповер информации о связи (клик по плашке с описанием). Задаётся
  // только для level-рёбер (в контексте схема только для просмотра).
  onOpenDetails?: () => void;
  // приглушено фильтром «Вид схемы»: конец ребра в скрытом статусе. Линия рисуется
  // полупрозрачной (style.opacity ставит LevelGraph), а здесь гасим ещё и плашку подписи.
  dimmed?: boolean;
  // идёт анимированная ОТРИСОВКА стрелки после раскрытия/сворачивания (useLayoutAnimation):
  // линия рисуется штрихом от исходного хэндла к целевому (CSS lg-edge-drawin,
  // pathLength=1 + stroke-dashoffset), маркер-наконечник и плашка скрыты до конца
  // отрисовки. Флаг ставит и снимает оркестратор анимации по таймеру drawSpanMs.
  drawIn?: boolean;
  // Ф5, каскад отрисовки: задержка старта волны этого ребра (animation-delay, мс).
  // Ставится markDrawIn только при DRAW_CASCADE и только ненулевая (нормальная
  // форма для реконсиляции); fill-mode both держит линию пустой до старта волны.
  drawInDelay?: number;
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
  // Число детей для бейджа «есть дети (N)» и гейта лупы: read-only (страница) —
  // РЕЛЕВАНТНЫЕ дети (с граничным ребром на схеме, X16 v2); редактор — все дети
  // по child_count (Д3).
  badgeCount: number;
  // «Войти» — дрилл на слой узла. Задаётся только в редакторе (drill-навигация);
  // на странице объекта (read-only блок) undefined → кнопки нет, навигация —
  // двойной клик на страницу объекта + лупа инлайн-раскрытия (onExpand).
  onDrillDown?: (node: AppNode) => void;
  isArchitect: boolean;
  colors: NodeColors;
  // прячет ВСЕ кнопки действий (включая лупу); сейчас всегда false — страничный
  // read-only режим гейтится отсутствием самих колбэков (onDrillDown/onEnter)
  hideActions?: boolean;
  // можно ли НАЧАТЬ связь с хэндлов узла (архитектор, не контекст-режим) — раскрытие
  // хэндлов по ховеру для протягивания новой стрелки
  connectable?: boolean;
  // «быстрая связь» по стрелке-кнопке у хэндла (только когда connectable)
  quickConnect?: QuickConnectHandlers;
  // раскрыть содержимое ЛОКАЛЬНОГО контейнера инлайн (R5): лупа у сервиса с
  // детьми — узел заменяется рамкой со всеми детьми. undefined — кнопки нет.
  onExpand?: (id: string) => void;
  // узел С ДЕТЬМИ на предельной инлайн-глубине (C8): лупа рисуется, но неактивна и
  // по клику объясняет предел. Взаимоисключимо с onExpand.
  expandLimited?: boolean;
}

export interface GhostData extends Record<string, unknown> {
  appNode: GhostNode;
  colors: NodeColors;
  connectable?: boolean;
  quickConnect?: QuickConnectHandlers;
  // войти к компонентам гостя: открыть его слой-схему (колбэк уже замкнут на путь
  // гостя). Задаётся только в редакторе (drill-навигация); undefined (read-only
  // блок на странице) → кнопки нет. Показ кнопки дополнительно гейтится
  // appNode.has_children (атомарному некуда входить).
  onEnter?: () => void;
}

// Свёрнутый узел-контейнер соседней ветки (напр. ProdMon) — с кнопкой-лупой.
export interface ContainerData extends Record<string, unknown> {
  id: string;
  name: string;
  depth: number;
  ancestors: AncestorRef[];
  colors: NodeColors;
  // раскрыть содержимое ГОСТЕВОГО контейнера инлайн (R5). undefined — контейнер уже
  // на предельной инлайн-глубине MAX_INLINE_DEPTH (C8): лупа остаётся на месте, но
  // неактивна (expandLimited), глубже — только «Войти к компонентам».
  onExpand?: (id: string) => void;
  // предельная инлайн-глубина достигнута: неактивная лупа с объяснением (C8)
  expandLimited?: boolean;
  // войти к компонентам контейнера: открыть его слой-схему (колбэк замкнут на его
  // путь). Контейнер всегда промежуточный (содержит спроецированного гостя), поэтому
  // кнопка показывается всегда, когда задан колбэк. Задаётся только в редакторе;
  // undefined (read-only блок на странице) → кнопки нет.
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

// ЯКОРЬ РОДНОЙ РАМКИ (эпик «связи, упирающиеся в рамку»): невидимый RF-узел на
// прямоугольнике рамки контейнера УРОВНЯ. Нужен только затем, чтобы RF было к чему
// пристыковать связь, чей конец — сам контейнер: сама рамка остаётся оверлеем
// LevelBoundary (ему нужен живой bbox-follow за драгом), а рисовать её вторым слоем
// нельзя. Узел ничего не рендерит, кроме 12 точек стыковки.
export type FrameDockRFNode = RFNode<Record<string, unknown>, "framedock">;

export type BlockRFNode = RFNode<BlockData, "block">;
export type GhostRFNode = RFNode<GhostData, "ghost">;
export type ContainerRFNode = RFNode<ContainerData, "container">;
export type FrameRFNode = RFNode<FrameData, "frame">;

// --- Проекция гостей с учётом свёрнутых контейнеров ---

export interface DisplayContainer { kind: "container"; id: string; name: string; depth: number; ancestors: AncestorRef[]; is_external: boolean; }
export interface DisplayLeaf { kind: "leaf"; id: string; ghost: GhostNode; }
export type DisplayExternal = DisplayContainer | DisplayLeaf;

// --- Бандлы пропсов LevelGraph (Фаза 3д) -------------------------------------
// Плоские ~43 пропса LevelGraph сгруппированы в связные доменные бандлы, чтобы
// интерфейс компонента не был god-object'ом (аудит рефакторинга). Поведение НЕ
// меняется: LevelGraphInner деструктурирует бандлы обратно в те же плоские имена,
// вынесенные хуки получают прежние члены. Бандлы в точках вызова мемоизируются
// (useMemo) для ссылочной стабильности — канвас чувствителен к ре-рендерам.

// Персист раскладки вида (fence + политика 409 + зеркало родителю). Всё опционально:
// read-only страницы бандл не передают — записи гейтятся readOnly внутри канваса.
export interface LevelPersistenceProps {
  // Раскладка вида изменена и сохранена (батч view_layout) — родитель зеркалит те же
  // значения в свой стейт. ЕДИНСТВЕННЫЙ канал зеркалирования раскладки (R3).
  onLayoutChanged?: (items: Record<string, ViewLayoutPayload | null>) => void;
  // Фоновый персист упал — родитель возвращает зеркало к истине (ресинк уровня из БД).
  onPersistError?: (e: unknown) => void | Promise<void>;
  // Живой снимок версий (fence записей): читается при каждой записи, обновляется из PUT.
  viewMeta?: { current: ViewMetaState };
  // Флаг «идёт жест драга» для поллинга: рефетч не врывается в жест. Реф — ноль ре-рендеров.
  gestureActiveRef?: { current: boolean };
  // Канал переигровки 409 user-батча: исходный патч уходит НАВЕРХ (ресинк + возврат патча).
  onPersistConflict?: (patch: Record<string, Partial<ViewLayoutPayload> | null>) => void;
  // Запрос переигровки 409 user-батча (одноразов по token).
  retryPatch?: { patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number } | null;
}

// Флаги режима канваса (read-only / расстановка / центрирование / вид схемы).
export interface LevelModeFlags {
  // Read-only: все жесты правки отключены, рендер уровня и навигация сохраняются.
  readOnly?: boolean;
  // Инспекция связей (двойной клик по стрелке) доступна и в read-only — просмотр, не
  // правка. Дефолт гейтится readOnly (?? !readOnly).
  edgesInspectable?: boolean;
  // Переопределение draggable-узлов: драг даже в readOnly (без персиста). Дефолт — !readOnly.
  nodesDraggable?: boolean;
  // «Только расстановка»: драг/персист/undo ВКЛЮЧЕНЫ, структурная правка ВЫКЛЮЧЕНА.
  arrangeOnly?: boolean;
  // Стартовать свёрнутым: персистные раскрытия вида НЕ применяются (страничные схемы).
  ignorePersistedExpanded?: boolean;
  // Авто-центрирование вида ПОСЛЕ оседания раскладки (встроенные блоки на страницах).
  fitOnLoad?: boolean;
  // Анимированное центрирование при каждом раскрытии узла лупой.
  fitOnExpand?: boolean;
  // Выбранный «Вид схемы» (as-is/переход/to-be). Дефолт «all» (переход).
  schemaView?: SchemaView;
  // «Скрыть подписи связей» (CV32) в УПРАВЛЯЕМОМ режиме: хост владеет тумблером
  // (редактор-карта — кнопка в топбаре, угол холста там занят рейлом алертов) и
  // передаёт состояние сюда; канвас применяет класс и СВОЙ тумблер не рисует.
  // undefined — канвас сам ведёт состояние и рисует тумблер в правом верхнем углу.
  edgeLabelsHidden?: boolean;
}

// Drill-навигация и деталька (двойной клик). onDrillDown/onEditNode обязательны — без
// них канвас не навигирует; остальные опциональны (зависят от контекста/режима).
export interface LevelDrillCallbacks {
  // Дрилл на слой узла (прямой узел уровня / fallback невосстановимой цепочки предков).
  onDrillDown: (node: AppNode) => void;
  // Войти к компонентам гостя/контейнера — открыть слой-схему по полному пути (предки + узел).
  onEnterNode?: (path: AncestorRef[]) => void;
  // Двойной клик по локальному узлу — открыть его в правой панели / на странице.
  onEditNode: (node: AppNode) => void;
  // Двойной клик по ГОСТЮ (проекция чужого узла) — детализация read-only в правой панели.
  onInspectGhost?: (ghost: GhostNode) => void;
  // Двойной клик по РАМКЕ раскрытого узла (её плашке или пустому месту внутри) или по
  // СВЁРНУТОМУ КОНТЕЙНЕРУ гостя: объекта узла у них нет, только id — хозяин сам находит
  // узел (редактор: свой — панель свойств, чужой — панель проекции; страница — переход).
  onInspectNodeId?: (id: string) => void;
  // Двойной клик по пустому холсту — сбросить выделение (подсветку) и правую панель.
  onClearSelection?: () => void;
}

// Колбэки создания и инспекции связей. onEdgesChoice обязателен (даже одиночная связь
// открывает «Выберите связь»); остальные — по контексту (жесты протягивания, общее плечо).
// НАМЕРЕННО НЕ `edges`: так зовётся дата-проп AppEdge[] самого LevelGraph.
export interface LevelEdgeCallbacks {
  // Клик по описанию связи (одиночной или мастер-стрелке) — список для выбора.
  onEdgesChoice: (edges: AppEdge[]) => void;
  // ОБЩЕЕ ПЛЕЧО (E80): двойной клик в точке легального ствола ≥2 связей — модалка с направлением.
  onTrunkChoice?: (kind: "out" | "in", edges: AppEdge[]) => void;
  // Протянули стрелку на ЛИСТОВОЙ узел/хэндл — создать связь. Имена концов едут С ЖЕСТОМ
  // (дети раскрытых ЛОКАЛЬНЫХ контейнеров известны только холсту — родитель их не резолвит).
  onCreateEdge?: (
    sourceId: string, targetId: string,
    sourceHandle: string | null, targetHandle: string | null,
    sourceName?: string, targetName?: string,
  ) => void;
  // Протянули стрелку на узел С ДЕТЬМИ (containerId) — открыть выбор его потомка как
  // дальнего конца межуровневой связи.
  onConnectInto?: (
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null, sourceName?: string,
  ) => void;
  // Конец стрелки отпустили на плитку «вне уровня» — выбор дальнего конца из всей схемы.
  onExitUp?: (sourceId: string, sourceHandle: string | null, sourceName?: string) => void;
  // ПЕРЕПРИВЯЗКА КОНЦА-В-РАМКУ (эпик «связи, упирающиеся в рамку»): единственное
  // исключение из «геометрия связи целиком автоматическая» (edge.md E1) — тянется
  // только тот конец, что упёрся в рамку, и только на узел ВНУТРИ неё. Холст уже
  // проверил попадание; промах сюда не доходит (жест просто отменяется).
  // edgeIds — реальные связи группы (у мастер-стрелки их несколько).
  onReconnectFrameEnd?: (
    edgeIds: string[], end: "source" | "target",
    fromFrameId: string, toNodeId: string,
  ) => void;
}

// Запросы удаления узлов с канваса (клавиатура → подтверждение в родителе).
export interface LevelDeleteCallbacks {
  // Удаление одного выбранного узла (Backspace/Delete по узлу) — подтверждение со связями.
  onRequestDeleteNode?: (node: AppNode) => void;
  // Удаление НЕСКОЛЬКИХ выбранных узлов (Backspace/Delete по рамке) — агрегированное подтверждение.
  onRequestDeleteNodes?: (nodes: AppNode[]) => void;
}

// Дроп шаблона узла из боковой палитры на схему.
export interface LevelDropProps {
  // Отпускание перетянутого шаблона: shape — форма, pos — координаты в системе графа,
  // parentId — контейнер раскрытой рамки под курсором (узел станет его ребёнком) / null (уровень).
  onDropNode?: (shape: NodeShape, pos: { x: number; y: number }, parentId: string | null) => void;
  // Форма шаблона, который СЕЙЧАС перетаскивают (null — драга нет) — для превью-рамки в dragover.
  dragShape?: NodeShape | null;
}

// Undo/Redo: общая история + дисптчеры из страницы-хозяина (кросс-уровневый редирект).
// Без бандла (страницы объекта/проекта) канвас заводит свою локальную историю.
export interface LevelUndoProps {
  // Общая история, поднятая в страницу-хозяин; не передана — своя локальная.
  history?: History;
  // Дисптчер Undo из страницы-хозяина (умеет редиректить на уровень правки перед откатом).
  onUndo?: () => void;
  // Дисптчер Redo из страницы-хозяина.
  onRedo?: () => void;
}
