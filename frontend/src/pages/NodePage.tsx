// Страница объекта (NodePage) — скролл-документ с фиксированным шаблоном секций.
// Фаза 1: шапка (breadcrumb, имя, статус, чип), свойства (inline CAS), связи (таблица).
// Схемы (контекст, компоненты) добавляются в Фазе 2.
import { useCallback, useEffect, useState } from "react";
import type { AncestorRef, Node, NodeEdgeInfo, NodeShape, NodeStatus, GhostNode, ViewLayout, Edge, NodeContext, LevelEdge } from "../types";
import { canHaveChildren } from "../types";
import { nodesApi, edgesApi } from "../api/nodes";
import { getNodeColors, STATUS_META } from "../components/graph/colors";
import { useNodePatch } from "./useNodePatch";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import EmbeddedSchemaBlock from "../components/EmbeddedSchemaBlock";
import DocOverlay from "../components/inspector/DocOverlay";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "../components/schemaView";
import "./NodePage.css";

interface Props {
  nodeId: string;
  isArchitect: boolean;
  // Навигация: страница другого узла / страница проекта
  onNavigateNode: (nodeId: string) => void;
  onNavigateProject: () => void;
  // Навигация в редактор-карту
  onNavigateMap?: (nodeId: string | null) => void;
  // Удаление узла со страницы → редирект на родителя
  onNodeDeleted?: (parentId: string | null) => void;
}

export default function NodePage({ nodeId, isArchitect, onNavigateNode, onNavigateProject, onNavigateMap, onNodeDeleted }: Props) {
  const [node, setNode] = useState<Node | null>(null);
  const [ancestors, setAncestors] = useState<AncestorRef[]>([]);
  const [edges, setEdges] = useState<NodeEdgeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  // Загрузка узла, предков (breadcrumb) и связей
  const load = useCallback(async (id: string) => {
    setLoading(true);
    setNode(null);
    try {
      const [n, all, eds] = await Promise.all([
        nodesApi.get(id),
        nodesApi.getAll(),
        nodesApi.getEdges(id),
      ]);
      setNode(n);
      setEdges(eds);
      const byId = new Map(all.map((x) => [x.id, x]));
      const path: AncestorRef[] = [];
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      while (cur) {
        path.unshift({ id: cur.id, name: cur.name, is_external: cur.is_external });
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      setAncestors(path);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных при смене nodeId; setState в load() — стандартный паттерн (как TreePage.load)
  useEffect(() => { void load(nodeId); }, [nodeId, load]);

  if (loading || !node) {
    return <div className="np-loading">Загрузка…</div>;
  }

  return (
    <NodePageInner
      key={node.id}
      node={node}
      ancestors={ancestors}
      edges={edges}
      isArchitect={isArchitect}
      onNavigateNode={onNavigateNode}
      onNavigateProject={onNavigateProject}
      onNavigateMap={onNavigateMap}
      onNodeDeleted={onNodeDeleted}
      confirming={confirming}
      setConfirming={setConfirming}
      onEdgesReload={() => {
        nodesApi.getEdges(nodeId).then(setEdges).catch(() => {});
      }}
    />
  );
}

// Внутренний компонент с key=node.id: перемонтируется при смене узла,
// сбрасывая локальные значения полей (как ObjectInspector в TreePage).
function NodePageInner({
  node: initialNode,
  ancestors,
  edges,
  isArchitect,
  onNavigateNode,
  onNavigateProject,
  onNavigateMap,
  onNodeDeleted,
  confirming,
  setConfirming,
  onEdgesReload,
}: {
  node: Node;
  ancestors: AncestorRef[];
  edges: NodeEdgeInfo[];
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onNavigateProject: () => void;
  onNavigateMap?: (nodeId: string | null) => void;
  onNodeDeleted?: (parentId: string | null) => void;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  onEdgesReload: () => void;
}) {
  const patch = useNodePatch(initialNode);
  const node = patch.node;
  const shape = node.shape;
  const isContainer = canHaveChildren(shape) && node.has_children;
  const colors = getNodeColors(node.is_external, 0, node.status);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [doc, setDoc] = useState<{ mode: "flowchart" | "openapi"; docId?: string } | null>(null);

  const statusMeta = STATUS_META[node.status];

  return (
    <div className="np-page">
      <div className="np-inner">
        {/* ── Шапка ─────────────────────────────────────────────── */}
        <div className="np-header">
          {/* Breadcrumb предков */}
          <div className="np-breadcrumb">
            <button onClick={onNavigateProject}>Проект</button>
            {ancestors.map((a) => (
              <span key={a.id} style={{ display: "inline-flex", alignItems: "center" }}>
                <span className="np-bc-sep">›</span>
                <button onClick={() => onNavigateNode(a.id)}>{a.name}</button>
              </span>
            ))}
          </div>

          {/* Глиф + имя + бейджи */}
          <div className="np-title-row">
            <span className="np-glyph" style={{ background: colors.bg }}>
              <HeaderGlyph shape={shape} container={isContainer} />
            </span>

            {isArchitect ? (
              <input
                className="np-name-input"
                value={patch.name}
                onChange={(e) => patch.setName(e.target.value)}
                onBlur={patch.commitName}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
            ) : (
              <span className="np-name">{node.name}</span>
            )}

            {/* Бейдж статуса */}
            <span className={`np-status-badge np-status-badge--${node.status}`}>
              <span className="np-dot" style={{ background: statusDotColor(node.status, node.is_external) }} />
              {statusMeta.label}
            </span>

            {/* Чип «внешний» */}
            {node.is_external && (
              <span className="np-external-chip">внешний</span>
            )}

            {/* ⋯-меню (архитектор) */}
            {isArchitect && (
              <div className="np-menu-wrap">
                <button
                  className="np-menu-btn"
                  onClick={() => setMenuOpen((o) => !o)}
                  title="Действия"
                >
                  ⋯
                </button>
                {menuOpen && (
                  <>
                    <div className="np-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="np-dropdown">
                      {onNavigateMap && (
                        <button onClick={() => { setMenuOpen(false); onNavigateMap(node.id); }}>
                          Открыть в карте
                        </button>
                      )}
                      <button className="np-danger" onClick={() => { setMenuOpen(false); setConfirming(true); }}>
                        Удалить объект
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Конфликт CAS */}
        {patch.conflict && <p className="np-conflict">{patch.conflict}</p>}

        {/* ── Свойства ──────────────────────────────────────────── */}
        <div className="np-card">
          <h3 className="np-card-title">Свойства</h3>
          <div className="np-props">
            {/* Тип */}
            <span className="np-term">Тип</span>
            <span className="np-value">{SHAPE_LABEL[shape]}</span>

            {/* Размещение */}
            <span className="np-term">Размещение</span>
            <span className="np-value">
              {isArchitect ? (
                <button type="button" className="np-toggle" onClick={patch.toggleExternal}>
                  <span className={"np-switch" + (patch.isExternal ? " is-on" : "")} />
                  {patch.isExternal ? "Внешний" : "Внутренний"}
                </button>
              ) : (
                <>
                  <span className="np-dot" style={{ background: node.is_external ? "#9ca3af" : "#2563eb", display: "inline-block", marginRight: 6 }} />
                  {node.is_external ? "Внешний" : "Внутренний"}
                </>
              )}
            </span>

            {/* Статус */}
            <span className="np-term">Статус</span>
            <span className="np-value">
              {isArchitect ? (
                <span className="np-selwrap">
                  <button
                    type="button"
                    className="np-select"
                    onClick={() => setStatusOpen((o) => !o)}
                  >
                    <span className="np-dot" style={{ background: statusDotColor(patch.status, patch.isExternal) }} />
                    {STATUS_META[patch.status].label}
                    <ChevronDown />
                  </button>
                  {statusOpen && (
                    <>
                      <div className="np-backdrop" onClick={() => setStatusOpen(false)} />
                      <ul className="np-menu">
                        {STATUS_ORDER.map((st) => (
                          <li key={st} onClick={() => { setStatusOpen(false); patch.pickStatus(st); }}>
                            <span className="np-dot" style={{ background: statusDotColor(st, patch.isExternal) }} />
                            {STATUS_META[st].label}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </span>
              ) : (
                <>
                  <span className="np-dot" style={{ background: statusDotColor(node.status, node.is_external), display: "inline-block", marginRight: 6 }} />
                  {STATUS_META[node.status].label}
                </>
              )}
            </span>

            {/* Роль */}
            <span className="np-term">Роль</span>
            <span className="np-value">
              {isArchitect ? (
                <input
                  className="np-field"
                  value={patch.role}
                  onChange={(e) => patch.setRole(e.target.value)}
                  onBlur={patch.commitRole}
                  placeholder="сервис, БД, брокер…"
                />
              ) : (
                node.role || <span className="np-value--empty">не указана</span>
              )}
            </span>

            {/* Технология (не для персон) */}
            {shape !== "person" && (
              <>
                <span className="np-term">Технология</span>
                <span className="np-value">
                  {isArchitect ? (
                    <input
                      className="np-field"
                      value={patch.technology}
                      onChange={(e) => patch.setTechnology(e.target.value)}
                      onBlur={patch.commitTech}
                      placeholder="Python, Kafka, Redis…"
                    />
                  ) : (
                    node.technology || <span className="np-value--empty">не указана</span>
                  )}
                </span>
              </>
            )}
          </div>

          {/* Описание — во всю ширину */}
          <div style={{ marginTop: 12 }}>
            <span className="np-term" style={{ display: "block", marginBottom: 6 }}>Описание</span>
            {isArchitect ? (
              <textarea
                className="np-field np-fieldarea"
                value={patch.description}
                onChange={(e) => patch.setDescription(e.target.value)}
                onBlur={patch.commitDesc}
                placeholder="Описание объекта"
                style={{ width: "100%" }}
              />
            ) : (
              <p className="np-value" style={{ margin: 0, lineHeight: 1.55 }}>
                {node.description || <span className="np-value--empty">нет описания</span>}
              </p>
            )}
          </div>
        </div>

        {/* ── Схема контекста ──────────────────────────────────── */}
        <div className="np-card">
          <h3 className="np-card-title">Схема контекста</h3>
          <ContextSection
            nodeId={node.id}
            isArchitect={isArchitect}
            onNavigateNode={onNavigateNode}
          />
        </div>

        {/* ── Схема компонентов (только у узлов с детьми) ──────── */}
        {canHaveChildren(node.shape) && (
          <div className="np-card">
            <h3 className="np-card-title">Схема компонентов</h3>
            <ComponentsSection
              nodeId={node.id}
              nodeName={node.name}
              ancestors={ancestors}
              isArchitect={isArchitect}
              onNavigateNode={onNavigateNode}
            />
          </div>
        )}

        {/* ── Связи ─────────────────────────────────────────────── */}
        <div className="np-card">
          <h3 className="np-card-title">Связи</h3>
          {edges.length === 0 ? (
            <p className="np-empty">Связей нет</p>
          ) : (
            <table className="np-edges-table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>Направление</th>
                  <th>Объект</th>
                  <th>Описание</th>
                  <th style={{ width: 140 }}>Технология</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((e) => (
                  <EdgeRow
                    key={e.id}
                    edge={e}
                    isArchitect={isArchitect}
                    onNavigateNode={onNavigateNode}
                    onReload={onEdgesReload}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Логика (node_docs) ────────────────────────────────── */}
        {node.shape !== "person" && (isArchitect || node.docs.length > 0) && (
          <div className="np-card">
            <h3 className="np-card-title">Логика</h3>
            {node.docs.length === 0 ? (
              <p className="np-empty">Схемы логики не заданы</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {node.docs.map((d) => (
                  <button
                    key={d.id}
                    className="np-doc-row"
                    onClick={() => setDoc({ mode: "flowchart", docId: d.id })}
                  >
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{d.name}</span>
                    <span className={`np-doc-chip np-doc-chip--${d.kind}`}>
                      {d.kind === "overview" ? "обзор" : d.kind === "operation" ? "операция" : "воркер"}
                    </span>
                    {d.operation && <span style={{ fontSize: 12, color: "#64748b", fontFamily: "ui-monospace, monospace" }}>{d.operation}</span>}
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── OpenAPI ───────────────────────────────────────────── */}
        {node.shape !== "person" && (isArchitect || node.openapi_spec) && (
          <div className="np-card">
            <h3 className="np-card-title">OpenAPI</h3>
            {node.openapi_spec ? (
              <button className="np-doc-row" onClick={() => setDoc({ mode: "openapi" })}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Спецификация</span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
              </button>
            ) : (
              <p className="np-empty">Спецификация не задана</p>
            )}
          </div>
        )}
      </div>

      {/* Подтверждение удаления */}
      {confirming && (
        <NodeDeleteConfirm
          node={node}
          onCancel={() => setConfirming(false)}
          onDeleted={() => {
            setConfirming(false);
            onNodeDeleted?.(node.parent_id);
          }}
        />
      )}

      {/* Оверлей документации (Логика / OpenAPI) */}
      {doc && (
        <DocOverlay
          mode={doc.mode}
          nodeId={node.id}
          nodeName={node.name}
          openapi={node.openapi_spec ?? ""}
          isArchitect={isArchitect}
          onCommitOpenapi={(value) => {
            // CAS-правка openapi_spec через useNodePatch
            void patch.commitOpenapi(value);
          }}
          onDocEvent={() => {
            // После мутации доков — перезагружаем узел для обновления мета
            nodesApi.get(node.id).then(() => {
              // TODO: обновить node.docs в стейте
            }).catch(() => {});
          }}
          onClose={() => setDoc(null)}
          notice={patch.conflict}
        />
      )}
    </div>
  );
}

// Строка таблицы связей с inline-правкой описания/технологии (архитектор).
function EdgeRow({
  edge,
  isArchitect,
  onNavigateNode,
  onReload,
}: {
  edge: NodeEdgeInfo;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onReload: () => void;
}) {
  const [label, setLabel] = useState(edge.label ?? "");
  const [tech, setTech] = useState(edge.technology ?? "");
  const isOut = edge.direction === "outgoing";

  const commitLabel = () => {
    if (label === (edge.label ?? "")) return;
    edgesApi.update(edge.id, { label: label || null }).then(onReload).catch(() => {});
  };
  const commitTech = () => {
    if (tech === (edge.technology ?? "")) return;
    edgesApi.update(edge.id, { technology: tech || null }).then(onReload).catch(() => {});
  };

  return (
    <tr>
      <td>
        <span className={`np-dir ${isOut ? "np-dir--out" : "np-dir--in"}`}>
          {isOut ? "→ исходящая" : "← входящая"}
        </span>
      </td>
      <td>
        <button className="np-edge-link" onClick={() => onNavigateNode(edge.other_node_id)}>
          {edge.other_node_name}
        </button>
      </td>
      <td>
        {isArchitect ? (
          <input
            className="np-edge-field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitLabel}
            placeholder="описание"
          />
        ) : (
          edge.label || <span className="np-value--empty">—</span>
        )}
      </td>
      <td>
        {isArchitect ? (
          <input
            className="np-edge-field"
            value={tech}
            onChange={(e) => setTech(e.target.value)}
            onBlur={commitTech}
            placeholder="технология"
          />
        ) : (
          edge.technology || <span className="np-value--empty">—</span>
        )}
      </td>
    </tr>
  );
}

// ── Вспомогательные ─────────────────────────────────────────────────

const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер сообщений",
  person: "Пользователь",
};

const STATUS_ORDER: NodeStatus[] = ["existing", "planned", "deprecated"];

function statusDotColor(status: NodeStatus, isExternal: boolean): string {
  if (status === "existing") return isExternal ? "#9ca3af" : "#9ca3af";
  return getNodeColors(isExternal, 0, status).bg;
}

// Глиф формы для шапки страницы (20×20, белый на цветном фоне).
function HeaderGlyph({ shape, container }: { shape: NodeShape; container: boolean }) {
  const c = {
    fill: "none",
    stroke: "#fff",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let body: React.ReactNode;
  if (container) {
    body = (
      <>
        <rect x={2} y={5} width={16} height={10} rx={2.5} {...c} />
        <path d="M5 5 V3.5 a1.5 1.5 0 0 1 1.5-1.5 h7 A1.5 1.5 0 0 1 15 3.5 V5" {...c} />
      </>
    );
  } else if (shape === "database") {
    body = (
      <>
        <path d="M3 4 v9 a7 2.5 0 0 0 14 0 V4" {...c} />
        <ellipse cx={10} cy={4.2} rx={7} ry={2.4} {...c} />
      </>
    );
  } else if (shape === "broker") {
    body = (
      <>
        <path d="M6 3 h8 a4 7 0 0 1 0 14 h-8 a4 7 0 0 1 0-14 Z" {...c} />
        <path d="M6 3 a4 7 0 0 1 0 14" {...c} />
      </>
    );
  } else if (shape === "person") {
    body = (
      <>
        <circle cx={10} cy={6.5} r={3.2} {...c} />
        <path d="M3.5 17 a 6.5 5.5 0 0 1 13 0" {...c} />
      </>
    );
  } else {
    body = <rect x={2.5} y={3} width={15} height={14} rx={3} {...c} />;
  }
  return <svg width={20} height={20} viewBox="0 0 20 20">{body}</svg>;
}

function ChevronDown() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }}>
      <path d="M6 9 L12 15 L18 9" />
    </svg>
  );
}

// ── Секция «Схема компонентов» ──────────────────────────────────────
// Загружает граф уровня узла и рендерит EmbeddedSchemaBlock (read-only).
function ComponentsSection({
  nodeId,
  nodeName,
  ancestors,
  isArchitect,
  onNavigateNode,
}: {
  nodeId: string;
  nodeName: string;
  ancestors: AncestorRef[];
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
}) {
  const [graphNodes, setGraphNodes] = useState<Node[]>([]);
  const [endpoints, setEndpoints] = useState<GhostNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [viewLayout, setViewLayout] = useState<ViewLayout>({});
  const [loading, setLoading] = useState(true);
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);

  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, schemaView); }, [schemaView]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка графа уровня при маунте
  useEffect(() => {
    let alive = true;
    nodesApi.getGraph(nodeId).then((g) => {
      if (!alive) return;
      setGraphNodes(g.nodes);
      setEndpoints(g.endpoints);
      // GraphEdge → Edge: добавляем отсутствующие поля (created_at, is_synchronous)
      setEdges(g.edges.map((ge) => ({ ...ge, created_at: "", is_synchronous: null })));
      setViewLayout(g.layout ?? {});
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [nodeId]);

  if (loading) {
    return <p className="np-empty">Загрузка схемы…</p>;
  }

  const hasNodes = graphNodes.length + endpoints.length > 0;
  const hasStatusInfo =
    graphNodes.some((n) => n.status !== "existing") ||
    endpoints.some((g) => g.status !== "existing");

  // Высота блока: min(430, max(280, nodes*62))
  const height = Math.min(430, Math.max(280, graphNodes.length * 62));

  // Имена/id предков для рамок (breadcrumb страницы + сам узел)
  const ancestorNames = [...ancestors.map((a) => a.name), nodeName];
  const ancestorIds = [...ancestors.map((a) => a.id), nodeId];

  return (
    <EmbeddedSchemaBlock
      nodes={graphNodes}
      endpoints={endpoints}
      edges={edges}
      viewLayout={viewLayout}
      containerId={nodeId}
      ancestorNames={ancestorNames}
      ancestorIds={ancestorIds}
      depth={ancestors.length + 1}
      isArchitect={isArchitect}
      schemaView={schemaView}
      onSchemaViewChange={setSchemaView}
      onNavigateNode={onNavigateNode}
      height={height}
      toolbarHint={hasNodes ? `${graphNodes.length} комп.` : undefined}
      showViewFilter={hasStatusInfo}
      empty={
        hasNodes ? undefined : (
          <span>
            Внутренний состав не описан
            {isArchitect && (
              <>
                <br />
                <button
                  className="esb-edit"
                  style={{ marginTop: 10 }}
                  onClick={() => onNavigateNode(nodeId)}
                >
                  Добавить компонент
                </button>
              </>
            )}
          </span>
        )
      }
    />
  );
}

// ── Секция «Схема контекста» ────────────────────────────────────────
// Загружает контекст узла (фокус + внешние соседи поддерева) и рендерит
// EmbeddedSchemaBlock в режиме context (звёздная раскладка, read-only).
function ContextSection({
  nodeId,
  isArchitect,
  onNavigateNode,
}: {
  nodeId: string;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
}) {
  const [ctx, setCtx] = useState<NodeContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);

  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, schemaView); }, [schemaView]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка контекста при маунте
  useEffect(() => {
    let alive = true;
    nodesApi.getContext(nodeId).then((c) => {
      if (!alive) return;
      setCtx(c);
      setLoading(false);
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [nodeId]);

  if (loading) {
    return <p className="np-empty">Загрузка контекста…</p>;
  }

  if (!ctx) return null;

  const noNeighbors = ctx.neighbors.length === 0;

  // Рёбра контекста → LevelEdge (концы уже спроецированы сервером)
  const edges: LevelEdge[] = ctx.edges.map((ge) => ({
    id: ge.id,
    label: ge.label,
    technology: ge.technology,
    source_id: ge.source_id,
    target_id: ge.target_id,
    original_source_id: ge.original_source_id,
    original_target_id: ge.original_target_id,
    original_source_name: ge.original_source_name,
    original_target_name: ge.original_target_name,
    version: ge.version,
    created_at: "",
  }));

  // Высота: max(240, min(380, neighbors*80))
  const height = Math.max(240, Math.min(380, ctx.neighbors.length * 80));

  return (
    <EmbeddedSchemaBlock
      nodes={[ctx.focus]}
      endpoints={ctx.neighbors}
      edges={edges}
      viewLayout={{}}
      containerId={ctx.focus.parent_id}
      ancestorNames={ctx.focus_ancestors.map((a) => a.name)}
      ancestorIds={ctx.focus_ancestors.map((a) => a.id)}
      depth={ctx.focus_ancestors.length}
      isArchitect={isArchitect}
      schemaView={schemaView}
      onSchemaViewChange={setSchemaView}
      onNavigateNode={onNavigateNode}
      height={height}
      showViewFilter={false}
      mode="context"
      empty={
        noNeighbors ? (
          <span>
            Внешних связей нет
            <br />
            <span style={{ fontSize: 12, color: "#b0bec5" }}>
              Связи создаются в редакторе-карте
            </span>
          </span>
        ) : undefined
      }
    />
  );
}
