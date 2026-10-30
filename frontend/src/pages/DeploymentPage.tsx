// Режим «Развёртывание» (docs/tasks/deployment-view.md, спека docs/specs/deployment.md):
// где крутятся объекты уровня. Слева — дерево объектов (NodeTreePanel mode="deploy"):
// система — её уровень, объект — выделить его карточки (у компонента — карточки его
// контейнера), иконка строки — режим размещения щелчком по площадке. Холст — тот же
// LevelGraph с проекцией хозяина: площадки — зоны (вложенность без предела,
// сворачиваются в карточку), представитель — карточка в каждой площадке, где он стоит:
// единица (контейнер, лист или с компонентами) или цельная система одной карточкой;
// без размещения — в пунктирной группе. Уровень (объём холста) — из адреса
// #/p/<pid>/deploy/<уровень?>, в тулбаре — путь текстом и справа квадратные иконки
// «Площадки», «Переразложить» (архитектор) и тумблер «Подписи связей» (CV32: холст в
// управляемом режиме, свой тумблер в углу не рисует). Архитектору — расстановка (драг,
// персист ключами deploy:…, undo), «Переразложить» и размещение; читателю — просмотр.
// Связи — как на холсте объектов: двойной клик по стрелке (или клик по плашке)
// подсвечивает её и оба конца, несколько связей в пучке — окно выбора (useEdgeChoice).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node as AppNode, AncestorRef, LevelEdge, ViewLayoutPayload } from "../types";
import LevelGraph from "../components/LevelGraph";
import NodeTreePanel from "../components/NodeTreePanel";
import SchemaLegend from "../components/SchemaLegend";
import type {
  LevelDrillCallbacks, LevelEdgeCallbacks, LevelModeFlags, LevelPersistenceProps, LevelProjectionProps,
  LinkedHighlight, LocateRequest,
} from "../components/graph/types";
import { useEdgeChoice } from "../components/graph/interaction/useEdgeChoice";
import { readEdgeLabelsHidden, writeEdgeLabelsHidden } from "../components/graph/labelsPref";
import { cardsOf, projectDeployment } from "../components/deployment/deploymentProjection";
import PlacementDialog from "../components/deployment/PlacementDialog";
import PlacementConflictList from "../components/deployment/PlacementConflictList";
import { PLACE_LEAD, placeQuestion, UNPLACE_LEAD, unplaceQuestion } from "../components/deployment/placementConflicts";
import SitesDialog from "../components/deployment/SitesDialog";
import { nodesApi, viewsApi } from "../api/nodes";
import { isConflict } from "../api/client";
import { useAsyncLoad } from "../lib/useAsyncLoad";
import ConfirmDialog from "../ui/ConfirmDialog";
import LoadError from "../ui/LoadError";
import { listToast } from "../ui/pageChrome";
import { primaryBtn } from "../ui/styles";
import { EdgeLabelsIcon, RelayoutIcon, SiteKindIcon } from "../ui/icons";
import { loadErrorText } from "../ui/loadErrorText";
import { plural } from "../ui/plural";
import { useDeploymentGraph } from "./useDeploymentGraph";
import { useDeploymentPlacing } from "./useDeploymentPlacing";
import { usePersistenceHost } from "./usePersistenceHost";
import { useRemoteSync } from "./useRemoteSync";
import { useMessageToast } from "./useToast";
import "./DeploymentPage.css";

interface Props {
  isArchitect: boolean;
  // Уровень — из адреса (#/p/<pid>/deploy/<уровень?>): система, чьё поддерево на холсте,
  // null — весь проект. Уровня контейнера нет (D24): сервер отвечает 422 текстом.
  level: string | null;
  // Сменить уровень — навигацией (дерево, двойной клик по системе, «Весь проект» в
  // тулбаре): адрес меняется, и «назад» браузера возвращает прежний уровень.
  onNavigateLevel: (level: string | null) => void;
  // Двойной клик по карточке объекта → страница объекта (оболочка переключает режим).
  onOpenNode: (nodeId: string) => void;
}

// Стабильный пустой вход холста: у развёртывания нет breadcrumb-рамок (уровень — объём).
const NO_ANCESTORS: string[] = [];
const NO_ANCESTOR_ELEMENTS: AncestorRef["element_effective"][] = [];

/** Цепочка системы уровня от корня проекта (она сама — последней); пусто у всего проекта
 *  и пока объекты не загружены. Обход с seen: данные могут оказаться циклом. */
function levelChain(all: readonly AppNode[], level: string | null): AppNode[] {
  if (level === null) return [];
  const byId = new Map(all.map((n) => [n.id, n] as const));
  const chain: AppNode[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(level); cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
    seen.add(cur.id);
    chain.unshift(cur);
  }
  return chain;
}

/** Контейнер компонента — ближайший предок с элементом «контейнер» (элемент считает
 *  сервер) по составу проекта; подъём с seen. Не нашёлся (состав не загружен, цикл в
 *  данных) — null. */
function containerOf(all: readonly AppNode[], node: AppNode): AppNode | null {
  const byId = new Map(all.map((n) => [n.id, n] as const));
  const seen = new Set<string>([node.id]);
  for (let cur = node.parent_id ? byId.get(node.parent_id) : undefined; cur && !seen.has(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
    if (cur.element_effective === "container") return cur;
    seen.add(cur.id);
  }
  return null;
}

export default function DeploymentPage({ isArchitect, level, onNavigateLevel, onOpenNode }: Props) {
  const dep = useDeploymentGraph(level);
  // Все объекты проекта: путь уровня в тулбаре, своё размещение и состав для режима
  // размещения. Перечитываются после записи размещения; прошлый список держится, пока не
  // придёт новый (без мигания пути).
  const all = useAsyncLoad("deployment-nodes", () => nodesApi.getAll());
  const [allNodes, setAllNodes] = useState<AppNode[]>([]);
  if (all.data && all.data !== allNodes) setAllNodes(all.data);

  // Поллинг чужих правок: схема (graph_rev) и мета карточек (имена, статусы — meta_rev).
  useRemoteSync({
    currentParentId: level,
    viewMeta: dep.viewMetaRef,
    gestureActiveRef: dep.gestureActiveRef,
    onRemoteChange: () => { void dep.reload(); },
    onMetaChange: () => { void dep.reload(); },
  });

  // Путь уровня в тулбаре и глубина цвета карточек: корни объёма — дети системы
  // уровня, их архитектурная глубина — длина её цепочки (0 у всего проекта).
  const chain = useMemo(() => levelChain(allNodes, level), [allNodes, level]);
  const path = chain.map((n) => n.name).join(" › ");
  const proj = useMemo(() => (dep.graph ? projectDeployment(dep.graph, chain.length) : null), [dep.graph, chain.length]);

  // Выбранная связь (двойной клик по стрелке или клик по плашке): подсветка её и обоих
  // концов (linkedHighlight), несколько связей в пучке — окно выбора. Снимается двойным
  // кликом по пустому холсту и сменой уровня.
  const [selectedEdge, setSelectedEdge] = useState<LevelEdge | null>(null);
  const resolveEdge = useCallback(
    (id: string): LevelEdge | null => (proj?.edges.find((e) => e.id === id) as LevelEdge | undefined) ?? null,
    [proj],
  );
  // Подпись конца в окне выбора — имя объекта карточки (реестр концов) или площадки.
  const labelOf = useCallback(
    (id: string): string =>
      proj?.endpoints.find((ep) => ep.id === id)?.name ?? proj?.nodes.find((n) => n.id === id)?.name ?? id,
    [proj],
  );
  const linkedHighlight = useMemo(
    (): LinkedHighlight | null => (selectedEdge ? { kind: "edge", id: selectedEdge.id } : null),
    [selectedEdge],
  );
  const { onEdgesChoice, choiceModal } = useEdgeChoice({ resolveEdge, labelOf, onPick: setSelectedEdge });
  const edgeCallbacks = useMemo<LevelEdgeCallbacks>(() => ({ onEdgesChoice }), [onEdgesChoice]);

  // Выделение холста (id карточек) → выбранные объекты без повторов.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedObjects = useMemo(() => {
    if (!proj) return [];
    return [...new Set(selectedIds.map((id) => proj.groupOf(id)).filter((x): x is string => !!x))];
  }, [selectedIds, proj]);
  // «Снять выделение» — токеном холсту (ремаунт потерял бы камеру).
  const [clearToken, setClearToken] = useState(0);
  // Окна: «Размещение» выбранных объектов и «Площадки».
  const [placementOpen, setPlacementOpen] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(false);
  // Сигнал мутации холсту: после смены размещения стрелки перерисуются анимированно.
  const [mutationToken, setMutationToken] = useState(0);
  const [toast, showToast] = useMessageToast(4000);

  // Показ объекта на холсте (D28): выделить его карточки (selectRequest) и, по щелчку в
  // дереве, навести камеру на первую (locate). Токен растёт с каждым запросом; ids: [] —
  // запроса нет (так его снимает смена уровня, не сбрасывая счёт токенов).
  const [focus, setFocus] = useState<{ ids: string[]; token: number; locate: boolean }>(
    { ids: [], token: 0, locate: false },
  );
  const showCards = useCallback((ids: string[], locate: boolean) => {
    setFocus((f) => ({ ids, token: f.token + 1, locate }));
  }, []);
  const selectRequest = useMemo(
    () => (focus.ids.length > 0 ? { ids: focus.ids, token: focus.token } : null),
    [focus],
  );
  const locate = useMemo<LocateRequest | null>(
    () => (focus.ids.length > 0 && focus.locate ? { kind: "node", ids: [focus.ids[0]], token: focus.token } : null),
    [focus],
  );
  // Объект из дерева, чьи карточки выделить, когда загрузится граф его уровня (уровень
  // родителя: там лист всегда свой представитель).
  const [pendingShow, setPendingShow] = useState<{ nodeId: string; level: string | null } | null>(null);

  // Режим размещения (архитектор): иконка строки дерева → щелчок по площадке.
  const placingMode = useDeploymentPlacing({
    proj,
    sites: dep.graph?.sites ?? [],
    allNodes,
    onWritten: async () => {
      setClearToken((t) => t + 1);
      setMutationToken((t) => t + 1);
      all.reload();
      return dep.reload();
    },
    onShow: (ids) => showCards(ids, false),
    onToast: showToast,
  });

  // Персист раскладки (архитектор): зеркало, ресинк при отказе, переигровка 409.
  const host = usePersistenceHost(dep.reload);
  const persistence = useMemo<LevelPersistenceProps | undefined>(() => {
    if (!isArchitect) return undefined;
    return {
      onLayoutChanged: dep.mergeLayout,
      onPersistError: host.resync,
      onPersistConflict: host.onConflict,
      retryPatch: host.retryPatch,
      viewMeta: dep.viewMetaRef,
      gestureActiveRef: dep.gestureActiveRef,
    };
  }, [isArchitect, dep.mergeLayout, dep.viewMetaRef, dep.gestureActiveRef, host.resync, host.onConflict, host.retryPatch]);

  // «Скрыть подписи связей» (CV32) — тумблер в тулбаре страницы (управляемый режим
  // холста, как в редакторе-карте): настройка на проект, общая со схемой объектов.
  const [edgeLabelsHidden, setEdgeLabelsHidden] = useState(readEdgeLabelsHidden);
  useEffect(() => { writeEdgeLabelsHidden(edgeLabelsHidden); }, [edgeLabelsHidden]);

  const mode = useMemo<LevelModeFlags>(() => ({
    readOnly: true,
    arrangeOnly: isArchitect,
    // связи инспектируются и в просмотре: подсветка пути и окно выбора у пучка
    edgesInspectable: true,
    fitOnLoad: true,
    ignorePersistedExpanded: false,
    edgeLabelsHidden,
  }), [isArchitect, edgeLabelsHidden]);

  const projection = useMemo<LevelProjectionProps | undefined>(() => (proj
    ? {
        children: proj.children,
        inlineDepth: Infinity,
        frameDecor: proj.frameDecor,
        marks: proj.marks,
        depths: proj.depths,
        groupOf: proj.groupOf,
        clearSelectionToken: clearToken,
        pickFrame: placingMode.pickFrame,
        selectRequest,
      }
    : undefined), [proj, clearToken, placingMode.pickFrame, selectRequest]);

  // Ошибка действия тулбара («Переразложить»); смена уровня её снимает.
  const [actionError, setActionError] = useState<string | null>(null);
  // Уровень сменился (дерево, двойной клик по системе, «назад» браузера): выделение,
  // показ объекта, ошибка и отложенная переигровка 409 прежнего уровня снимаются прямо в
  // рендере (приём React «adjust state when props change»: setState в эффекте — каскад
  // рендеров). Переигровку — обязательно: у нового холста счётчик токенов с нуля.
  // Режим размещения смена уровня не сбрасывает; отложенный показ объекта — только если
  // уровень сменили не ради него.
  const [shownLevel, setShownLevel] = useState(level);
  if (shownLevel !== level) {
    setShownLevel(level);
    setSelectedIds([]);
    setSelectedEdge(null);
    setFocus((f) => ({ ids: [], token: f.token, locate: false }));
    setActionError(null);
    if (pendingShow && pendingShow.level !== level) setPendingShow(null);
    host.dropRetry();
  }
  // Граф уровня отложенного показа загружен: выделить карточки объекта (их нет — объекта
  // на холсте нет, как «Пользователя», — показ просто снимается).
  if (pendingShow && pendingShow.level === level && !dep.loading && dep.graphLevel === level && proj) {
    const ids = cardsOf(proj, pendingShow.nodeId);
    setPendingShow(null);
    if (ids.length > 0) showCards(ids, true);
  }

  // Щелчок по объекту в дереве (D28): представитель на этом уровне — выделить его
  // карточки и навести камеру; иначе — уровень его родителя и показ после загрузки.
  // Компонента на этом холсте нет (D33) — показываются карточки его контейнера.
  const pickObject = (picked: AppNode) => {
    if (picked.shape === "person") return; // «Пользователей» на этом холсте нет (D1)
    const node = picked.element_effective === "component" ? containerOf(allNodes, picked) : picked;
    if (!node) return;
    const ids = proj && !dep.loading && dep.graphLevel === level ? cardsOf(proj, node.id) : [];
    if (ids.length > 0) {
      showCards(ids, true);
      return;
    }
    setPendingShow({ nodeId: node.id, level: node.parent_id });
    if (node.parent_id !== level) onNavigateLevel(node.parent_id);
  };

  // Двойной клик по карточке: цельная система — вход в её уровень (системы здесь не
  // раскрываются), единица — страница объекта: внутри контейнера на этом холсте пусто,
  // его уровень закрыт (D13, D24). Площадка объектом не является (её карточку
  // раскрывает сам холст).
  const openCard = useCallback((n: AppNode) => {
    const inst = proj?.siteOf.get(n.id);
    if (!inst) return;
    if (n.element_effective === "system") onNavigateLevel(inst.nodeId);
    else onOpenNode(inst.nodeId);
  }, [proj, onNavigateLevel, onOpenNode]);
  const drill = useMemo<LevelDrillCallbacks>(() => ({
    onDrillDown: openCard,
    onEditNode: openCard,
    onSelectionChange: setSelectedIds,
    // двойной клик по пустому холсту — снять подсветку связи
    onClearSelection: () => setSelectedEdge(null),
  }), [openCard]);

  // «Переразложить» (архитектор): снять все ключи deploy: этого вида одним батчем и
  // вторым вернуть свёрнутым площадкам expanded: false (список — из зеркала до сброса:
  // переразложить — значит сбросить расстановку, а не раскрыть всё), перечитать граф —
  // холст разложит заново и анимирует переезд (relayoutToken). 409 любого батча — один
  // раз перечитать и повторить оба.
  const [relayoutToken, setRelayoutToken] = useState(0);
  const relayoutInflight = useRef(false);
  const handleRelayout = useCallback(async () => {
    if (relayoutInflight.current) return;
    relayoutInflight.current = true;
    setActionError(null);
    const keys = Object.keys(dep.layout).filter((k) => k.startsWith("deploy:"));
    const collapsed = keys.filter((k) => k.startsWith("deploy:site:") && dep.layout[k]?.expanded === false);
    const save = (items: Record<string, ViewLayoutPayload | null>): Promise<void> =>
      viewsApi.saveLayout(level, items, dep.viewMetaRef.current.version).then((res) => {
        dep.viewMetaRef.current = { ...dep.viewMetaRef.current, version: res.version, graphRev: res.graph_rev };
      });
    const reset = async (): Promise<void> => {
      if (keys.length > 0) await save(Object.fromEntries(keys.map((k) => [k, null])));
      if (collapsed.length > 0) await save(Object.fromEntries(collapsed.map((k) => [k, { expanded: false }])));
    };
    try {
      try {
        await reset();
      } catch (e) {
        // Вид изменили в другой сессии: перечитать и повторить один раз от свежей версии.
        if (!isConflict(e)) throw e;
        await dep.reload();
        await reset();
      }
      setRelayoutToken((t) => t + 1);
      await dep.reload();
    } catch (e) {
      setActionError(`Не удалось переразложить. ${loadErrorText(e)}`);
      void dep.reload();
    } finally {
      relayoutInflight.current = false;
    }
  }, [dep, level]);

  // Объекты есть — есть хоть один представитель (система без единиц не рисуется).
  const hasObjects = (proj?.siteOf.size ?? 0) > 0;
  const selectedNodes = useMemo(() => {
    const ids = new Set(selectedObjects);
    return (dep.graph?.nodes ?? []).filter((n) => ids.has(n.id));
  }, [dep.graph, selectedObjects]);

  // Размещение записано окном: перечитать граф и объекты, анимировать пере-раскладку,
  // снять выделение.
  const onPlacementApplied = () => {
    setPlacementOpen(false);
    setClearToken((t) => t + 1);
    setMutationToken((t) => t + 1);
    all.reload();
    void dep.reload();
  };

  const placing = placingMode.placing;

  return (
    <>
      <NodeTreePanel
        mode="deploy"
        isArchitect={isArchitect}
        currentNodeId={level}
        onOpenLevel={(node) => onNavigateLevel(node.id)}
        onPickObject={pickObject}
        onPlace={isArchitect ? placingMode.start : undefined}
        placingId={placing?.id ?? null}
      />
      <div className="dp-page">
        <div className="dp-toolbar">
          {/* Путь уровня текстом; уровень выбирают в дереве слева. */}
          <nav className="dp-path" aria-label="Уровень">
            {level === null ? (
              <span className="dp-path-current">Весь проект</span>
            ) : (
              <>
                <button type="button" className="dp-path-root" onClick={() => onNavigateLevel(null)}>
                  Весь проект
                </button>
                <span className="dp-path-sep" aria-hidden>›</span>
                <span className="dp-path-current">{path || "…"}</span>
              </>
            )}
          </nav>
          <span style={{ flex: 1 }} />
          {actionError && <span role="alert" className="dp-error">{actionError}</span>}
          {/* Квадратные иконки (приёмка 2026-10-27): «Площадки» — тот же знак вида площадки,
              что на карточках и плашках площадок (вид по умолчанию «другое»); «Переразложить»
              и тумблер «Подписи связей» — сосед «Переразложить», как в углу холста на
              страницах и в топбаре редактора (CV32). */}
          <button type="button" className="dp-iconbtn" onClick={() => setSitesOpen(true)} title="Площадки" aria-label="Площадки">
            <SiteKindIcon kind="other" size={17} />
          </button>
          {isArchitect && (
            <button
              type="button"
              className="dp-iconbtn"
              onClick={() => { void handleRelayout(); }}
              disabled={!hasObjects}
              title="Переразложить уровень"
              aria-label="Переразложить"
            >
              <RelayoutIcon />
            </button>
          )}
          <button
            type="button"
            className="dp-iconbtn"
            onClick={() => setEdgeLabelsHidden((v) => !v)}
            aria-pressed={edgeLabelsHidden}
            title={edgeLabelsHidden ? "Показать подписи связей" : "Скрыть подписи связей"}
            aria-label="Подписи связей"
          >
            <EdgeLabelsIcon off={edgeLabelsHidden} />
          </button>
        </div>

        <div className="dp-canvas">
          {/* Режим размещения: холст ждёт щелчка по площадке (D29). Баннер — полосой между
              тулбаром и холстом (поверх холста он накрывал бы верхний ряд площадок), виден и
              на время загрузки уровня (смена уровня режим не сбрасывает). */}
          {placing && (
            <div className="dp-placing" role="status">
              <span className="dp-placing-text">Куда поставить «{placing.name}»? Щёлкните площадку</span>
              {placingMode.hasOwn && (
                <button type="button" className="btn-soft" onClick={placingMode.unplace} disabled={placingMode.busy}>
                  Снять размещение
                </button>
              )}
              <button type="button" className="btn-soft" onClick={placingMode.cancel}>
                Отмена
              </button>
              {placingMode.error && <span className="dp-placing-error" role="alert">{placingMode.error}</span>}
            </div>
          )}
          {dep.error ? (
            <LoadError what="схему развёртывания" error={dep.error} onRetry={dep.retry} />
          ) : dep.loading || !dep.graph || !proj || !projection ? (
            <div className="dp-note">Загрузка…</div>
          ) : !hasObjects ? (
            <div className="dp-note">Нет объектов для размещения</div>
          ) : (
            <div className="dp-stage">
              <LevelGraph
                nodes={proj.nodes}
                endpoints={proj.endpoints}
                edges={proj.edges}
                viewLayout={dep.layout}
                depth={0}
                containerId={level}
                ancestorIds={NO_ANCESTORS}
                ancestorNames={NO_ANCESTORS}
                ancestorElements={NO_ANCESTOR_ELEMENTS}
                isArchitect={isArchitect}
                persistence={persistence}
                linkedHighlight={linkedHighlight}
                mode={mode}
                drill={drill}
                edgeCallbacks={edgeCallbacks}
                relayoutToken={relayoutToken}
                mutationToken={mutationToken}
                locate={locate}
                projection={projection}
              />
              <SchemaLegend variant="deployment" />
              {isArchitect && !placing && selectedObjects.length > 0 && (
                <div className="dp-selection" role="status">
                  <span className="dp-selection-count">
                    {plural(selectedObjects.length, ["Выбран", "Выбрано", "Выбрано"])} {selectedObjects.length}{" "}
                    {plural(selectedObjects.length, ["объект", "объекта", "объектов"])}
                  </span>
                  <button type="button" style={selectionMainBtn} onClick={() => setPlacementOpen(true)}>
                    Указать размещение
                  </button>
                  <button type="button" className="btn-soft" onClick={() => setClearToken((t) => t + 1)}>
                    Снять выделение
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {placementOpen && dep.graph && selectedNodes.length > 0 && (
          <PlacementDialog
            objects={selectedNodes}
            sites={dep.graph.sites}
            onClose={() => setPlacementOpen(false)}
            onApplied={onPlacementApplied}
            onSitesChanged={() => { void dep.reload(); }}
          />
        )}
        {sitesOpen && (
          <SitesDialog
            isArchitect={isArchitect}
            onClose={() => setSitesOpen(false)}
            onChanged={() => { setMutationToken((t) => t + 1); void dep.reload(); }}
          />
        )}
        {/* Контейнер размещается целиком (D30): набор получают все объекты внутри, чьё-то
            иное размещение перезапишется (или снимется) — перед записью список «объект:
            площадки». */}
        {placingMode.confirm && (
          <ConfirmDialog
            tone="neutral"
            title={placingMode.confirm.siteId
              ? placeQuestion(placingMode.confirm.node.name, [placingMode.confirm.siteName])
              : unplaceQuestion(placingMode.confirm.node.name)}
            lead={placingMode.confirm.siteId ? PLACE_LEAD : UNPLACE_LEAD}
            error={placingMode.confirmError}
            confirmLabel={placingMode.confirm.siteId ? "Разместить" : "Снять"}
            busyLabel={placingMode.confirm.siteId ? "Размещение…" : "Снятие…"}
            busy={placingMode.busy}
            onConfirm={() => { void placingMode.confirmPlace(); }}
            onCancel={placingMode.cancelConfirm}
            scroll
          >
            <PlacementConflictList items={placingMode.confirm.conflicts} />
          </ConfirmDialog>
        )}
        {/* Окно выбора связи (несколько связей в пучке) — рендерит useEdgeChoice */}
        {choiceModal}
        {toast && <div style={listToast} aria-live="polite">{toast}</div>}
      </div>
    </>
  );
}

// Главная кнопка панели выделения — та же, что в окнах, но ниже ростом (панель тихая).
const selectionMainBtn = { ...primaryBtn, padding: "6px 12px", fontSize: 13 };
