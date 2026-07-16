import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi, edgesApi, exportApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import type { AncestorRef, DeletionSnapshot, Edge, EdgeUpdate, GhostNode, LevelEdge, Node, NodeShape, NodeStatus, NodeUpdate, SchemaAlerts as Alerts, ViewLayout, ViewLayoutPayload } from "../types";
import { useHistory } from "../components/graph/interaction/useHistory";
import { guardPersist } from "../components/graph/interaction/persistGuard";
import { liftEdgesToLevel } from "../components/graph/projection";
import CrossLevelEdgePicker from "../components/CrossLevelEdgePicker";
import EdgeQuickCreate from "../components/EdgeQuickCreate";
import SchemaAlerts, { type LocateTarget } from "../components/SchemaAlerts";
import EdgeChoiceModal from "../components/EdgeChoiceModal";
import NodeModal from "../components/NodeModal";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import NodesDeleteConfirm from "../components/NodesDeleteConfirm";
import NodeContextModal from "../components/NodeContextModal";
import RelayoutConfirm from "../components/RelayoutConfirm";
import LevelGraph, { type LocateRequest } from "../components/LevelGraph";
import EmptyLevelHint from "../components/EmptyLevelHint";
import NodeTreePanel from "../components/NodeTreePanel";
import ObjectInspector, { type Selected } from "../components/inspector/ObjectInspector";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "../components/schemaView";
import ExportModal from "../components/ExportModal";
import ProcessWorkspace from "../components/processes/ProcessWorkspace";
import { processesApi } from "../api/processes";
import { detailToMermaid } from "../components/processes/sequence/toMermaid";
import ProfileMenu from "../ui/ProfileMenu";
import ProjectSwitcher from "../components/ProjectSwitcher";
import { LogoMark, UpIcon, ExportIcon, RelayoutIcon, ChevronIcon, CollapseIcon } from "../ui/icons";
import "../ui/chrome.css";
import "../components/NodeTreePanel.css"; // классы .nt-collapse / .nt-railbtn для правой панели

// Рабочая область: C4-схема или бизнес-процессы. Персистится в localStorage.
type WorkMode = "schema" | "proc";
const MODE_KEY = "archmap_mode";

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
  // Реестр не-локальных концов рёбер уровня (R2): гости И глубокие концы внутри
  // поддерева, с цепочками предков. Проекцию на видимые сущности делает конвейер
  // LevelGraph; здесь реестр нужен ещё и для имён концов и производных гостей.
  const [endpoints, setEndpoints] = useState<GhostNode[]>([]);
  // Раскладка текущего вида (R3, единое хранилище view_layout): item_id → payload.
  // Позиции сущностей (локалы/гости/контейнеры) — по их id; геометрия рёбер не
  // хранится (авто-слой, легаси-ключи пучков "b:" бэк отфильтровывает).
  // Зеркало БД: правки приходят из onLayoutChanged.
  const [viewLayout, setViewLayout] = useState<ViewLayout>({});
  const [edges, setEdges] = useState<LevelEdge[]>([]);
  // Хлебный путь хранит только id+name каждого уровня (этого достаточно для рендера
  // и навигации вверх). Лёгкий тип нужен, чтобы заходить и к госту из другой ветки:
  // его полный путь известен только как ancestors (AncestorRef), без целого Node.
  const [breadcrumb, setBreadcrumb] = useState<AncestorRef[]>([]);
  const [loading, setLoading] = useState(false);
  // Запрос «показать на схеме» из индикатора незавершённости — прокидывается в LevelGraph.
  // token (монотонный) меняется на каждый клик, чтобы повторный клик снова сфокусировал.
  const [locate, setLocate] = useState<LocateRequest | null>(null);
  const locateSeq = useRef(0);

  // node — редактируемый узел (null = создание). При создании перетаскиванием
  // шаблона на схему сюда кладутся выбранная форма (shape) и точка дропа (pos).
  const [nodeModal, setNodeModal] = useState<{
    open: boolean;
    node: Node | null;
    shape?: NodeShape;
    pos?: { x: number; y: number } | null;
    // Дроп в раскрытую рамку: parentId — контейнер рамки (родитель узла), posView — вид
    // текущего уровня (куда писать позицию). Оба отсутствуют при обычном дропе на уровень.
    parentId?: string | null;
    posView?: string | null;
  }>({
    open: false,
    node: null,
  });
  // Триггер таргетного рефреша кэша детей раскрытого контейнера в LevelGraph (дроп нового
  // узла в его рамку / откат такого дропа — localChildren иначе держит устаревший список).
  const [childRefresh, setChildRefresh] = useState<{ id: string; token: number } | null>(null);
  const childRefreshTok = useRef(0);
  const refreshFrameChildren = (id: string) => {
    childRefreshTok.current += 1;
    setChildRefresh({ id, token: childRefreshTok.current });
  };
  // протянули стрелку на узел с детьми — выбор его потомка как дальнего конца связи.
  // Имена концов приезжают С ЖЕСТОМ (LevelGraph): дети раскрытых локальных контейнеров
  // известны только холсту — findNodeLabel по nodes/endpoints их не разрешит.
  const [intoPicker, setIntoPicker] = useState<{
    sourceId: string;
    containerId: string;
    containerName: string;
    // хэндл узла-источника, из которого протянули стрелку (дальний конец — дефолт)
    sourceHandle: string | null;
    sourceName?: string;
  } | null>(null);
  // протянули стрелку на верхнюю плитку «вне уровня» — выбор дальнего конца из ВСЕЙ
  // схемы (узел, которого нет на текущем холсте). Доступно только на не-корневом уровне.
  const [outPicker, setOutPicker] = useState<{
    sourceId: string;
    sourceHandle: string | null;
    sourceName?: string;
  } | null>(null);
  // протянули стрелку на хэндл (прямая связь) — упрощённый поповер: описание+технология.
  // Хэндлы из жеста: при дропе на хэндл оба, на тело листа — только исходный.
  const [edgeQuick, setEdgeQuick] = useState<{
    sourceId: string;
    targetId: string;
    sourceHandle: string | null;
    targetHandle: string | null;
    sourceName?: string;
    targetName?: string;
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
  // Открыто подтверждение «Переразложить уровень» (сброс ручного layout → авто).
  const [relayoutOpen, setRelayoutOpen] = useState(false);
  // форма шаблона, который сейчас тянут из палитры (null — драга нет). Прокидываем
  // в LevelGraph, чтобы он рисовал превью-рамку будущего узла под курсором.
  const [dragShape, setDragShape] = useState<NodeShape | null>(null);
  // Вид схемы (as-is/переход/to-be) — клиентский визуальный фильтр статусов. Поднят
  // сюда: переключатель живёт в правой панели, а LevelGraph применяет его (приглушение
  // + легенда). Переживает перезагрузку (localStorage), не серверное и не раскладка.
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, schemaView); }, [schemaView]);
  // Режим рабочей области: «Схема» (C4-холст + дерево) или «Процессы» (рейл + sequence).
  // Персистится так же, как вид схемы — через localStorage (общая привычка пользователя).
  const [mode, setMode] = useState<WorkMode>(() => (localStorage.getItem(MODE_KEY) === "proc" ? "proc" : "schema"));
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);
  // Выбранный процесс в режиме «Процессы» (id + имя) — поднят из ProcessWorkspace,
  // чтобы кнопка экспорта в шапке знала, какой процесс выгружать в Mermaid.
  const [procSelection, setProcSelection] = useState<{ id: string; name: string } | null>(null);
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

  // экспорт схемы в YAML для LLM. Область снимаем на момент открытия (nodeId=null —
  // вся схема, иначе поддерево узла), чтобы навигация её не сбила.
  const [exportScope, setExportScope] = useState<{
    key: string;
    title: string;
    load: () => Promise<{ content: string }>;
  } | null>(null);

  // История Undo/Redo: команды перемещений/изломов кладёт LevelGraph, структурные
  // (создание/правка/удаление узлов и связей) — обработчики здесь. История СКВОЗНАЯ
  // по уровням (при навигации НЕ чистится): каждая команда несёт level, и дисптчеры
  // dispatchUndo/dispatchRedo перед откатом редиректят пользователя на уровень правки.
  // Полная чистка — только при «Переразложить уровень» (история кросс-уровневая, а
  // сброс раскладки необратим).
  const history = useHistory();

  const isArchitect = getUserRole() === "architect";
  const currentParent =
    breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null;
  const currentParentId = currentParent?.id ?? null;

  // Открыть экспорт. В режиме «Процессы» — выбранный процесс в Mermaid sequenceDiagram;
  // в режиме «Схема» — C4 в YAML: на корне вся схема, внутри узла его поддерево.
  const openExport = () => {
    if (mode === "proc") {
      if (!procSelection) return; // нет выбранного процесса — экспортировать нечего
      const { id, name } = procSelection;
      setExportScope({
        key: `proc:${id}`,
        title: `Экспорт процесса «${name}» (Mermaid)`,
        load: () => processesApi.get(id).then((d) => ({ content: detailToMermaid(d) })),
      });
    } else if (currentParent) {
      setExportScope({
        key: currentParent.id,
        title: `Экспорт поддерева «${currentParent.name}»`,
        load: () => exportApi.subtree(currentParent.id),
      });
    } else {
      setExportScope({ key: "all", title: "Экспорт схемы", load: () => exportApi.all() });
    }
  };

  async function load(parentId: string | null) {
    setLoading(true);
    try {
      const graph = await nodesApi.getGraph(parentId);
      setNodes(graph.nodes);
      setEndpoints(graph.endpoints);
      // раскладка вида как есть (R3): геометрию по ней раздаёт конвейер LevelGraph
      setViewLayout(graph.layout ?? {});
      // Имена для original_* — из локалов и реестра концов (R2: source_id/target_id
      // ребра и ЕСТЬ реальные концы, original_* синтезируются для модалок деталей).
      const nameById = new Map<string, string>([
        ...graph.nodes.map((n) => [n.id, n.name] as const),
        ...graph.endpoints.map((ep) => [ep.id, ep.name] as const),
      ]);
      setEdges(
        graph.edges.map((ge) => ({
          id: ge.id,
          label: ge.label,
          technology: ge.technology,
          source_id: ge.source_id,
          target_id: ge.target_id,
          original_source_id: ge.source_id,
          original_target_id: ge.target_id,
          original_source_name: nameById.get(ge.source_id) ?? "",
          original_target_name: nameById.get(ge.target_id) ?? "",
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

  // «Показать на схеме» из индикатора незавершённости. Алерты глобальные (могут лежать
  // на другом уровне), поэтому сперва вычисляем «домашний» уровень цели по дереву и
  // приводим к нему холст (navigateToLevel), затем кладём запрос фокуса в LevelGraph.
  async function handleLocate(target: LocateTarget) {
    const all = await nodesApi.getAll();
    const byId = new Map(all.map((n) => [n.id, n]));
    // Цепочка контейнеров узла снизу вверх: [родитель, дед, ..., null(корень)].
    const parentChain = (id: string): (string | null)[] => {
      const out: (string | null)[] = [];
      let n = byId.get(id);
      while (n && n.parent_id) {
        out.push(n.parent_id);
        n = byId.get(n.parent_id);
      }
      out.push(null);
      return out;
    };
    // Самый глубокий общий предок набора узлов = уровень, на котором рисуется их связь
    // (для одного узла — его родитель; для связи — общий предок концов).
    const commonLevel = (ids: string[]): string | null => {
      const chains = ids.map(parentChain);
      for (const cand of chains[0]) {
        if (chains.every((ch) => ch.includes(cand))) return cand;
      }
      return null;
    };

    let level: string | null;
    let req: LocateRequest;
    if (target.kind === "node") {
      level = commonLevel([target.id]);
      req = { kind: "node", ids: [target.id], token: ++locateSeq.current };
    } else if (target.kind === "edge") {
      // источник/цель связи берём из самих алертов (в onLocate приходит только edge_id)
      const al = alerts.intermediate_edges.find((e) => e.edge_id === target.id);
      if (!al) return;
      level = commonLevel([al.source_id, al.target_id]);
      req = { kind: "edge", ids: [target.id], token: ++locateSeq.current };
    } else {
      level = commonLevel(target.ids);
      req = { kind: "group", ids: target.ids, token: ++locateSeq.current };
    }

    if (level !== currentParentId) await navigateToLevel(level);
    setLocate(req);
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

  // «Перейти к источнику» гостя: гость — проекция чужого узла, реальный узел живёт на
  // уровне своего непосредственного родителя (ancestors = корень→родитель). Уводим туда,
  // где узел показан как локал; пустой путь предков → узел живёт на корневом уровне.
  function goToGhostSource(ghost: GhostNode) {
    if (ghost.ancestors.length > 0) { drillToPath(ghost.ancestors); return; }
    setContextNode(null);
    setSelectedObject(null);
    setBreadcrumb([]);
    load(null);
  }

  // Рефетч уровня + бокового дерева для undo/redo структурных команд: замыкание
  // фиксирует уровень правки на момент создания команды (redo/undo могут выполняться
  // с другого уровня — дисптчер сперва средиректит по cmd.level).
  const refetchLevel = (level: string | null) => () => {
    load(level);
    setTreeReload((t) => t + 1);
  };

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
    // Дроп в раскрытую рамку: узел — ребёнок ДРУГОГО контейнера, а не прямой локал уровня.
    // В nodes уровня его добавлять нельзя (появился бы вне рамки). Позицию (её NodeModal
    // записал в вид уровня) зеркалим в стейт viewLayout — иначе own-on-first-render засеет
    // поверх; кэш детей контейнера обновляем в LevelGraph таргетным рефрешем.
    const intoFrame = isCreate && saved.parent_id != null && saved.parent_id !== currentParentId;
    if (intoFrame) {
      if (nodeModal.pos) handleLayoutChanged({ [saved.id]: { x: nodeModal.pos.x, y: nodeModal.pos.y } });
      refreshFrameChildren(saved.parent_id!);
    } else {
      setNodes((prev) =>
        prev.some((n) => n.id === saved.id)
          ? prev.map((n) => (n.id === saved.id ? saved : n))
          : [...prev, saved]
      );
    }
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
      // и удаляет (с сохранением id), redo восстанавливает; уровень перечитываем. Для дропа
      // в рамку дополнительно рефрешим кэш детей контейнера (узел не в nodes уровня).
      const levelAtCreate = currentParentId;
      const frameParent = intoFrame ? saved.parent_id : null;
      const refetch = () => {
        refetchLevel(levelAtCreate)();
        if (frameParent) refreshFrameChildren(frameParent);
      };
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
    // level обязателен: история СКВОЗНАЯ по уровням, и без него кросс-уровневый
    // Undo не средиректил бы на уровень удаления, а refetch загрузил бы данные
    // чужого уровня в текущий холст (расходясь с breadcrumb).
    if (!snapshot) return;
    const levelAtDelete = currentParentId;
    const refetch = refetchLevel(levelAtDelete);
    history.push({
      label: "Удаление объекта",
      level: levelAtDelete,
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
    const refetch = refetchLevel(levelAtDelete);
    history.push({
      label: `Удаление объектов (${ids.length})`,
      level: levelAtDelete,
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

  // Раскладка вида изменена и сохранена (LevelGraph.commitLayout: позиции узлов и/или
  // геометрия пучков) — зеркалим ТЕ ЖЕ значения в стейт, иначе пересчёт раскладки без
  // рефетча откатил бы правку к сохранённому. ЕДИНСТВЕННЫЙ канал зеркалирования (R3;
  // заменил пять прежних колбэков по слоям). null — строка удалена (сброс в авто).
  function handleLayoutChanged(items: Record<string, ViewLayoutPayload | null>) {
    setViewLayout((prev) => {
      const next = { ...prev };
      for (const [k, p] of Object.entries(items)) {
        if (p === null) delete next[k];
        else next[k] = p;
      }
      return next;
    });
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
    sourceName?: string, targetName?: string,
  ) {
    setEdgeQuick({ sourceId, targetId, sourceHandle, targetHandle, sourceName, targetName });
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

  // Хэндлы из ЖЕСТА создания связи НЕ персистятся (V2.2, санкция 2026-07-08 —
  // «запоминание хэндлов» снято): сохранённый хэндл навсегда фиксировал сторону
  // (lockedIds), и при сдвигах узлов роутер был вынужден вести маршрут огородами от
  // устаревшей стороны. Сторону стыковки теперь ВСЕГДА выбирает роутер — ручной
  // фиксации хэндлов больше не существует (реконнект удалён вместе с ручным слоем
  // 2026-07-09).
  function handleQuickCreated(created: Edge) {
    setEdgeQuick(null);
    load(currentParentId);
    pushEdgeCreate(created);
  }

  // Протянули стрелку на узел С ДЕТЬМИ — открываем выбор его потомка.
  function handleConnectInto(
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null, sourceName?: string,
  ) {
    setIntoPicker({ sourceId, containerId, containerName, sourceHandle, sourceName });
  }

  function handleIntoCreated(created: Edge) {
    setIntoPicker(null);
    load(currentParentId);
    pushEdgeCreate(created);
  }

  // Шаблон узла отпустили на схему (LevelGraph посчитал координаты в системе графа) —
  // открываем модалку создания с выбранной формой и точкой дропа.
  function handleDropNode(shape: NodeShape, pos: { x: number; y: number }, dropParentId: string | null) {
    // Дроп в раскрытую рамку: узел — ребёнок её контейнера (dropParentId), а позиция
    // принадлежит виду ТЕКУЩЕГО уровня (posView=currentParentId). Обычный дроп — как раньше.
    if (dropParentId) {
      setNodeModal({ open: true, node: null, shape, pos, parentId: dropParentId, posView: currentParentId });
    } else {
      setNodeModal({ open: true, node: null, shape, pos });
    }
  }

  // Полное ребро уровня по id — LevelGraph отдаёт в колбэках суженный до Edge тип
  // (без original_*), а модалке деталей нужны реальные концы. Это тот же объект из
  // стейта (LevelGraph искал его в том же массиве), просто восстанавливаем тип.
  const findLevelEdge = (id: string): LevelEdge | null =>
    edges.find((e) => e.id === id) ?? null;

  const findNodeLabel = (id: string): string =>
    nodes.find((n) => n.id === id)?.name ??
    endpoints.find((ep) => ep.id === id)?.name ??
    id;

  // Производные ГОСТИ уровня (identity вне поддерева): та же первая половина
  // проекции, что в конвейере LevelGraph. Нужны легенде статусов и пикеру
  // «объект вне уровня» — реестр endpoints шире (содержит и глубокие концы
  // внутри поддерева, которые на холст не попадают).
  const levelGhosts = useMemo(
    () =>
      liftEdgesToLevel({
        edges,
        endpoints,
        localIds: new Set(nodes.map((n) => n.id)),
        containerId: currentParentId,
      }).ghosts,
    [edges, endpoints, nodes, currentParentId],
  );

  // Что открыто в панели → устойчивая подсветка связанного на схеме (П5/П6). Гость и
  // локал сводятся к kind:"node" (подсветить узел + его стрелки); связь → kind:"edge"
  // (подсветить стрелку + оба её узла). Мемо — чтобы эффект подсветки не гонялся каждый рендер.
  const linkedHighlight = useMemo((): { kind: "node" | "edge"; id: string } | null => {
    if (!selectedObject) return null;
    if (selectedObject.kind === "edge") return { kind: "edge", id: selectedObject.edge.id };
    if (selectedObject.kind === "ghost") return { kind: "node", id: selectedObject.ghost.id };
    return { kind: "node", id: selectedObject.node.id };
  }, [selectedObject]);

  // Имя конца связи для заголовка «Выберите связь». Берём ФАКТИЧЕСКИЙ конец ребра
  // (может быть дочерним узлом при сквозной связи), а не спроецированный на уровень
  // узел. У членов мастер-стрелки фактические концы могут различаться (общий лишь
  // спроецированный конец, по нему и сгруппированы) — если расходятся, показываем
  // спроецированный общий конец (findNodeLabel по общему source_id/target_id группы).
  const edgeEndLabel = (originalNames: string[], projectedId: string): string => {
    const uniq = new Set(originalNames);
    return uniq.size === 1 ? originalNames[0] : findNodeLabel(projectedId);
  };

  const hasNodes = nodes.length + levelGhosts.length > 0;
  // Есть ли на уровне не-existing узлы — тогда показываем правую панель «Вид схемы»
  // (на чистой as-is-схеме фильтровать нечего; то же условие, что у легенды в LevelGraph).
  const hasStatusInfo =
    nodes.some((n) => n.status !== "existing") ||
    levelGhosts.some((g) => g.status !== "existing");

  // Счётчики узлов уровня по статусу — для легенды в правой панели (как у прежнего
  // оверлея на холсте). Считаем по локалам и ГОСТЯМ уровня (не по всему реестру
  // endpoints — глубокие концы внутри поддерева на холсте не видны).
  const statusCounts = useMemo<Record<NodeStatus, number>>(() => {
    const c: Record<NodeStatus, number> = { existing: 0, planned: 0, deprecated: 0 };
    for (const n of nodes) c[n.status]++;
    for (const g of levelGhosts) c[g.status]++;
    return c;
  }, [nodes, levelGhosts]);

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
          {/* Хлебные крошки нужны только навигации по схеме — в режиме «Процессы» скрыты */}
          {mode === "schema" && (
          <>
          <span style={{ width: 1, height: 22, background: "#e2e8f0", flex: "none", margin: "0 4px" }} />
          <button
            className="crumb"
            style={crumbLink}
            onClick={() => { void navigateToLevel(null); }}
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
          </>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Переключатель рабочей области: Схема / Процессы (персистится) */}
          <ModeSwitch mode={mode} onChange={setMode} />
          {/* Переразложить уровень — сброс ручного layout к авто-раскладке. Только
              архитектор, только режим схемы и когда на уровне есть что раскладывать. */}
          {mode === "schema" && isArchitect && (
            <button
              className="icon-btn"
              onClick={() => setRelayoutOpen(true)}
              style={iconBtn}
              disabled={!hasNodes}
              title="Переразложить уровень — вернуть авто-раскладку"
              aria-label="Переразложить уровень"
            >
              <RelayoutIcon />
            </button>
          )}
          {/* Создание узла — перетаскиванием шаблона из боковой панели (секция
              «Добавить объект»), связи — протягиванием стрелки от хэндла узла.
              Отдельных кнопок создания в шапке больше нет. */}
          <button
            className="icon-btn"
            onClick={openExport}
            style={iconBtn}
            disabled={mode === "proc" && !procSelection}
            title={
              mode === "proc"
                ? "Скопировать выбранный процесс в Mermaid sequenceDiagram для LLM"
                : "Скопировать схему (или текущее поддерево) в YAML для LLM"
            }
            aria-label={mode === "proc" ? "Экспорт процесса в Mermaid" : "Экспорт в YAML"}
          >
            <ExportIcon />
          </button>
          <ProfileMenu role={isArchitect ? "Архитектор" : "Наблюдатель"} onLogout={onLogout} />
        </div>
      </div>

      {/* Тело: режим «Процессы» — рейл + sequence-холст; режим «Схема» — дерево +
          C4-граф + панель свойств. Процессы живут самостоятельным режимом, а не модалкой. */}
      <div style={bodyRow}>
        {mode === "proc" ? (
          <ProcessWorkspace isArchitect={isArchitect} onSelectedChange={setProcSelection} />
        ) : (
        <>
        <NodeTreePanel
          onDrillTo={drillToPath}
          onNodeContext={setContextNode}
          isArchitect={isArchitect}
          onTemplateDrag={setDragShape}
          reloadToken={treeReload}
        />

        {/* Область графа — заполняет оставшееся пространство */}
        <div style={graphArea}>
          {/* РЕЙЛ ТОСТОВ в правом верхнем углу ХОЛСТА (не вьюпорта): все всплывашки
              схемы живут здесь колонкой, не заслоняя шапку и панели. overflow:hidden
              graphArea обрезает их анимации — тосты выезжают из-за края холста и
              уезжают туда же (а не за край экрана поверх правой панели). */}
          <div style={toastRail}>
            {/* Индикатор незавершённости схемы (только архитектор) */}
            {isArchitect && <SchemaAlerts alerts={alerts} onLocate={handleLocate} />}
            {/* Подсказка про пустой уровень. Холст (даже пустой) рендерим всегда,
                чтобы сразу была видна канва и в неё можно было дропнуть первый узел.
                Тост уезжает уже при открытии окна создания узла: пользователь до него
                дошёл — значит инструкцию прочёл, дальше тост только отвлекает. */}
            <EmptyLevelHint
              visible={!loading && !hasNodes && !nodeModal.open}
              isArchitect={isArchitect}
            />
          </div>
          {loading ? (
            <p style={{ color: "#6b7280", padding: 24 }}>Загрузка...</p>
          ) : (
            <LevelGraph
              nodes={nodes}
              endpoints={endpoints}
              viewLayout={viewLayout}
              edges={edges}
              depth={breadcrumb.length}
              containerId={currentParentId}
              ancestorNames={breadcrumb.map((b) => b.name)}
              ancestorIds={breadcrumb.map((b) => b.id)}
              isArchitect={isArchitect}
              onDrillDown={drillDown}
              onEnterNode={drillToPath}
              onEditNode={(node) => { setSelectedObject({ kind: "node", node }); setRightCollapsed(false); }}
              onInspectGhost={(ghost) => { setSelectedObject({ kind: "ghost", ghost }); setRightCollapsed(false); }}
              linkedHighlight={linkedHighlight}
              onClearSelection={() => setSelectedObject(null)}
              onEdgesChoice={(group) => {
                const les = group
                  .map((g) => findLevelEdge(g.id))
                  .filter((e): e is LevelEdge => e != null);
                // одна связь — сразу в панель; несколько — выбор участника (модалка-пикер)
                if (les.length === 1) inspectEdge(les[0]);
                else if (les.length > 1) setEdgeChoice(les);
              }}
              onLayoutChanged={handleLayoutChanged}
              onDropNode={handleDropNode}
              refreshChildrenOf={childRefresh}
              onCreateEdge={handleCreateEdge}
              onConnectInto={handleConnectInto}
              onExitUp={(sourceId, sourceHandle, sourceName) => setOutPicker({ sourceId, sourceHandle, sourceName })}
              onRequestDeleteNode={setPendingDelete}
              onRequestDeleteNodes={setPendingMultiDelete}
              dragShape={dragShape}
              history={history}
              onUndo={dispatchUndo}
              onRedo={dispatchRedo}
              onPersistError={resyncOnPersistError}
              schemaView={schemaView}
              locate={locate}
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
                onGhostGoToSource={goToGhostSource}
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
        </>
        )}
      </div>

      {nodeModal.open && (
        <NodeModal
          parentId={nodeModal.parentId !== undefined ? nodeModal.parentId : currentParentId}
          shape={nodeModal.shape}
          initialPos={nodeModal.pos ?? null}
          posView={nodeModal.posView}
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
      {/* Подтверждение «Переразложить уровень»: по ОК сносим ручной layout уровня на
          бэке, перезагружаем уровень и чистим историю (старые Undo-перемещения этого
          уровня после пере-сева указывали бы на исчезнувшие позиции). */}
      {relayoutOpen && (
        <RelayoutConfirm
          containerId={currentParentId}
          levelName={currentParent?.name}
          onCancel={() => setRelayoutOpen(false)}
          onDone={() => {
            setRelayoutOpen(false);
            load(currentParentId);
            history.clear();
          }}
        />
      )}
      {edgeQuick && (
        <EdgeQuickCreate
          sourceId={edgeQuick.sourceId}
          targetId={edgeQuick.targetId}
          sourceLabel={edgeQuick.sourceName ?? findNodeLabel(edgeQuick.sourceId)}
          targetLabel={edgeQuick.targetName ?? findNodeLabel(edgeQuick.targetId)}
          onClose={() => setEdgeQuick(null)}
          onCreated={handleQuickCreated}
        />
      )}
      {intoPicker && (
        <CrossLevelEdgePicker
          title={`Связь внутрь «${intoPicker.containerName}»`}
          subtitle="Выберите объект-потомок — дальний конец межуровневой связи."
          sourceId={intoPicker.sourceId}
          sourceLabel={intoPicker.sourceName ?? findNodeLabel(intoPicker.sourceId)}
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
          sourceLabel={outPicker.sourceName ?? findNodeLabel(outPicker.sourceId)}
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
              ...levelGhosts.map((g) => g.id),
            ])
          }
          onClose={() => setOutPicker(null)}
          // Хэндл источника из жеста НЕ сохраняем: хэндлы вообще не персистятся
          // (авто-слой, сторону выбирает роутер) — стрелка встанет на авто-хэндл.
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
          load={exportScope.load}
          onClose={() => setExportScope(null)}
        />
      )}

    </div>
  );
}

// Сегмент-переключатель режима «Схема / Процессы» (как в прототипе варианта B):
// активная вкладка — белый чип с тенью и акцентным цветом.
function ModeSwitch({ mode, onChange }: { mode: WorkMode; onChange: (m: WorkMode) => void }) {
  const tab = (active: boolean): CSSProperties => ({
    height: 30,
    padding: "0 14px",
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 7,
    cursor: "pointer",
    border: "none",
    fontFamily: "inherit",
    color: active ? "#2563eb" : "#64748b",
    background: active ? "#fff" : "transparent",
    boxShadow: active ? "0 1px 2px rgba(15,23,42,.10)" : "none",
  });
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: 3, background: "#f1f5f9", borderRadius: 9 }}>
      <button style={tab(mode === "schema")} onClick={() => onChange("schema")} title="C4-схема">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="4.5" rx="1" /><rect x="3" y="16.5" width="6" height="4.5" rx="1" /><rect x="15" y="16.5" width="6" height="4.5" rx="1" /><path d="M12 7.5 V11 M6 16.5 V13 H18 V16.5" />
        </svg>
        Схема
      </button>
      <button style={tab(mode === "proc")} onClick={() => onChange("proc")} title="Бизнес-процессы">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="18" r="2.4" /><path d="M8.4 6 H13 a2.6 2.6 0 0 1 2.6 2.6 V9.6 M8.4 18 H13 a2.6 2.6 0 0 0 2.6-2.6 V14.4" />
        </svg>
        Процессы
      </button>
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
  position: "relative", // якорь для рейла тостов (и клип их въезда/уезда)
};
// Рейл тостов холста: колонка в правом верхнем углу graphArea (алерты схемы,
// подсказка пустого уровня). Сам рейл прозрачен для мыши — интерактив включают
// дети точечно (кнопка алертов); чисто информативные тосты остаются некликабельными.
const toastRail: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 6,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 8,
  pointerEvents: "none",
};
// Правая панель схемы (вид схемы; позже — мета узлов/связей) — зеркало левого дерева:
// сворачивается в узкий рейл, футер-кнопка снизу. Стили .nt-collapse/.nt-railbtn
// переиспользуем из NodeTreePanel.css.
const RIGHT_W = 320;          // ширина развёрнутой панели (под поле «Статус», чтобы не было гор. скролла)
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
  // gutter под бегунок резервируем отдельной дорожкой: на Linux/WSL Chrome бегунок —
  // оверлей и иначе наезжал бы на правый паддинг, из-за чего поля меты упирались в него.
  scrollbarGutter: "stable",
  padding: "14px 16px",
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
