// Режим «Развёртывание» (docs/tasks/deployment-view.md, спека docs/specs/deployment.md):
// где крутятся объекты уровня. Холст — тот же LevelGraph с проекцией хозяина: площадки —
// сплошные рамки (вложенность без предела), объект — карточка в каждой площадке, где
// он стоит, объекты без размещения — в пунктирной группе. Архитектору — расстановка
// (драг, персист ключами deploy:…, undo) и «Переразложить»; читателю — просмотр.
import { useCallback, useMemo, useRef, useState } from "react";
import type { GhostNode, Node as AppNode } from "../types";
import LevelGraph from "../components/LevelGraph";
import SchemaLegend from "../components/SchemaLegend";
import type {
  LevelDrillCallbacks, LevelEdgeCallbacks, LevelModeFlags, LevelPersistenceProps, LevelProjectionProps,
} from "../components/graph/types";
import { projectDeployment } from "../components/deployment/deploymentProjection";
import { nodesApi, viewsApi } from "../api/nodes";
import { isConflict } from "../api/client";
import { useAsyncLoad } from "../lib/useAsyncLoad";
import LoadError from "../ui/LoadError";
import { loadErrorText } from "../ui/loadErrorText";
import { plural } from "../ui/plural";
import { useDeploymentGraph } from "./useDeploymentGraph";
import { usePersistenceHost } from "./usePersistenceHost";
import { useRemoteSync } from "./useRemoteSync";
import "./DeploymentPage.css";

interface Props {
  isArchitect: boolean;
  // Двойной клик по карточке → страница её объекта (оболочка переключает режим).
  onOpenNode: (nodeId: string) => void;
}

// Стабильные пустые входы холста: у развёртывания нет гостей и breadcrumb-рамок.
const NO_ENDPOINTS: GhostNode[] = [];
const NO_ANCESTORS: string[] = [];
// Связи развёртывания не инспектируются — выбирать в окне нечего.
const EDGE_CALLBACKS: LevelEdgeCallbacks = { onEdgesChoice: () => {} };

/** Пункты выбора уровня: контейнеры проекта с путём именами, по алфавиту пути. */
function levelOptions(all: AppNode[]): { id: string; path: string }[] {
  const byId = new Map(all.map((n) => [n.id, n] as const));
  const pathOf = (n: AppNode): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let cur: AppNode | undefined = n; cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
      seen.add(cur.id);
      names.unshift(cur.name);
    }
    return names.join(" / ");
  };
  return all
    .filter((n) => n.has_children)
    .map((n) => ({ id: n.id, path: pathOf(n) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export default function DeploymentPage({ isArchitect, onOpenNode }: Props) {
  const [level, setLevel] = useState<string | null>(null);
  const dep = useDeploymentGraph(level);
  // Контейнеры проекта для выбора уровня — один раз на вход в режим.
  const all = useAsyncLoad("deployment-levels", () => nodesApi.getAll());
  const options = useMemo(() => levelOptions(all.data ?? []), [all.data]);

  // Поллинг чужих правок: схема (graph_rev) и мета карточек (имена, статусы — meta_rev).
  useRemoteSync({
    currentParentId: level,
    viewMeta: dep.viewMetaRef,
    gestureActiveRef: dep.gestureActiveRef,
    onRemoteChange: () => { void dep.reload(); },
    onMetaChange: () => { void dep.reload(); },
  });

  const proj = useMemo(() => (dep.graph ? projectDeployment(dep.graph) : null), [dep.graph]);

  // Выделение холста (id карточек) → выбранные объекты без повторов.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedObjects = useMemo(() => {
    if (!proj) return [];
    return [...new Set(selectedIds.map((id) => proj.groupOf(id)).filter((x): x is string => !!x))];
  }, [selectedIds, proj]);
  // «Снять выделение» — токеном холсту (ремаунт потерял бы камеру).
  const [clearToken, setClearToken] = useState(0);

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

  const mode = useMemo<LevelModeFlags>(() => ({
    readOnly: true,
    arrangeOnly: isArchitect,
    edgesInspectable: false,
    fitOnLoad: true,
    ignorePersistedExpanded: false,
  }), [isArchitect]);

  const projection = useMemo<LevelProjectionProps | undefined>(() => (proj
    ? {
        children: proj.children,
        inlineDepth: Infinity,
        frameDecor: proj.frameDecor,
        marks: proj.marks,
        groupOf: proj.groupOf,
        clearSelectionToken: clearToken,
      }
    : undefined), [proj, clearToken]);

  // Двойной клик по карточке экземпляра — страница объекта; площадка объектом не является.
  const openCard = useCallback((n: AppNode) => {
    const inst = proj?.siteOf.get(n.id);
    if (inst) onOpenNode(inst.nodeId);
  }, [proj, onOpenNode]);
  const drill = useMemo<LevelDrillCallbacks>(() => ({
    onDrillDown: openCard,
    onEditNode: openCard,
    onSelectionChange: setSelectedIds,
  }), [openCard]);

  // «Переразложить» (архитектор): снять все ключи deploy: этого вида одним батчем,
  // перечитать граф — холст разложит заново и анимирует переезд (relayoutToken).
  const [relayoutToken, setRelayoutToken] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const relayoutInflight = useRef(false);
  const handleRelayout = useCallback(async () => {
    if (relayoutInflight.current) return;
    relayoutInflight.current = true;
    setActionError(null);
    const reset = (): Promise<unknown> => {
      const keys = Object.keys(dep.layout).filter((k) => k.startsWith("deploy:"));
      if (keys.length === 0) return Promise.resolve();
      return viewsApi.saveLayout(level, Object.fromEntries(keys.map((k) => [k, null])), dep.viewMetaRef.current.version)
        .then((res) => {
          dep.viewMetaRef.current = { ...dep.viewMetaRef.current, version: res.version, graphRev: res.graph_rev };
        });
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

  const changeLevel = (next: string | null) => {
    host.dropRetry();
    setSelectedIds([]);
    setActionError(null);
    setLevel(next);
  };

  const hasObjects = (dep.graph?.nodes.length ?? 0) > 0;

  return (
    <div className="dp-page">
      <div className="dp-toolbar">
        <select
          className="dp-level"
          aria-label="Уровень"
          value={level ?? ""}
          onChange={(e) => changeLevel(e.target.value || null)}
        >
          <option value="">Весь проект</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.path}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {actionError && <span role="alert" className="dp-error">{actionError}</span>}
        {isArchitect && (
          <button type="button" className="btn-soft" onClick={() => { void handleRelayout(); }} disabled={!hasObjects}>
            Переразложить
          </button>
        )}
      </div>

      <div className="dp-canvas">
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
              endpoints={NO_ENDPOINTS}
              edges={proj.edges}
              viewLayout={dep.layout}
              depth={0}
              containerId={level}
              ancestorIds={NO_ANCESTORS}
              ancestorNames={NO_ANCESTORS}
              isArchitect={isArchitect}
              persistence={persistence}
              mode={mode}
              drill={drill}
              edgeCallbacks={EDGE_CALLBACKS}
              relayoutToken={relayoutToken}
              projection={projection}
            />
            <SchemaLegend variant="deployment" />
            {isArchitect && selectedObjects.length > 0 && (
              <div className="dp-selection" role="status">
                <span className="dp-selection-count">
                  {plural(selectedObjects.length, ["Выбран", "Выбрано", "Выбрано"])} {selectedObjects.length}{" "}
                  {plural(selectedObjects.length, ["объект", "объекта", "объектов"])}
                </span>
                <button type="button" className="btn-soft" onClick={() => setClearToken((t) => t + 1)}>
                  Снять выделение
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
