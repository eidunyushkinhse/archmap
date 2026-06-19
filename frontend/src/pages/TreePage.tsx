import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi, edgesApi, exportApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import type { AncestorRef, DeletionSnapshot, Edge, EdgePoint, EdgeUpdate, GhostNode, LevelEdge, LevelPos, LevelWaypoints, Node, NodeShape, NodeStatus, NodeUpdate, SchemaAlerts as Alerts } from "../types";
import { useHistory } from "../components/graph/interaction/useHistory";
import { guardPersist } from "../components/graph/interaction/persistGuard";
import CrossLevelEdgePicker from "../components/CrossLevelEdgePicker";
import EdgeQuickCreate from "../components/EdgeQuickCreate";
import SchemaAlerts from "../components/SchemaAlerts";
import EdgeChoiceModal from "../components/EdgeChoiceModal";
import NodeModal from "../components/NodeModal";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import NodesDeleteConfirm from "../components/NodesDeleteConfirm";
import NodeContextModal from "../components/NodeContextModal";
import LevelGraph from "../components/LevelGraph";
import EmptyLevelHint from "../components/EmptyLevelHint";
import NodeTreePanel from "../components/NodeTreePanel";
import ObjectInspector, { type Selected } from "../components/inspector/ObjectInspector";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "../components/schemaView";
import ExportModal from "../components/ExportModal";
import ProcessViewerModal from "../components/ProcessViewerModal";
import ProcessEditorModal from "../components/ProcessEditorModal";
import ProfileMenu from "../ui/ProfileMenu";
import ProjectSwitcher from "../components/ProjectSwitcher";
import { LogoMark, UpIcon, ExportIcon, ChevronIcon, CollapseIcon } from "../ui/icons";
import "../ui/chrome.css";
import "../components/NodeTreePanel.css"; // классы .nt-collapse / .nt-railbtn для правой панели

interface Props {
  // id текущего проекта (схема скоупится им; смена проекта ремаунтит TreePage по key)
  projectId: string;
  onLogout: () => void;
  // навигация лендинга/свитчера проектов
  onAllProjects: () => void;
  onSwitchProject: (id: string) => void;
}

export default function TreePage({ projectId, onLogout, onAllProjects, onSwitchProject }: Props) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [ghostNodes, setGhostNodes] = useState<GhostNode[]>([]);
  // сохранённые координаты гостей на уровне (ключ — id отображаемой сущности:
  // лист-гость или предок-контейнер, в который гость свёрнут)
  const [levelPositions, setLevelPositions] = useState<
    Record<string, LevelPos>
  >({});
  // Сохранённые хэндлы гостевых концов рёбер на уровне: edge_id → список значений
  // (по одному на проекцию гостевого конца — лист-гость и/или предок-контейнер).
  const [levelEdgeHandles, setLevelEdgeHandles] = useState<
    Record<string, string[]>
  >({});
  // Сохранённые пути (изломы) гостевых стрелок на уровне: edge_id → точки-сгибы.
  const [levelEdgeWaypoints, setLevelEdgeWaypoints] = useState<
    Record<string, LevelWaypoints>
  >({});
  const [edges, setEdges] = useState<LevelEdge[]>([]);
  // Хлебный путь хранит только id+name каждого уровня (этого достаточно для рендера
  // и навигации вверх). Лёгкий тип нужен, чтобы заходить и к госту из другой ветки:
  // его полный путь известен только как ancestors (AncestorRef), без целого Node.
  const [breadcrumb, setBreadcrumb] = useState<AncestorRef[]>([]);
  const [loading, setLoading] = useState(false);

  // node — редактируемый узел (null = создание). При создании перетаскиванием
  // шаблона на схему сюда кладутся выбранная форма (shape) и точка дропа (pos).
  const [nodeModal, setNodeModal] = useState<{
    open: boolean;
    node: Node | null;
    shape?: NodeShape;
    pos?: { x: number; y: number } | null;
  }>({
    open: false,
    node: null,
  });
  // протянули стрелку на узел с детьми — выбор его потомка как дальнего конца связи
  const [intoPicker, setIntoPicker] = useState<{
    sourceId: string;
    containerId: string;
    containerName: string;
    // хэндл узла-источника, из которого протянули стрелку (дальний конец — дефолт)
    sourceHandle: string | null;
  } | null>(null);
  // протянули стрелку на верхнюю плитку «вне уровня» — выбор дальнего конца из ВСЕЙ
  // схемы (узел, которого нет на текущем холсте). Доступно только на не-корневом уровне.
  const [outPicker, setOutPicker] = useState<{
    sourceId: string;
    sourceHandle: string | null;
  } | null>(null);
  // протянули стрелку на хэндл (прямая связь) — упрощённый поповер: описание+технология.
  // Хэндлы из жеста: при дропе на хэндл оба, на тело листа — только исходный.
  const [edgeQuick, setEdgeQuick] = useState<{
    sourceId: string;
    targetId: string;
    sourceHandle: string | null;
    targetHandle: string | null;
  } | null>(null);
  // Объект, чья мета открыта в правой панели (двойной клик по узлу/связи). null — панель
  // показывает пустое состояние. Мету правят inline прямо в панели (см. ObjectInspector).
  const [selectedObject, setSelectedObject] = useState<Selected>(null);
  // выбор связи из «мастер-стрелки» (несколько слитых связей одного направления)
  const [edgeChoice, setEdgeChoice] = useState<LevelEdge[] | null>(null);
  // узел, для которого открыта контекстная схема (клик по дереву слева)
  const [contextNode, setContextNode] = useState<Node | null>(null);
  // узел, который удаляют с канваса по Backspace/Delete → подтверждение со связями
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
  // Несколько выбранных узлов под удаление (мультиудаление с канваса). null — нет.
  const [pendingMultiDelete, setPendingMultiDelete] = useState<Node[] | null>(null);
  // форма шаблона, который сейчас тянут из палитры (null — драга нет). Прокидываем
  // в LevelGraph, чтобы он рисовал превью-рамку будущего узла под курсором.
  const [dragShape, setDragShape] = useState<NodeShape | null>(null);
  // Вид схемы (as-is/переход/to-be) — клиентский визуальный фильтр статусов. Поднят
  // сюда: переключатель живёт в правой панели, а LevelGraph применяет его (приглушение
  // + легенда). Переживает перезагрузку (localStorage), не серверное и не раскладка.
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, schemaView); }, [schemaView]);
  // Свёрнута ли правая панель схемы (как у левого дерева — локально, без персиста).
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Глобальные алерты незавершённости схемы (только для архитектора)
  const [alerts, setAlerts] = useState<Alerts>({
    disconnected_nodes: [],
    intermediate_edges: [],
    isolated_groups: [],
  });

  // сигнал перезагрузки бокового дерева: бампаем после создания/удаления узла,
  // чтобы новый узел сразу попал в дерево без перезагрузки страницы
  const [treeReload, setTreeReload] = useState(0);

  // Открытое окно бизнес-процесса (просмотр/редактор) и токен обновления списка в
  // панели (бумпим при закрытии окна — счётчик сообщений мог измениться).
  const [processModal, setProcessModal] = useState<{ id: string; mode: "view" | "edit" } | null>(null);
  const [processReload, setProcessReload] = useState(0);

  // экспорт схемы в YAML для LLM. Область снимаем на момент открытия (nodeId=null —
  // вся схема, иначе поддерево узла), чтобы навигация её не сбила.
  const [exportScope, setExportScope] = useState<{
    key: string;
    title: string;
    nodeId: string | null;
  } | null>(null);

  // История Undo/Redo всего вида уровня: команды перемещений/изломов кладёт LevelGraph,
  // команду удаления — handleNodeDeleted (удаление инициируется здесь). История
  // per-level-view: чистим при смене уровня. Чистка живёт ЗДЕСЬ, а не в LevelGraph,
  // потому что после удаления load() на миг подменяет LevelGraph спиннером — его
  // эффект-на-mount затёр бы только что положенную команду удаления. TreePage на load
  // не ремаунтится, поэтому эффект на currentParentId срабатывает лишь на реальной навигации.
  const history = useHistory();

  const isArchitect = getUserRole() === "architect";
  const currentParent =
    breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null;
  const currentParentId = currentParent?.id ?? null;

  // Открыть экспорт по текущей области: на корне — вся схема, внутри узла — его поддерево.
  const openExport = () => {
    if (currentParent) {
      setExportScope({
        key: currentParent.id,
        title: `Экспорт поддерева «${currentParent.name}»`,
        nodeId: currentParent.id,
      });
    } else {
      setExportScope({ key: "all", title: "Экспорт схемы", nodeId: null });
    }
  };

  async function load(parentId: string | null) {
    setLoading(true);
    try {
      const graph = await nodesApi.getGraph(parentId);
      setNodes(graph.nodes);
      setGhostNodes(graph.ghost_nodes);
      // ?? {} — на случай старого бэкенда без поля: без позиций, но не белый экран
      setLevelPositions(graph.level_positions ?? {});
      setLevelEdgeHandles(graph.level_edge_handles ?? {});
      setLevelEdgeWaypoints(graph.level_edge_waypoints ?? {});
      setEdges(
        graph.edges.map((ge) => ({
          id: ge.id,
          label: ge.label,
          technology: ge.technology,
          source_id: ge.source_id,
          target_id: ge.target_id,
          // реальные концы ребра — нужны модалке деталей (см. LevelEdge)
          original_source_id: ge.original_source_id,
          original_target_id: ge.original_target_id,
          original_source_name: ge.original_source_name,
          original_target_name: ge.original_target_name,
          source_handle: ge.source_handle,
          target_handle: ge.target_handle,
          waypoints: ge.waypoints,
          label_t: ge.label_t,
          created_at: "",
        }))
      );
    } finally {
      setLoading(false);
    }
    // Алерты глобальные — обновляем при каждой перезагрузке уровня (после правок
    // узлов/связей и навигации). Fire-and-forget: индикатор не блокирует граф.
    void loadAlerts();
  }

  // Компенсирующий/оптимистичный персист правки канваса упал — БД осталась в прежнем
  // состоянии, а зеркало уже показывает новое. Возвращаем зеркало к истине, перезагружая
  // уровень из БД. Дедуп: при пачке отказов (групповой драг — N узлов разом) хватает
  // одной перезагрузки, иначе спиннер дёргался бы N раз.
  const resyncingRef = useRef(false);
  function resyncOnPersistError() {
    if (resyncingRef.current) return;
    resyncingRef.current = true;
    void load(currentParentId).finally(() => { resyncingRef.current = false; });
  }

  // Алерты считаются на бэке по всей схеме; viewer'у эндпоинт недоступен.
  async function loadAlerts() {
    if (!isArchitect) return;
    try {
      setAlerts(await nodesApi.getAlerts());
    } catch {
      // вспомогательный индикатор — ошибку молча гасим, граф важнее
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- первичная загрузка при маунте; load() синхронно зовётся и из навигации, в deps зациклил бы эффект
  useEffect(() => { load(null); }, []);

  // История теперь СКВОЗНАЯ (не чистится при навигации): кросс-уровневый Undo сам
  // редиректит пользователя на уровень правки (см. navigateToLevel/dispatchUndo).

  // Перейти на уровень по его containerId (для кросс-уровневого Undo/Redo). Достраивает
  // breadcrumb по цепочке parent_id из плоского списка всех узлов и грузит уровень.
  // Возвращает промис загрузки — дисптчер ждёт его, чтобы зеркало команды село на
  // уже загруженные данные нужного уровня.
  async function navigateToLevel(level: string | null): Promise<void> {
    if (level === currentParentId) return;
    setContextNode(null);
    setSelectedObject(null);
    if (level === null) {
      setBreadcrumb([]);
      await load(null);
      return;
    }
    const all = await nodesApi.getAll();
    const byId = new Map(all.map((n) => [n.id, n]));
    const path: AncestorRef[] = [];
    let cur: Node | undefined = byId.get(level);
    while (cur) {
      path.unshift({ id: cur.id, name: cur.name, is_external: cur.is_external });
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    setBreadcrumb(path);
    await load(level);
  }

  // Дисптчеры Undo/Redo: если правка сделана на другом уровне — сперва редиректим туда,
  // затем выполняем команду (её зеркало/рефетч сядут на нужный уровень). На текущем
  // уровне работают как раньше (мгновенно). Заглушка level === undefined = текущий.
  async function dispatchUndo() {
    const cmd = history.peekUndo();
    if (!cmd) return;
    if (cmd.level !== undefined && cmd.level !== currentParentId) {
      await navigateToLevel(cmd.level);
    }
    history.undo();
  }
  async function dispatchRedo() {
    const cmd = history.peekRedo();
    if (!cmd) return;
    if (cmd.level !== undefined && cmd.level !== currentParentId) {
      await navigateToLevel(cmd.level);
    }
    history.redo();
  }

  function drillDown(node: Node) {
    setSelectedObject(null); // мета прежнего уровня неактуальна
    setBreadcrumb((prev) => [...prev, node]);
    load(node.id);
  }

  function goUp() {
    setSelectedObject(null);
    const prev = breadcrumb.slice(0, -1);
    setBreadcrumb(prev);
    load(prev.length > 0 ? prev[prev.length - 1].id : null);
  }

  function navigateTo(index: number) {
    setSelectedObject(null);
    const next = breadcrumb.slice(0, index + 1);
    setBreadcrumb(next);
    load(next[next.length - 1].id);
  }

  // Клик по промежуточному узлу в дереве → перейти на его слой основной схемы.
  // path — полный путь от корня до узла включительно (последний элемент = открываемый слой).
  function drillToPath(path: AncestorRef[]) {
    if (path.length === 0) return;
    setContextNode(null); // если была открыта контекст-модалка — закрываем
    setSelectedObject(null);
    setBreadcrumb(path);
    load(path[path.length - 1].id);
  }

  // Семантические (версионируемые) поля узла для отката правки — без раскладки
  // (pos/handle) и parent_id (через модалку не меняется). Совпадает с payload правки
  // в NodeModal, поэтому update(before)/update(after) точно отменяют/повторяют правку.
  function nodeFields(n: Node): NodeUpdate {
    return {
      name: n.name,
      description: n.description,
      role: n.role,
      technology: n.technology,
      flowchart: n.flowchart,
      openapi_spec: n.openapi_spec,
      is_external: n.is_external,
      shape: n.shape,
    };
  }

  // before — узел «как было» до правки полей. У создания приходит из модалки (там before
  // не нужен); у inline-правки в панели его передаёт NodeInspector (модалки уже нет).
  function handleNodeSaved(saved: Node, isCreate: boolean, before?: Node) {
    setNodes((prev) =>
      prev.some((n) => n.id === saved.id)
        ? prev.map((n) => (n.id === saved.id ? saved : n))
        : [...prev, saved]
    );
    setNodeModal({ open: false, node: null });
    // Панель меты показывает актуальные данные правленого узла (если он сейчас выбран).
    setSelectedObject((sel) =>
      sel?.kind === "node" && sel.node.id === saved.id ? { kind: "node", node: saved } : sel
    );
    // Этот обработчик не перезагружает уровень (правит локальный стейт) —
    // алерты обновляем явно: добавленный/изменённый узел мог стать «подвисшим».
    void loadAlerts();
    // боковое дерево перечитываем: новый узел должен появиться, у правленого мог
    // смениться name/форма/число детей (порядок ранжирования)
    setTreeReload((t) => t + 1);

    if (!isArchitect) return;
    if (isCreate) {
      // Создание узла (Undo): структурная операция, как удаление — undo снимает снимок
      // и удаляет (с сохранением id), redo восстанавливает; уровень перечитываем.
      const levelAtCreate = currentParentId;
      const refetch = () => { load(levelAtCreate); setTreeReload((t) => t + 1); };
      let snap: DeletionSnapshot | null = null;
      history.push({
        label: "Создание объекта",
        level: levelAtCreate,
        undo: () => {
          guardPersist(
            nodesApi.deletionSnapshot(saved.id)
              .then((s) => { snap = s; return nodesApi.delete(saved.id); })
              .then(refetch),
            resyncOnPersistError,
          );
        },
        redo: () => {
          guardPersist((snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch), resyncOnPersistError);
        },
      });
    } else if (before) {
      // Правка полей (Undo): возвращаем/повторяем семантику через update, зеркаля в
      // локальный стейт сразу (мгновенно, как перемещения) + обновляя алерты/дерево.
      const apply = (n: Node) => {
        setNodes((prev) => prev.map((x) => (x.id === n.id ? n : x)));
        void loadAlerts();
        setTreeReload((t) => t + 1);
      };
      history.push({
        label: "Правка объекта",
        level: currentParentId,
        undo: () => { apply(before); guardPersist(nodesApi.update(before.id, nodeFields(before)), resyncOnPersistError); },
        redo: () => { apply(saved); guardPersist(nodesApi.update(saved.id, nodeFields(saved)), resyncOnPersistError); },
      });
    }
  }

  function handleNodeDeleted(id: string, snapshot?: DeletionSnapshot) {
    // Перезагружаем уровень: вместе с узлом удалились его связи (в т.ч. сквозные),
    // поэтому проецированные рёбра и гости без связей должны пересчитаться.
    setNodeModal({ open: false, node: null });
    setSelectedObject(null); // удалённый узел больше нельзя показывать в панели
    load(currentParentId);
    setTreeReload((t) => t + 1); // удалённый узел должен уйти и из бокового дерева

    // Откат удаления (Undo): restore воссоздаёт поддерево с исходными id, redo —
    // повторное удаление по тому же id. В отличие от перемещений (мгновенное зеркало
    // в стейт), структурное восстановление требует серверной проекции гостей/рёбер,
    // поэтому undo/redo перечитывают уровень — та же цена, что и у самого удаления.
    // Уровень фиксируем на момент удаления: история чистится при навигации, так что
    // на момент undo пользователь на том же уровне.
    if (!snapshot) return;
    const levelAtDelete = currentParentId;
    const refetch = () => {
      load(levelAtDelete);
      setTreeReload((t) => t + 1);
    };
    history.push({
      label: "Удаление объекта",
      undo: () => {
        guardPersist(nodesApi.restore(snapshot).then(refetch), resyncOnPersistError);
      },
      redo: () => {
        guardPersist(nodesApi.delete(id).then(refetch), resyncOnPersistError);
      },
    });
  }

  // Мультиудаление с канваса: несколько узлов снесены одним действием. Откат —
  // ОДНА запись истории, восстанавливающая/повторно сносящая всю пачку (узлы
  // уровня — сиблинги, удаления независимы, поэтому restore/delete параллельны).
  function handleNodesDeleted(ids: string[], snapshots: DeletionSnapshot[]) {
    load(currentParentId);
    setTreeReload((t) => t + 1);
    if (snapshots.length === 0) return;
    const levelAtDelete = currentParentId;
    const refetch = () => {
      load(levelAtDelete);
      setTreeReload((t) => t + 1);
    };
    history.push({
      label: `Удаление объектов (${ids.length})`,
      undo: () => {
        guardPersist(
          Promise.all(snapshots.map((s) => nodesApi.restore(s))).then(refetch),
          resyncOnPersistError,
        );
      },
      redo: () => {
        guardPersist(
          Promise.all(ids.map((id) => nodesApi.delete(id))).then(refetch),
          resyncOnPersistError,
        );
      },
    });
  }

  // Reconnect в LevelGraph сохранил новые хэндлы (в БД и в локальные rfEdges).
  // Синхронизируем стейт уровня теми же значениями, что вернул бы рефетч графа —
  // иначе пересчёт раскладки (сворачивание/разворачивание контейнеров без рефетча)
  // откатил бы привязку к autoHandles. Хэндл локального конца — в колонку ребра,
  // хэндл гостевого конца — в level_edge_handles (по проекции node_id).
  function updateEdgeHandles(
    edgeId: string,
    changes: {
      column?: { source_handle?: string; target_handle?: string };
      ghost?: { node_id: string; handle: string };
    },
  ) {
    if (changes.column) {
      const col = changes.column;
      setEdges((prev) =>
        prev.map((e) => (e.id === edgeId ? { ...e, ...col } : e)),
      );
    }
    if (changes.ghost) {
      const { node_id, handle } = changes.ghost;
      setLevelEdgeHandles((prev) => {
        // одна проекция (node_id) = один хэндл: выкидываем прежний для этого узла
        const rest = (prev[edgeId] ?? []).filter(
          (h) => !h.startsWith(node_id + "--"),
        );
        return { ...prev, [edgeId]: [...rest, handle] };
      });
    }
  }

  // Путь стрелки изменён жестом (изломы) и сохранён в БД (useEdgeWaypoints) — зеркалируем
  // waypoints в стейт уровня теми же значениями, что вернул бы рефетч. Иначе пересчёт
  // раскладки без рефетча (напр. сворачивание контейнера) откатил бы излом к авто-маршруту.
  function updateEdgeWaypoints(edgeId: string, waypoints: EdgePoint[]) {
    setEdges((prev) =>
      prev.map((e) => (e.id === edgeId ? { ...e, waypoints } : e)),
    );
  }

  // То же для ГОСТЕВОЙ стрелки — путь живёт в пер-уровневом слое (level_edge_waypoints),
  // а не в колонке ребра. Зеркалируем теми же значениями, что вернул бы рефетч; anchor_rel
  // помечает изломы владеемой группы (офсет от якоря, ТЗ D8) — по умолчанию абсолют.
  function updateLevelEdgeWaypoints(edgeId: string, waypoints: EdgePoint[], anchorRel = false) {
    setLevelEdgeWaypoints((prev) => ({ ...prev, [edgeId]: { waypoints, anchor_rel: anchorRel } }));
  }

  // Плашку подписи перетащили — доля label_t сохранена в колонку ребра (commitLabelT).
  // Зеркалим в стейт уровня теми же значениями, что вернул бы рефетч (доля одна на ребро).
  function updateEdgeLabelT(edgeId: string, t: number | null) {
    setEdges((prev) => prev.map((e) => (e.id === edgeId ? { ...e, label_t: t } : e)));
  }

  // Узел перетащили — позиция уже сохранена в БД (useSnapAlignment), здесь
  // зеркалируем её в стейт уровня теми же значениями, что вернул бы рефетч. Иначе
  // пересчёт раскладки БЕЗ рефетча (локальный setEdges при реконнекте хэндла)
  // откатил бы узел на прежнюю сохранённую позицию. Локальный узел (block) хранит
  // координаты в самом узле, гость/контейнер — в levelPositions по id сущности.
  function handleNodeMoved(
    id: string,
    kind: "block" | "ghost" | "container",
    pos: { pos_x: number; pos_y: number; anchor_rel?: boolean },
  ) {
    if (kind === "block") {
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, pos_x: pos.pos_x, pos_y: pos.pos_y } : n)),
      );
    } else {
      // anchor_rel зеркалим из сохранённого значения (драг обычной позиции — абсолют;
      // пин владеемой группы пишет офсет с anchor_rel=true, см. шаг 4)
      setLevelPositions((prev) => ({
        ...prev,
        [id]: { pos_x: pos.pos_x, pos_y: pos.pos_y, anchor_rel: pos.anchor_rel ?? false },
      }));
    }
  }

  function handleEdgeDeleted(id: string, snapshot?: DeletionSnapshot) {
    setSelectedObject(null);
    load(currentParentId);
    // Откат удаления связи (Undo): restore воссоздаёт связь с исходным id, redo —
    // повторное удаление. Симметрично удалению узла (та же цена — рефетч уровня).
    if (!snapshot || !isArchitect) return;
    const levelAtDelete = currentParentId;
    const refetch = () => load(levelAtDelete);
    history.push({
      label: "Удаление связи",
      level: levelAtDelete,
      undo: () => { guardPersist(nodesApi.restore(snapshot).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist(edgesApi.delete(id).then(refetch), resyncOnPersistError); },
    });
  }

  function handleEdgeSaved(updated: Edge, undoPayload?: EdgeUpdate, redoPayload?: EdgeUpdate) {
    // Перезагружаем уровень — метка/технология/концы обновятся на стрелке. Саму модалку
    // не трогаем: её концы — спроецированные (а PATCH вернул бы сырые), а новые
    // метка/технология уже показаны из локального состояния модалки.
    load(currentParentId);
    // Откат ПРАВКИ полей связи (Undo): update(undoPayload)/update(redoPayload), рефетч —
    // смена концов меняет проекцию гостей/рёбер, поэтому зеркалить в стейт нельзя.
    if (!undoPayload || !redoPayload || !isArchitect) return;
    const levelAtEdit = currentParentId;
    const refetch = () => load(levelAtEdit);
    history.push({
      label: "Правка связи",
      level: levelAtEdit,
      undo: () => { guardPersist(edgesApi.update(updated.id, undoPayload).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist(edgesApi.update(updated.id, redoPayload).then(refetch), resyncOnPersistError); },
    });
  }

  // Протянули стрелку на хэндл/листовой узел — открываем упрощённый поповер, чтобы
  // сразу заполнить описание и технологию (связь создаётся по «Создать», см. EdgeQuickCreate).
  // Хэндлы из жеста прокидываем в поповер, чтобы связь создалась с ними, а не с дефолтными.
  function handleCreateEdge(
    sourceId: string, targetId: string,
    sourceHandle: string | null, targetHandle: string | null,
  ) {
    setEdgeQuick({ sourceId, targetId, sourceHandle, targetHandle });
  }

  // Откат СОЗДАНИЯ связи (Undo): структурная операция, как создание узла — undo снимает
  // снимок связи (само ребро + ghost-хэндлы/изломы) и удаляет, redo восстанавливает с
  // сохранением id. Уровень перечитываем (связь могла спроецироваться гостем).
  function pushEdgeCreate(created: Edge) {
    if (!isArchitect) return;
    const levelAtCreate = currentParentId;
    const refetch = () => load(levelAtCreate);
    let snap: DeletionSnapshot | null = null;
    history.push({
      label: "Создание связи",
      level: levelAtCreate,
      undo: () => {
        guardPersist(
          edgesApi.deletionSnapshot(created.id)
            .then((s) => { snap = s; return edgesApi.delete(created.id); })
            .then(refetch),
          resyncOnPersistError,
        );
      },
      redo: () => {
        guardPersist((snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch), resyncOnPersistError);
      },
    });
  }

  function handleQuickCreated(created: Edge) {
    setEdgeQuick(null);
    load(currentParentId);
    pushEdgeCreate(created);
  }

  // Протянули стрелку на узел С ДЕТЬМИ — открываем выбор его потомка. Хэндл источника
  // сохраняем (дальний конец — дефолт, см. CrossLevelEdgePicker).
  function handleConnectInto(
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null,
  ) {
    setIntoPicker({ sourceId, containerId, containerName, sourceHandle });
  }

  function handleIntoCreated(created: Edge) {
    setIntoPicker(null);
    load(currentParentId);
    pushEdgeCreate(created);
  }

  // Шаблон узла отпустили на схему (LevelGraph посчитал координаты в системе графа) —
  // открываем модалку создания с выбранной формой и точкой дропа.
  function handleDropNode(shape: NodeShape, pos: { x: number; y: number }) {
    setNodeModal({ open: true, node: null, shape, pos });
  }

  // Полное ребро уровня по id — LevelGraph отдаёт в колбэках суженный до Edge тип
  // (без original_*), а модалке деталей нужны реальные концы. Это тот же объект из
  // стейта (LevelGraph искал его в том же массиве), просто восстанавливаем тип.
  const findLevelEdge = (id: string): LevelEdge | null =>
    edges.find((e) => e.id === id) ?? null;

  const findNodeLabel = (id: string): string =>
    nodes.find((n) => n.id === id)?.name ??
    ghostNodes.find((g) => g.id === id)?.name ??
    id;

  // Имя конца связи для заголовка «Выберите связь». Берём ФАКТИЧЕСКИЙ конец ребра
  // (может быть дочерним узлом при сквозной связи), а не спроецированный на уровень
  // узел. У членов мастер-стрелки фактические концы могут различаться (общий лишь
  // спроецированный конец, по нему и сгруппированы) — если расходятся, показываем
  // спроецированный общий конец (findNodeLabel по общему source_id/target_id группы).
  const edgeEndLabel = (originalNames: string[], projectedId: string): string => {
    const uniq = new Set(originalNames);
    return uniq.size === 1 ? originalNames[0] : findNodeLabel(projectedId);
  };

  const hasNodes = nodes.length + ghostNodes.length > 0;
  // Есть ли на уровне не-existing узлы — тогда показываем правую панель «Вид схемы»
  // (на чистой as-is-схеме фильтровать нечего; то же условие, что у легенды в LevelGraph).
  const hasStatusInfo =
    nodes.some((n) => n.status !== "existing") ||
    ghostNodes.some((g) => g.status !== "existing");

  // Счётчики узлов уровня по статусу — для легенды в правой панели (как у прежнего
  // оверлея на холсте). Считаем по сырым узлам/гостям уровня.
  const statusCounts = useMemo<Record<NodeStatus, number>>(() => {
    const c: Record<NodeStatus, number> = { existing: 0, planned: 0, deprecated: 0 };
    for (const n of nodes) c[n.status]++;
    for (const g of ghostNodes) c[g.status]++;
    return c;
  }, [nodes, ghostNodes]);

  // Открыть мету связи в панели (двойной клик / выбор участника мастер-стрелки).
  const inspectEdge = (edge: LevelEdge) => {
    setSelectedObject({ kind: "edge", edge });
    setRightCollapsed(false);
  };

  return (
    <div style={page}>
      {/* Шапка + панель управления */}
      <div style={topBar}>
        <div style={topLeft}>
          {/* Логомарк + вордмарк */}
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <LogoMark />
            <span style={{ fontSize: 16.5, fontWeight: 700, letterSpacing: "-0.01em", color: "#0f172a" }}>
              Arch<span style={{ color: "#2563eb" }}>Map</span>
            </span>
          </div>
          <span style={{ width: 1, height: 22, background: "#e2e8f0", flex: "none", margin: "0 4px" }} />
          {/* Свитчер проектов: имя текущего + дропдаун (поиск, выбор, новый/все) */}
          <ProjectSwitcher
            projectId={projectId}
            isArchitect={isArchitect}
            onAllProjects={onAllProjects}
            onSwitchProject={onSwitchProject}
          />
          <span style={{ width: 1, height: 22, background: "#e2e8f0", flex: "none", margin: "0 4px" }} />
          {/* Хлебные крошки — без подчёркиваний, разделители-шевроны */}
          <button
            className="crumb"
            style={crumbLink}
            onClick={() => { setBreadcrumb([]); load(null); }}
          >
            Контекст
          </button>
          {breadcrumb.map((n, i) => (
            <span key={n.id} style={{ display: "flex", alignItems: "center" }}>
              <span style={crumbSep}><ChevronIcon /></span>
              {i < breadcrumb.length - 1 ? (
                <button className="crumb" style={crumbLink} onClick={() => navigateTo(i)}>{n.name}</button>
              ) : (
                // активный уровень — тоже <button> (без onClick), чтобы метрики бокса
                // совпадали с соседними крошками-кнопками и текст не «съезжал» вниз
                <button style={crumbCurrent} disabled>{n.name}</button>
              )}
            </span>
          ))}
          {breadcrumb.length > 0 && (
            <button
              className="icon-btn"
              onClick={goUp}
              style={{ ...iconBtn, width: 30, height: 30 }}
              title="На уровень выше"
              aria-label="На уровень выше"
            >
              <UpIcon />
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Создание узла — перетаскиванием шаблона из боковой панели (секция
              «Добавить объект»), связи — протягиванием стрелки от хэндла узла.
              Отдельных кнопок создания в шапке больше нет. */}
          <button
            className="icon-btn"
            onClick={openExport}
            style={iconBtn}
            title="Скопировать схему (или текущее поддерево) в YAML для LLM"
            aria-label="Экспорт в YAML"
          >
            <ExportIcon />
          </button>
          <ProfileMenu role={isArchitect ? "Архитектор" : "Наблюдатель"} onLogout={onLogout} />
        </div>
      </div>

      {/* Тело: боковая панель слева + область графа справа */}
      <div style={bodyRow}>
        <NodeTreePanel
          onDrillTo={drillToPath}
          onNodeContext={setContextNode}
          isArchitect={isArchitect}
          onTemplateDrag={setDragShape}
          reloadToken={treeReload}
          onOpenProcess={(id) => setProcessModal({ id, mode: "view" })}
          onEditProcess={(id) => setProcessModal({ id, mode: "edit" })}
          processRefreshToken={processReload}
        />

        {/* Область графа — заполняет оставшееся пространство */}
        <div style={graphArea}>
          {/* Индикатор незавершённости схемы (только архитектор) */}
          {isArchitect && <SchemaAlerts alerts={alerts} />}
          {/* Подсказка про пустой уровень — тостом в правом верхнем углу. Холст
              (даже пустой) рендерим всегда, чтобы сразу была видна канва и в неё
              можно было дропнуть первый узел. Тост уезжает уже при открытии окна
              создания узла: пользователь до него дошёл — значит инструкцию прочёл,
              дальше тост только отвлекает. */}
          <EmptyLevelHint
            visible={!loading && !hasNodes && !nodeModal.open}
            isArchitect={isArchitect}
          />
          {loading ? (
            <p style={{ color: "#6b7280", padding: 24 }}>Загрузка...</p>
          ) : (
            <LevelGraph
              nodes={nodes}
              ghostNodes={ghostNodes}
              levelPositions={levelPositions}
              levelEdgeHandles={levelEdgeHandles}
              levelEdgeWaypoints={levelEdgeWaypoints}
              edges={edges}
              depth={breadcrumb.length}
              containerId={currentParentId}
              ancestorNames={breadcrumb.map((b) => b.name)}
              ancestorIds={breadcrumb.map((b) => b.id)}
              isArchitect={isArchitect}
              onDrillDown={drillDown}
              onEnterNode={drillToPath}
              onEditNode={(node) => { setSelectedObject({ kind: "node", node }); setRightCollapsed(false); }}
              onEdgesChoice={(group) => {
                const les = group
                  .map((g) => findLevelEdge(g.id))
                  .filter((e): e is LevelEdge => e != null);
                // одна связь — сразу в панель; несколько — выбор участника (модалка-пикер)
                if (les.length === 1) inspectEdge(les[0]);
                else if (les.length > 1) setEdgeChoice(les);
              }}
              onEdgeHandlesChanged={updateEdgeHandles}
              onEdgeWaypointsChanged={updateEdgeWaypoints}
              onLevelEdgeWaypointsChanged={updateLevelEdgeWaypoints}
              onEdgeLabelTChanged={updateEdgeLabelT}
              onNodeMoved={handleNodeMoved}
              onDropNode={handleDropNode}
              onCreateEdge={handleCreateEdge}
              onConnectInto={handleConnectInto}
              onExitUp={(sourceId, sourceHandle) => setOutPicker({ sourceId, sourceHandle })}
              onRequestDeleteNode={setPendingDelete}
              onRequestDeleteNodes={setPendingMultiDelete}
              dragShape={dragShape}
              history={history}
              onUndo={dispatchUndo}
              onRedo={dispatchRedo}
              onPersistError={resyncOnPersistError}
              schemaView={schemaView}
            />
          )}
        </div>

        {/* Правая панель схемы — сворачиваемая, по аналогии с левым деревом. Держит мету
            выбранного объекта (узла/связи) и переключатель «Вид схемы» (когда есть что
            фильтровать). Присутствует всегда — даже на чистой as-is-схеме (ради меты). */}
        <aside style={{ ...rightPanel, width: rightCollapsed ? RIGHT_COLLAPSED_W : RIGHT_W }}>
          {rightCollapsed ? (
            <div style={rightRail}>
              {/* свойства — разворачивает панель к выбранному объекту */}
              <button
                className="nt-railbtn"
                title="Свойства объекта"
                onClick={() => setRightCollapsed(false)}
              >
                <svg width={17} height={17} viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
                </svg>
              </button>
              {hasStatusInfo && (
                <button
                  className="nt-railbtn"
                  title="Вид схемы"
                  onClick={() => setRightCollapsed(false)}
                >
                  {/* воронка-фильтр */}
                  <svg width={17} height={17} viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 5h18l-7 8v6l-4-2v-4z" />
                  </svg>
                </button>
              )}
            </div>
          ) : (
            <div style={rightContent}>
              <ObjectInspector
                hasStatusInfo={hasStatusInfo}
                view={schemaView}
                onViewChange={setSchemaView}
                counts={statusCounts}
                selected={selectedObject}
                isArchitect={isArchitect}
                onNodeSaved={handleNodeSaved}
                onNodeDeleted={handleNodeDeleted}
                onEdgeSaved={handleEdgeSaved}
                onEdgeDeleted={handleEdgeDeleted}
              />
            </div>
          )}
          <button
            className="nt-collapse"
            onClick={() => setRightCollapsed((c) => !c)}
            title={rightCollapsed ? "Развернуть панель" : "Свернуть панель"}
          >
            <CollapseIcon dir={rightCollapsed ? "left" : "right"} />
            {!rightCollapsed && <span>Свернуть панель</span>}
          </button>
        </aside>
      </div>

      {nodeModal.open && (
        <NodeModal
          parentId={currentParentId}
          shape={nodeModal.shape}
          initialPos={nodeModal.pos ?? null}
          onClose={() => setNodeModal({ open: false, node: null })}
          onSaved={handleNodeSaved}
        />
      )}
      {/* Подтверждение удаления узла, инициированное с канваса (Backspace/Delete) —
          то же предупреждение со списком связей, что и из модалки узла */}
      {pendingDelete && (
        <NodeDeleteConfirm
          node={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDeleted={(id, snapshot) => { setPendingDelete(null); handleNodeDeleted(id, snapshot); }}
        />
      )}
      {/* Мультиудаление с канваса (несколько выбранных узлов по Backspace/Delete) */}
      {pendingMultiDelete && (
        <NodesDeleteConfirm
          nodes={pendingMultiDelete}
          onCancel={() => setPendingMultiDelete(null)}
          onDeleted={(ids, snapshots) => { setPendingMultiDelete(null); handleNodesDeleted(ids, snapshots); }}
        />
      )}
      {edgeQuick && (
        <EdgeQuickCreate
          sourceId={edgeQuick.sourceId}
          targetId={edgeQuick.targetId}
          sourceHandle={edgeQuick.sourceHandle}
          targetHandle={edgeQuick.targetHandle}
          sourceLabel={findNodeLabel(edgeQuick.sourceId)}
          targetLabel={findNodeLabel(edgeQuick.targetId)}
          onClose={() => setEdgeQuick(null)}
          onCreated={handleQuickCreated}
        />
      )}
      {intoPicker && (
        <CrossLevelEdgePicker
          title={`Связь внутрь «${intoPicker.containerName}»`}
          subtitle="Выберите объект-потомок — дальний конец межуровневой связи."
          sourceId={intoPicker.sourceId}
          sourceLabel={findNodeLabel(intoPicker.sourceId)}
          sourceHandle={intoPicker.sourceHandle}
          loadNodes={() => nodesApi.getDescendants(intoPicker.containerId)}
          scopeKey={intoPicker.containerId}
          rootParentId={intoPicker.containerId}
          slotPlaceholder={`Объект внутри «${intoPicker.containerName}»…`}
          onClose={() => setIntoPicker(null)}
          onCreated={handleIntoCreated}
        />
      )}
      {outPicker && (
        <CrossLevelEdgePicker
          title="Связь с объектом вне уровня"
          subtitle="Выберите объект из любой части схемы — связь станет сквозной."
          sourceId={outPicker.sourceId}
          sourceLabel={findNodeLabel(outPicker.sourceId)}
          sourceHandle={outPicker.sourceHandle}
          loadNodes={() => nodesApi.getAll()}
          scopeKey="all"
          rootParentId={null}
          slotPlaceholder="Объект вне уровня…"
          // на этом уровне уже видны локальные узлы и гости — их (и сам источник)
          // выбирать незачем: к ним тянут связь прямо на холсте
          excludeIds={
            new Set<string>([
              outPicker.sourceId,
              ...nodes.map((n) => n.id),
              ...ghostNodes.map((g) => g.id),
            ])
          }
          onClose={() => setOutPicker(null)}
          onCreated={(created) => { setOutPicker(null); load(currentParentId); pushEdgeCreate(created); }}
        />
      )}
      {edgeChoice && edgeChoice.length > 0 && (
        <EdgeChoiceModal
          edges={edgeChoice}
          sourceLabel={edgeEndLabel(edgeChoice.map((e) => e.original_source_name), edgeChoice[0].source_id)}
          targetLabel={edgeEndLabel(edgeChoice.map((e) => e.original_target_name), edgeChoice[0].target_id)}
          onPick={(edge) => { setEdgeChoice(null); inspectEdge(edge); }}
          // Архитектору — дозаписать новую связь в том же направлении (концы как у
          // стрелки на схеме, хэндлы дефолтные). Открываем тот же поповер, что и жест.
          onAdd={
            isArchitect
              ? () => {
                  const dir = edgeChoice[0];
                  setEdgeChoice(null);
                  setEdgeQuick({
                    sourceId: dir.source_id,
                    targetId: dir.target_id,
                    sourceHandle: null,
                    targetHandle: null,
                  });
                }
              : undefined
          }
          onClose={() => setEdgeChoice(null)}
        />
      )}
      {contextNode && (
        <NodeContextModal
          node={contextNode}
          onClose={() => setContextNode(null)}
        />
      )}

      {exportScope && (
        <ExportModal
          title={exportScope.title}
          loadKey={exportScope.key}
          load={() =>
            exportScope.nodeId ? exportApi.subtree(exportScope.nodeId) : exportApi.all()
          }
          onClose={() => setExportScope(null)}
        />
      )}

      {/* Окно бизнес-процесса. Закрытие бумпит processReload → панель перечитывает
          список (счётчик сообщений мог измениться в редакторе). */}
      {processModal?.mode === "view" && (
        <ProcessViewerModal
          id={processModal.id}
          isArchitect={isArchitect}
          onClose={() => { setProcessModal(null); setProcessReload((n) => n + 1); }}
          onEdit={(id) => setProcessModal({ id, mode: "edit" })}
        />
      )}
      {processModal?.mode === "edit" && (
        <ProcessEditorModal
          id={processModal.id}
          onClose={() => { setProcessModal(null); setProcessReload((n) => n + 1); }}
        />
      )}
    </div>
  );
}

const page: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  fontFamily: "system-ui, -apple-system, sans-serif",
  overflow: "hidden",
};
const topBar: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "11px 20px",
  borderBottom: "1px solid #e2e8f0",
  background: "#fff",
  flexShrink: 0,
  gap: 12,
  flexWrap: "wrap",
};
const topLeft: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 14,
  flexWrap: "wrap",
  flex: 1,
  minWidth: 0,
};
const bodyRow: CSSProperties = {
  flex: 1,
  display: "flex",
  minHeight: 0,
  overflow: "hidden",
};
const graphArea: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  padding: "16px 20px 20px",
  display: "flex",
  flexDirection: "column",
  position: "relative", // якорь для абсолютного индикатора алертов
};
// Правая панель схемы (вид схемы; позже — мета узлов/связей) — зеркало левого дерева:
// сворачивается в узкий рейл, футер-кнопка снизу. Стили .nt-collapse/.nt-railbtn
// переиспользуем из NodeTreePanel.css.
const RIGHT_W = 264;          // ширина развёрнутой панели
const RIGHT_COLLAPSED_W = 48; // узкий рейл со значком в свёрнутом виде
const rightPanel: CSSProperties = {
  position: "relative",
  flexShrink: 0,
  borderLeft: "1px solid #e2e8f0",
  background: "#fbfcfd",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  transition: "width 0.22s ease",
};
const rightRail: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  paddingTop: 12,
  flex: 1,
};
const rightContent: CSSProperties = {
  width: RIGHT_W,   // фиксированная ширина — без переноса при анимации сворачивания
  boxSizing: "border-box", // паддинг ВНУТРИ ширины, иначе контент шире панели и сегмент уезжает
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "14px 14px",
};
const crumbLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "3px 7px",
  borderRadius: 7,
  fontSize: 13.5,
  color: "#64748b",
  cursor: "pointer",
  background: "none",
  border: "none",
}; // hover (фон/синий) — класс .crumb в chrome.css
const crumbCurrent: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "3px 7px",
  fontSize: 13.5,
  color: "#1e293b",
  fontWeight: 600,
  background: "none",
  border: "none",
  cursor: "default",
};
const crumbSep: CSSProperties = {
  color: "#cbd5e1",
  display: "inline-flex",
  alignItems: "center",
  margin: "0 1px",
};
const iconBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 34,
  height: 34,
  flex: "none",
  background: "#fff",
  color: "#475569",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  cursor: "pointer",
}; // hover — класс .icon-btn в chrome.css
