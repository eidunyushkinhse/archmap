// Редактор-карта (MapEditorPage) — полноэкранный редактор схем (pages_pivot, Фаза 4).
// Роут: #/p/<pid>/map/<nodeId?>. Топбар: breadcrumb + undo/redo + «Готово».
// Слева: дерево объектов (дизайн страниц + секция «Добавить объект» внизу).
// Центр: LevelGraph со всеми жестами. Справа: ObjectInspector (272px).
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi, edgesApi, exportApi } from "../api/nodes";
import { getIsGuest } from "../api/auth";
import { canEditProject, useProjectRole } from "./projectRole";
import type {
  AncestorRef, DeletionSnapshot, Edge, EdgeUpdate, GhostNode, LevelEdge,
  Node, NodeShape, NodeUpdate,
  ViewLayout, ViewLayoutPayload,
} from "../types";
import { useHistory } from "../components/graph/interaction/useHistory";
import { guardPersist } from "../components/graph/interaction/persistGuard";
import { liftEdgesToLevel } from "../components/graph/projection";
import CrossLevelEdgePicker from "../components/CrossLevelEdgePicker";
import EdgeQuickCreate from "../components/EdgeQuickCreate";
import { useEdgeChoice } from "../components/graph/interaction/useEdgeChoice";
import NodeModal from "../components/NodeModal";
import NodeTreePanel from "../components/NodeTreePanel";
import "../components/NodeTreePanel.css";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import NodesDeleteConfirm from "../components/NodesDeleteConfirm";
import RelayoutConfirm from "../components/RelayoutConfirm";
import LevelGraph from "../components/LevelGraph";
import type {
  ViewMetaState, LocateRequest,
  LevelPersistenceProps, LevelModeFlags, LevelDrillCallbacks, LevelEdgeCallbacks,
  LevelDeleteCallbacks, LevelDropProps, LevelUndoProps,
} from "../components/graph/types";
import { useRemoteSync } from "./useRemoteSync";
import { useToast } from "./useToast";
import { useSchemaAlerts, resolveAlertLocate, PENDING_ALERT_LOCATE_KEY, PENDING_PROCESS_KEY } from "./useSchemaAlerts";
import { toLevelEdges } from "../components/pageSchema";
import SchemaAlerts, { type LocateTarget } from "../components/SchemaAlerts";
import ObjectInspector, { type Selected } from "../components/inspector/ObjectInspector";
import { readSchemaView, showStatusControls, writeSchemaView, type SchemaView } from "../components/schemaView";
import { SchemaViewFilter } from "../components/SchemaViewFilter";
import { readEdgeLabelsHidden, writeEdgeLabelsHidden } from "../components/graph/labelsPref";
import SchemaActions, { type ExportScope } from "../components/SchemaActions";
import TransitionConfirm from "../components/TransitionConfirm";
import { RelayoutIcon, ChevronIcon, EdgeLabelsIcon, CollapseIcon, PropsIcon } from "../ui/icons";
import "../ui/chrome.css";
import BrandLink from "../ui/BrandLink";
import TourHelpButton from "../components/tour/TourHelpButton";
import DemoLimitToast from "../components/demo/DemoLimitToast";
import { useDemoLimitToast } from "../components/demo/useDemoLimitToast";
import type { LimitAction } from "../components/demo/demoLimits";
import { emitTourEvent } from "../components/tour/tourBus";

interface Props {
  projectId: string;
  // null = корневой уровень, иначе — уровень узла
  nodeId: string | null;
  // Узел для временной подсветки (locate, Ф11) — пульс ~2.5с при открытии
  locateNodeId?: string | null;
  // «Готово»/Esc → возврат туда, откуда открыли (роут не меняется, Ф12)
  onDone: () => void;
  // Логотип в топбаре — на экран «Все проекты».
  onAllProjects: () => void;
  // Двойной клик по гостю → его страница
  onNavigateNode: (nodeId: string) => void;
}

export default function MapEditorPage({ projectId, nodeId, locateNodeId, onDone, onAllProjects, onNavigateNode }: Props) {
  // ── Стейт уровня (адаптация TreePage) ────────────────────────────
  const [nodes, setNodes] = useState<Node[]>([]);
  // Ведёт ли ПРОЕКТ переход (есть planned/deprecated) — приходит с сервера вместе с
  // уровнем. Считать по составу текущего уровня нельзя: и «Вид схемы», и «Принять
  // переход» относятся ко всему проекту, а статусы обычно лежат уровнем глубже
  // (находка 2026-08-09). Итоговое условие показа собирает showStatusControls.
  const [projectHasStatuses, setProjectHasStatuses] = useState(false);
  const [endpoints, setEndpoints] = useState<GhostNode[]>([]);
  const [viewLayout, setViewLayout] = useState<ViewLayout>({});
  const [edges, setEdges] = useState<LevelEdge[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<AncestorRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedObject, setSelectedObject] = useState<Selected>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false); // свёрнута ли правая панель
  const [nodeModal, setNodeModal] = useState<{
    open: boolean; node: Node | null; shape?: NodeShape;
    pos?: { x: number; y: number } | null;
    parentId?: string | null; posView?: string | null;
  }>({ open: false, node: null });
  // Счётчик чтений уровня с сервера. Растёт на каждый успешный load — холст по нему
  // перечитывает кэш детей раскрытых рамок: ответ /graph детей рамок не несёт, и без
  // сигнала удалённый внутри рамки объект остаётся нарисованным (находка 2026-08-09).
  const [childrenRev, setChildrenRev] = useState(0);
  const [intoPicker, setIntoPicker] = useState<{
    sourceId: string; containerId: string; containerName: string;
    sourceHandle: string | null; sourceName?: string;
  } | null>(null);
  const [outPicker, setOutPicker] = useState<{
    sourceId: string; sourceHandle: string | null; sourceName?: string;
  } | null>(null);
  const [edgeQuick, setEdgeQuick] = useState<{
    sourceId: string; targetId: string;
    sourceHandle: string | null; targetHandle: string | null;
    sourceName?: string; targetName?: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
  const [pendingMultiDelete, setPendingMultiDelete] = useState<Node[] | null>(null);
  const [relayoutOpen, setRelayoutOpen] = useState(false);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [transitionToast, setTransitionToast] = useState<string | null>(null);
  // Токен свершившейся переразкладки: LevelGraph режиссирует приход свежей
  // раскладки чистым переездом узлов (анимация «Переразложить»).
  const [relayoutToken, setRelayoutToken] = useState(0);
  // Токен мутации (создание/удаление узлов и связей): LevelGraph перерисовывает
  // изменившиеся стрелки анимированно и рисует новые (окно мутаций, AN28а).
  const [mutationToken, setMutationToken] = useState(0);
  const [dragShape, setDragShape] = useState<NodeShape | null>(null);
  // Сигнал перезагрузки дерева (создание/удаление узла, undo/redo)
  const [treeReload, setTreeReload] = useState(0);
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { writeSchemaView(schemaView); }, [schemaView]);
  // «Скрыть подписи связей» (CV32) — редактор владеет тумблером сам (управляемый
  // режим канваса): правый верхний угол холста здесь занят рейлом алертов (AL10),
  // поэтому кнопка живёт в топбаре, рядом с «Переразложить» — как на страницах,
  // где обе соседствуют в углу холста.
  const [edgeLabelsHidden, setEdgeLabelsHidden] = useState(readEdgeLabelsHidden);
  useEffect(() => { writeEdgeLabelsHidden(edgeLabelsHidden); }, [edgeLabelsHidden]);
  const [remoteToast, showRemoteToast] = useToast();

  const history = useHistory();
  // Право правки — роль в проекте (owner/editor), не глобальная роль.
  const isArchitect = canEditProject(useProjectRole());
  const currentParent = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null;
  const currentParentId = currentParent?.id ?? null;

  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0 });
  const gestureActiveRef = useRef(false);
  const layoutRetrySeq = useRef(0);
  const [layoutRetry, setLayoutRetry] = useState<{
    patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number;
  } | null>(null);

  // Locate-подсветка узла (Ф11): пульс ~2.5с при открытии редактора со страницы.
  const [locate, setLocate] = useState<LocateRequest | null>(
    () => (locateNodeId ? { kind: "node", ids: [locateNodeId], token: 1 } : null),
  );
  useEffect(() => {
    if (!locate) return;
    const t = window.setTimeout(() => setLocate(null), 2600);
    return () => window.clearTimeout(t);
  }, [locate]);

  // ── Загрузка уровня ──────────────────────────────────────────────
  // Возвращает загруженные узлы уровня (дерево выбирает свежий объект после прыжка).
  // По умолчанию — ФОНОВОЕ обновление: loading не трогаем, холст НЕ размонтируется,
  // данные подменяются по готовности и инкрементально пересчитываются конвейером
  // раскладки (reconcile сохраняет позиции/выделение) — без моргания на мутациях
  // (создание/удаление/правка узлов и связей, remote-sync-эхо, ресинк 409, доки от
  // агента). foreground: true — заглушка «Загрузка…» (первичная загрузка и навигация
  // между уровнями, где холст всё равно сбрасывается на новый containerId).
  async function load(parentId: string | null, opts?: { foreground?: boolean }): Promise<Node[]> {
    if (opts?.foreground) setLoading(true);
    setLayoutRetry(null);
    try {
      const graph = await nodesApi.getGraph(parentId);
      viewMetaRef.current = { version: graph.version, graphRev: graph.graph_rev };
      setNodes(graph.nodes);
      setEndpoints(graph.endpoints);
      setViewLayout(graph.layout ?? {});
      setEdges(toLevelEdges(graph));
      setProjectHasStatuses(graph.has_status_info);
      setChildrenRev((r) => r + 1); // кэш детей раскрытых рамок протух — перечитать
      reloadAlerts(); // алерты глобальные — освежаем при каждой загрузке/мутации уровня
      // Обучающий тур демо-стенда: показан слой (вход внутрь, возврат наверх).
      emitTourEvent({ type: "level", levelId: parentId });
      return graph.nodes;
    } finally {
      if (opts?.foreground) setLoading(false);
    }
  }

  // Начальная загрузка: breadcrumb по nodeId + граф уровня
  useEffect(() => {
    (async () => {
      if (nodeId) {
        const all = await nodesApi.getAll();
        const byId = new Map(all.map((n) => [n.id, n]));
        const path: AncestorRef[] = [];
        let cur = byId.get(nodeId);
        while (cur) {
          path.unshift({ id: cur.id, name: cur.name, is_external: cur.is_external });
          cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        }
        setBreadcrumb(path);
      }
      await load(nodeId, { foreground: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Поллинг
  useRemoteSync({
    currentParentId,
    viewMeta: viewMetaRef,
    gestureActiveRef,
    onRemoteChange: () => {
      void load(currentParentId);
      showRemoteToast();
    },
  });

  // Демо-стенд (docs/tasks/demo-mode.md, экран 4): отказ по пределу при отмене или
  // повторе — тост внизу холста; схема при этом пересинхронизируется, как при любом
  // отказе записи.
  const [limitToast, showLimit] = useDemoLimitToast();
  const resyncingRef = useRef<Promise<void> | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- оркестрационный колбэк: осознанно plain-function (пересоздаётся каждый рендер). Бандл persistence (Фаза 3д) пересобирается с ним — поведение идентично прежней прямой передаче пропа; стабилизация через useCallback потребует обернуть load (отдельный рефакторинг).
  function resyncOnPersistError(): Promise<void> {
    if (resyncingRef.current) return resyncingRef.current;
    const p = load(currentParentId).then(() => undefined).finally(() => { resyncingRef.current = null; });
    resyncingRef.current = p;
    return p;
  }
  // Обработчик отказа записи истории: предел демо — тост, затем обычный ресинк.
  function onHistoryError(action: LimitAction): (e: unknown) => void {
    return (e: unknown) => {
      showLimit(e, action);
      void resyncOnPersistError();
    };
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- см. resyncOnPersistError: plain-function, бандл пересобирается с ним (поведение не меняется).
  function handlePersistConflict(patch: Record<string, Partial<ViewLayoutPayload> | null>) {
    void resyncOnPersistError().then(() => {
      setLayoutRetry({ patch, token: ++layoutRetrySeq.current });
    });
  }

  // ── Навигация по уровням (внутри редактора) ──────────────────────
  // Возвращает узлы загруженного уровня (undefined — переход не состоялся).
  async function navigateToLevel(level: string | null): Promise<Node[] | undefined> {
    if (level === currentParentId) return;
    setSelectedObject(null);
    if (level === null) { setBreadcrumb([]); return load(null, { foreground: true }); }
    const all = await nodesApi.getAll();
    const byId = new Map(all.map((n) => [n.id, n]));
    const path: AncestorRef[] = [];
    let cur: Node | undefined = byId.get(level);
    while (cur) {
      path.unshift({ id: cur.id, name: cur.name, is_external: cur.is_external });
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    setBreadcrumb(path);
    return load(level, { foreground: true });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- оркестрационный колбэк drill: plain-function (зависит от load), бандл drill (Фаза 3д) пересобирается с ним — поведение не меняется.
  function drillDown(node: Node) {
    setSelectedObject(null);
    setBreadcrumb((prev) => [...prev, node]);
    load(node.id, { foreground: true });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- см. drillDown: plain-function, бандл drill пересобирается с ним (поведение не меняется).
  function drillToPath(path: AncestorRef[]) {
    if (path.length === 0) return;
    setSelectedObject(null);
    setBreadcrumb(path);
    load(path[path.length - 1].id, { foreground: true });
  }

  function navigateTo(index: number) {
    setSelectedObject(null);
    const next = breadcrumb.slice(0, index + 1);
    setBreadcrumb(next);
    load(next[next.length - 1].id, { foreground: true });
  }

  // ── Навигация из дерева объектов ─────────────────────────────────
  // Счётчик токенов locate: пульс пере-триггерится на каждый новый запрос.
  const locateSeq = useRef(1);

  // Алерты схемы — в интерфейсе «Рекомендации» (кнопка в рейле холста, архитектор).
  const { alerts, loaded: alertsLoaded, reload: reloadAlerts } = useSchemaAlerts(isArchitect);

  // Переход к проблемному объекту/связи/группе из алертов: общий предок → уровень,
  // затем центрирование + вспышка (портировано из TreePage.handleLocate).
  async function handleLocate(target: LocateTarget) {
    const all = await nodesApi.getAll();
    const { level, request } = resolveAlertLocate(all, target, alerts, ++locateSeq.current);
    if (level !== currentParentId) await navigateToLevel(level);
    setLocate(request);
  }

  // Строка процессного алерта → режим «Процессы» оболочки с этим процессом. Роут
  // карты про процессы не знает, поэтому id кладём в sessionStorage (как и шапка
  // кладёт цель для карты), а уходим обычным закрытием редактора — туда же, куда
  // ведёт «Готово».
  function openProcess(processId: string) {
    sessionStorage.setItem(PENDING_PROCESS_KEY, processId);
    onDone();
  }

  // Цель алерта из шапки ProjectShell (переход «знак → карта»): применяется после
  // загрузки алертов (нужны концы связей), затем ключ очищается.
  useEffect(() => {
    if (!alertsLoaded) return;
    const raw = sessionStorage.getItem(PENDING_ALERT_LOCATE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_ALERT_LOCATE_KEY);
    try {
      void handleLocate(JSON.parse(raw) as LocateTarget);
    } catch { /* повреждённые данные цели — игнорируем */ }
    // handleLocate намеренно вне зависимостей: эффект срабатывает раз на загрузку алертов
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertsLoaded]);

  // Клик по контейнеру → дрилл на его слой (путь собран деревом).
  function drillFromTree(path: Node[]) {
    drillToPath(path.map((n) => ({ id: n.id, name: n.name, is_external: n.is_external })));
  }

  // Клик по листу → прыжок на его слой (слой родителя), выделение и пульс.
  async function pickFromTree(node: Node) {
    let pool = nodes;
    if (node.parent_id !== currentParentId) {
      pool = (await navigateToLevel(node.parent_id)) ?? pool;
    }
    const fresh = pool.find((n) => n.id === node.id) ?? node;
    setSelectedObject({ kind: "node", node: fresh });
    setLocate({ kind: "node", ids: [node.id], token: ++locateSeq.current });
  }

  // ── Undo/Redo ────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps -- оркестрационный дисптчер Undo: plain-function (зависит от navigateToLevel/currentParentId), бандл undo (Фаза 3д) пересобирается с ним — поведение не меняется.
  async function dispatchUndo() {
    const cmd = history.peekUndo();
    if (!cmd) return;
    if (cmd.level !== undefined && cmd.level !== currentParentId) await navigateToLevel(cmd.level);
    history.undo();
    setTreeReload((t) => t + 1);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- см. dispatchUndo: plain-function, бандл undo пересобирается с ним (поведение не меняется).
  async function dispatchRedo() {
    const cmd = history.peekRedo();
    if (!cmd) return;
    if (cmd.level !== undefined && cmd.level !== currentParentId) await navigateToLevel(cmd.level);
    history.redo();
    setTreeReload((t) => t + 1);
  }

  // Esc = «Готово»
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  // ── Обработчики (порты из TreePage) ──────────────────────────────
  const refetchLevel = (level: string | null) => () => { load(level); };

  // Мутация свершилась: следующее применение раскладки перерисует изменившиеся
  // стрелки анимированно и нарисует новые (окно мутаций, AN28а).
  function noteMutation() { setMutationToken((t) => t + 1); }

  // Компенсация правки меты для Undo/Redo: ПОЛНЫЙ снимок правимых панелью полей.
  // Перечень обязан покрывать всё, что правит NodeInspector: PATCH разбирается с
  // exclude_unset, поэтому пропущенное поле молча не откатывается (так статус не
  // возвращался по Ctrl+Z, пока его тут не было). parent_id — осознанно вне списка:
  // у переноса свой шаг истории со снимком раскладки (handleReparent).
  // Поля узла для ОТКАТА правки (Undo/Redo). Якорь входит явным null при его
  // отсутствии: поле source, не присланное в PATCH, якорь НЕ трогает, и Undo
  // правки якоря не вернул бы прежний (а Redo — новый). Для узла без якоря
  // null — та же пустота, что и была: очистка пустого ничего не меняет и
  // курсоров не двигает (проверено приёмкой Ф0).
  function nodeFields(n: Node): NodeUpdate {
    return { name: n.name, description: n.description, role: n.role, technology: n.technology, openapi_spec: n.openapi_spec, is_external: n.is_external, shape: n.shape, status: n.status, source: n.source ?? null };
  }

  // Перенос объекта на другой уровень (драг строки в дереве). Снимок раскладки
  // берём ДО правки: сервер снимет позиции переехавшего поддерева во внешних видах,
  // и без снимка Undo вернул бы родителя, но не геометрию.
  async function handleReparent(node: Node, newParentId: string | null) {
    const oldParentId = node.parent_id;
    const levelAtMove = currentParentId;
    const refetch = refetchLevel(levelAtMove);
    const snapshot = await nodesApi.moveSnapshot(node.id);
    await nodesApi.update(node.id, { parent_id: newParentId });
    setTreeReload((t) => t + 1);
    load(levelAtMove);
    noteMutation();
    history.push({
      label: "Перенос объекта", level: levelAtMove,
      // Порядок важен: сначала возвращаем родителя (эта же правка снимет позиции,
      // засеянные на новом месте), только потом кладём обратно старые строки.
      undo: () => {
        guardPersist(
          nodesApi.update(node.id, { parent_id: oldParentId })
            .then(() => nodesApi.restore(snapshot))
            .then(() => { setTreeReload((t) => t + 1); refetch(); }),
          onHistoryError("save"),
        );
      },
      redo: () => {
        guardPersist(
          nodesApi.update(node.id, { parent_id: newParentId })
            .then(() => { setTreeReload((t) => t + 1); refetch(); }),
          onHistoryError("save"),
        );
      },
    });
  }

  function handleNodeSaved(saved: Node, isCreate: boolean, before?: Node) {
    const intoFrame = isCreate && saved.parent_id != null && saved.parent_id !== currentParentId;
    // Позиция созданного узла — СРАЗУ в зеркало вида: иначе конвейер увидит узел
    // невладеемым, поставит его ELK'ом, а засев владения перетрёт записанную
    // при создании позицию (узел «спавнился случайно», не там, где его поставили).
    if (isCreate && nodeModal.pos) {
      handleLayoutChanged({ [saved.id]: { x: nodeModal.pos.x, y: nodeModal.pos.y } });
    }
    // Узел, созданный ВНУТРИ раскрытой рамки, в nodes уровня не входит — он ребёнок
    // рамки, и покажет его перечитанный кэш детей (childrenRev растёт в load ниже).
    if (!intoFrame) {
      setNodes((prev) => prev.some((n) => n.id === saved.id) ? prev.map((n) => (n.id === saved.id ? saved : n)) : [...prev, saved]);
    }
    setNodeModal({ open: false, node: null });
    setSelectedObject((sel) => sel?.kind === "node" && sel.node.id === saved.id ? { kind: "node", node: saved } : sel);
    if (!isArchitect) return;
    if (isCreate) {
      noteMutation();
      // Эхо-подавление самого создания: POST поднял graph_rev — без load курсор
      // viewMetaRef остаётся старым, и ресинк считает СОБСТВЕННУЮ мутацию чужой
      // сессией (ложный тост «Схема обновлена в другой сессии» + принудительный
      // пересчёт, обрывающий анимацию окна мутаций). load обновляет курсор и
      // даёт авторитетное состояние с сервера.
      load(currentParentId);
      setTreeReload((t) => t + 1);
      const levelAtCreate = currentParentId;
      // Откат/повтор создания в рамке отдельного канала не требует: load бампает
      // childrenRev, и кэш детей рамок перечитывается вместе с уровнем.
      const refetch = refetchLevel(levelAtCreate);
      let snap: DeletionSnapshot | null = null;
      history.push({ label: "Создание объекта", level: levelAtCreate,
        undo: () => { guardPersist(nodesApi.deletionSnapshot(saved.id).then((s) => { snap = s; return nodesApi.delete(saved.id); }).then(refetch), resyncOnPersistError); },
        redo: () => { guardPersist((snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch), onHistoryError("node")); },
      });
    } else if (before) {
      // Правка ребёнка раскрытой рамки: в nodes уровня его нет, оптимистичный патч
      // выше прошёл мимо — просим холст перечитать кэш детей рамок (load здесь не
      // зовём осознанно: правка не должна дёргать весь уровень).
      if (!nodes.some((n) => n.id === saved.id)) setChildrenRev((r) => r + 1);
      const apply = (n: Node) => { setNodes((prev) => prev.map((x) => (x.id === n.id ? n : x))); };
      history.push({ label: "Правка объекта", level: currentParentId,
        undo: () => { apply(before); guardPersist(nodesApi.update(before.id, nodeFields(before)), onHistoryError("save")); },
        redo: () => { apply(saved); guardPersist(nodesApi.update(saved.id, nodeFields(saved)), onHistoryError("save")); },
      });
    }
  }

  function handleNodeDeleted(id: string, snapshot?: DeletionSnapshot) {
    setNodeModal({ open: false, node: null });
    setSelectedObject(null);
    setTreeReload((t) => t + 1);
    load(currentParentId);
    noteMutation();
    if (!snapshot) return;
    const levelAtDelete = currentParentId;
    const refetch = refetchLevel(levelAtDelete);
    history.push({ label: "Удаление объекта", level: levelAtDelete,
      undo: () => { guardPersist(nodesApi.restore(snapshot).then(refetch), onHistoryError("node")); },
      redo: () => { guardPersist(nodesApi.delete(id).then(refetch), resyncOnPersistError); },
    });
  }

  function handleNodesDeleted(ids: string[], snapshots: DeletionSnapshot[]) {
    setTreeReload((t) => t + 1);
    load(currentParentId);
    noteMutation();
    if (snapshots.length === 0) return;
    const levelAtDelete = currentParentId;
    const refetch = refetchLevel(levelAtDelete);
    history.push({ label: `Удаление объектов (${ids.length})`, level: levelAtDelete,
      undo: () => { guardPersist(Promise.all(snapshots.map((s) => nodesApi.restore(s))).then(refetch), onHistoryError("node")); },
      redo: () => { guardPersist(Promise.all(ids.map((id2) => nodesApi.delete(id2))).then(refetch), resyncOnPersistError); },
    });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- оркестрационный колбэк зеркала раскладки: plain-function, бандл persistence (Фаза 3д) пересобирается с ним — поведение идентично прежней прямой передаче пропа.
  function handleLayoutChanged(items: Record<string, ViewLayoutPayload | null>) {
    setViewLayout((prev) => {
      // Пересобираем объект без оператора delete: сначала фильтруем удаляемые
      // ключи (null в items), затем применяем ненулевые обновления
      const removed = new Set(
        Object.entries(items).filter(([, p]) => p === null).map(([k]) => k),
      );
      const next: ViewLayout = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!removed.has(k)) next[k] = v;
      }
      for (const [k, p] of Object.entries(items)) {
        if (p !== null) next[k] = p;
      }
      return next;
    });
  }

  function handleEdgeDeleted(id: string, snapshot?: DeletionSnapshot) {
    setSelectedObject(null);
    load(currentParentId);
    noteMutation();
    if (!snapshot || !isArchitect) return;
    const levelAtDelete = currentParentId;
    const refetch = () => load(levelAtDelete);
    history.push({ label: "Удаление связи", level: levelAtDelete,
      undo: () => { guardPersist(nodesApi.restore(snapshot).then(refetch), onHistoryError("edge")); },
      redo: () => { guardPersist(edgesApi.delete(id).then(refetch), resyncOnPersistError); },
    });
  }

  function handleEdgeSaved(updated: Edge, undoPayload?: EdgeUpdate, redoPayload?: EdgeUpdate) {
    load(currentParentId);
    noteMutation();
    if (!undoPayload || !redoPayload || !isArchitect) return;
    const levelAtEdit = currentParentId;
    const refetch = () => load(levelAtEdit);
    history.push({ label: "Правка связи", level: levelAtEdit,
      undo: () => { guardPersist(edgesApi.update(updated.id, undoPayload).then(refetch), onHistoryError("save")); },
      redo: () => { guardPersist(edgesApi.update(updated.id, redoPayload).then(refetch), onHistoryError("save")); },
    });
  }

  // Перепривязка конца, упиравшегося в рамку, на узел внутри неё. Холст уже проверил,
  // что цель — член этой рамки; здесь только запись и история. У мастер-стрелки членов
  // несколько — переезжают ВСЕ (они и слились в одну потому, что делят пару концов).
  // Перепривязка конца, упиравшегося в рамку, на узел внутри неё. Холст уже проверил,
  // что цель — член этой рамки; здесь только запись и история. У мастер-стрелки членов
  // несколько — переезжают ВСЕ (они и слились в одну потому, что делят пару концов).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- как dispatchUndo: plain-function (зависит от load/currentParentId), бандл edgeCallbacks пересобирается с ней — поведение не меняется.
  function handleFrameEndReconnected(
    edgeIds: string[], end: "source" | "target", fromFrameId: string, toNodeId: string,
  ) {
    if (!isArchitect) return;
    const levelAt = currentParentId;
    const refetch = () => load(levelAt);
    const to = (id: string): EdgeUpdate => (end === "source" ? { source_id: id } : { target_id: id });
    const move = (id: string) =>
      Promise.all(edgeIds.map((eid) => edgesApi.update(eid, to(id)))).then(refetch);
    guardPersist(
      move(toNodeId).then(() => emitTourEvent({ type: "edge-reconnected", fromId: fromFrameId, toId: toNodeId })),
      resyncOnPersistError,
    );
    noteMutation();
    history.push({
      label: edgeIds.length > 1 ? "Перепривязка связей" : "Перепривязка связи",
      level: levelAt,
      undo: () => { guardPersist(move(fromFrameId), resyncOnPersistError); },
      redo: () => { guardPersist(move(toNodeId), resyncOnPersistError); },
    });
  }

  function pushEdgeCreate(created: Edge) {
    emitTourEvent({ type: "edge-created", id: created.id, sourceId: created.source_id, targetId: created.target_id });
    if (!isArchitect) return;
    noteMutation();
    const levelAtCreate = currentParentId;
    const refetch = () => load(levelAtCreate);
    let snap: DeletionSnapshot | null = null;
    history.push({ label: "Создание связи", level: levelAtCreate,
      undo: () => { guardPersist(edgesApi.deletionSnapshot(created.id).then((s) => { snap = s; return edgesApi.delete(created.id); }).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist((snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch), onHistoryError("edge")); },
    });
  }

  const findLevelEdge = (id: string): LevelEdge | null => edges.find((e) => e.id === id) ?? null;
  const findNodeLabel = (id: string): string => nodes.find((n) => n.id === id)?.name ?? endpoints.find((ep) => ep.id === id)?.name ?? id;

  const levelGhosts = useMemo(() =>
    liftEdgesToLevel({ edges, endpoints, localIds: new Set(nodes.map((n) => n.id)), containerId: currentParentId }).ghosts,
    [edges, endpoints, nodes, currentParentId]);

  const linkedHighlight = useMemo((): { kind: "node" | "edge"; id: string } | null => {
    if (!selectedObject) return null;
    if (selectedObject.kind === "edge") return { kind: "edge", id: selectedObject.edge.id };
    if (selectedObject.kind === "ghost") return { kind: "node", id: selectedObject.ghost.id };
    return { kind: "node", id: selectedObject.node.id };
  }, [selectedObject]);

  // Экспортируем то, что открыто: поддерево текущего уровня, в корне — всю схему.
  const exportScope: ExportScope = currentParentId
    ? { key: currentParentId, title: "Экспорт поддерева", load: () => exportApi.subtree(currentParentId) }
    : {
        key: "all", title: "Экспорт схемы", load: () => exportApi.all(),
        // Архив — операция над проектом целиком; в редакторе его прежде не было
        // вовсе (кнопка жила в модалке экспорта оболочки). Меню выравнивает.
        archive: { filename: "archmap.zip", load: () => exportApi.archive() },
      };

  const hasNodes = nodes.length + levelGhosts.length > 0;
  const hasStatusInfo = showStatusControls(projectHasStatuses, nodes, levelGhosts);

  const inspectEdge = (edge: LevelEdge) => { setSelectedObject({ kind: "edge", edge }); };
  // Выбор связи (общая оркестрация с просмотром — useEdgeChoice): модалки выбора
  // и резолв группы рёбер там; семантика «выбрать» здесь — открыть инспектор
  // (inspectEdge), «дозаписать связь» (архитектор) — EdgeQuickCreate.
  const { onEdgesChoice, onTrunkChoice, choiceModal } = useEdgeChoice({
    resolveEdge: findLevelEdge,
    labelOf: findNodeLabel,
    onPick: inspectEdge,
    onAddFromChoice: isArchitect
      ? (rep) => setEdgeQuick({ sourceId: rep.source_id, targetId: rep.target_id, sourceHandle: null, targetHandle: null })
      : undefined,
  });

  // ── Бандлы пропсов LevelGraph (Фаза 3д) ──────────────────────────
  // Плоские колбэк-пропсы сгруппированы в связные доменные бандлы и мемоизированы,
  // чтобы не создавать новый объект-литерал на каждый рендер (канвас чувствителен к
  // ре-рендерам). Зависимости — динамические значения, которые замыкают колбэки;
  // стабильные setState-сеттеры и ref'ы в deps не нужны (exhaustive-deps их не требует).
  const drill = useMemo<LevelDrillCallbacks>(() => ({
    onDrillDown: drillDown,
    onEnterNode: drillToPath,
    onEditNode: (node) => { setSelectedObject({ kind: "node", node }); },
    onInspectGhost: (ghost) => { onNavigateNode(ghost.id); },
    onClearSelection: () => setSelectedObject(null),
  }), [drillDown, drillToPath, onNavigateNode]);

  const edgeCallbacks = useMemo<LevelEdgeCallbacks>(() => ({
    onEdgesChoice,
    onTrunkChoice,
    onCreateEdge: (s, t, sh, th, sn, tn) => setEdgeQuick({ sourceId: s, targetId: t, sourceHandle: sh, targetHandle: th, sourceName: sn, targetName: tn }),
    onConnectInto: (s, cid, cn, sh, sn) => setIntoPicker({ sourceId: s, containerId: cid, containerName: cn, sourceHandle: sh, sourceName: sn }),
    onExitUp: (s, sh, sn) => setOutPicker({ sourceId: s, sourceHandle: sh, sourceName: sn }),
    onReconnectFrameEnd: handleFrameEndReconnected,
  }), [onEdgesChoice, onTrunkChoice, handleFrameEndReconnected]);

  const deleteCallbacks = useMemo<LevelDeleteCallbacks>(() => ({
    onRequestDeleteNode: setPendingDelete,
    onRequestDeleteNodes: setPendingMultiDelete,
  }), []);

  const drop = useMemo<LevelDropProps>(() => ({
    onDropNode: (shape, pos, dropParentId) => {
      if (dropParentId) setNodeModal({ open: true, node: null, shape, pos, parentId: dropParentId, posView: currentParentId });
      else setNodeModal({ open: true, node: null, shape, pos });
    },
    dragShape,
  }), [currentParentId, dragShape]);

  const undo = useMemo<LevelUndoProps>(() => ({
    history,
    onUndo: dispatchUndo,
    onRedo: dispatchRedo,
  }), [history, dispatchUndo, dispatchRedo]);

  const persistence = useMemo<LevelPersistenceProps>(() => ({
    onLayoutChanged: handleLayoutChanged,
    onPersistError: resyncOnPersistError,
    onPersistConflict: handlePersistConflict,
    retryPatch: layoutRetry,
    viewMeta: viewMetaRef,
    gestureActiveRef,
  }), [handleLayoutChanged, resyncOnPersistError, handlePersistConflict, layoutRetry]);

  const mode = useMemo<LevelModeFlags>(() => ({
    schemaView,
    edgeLabelsHidden,
  }), [schemaView, edgeLabelsHidden]);

  // ── Рендер ───────────────────────────────────────────────────────
  return (
    <div style={page}>
      {/* Топбар */}
      <div style={topBar}>
        <div style={topLeft}>
          <BrandLink onClick={onAllProjects} />
          <span style={divider} />
          {/* Breadcrumb уровней */}
          <button className="crumb" style={crumbLink} data-tour="crumb-root" onClick={() => { void navigateToLevel(null); }}>
            {breadcrumb.length === 0 ? "Контекст" : "Проект"}
          </button>
          {breadcrumb.map((n, i) => (
            <span key={n.id} style={{ display: "flex", alignItems: "center" }}>
              <span style={crumbSep}><ChevronIcon /></span>
              {i < breadcrumb.length - 1 ? (
                <button className="crumb" style={crumbLink} onClick={() => navigateTo(i)}>{n.name}</button>
              ) : (
                <button style={crumbCurrent} disabled>{n.name}</button>
              )}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Undo/Redo — только на канвасе (тулбар LevelGraph, левый верхний угол);
              из топбара убраны как дубль. */}
          {isArchitect && (
            <button className="icon-btn" style={iconBtn} onClick={() => setRelayoutOpen(true)} disabled={!hasNodes} title="Переразложить уровень">
              <RelayoutIcon />
            </button>
          )}
          {/* Тумблер «Скрыть подписи связей» (CV32) — сосед «Переразложить», как в
              углу холста на страницах; сам угол в редакторе занят рейлом алертов. */}
          <button
            className="icon-btn"
            style={edgeLabelsHidden ? { ...iconBtn, background: "#e2e8f0", color: "#1e293b" } : iconBtn}
            onClick={() => setEdgeLabelsHidden((v) => !v)}
            aria-pressed={edgeLabelsHidden}
            title={edgeLabelsHidden ? "Показать подписи связей" : "Скрыть подписи связей"}
          >
            <EdgeLabelsIcon off={edgeLabelsHidden} />
          </button>
          {/* Экспорт и обновление из репозитория — тот же компонент, что в шапке
              оболочки: в редакторе их не было вовсе (находка проверки 2026-08-08),
              а копия разметки разъехалась бы с оболочкой на первой же правке. */}
          <SchemaActions
            projectId={projectId}
            isArchitect={isArchitect}
            exportScope={exportScope}
            size={32}
            onSynced={() => {
              void load(currentParentId);
              setTreeReload((t) => t + 1);
            }}
          />
          {hasStatusInfo && <SchemaViewFilter view={schemaView} onChange={setSchemaView} variant="inline" />}
          {/* «Принять переход» стоит рядом с переключателем вида, а не среди
              иконок: обе вещи про статусы, и появляться должны там, где статусы
              видны. Кнопка есть, только когда принимать есть что. */}
          {isArchitect && hasStatusInfo && (
            <button className="btn-soft" onClick={() => setTransitionOpen(true)}>
              Принять переход
            </button>
          )}
          <button style={doneBtn} onClick={() => onDone()}>Готово</button>
          {/* Гость демо-стенда: пилюля «Обучение» — пройти обучение заново, как в
              шапках оболочки и списка. */}
          {getIsGuest() && <TourHelpButton />}
        </div>
      </div>

      {/* Тело: дерево + холст + инспектор */}
      <div style={bodyRow}>
        {/* Дерево объектов: тот же плоский дизайн, что на страницах (ProjectShell),
            но клик навигирует внутри редактора (контейнер → дрилл на слой,
            лист → прыжок на слой родителя + выделение + пульс) и внизу есть
            секция «Добавить объект» — единственное отличие от дерева страниц. */}
        <NodeTreePanel
          isArchitect={isArchitect}
          reloadToken={treeReload}
          currentNodeId={currentParentId}
          onDrillTo={drillFromTree}
          onPickLeaf={(node) => { void pickFromTree(node); }}
          onCreateChild={(parentId) => setNodeModal({ open: true, node: null, parentId, pos: null })}
          onReparent={(node, newParentId) => { void handleReparent(node, newParentId); }}
          onTemplateDrag={setDragShape}
        />

        {/* Холст */}
        <div style={graphArea}>
          {/* Рейл тостов холста (правый верхний угол, спека AL10): кнопка
              «Рекомендации» + тост чужой сессии. Прозрачен для мыши,
              интерактивны только кнопка и панель (pointerEvents у них auto). */}
          <div style={toastRail}>
            {isArchitect && (
              <SchemaAlerts
                alerts={alerts}
                placement="canvas"
                onLocate={handleLocate}
                // Процессные классы (AL26/AL27) на холсте чинить нечем: у повисшего
                // сообщения связь удалена, у непривязанного участника узла нет —
                // локализовать нечего. Уводим в процесс, редактор при этом
                // закрывается (решение пользователя: без вопроса и без возврата).
                onOpenProcess={openProcess}
              />
            )}
            {remoteToast && <div style={remoteToastStyle}>Схема обновлена в другой сессии</div>}
            {transitionToast && <div style={transitionToastStyle}>{transitionToast}</div>}
          </div>
          <DemoLimitToast message={limitToast} />
          {loading ? (
            <p style={{ color: "#6b7280", padding: 24 }}>Загрузка...</p>
          ) : (
            <LevelGraph
              nodes={nodes} endpoints={endpoints} viewLayout={viewLayout} edges={edges}
              depth={breadcrumb.length} containerId={currentParentId} relayoutToken={relayoutToken}
              mutationToken={mutationToken}
              ancestorNames={breadcrumb.map((b) => b.name)} ancestorIds={breadcrumb.map((b) => b.id)}
              isArchitect={isArchitect}
              linkedHighlight={linkedHighlight}
              childrenRev={childrenRev}
              locate={locate}
              drill={drill}
              edgeCallbacks={edgeCallbacks}
              delete={deleteCallbacks}
              drop={drop}
              undo={undo}
              persistence={persistence}
              mode={mode}
            />
          )}
        </div>

        {/* Инспектор. Сворачивается зеркально дереву слева (NodeTreePanel): узкий
            рейл с кнопкой панели и футер «Свернуть панель» внизу. */}
        <aside style={{ ...rightPanel, width: inspectorCollapsed ? RIGHT_PANEL_COLLAPSED_W : RIGHT_PANEL_W }}>
          {inspectorCollapsed ? (
            <div style={rightRail}>
              <button className="nt-railbtn" title="Свойства объекта" onClick={() => setInspectorCollapsed(false)}>
                <PropsIcon />
              </button>
            </div>
          ) : (
            <div style={rightContent}>
              <ObjectInspector
                selected={selectedObject} isArchitect={isArchitect}
                onNodeSaved={handleNodeSaved} onNodeDeleted={handleNodeDeleted}
                onEdgeSaved={handleEdgeSaved} onEdgeDeleted={handleEdgeDeleted}
                onGhostGoToSource={(ghost) => { onNavigateNode(ghost.id); }}
                onNavigateNode={onNavigateNode}
              />
            </div>
          )}
          <button
            className="nt-collapse"
            onClick={() => setInspectorCollapsed((c) => !c)}
            title={inspectorCollapsed ? "Развернуть панель" : "Свернуть панель"}
          >
            {!inspectorCollapsed && <span>Свернуть панель</span>}
            <CollapseIcon dir={inspectorCollapsed ? "left" : "right"} />
          </button>
        </aside>
      </div>

      {/* Модалки */}
      {nodeModal.open && (
        <NodeModal
          parentId={nodeModal.parentId !== undefined ? nodeModal.parentId : currentParentId}
          shape={nodeModal.shape} initialPos={nodeModal.pos ?? null} posView={nodeModal.posView}
          onClose={() => setNodeModal({ open: false, node: null })} onSaved={handleNodeSaved}
        />
      )}
      {pendingDelete && (
        <NodeDeleteConfirm node={pendingDelete} onCancel={() => setPendingDelete(null)}
          onDeleted={(id, snapshot) => { setPendingDelete(null); handleNodeDeleted(id, snapshot); }} />
      )}
      {pendingMultiDelete && (
        <NodesDeleteConfirm nodes={pendingMultiDelete} onCancel={() => setPendingMultiDelete(null)}
          onDeleted={(ids, snapshots) => { setPendingMultiDelete(null); handleNodesDeleted(ids, snapshots); }} />
      )}
      {relayoutOpen && (
        <RelayoutConfirm containerId={currentParentId} levelName={currentParent?.name}
          onCancel={() => setRelayoutOpen(false)}
          onDone={() => { setRelayoutOpen(false); setRelayoutToken((t) => t + 1); load(currentParentId); history.clear(); }} />
      )}
      {transitionOpen && (
        <TransitionConfirm
          onClose={() => setTransitionOpen(false)}
          onApplied={(message) => {
            // Переход меняет схему целиком: перечитываем уровень и дерево, а
            // историю чистим — её команды ссылаются на удалённые узлы.
            setTransitionToast(message);
            window.setTimeout(() => setTransitionToast(null), 5000);
            void load(currentParentId, { foreground: true });
            setTreeReload((t) => t + 1);
            history.clear();
          }}
        />
      )}
      {edgeQuick && (
        <EdgeQuickCreate sourceId={edgeQuick.sourceId} targetId={edgeQuick.targetId}
          sourceLabel={edgeQuick.sourceName ?? findNodeLabel(edgeQuick.sourceId)}
          targetLabel={edgeQuick.targetName ?? findNodeLabel(edgeQuick.targetId)}
          onClose={() => setEdgeQuick(null)}
          onCreated={(created) => { setEdgeQuick(null); load(currentParentId); pushEdgeCreate(created); }} />
      )}
      {intoPicker && (
        <CrossLevelEdgePicker title={`Связь внутрь «${intoPicker.containerName}»`}
          subtitle="Выберите объект-потомок — дальний конец межуровневой связи."
          sourceId={intoPicker.sourceId} sourceLabel={intoPicker.sourceName ?? findNodeLabel(intoPicker.sourceId)}
          loadNodes={() => nodesApi.getDescendants(intoPicker.containerId)} scopeKey={intoPicker.containerId}
          rootParentId={intoPicker.containerId} slotPlaceholder={`Объект внутри «${intoPicker.containerName}»…`}
          onClose={() => setIntoPicker(null)}
          onCreated={(created) => { setIntoPicker(null); load(currentParentId); pushEdgeCreate(created); }} />
      )}
      {outPicker && (
        <CrossLevelEdgePicker title="Связь с объектом вне уровня"
          sourceId={outPicker.sourceId} sourceLabel={outPicker.sourceName ?? findNodeLabel(outPicker.sourceId)}
          loadNodes={() => nodesApi.getAll()} scopeKey="all" rootParentId={null} slotPlaceholder="Объект вне уровня…"
          excludeIds={new Set<string>([outPicker.sourceId, ...nodes.map((n) => n.id), ...levelGhosts.map((g) => g.id)])}
          onClose={() => setOutPicker(null)}
          onCreated={(created) => { setOutPicker(null); load(currentParentId); pushEdgeCreate(created); }} />
      )}
      {/* Выбор связи (обычный / общее плечо) — рендерит useEdgeChoice */}
      {choiceModal}
    </div>
  );
}

// ── Стили ───────────────────────────────────────────────────────────

const page: CSSProperties = { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui, -apple-system, sans-serif", overflow: "hidden", background: "#f8fafc" };
const topBar: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 20px", borderBottom: "1px solid #e2e8f0", background: "#fff", flexShrink: 0, gap: 12, flexWrap: "wrap" };
const topLeft: CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 14, flexWrap: "wrap", flex: 1, minWidth: 0 };
const divider: CSSProperties = { width: 1, height: 22, background: "#e2e8f0", flex: "none", margin: "0 4px" };
const bodyRow: CSSProperties = { flex: 1, display: "flex", minHeight: 0, overflow: "hidden" };
const graphArea: CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", padding: 12, display: "flex", flexDirection: "column", position: "relative" };
const RIGHT_PANEL_W = 272;
const RIGHT_PANEL_COLLAPSED_W = 48; // как у свёрнутого дерева слева
const rightPanel: CSSProperties = { flexShrink: 0, borderLeft: "1px solid #e2e8f0", background: "#fbfcfd", display: "flex", flexDirection: "column", overflow: "hidden", transition: "width 0.22s ease" };
// Фиксированная ширина содержимого — без переноса текста при анимации ширины.
const rightContent: CSSProperties = { width: RIGHT_PANEL_W, boxSizing: "border-box", flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px", scrollbarGutter: "stable" };
const rightRail: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, paddingTop: 12, flex: 1 };
const doneBtn: CSSProperties = { padding: "7px 20px", fontSize: 13.5, fontWeight: 600, color: "#fff", background: "#2563eb", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" };
const crumbLink: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "3px 7px", borderRadius: 7, fontSize: 13.5, color: "#64748b", cursor: "pointer", background: "none", border: "none" };
const crumbCurrent: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "3px 7px", fontSize: 13.5, color: "#1e293b", fontWeight: 600, background: "none", border: "none", cursor: "default" };
const crumbSep: CSSProperties = { color: "#cbd5e1", display: "inline-flex", alignItems: "center", margin: "0 1px" };
const iconBtn: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, flex: "none", background: "#fff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer" };
// Рейл тостов холста (правый верхний угол): колонка, прозрачна для мыши —
// интерактивны только вложенные кнопка/панель рекомендаций и тост (у них pointerEvents auto).
const toastRail: CSSProperties = { position: "absolute", top: 12, right: 12, zIndex: 6, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, pointerEvents: "none" };
const transitionToastStyle: CSSProperties = { background: "#ecfdf5", border: "1px solid #6ee7b7", color: "#065f46", borderRadius: 10, padding: "7px 12px", fontSize: 13, boxShadow: "0 4px 12px rgba(30,41,59,.10)", pointerEvents: "auto" };
const remoteToastStyle: CSSProperties = { background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3", borderRadius: 10, padding: "7px 12px", fontSize: 13, boxShadow: "0 4px 12px rgba(30,41,59,.10)", pointerEvents: "auto" };
