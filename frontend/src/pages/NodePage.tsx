// Страница объекта (single-schema): шапка (breadcrumb, имя, статус), свойства
// (inline CAS), схема (контекст объекта виртуальным корневым уровнем — SchemaSection),
// связи (таблица), участие в процессах, логика (node_docs), OpenAPI.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AncestorRef, GraphResponse, Node, NodeEdgeInfo, NodeShape, NodeStatus, ProcessListItem } from "../types";
import { canHaveChildren } from "../types";
import { nodesApi, edgesApi, exportApi, viewsApi } from "../api/nodes";
import { getNodeColors, STATUS_META } from "../components/graph/colors";
import { useNodePatch } from "./useNodePatch";
import { useRemoteSync } from "./useRemoteSync";
import { useToast } from "./useToast";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import ExportModal from "../components/ExportModal";
import DocsAgentModal from "../components/docsImport/DocsAgentModal";
import EmbeddedSchemaBlock from "../components/EmbeddedSchemaBlock";
import DocOverlay from "../components/inspector/DocOverlay";
import type { NodeDocEvent } from "../components/inspector/FlowchartDocs";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "../components/schemaView";
import type { ViewMetaState } from "../components/graph/types";
import { hasNoNeighbors, schemaSectionHeight, toLevelEdges, visibleEntityGuess } from "../components/pageSchema";
import { plural } from "../ui/plural";
import "./NodePage.css";

// Сигнатура меты узла, отображаемой на странице, — для сверки при удалённом
// изменении (meta_rev): совпала → изменение своё (уже применено локально),
// тост не нужен; отличается → чужая сессия, освежить и показать тост.
const metaSig = (n: Node): string => JSON.stringify([
  n.name, n.role, n.technology, n.status, n.description, n.is_external, n.openapi_spec,
  [...(n.docs ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((d) => [d.id, d.name, d.kind, d.operation, d.version]),
]);

// Тост «Данные изменены в другой сессии» — поверх страницы (fixed).
const metaToastStyle: CSSProperties = {
  position: "fixed", top: 74, right: 24, zIndex: 60,
  background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3",
  borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 600,
  boxShadow: "0 4px 12px rgba(30,41,59,.12)",
};

interface Props {
  nodeId: string;
  isArchitect: boolean;
  // Навигация: страница другого узла / страница проекта
  onNavigateNode: (nodeId: string) => void;
  onNavigateProject: () => void;
  // Навигация в редактор-карту
  onNavigateMap?: (level: string | null, opts?: { locate?: string; ret?: string }) => void;
  // Навигация в режим «Процессы» с выбором процесса (секция «Участвует в процессах»)
  onNavigateProcesses?: (processId: string) => void;
  // Удаление узла со страницы → редирект на родителя
  onNodeDeleted?: (parentId: string | null) => void;
}

export default function NodePage({ nodeId, isArchitect, onNavigateNode, onNavigateProject, onNavigateMap, onNavigateProcesses, onNodeDeleted }: Props) {
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
      onNavigateProcesses={onNavigateProcesses}
      onNodeDeleted={onNodeDeleted}
      confirming={confirming}
      setConfirming={setConfirming}
      onEdgesReload={() => {
        // Сбой загрузки связей: список останется прежним, догонит поллинг/перезаход
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
  onNavigateProcesses,
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
  onNavigateMap?: (level: string | null, opts?: { locate?: string; ret?: string }) => void;
  onNavigateProcesses?: (processId: string) => void;
  onNodeDeleted?: (parentId: string | null) => void;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  onEdgesReload: () => void;
}) {
  // Общий с секцией «Схема» курсор конкурентности (viewMeta): СОБСТВЕННЫЕ
  // записи страницы (свойства/доки/спеки) тихо обновляют его после коммита,
  // чтобы тик поллинга не принял своё изменение за чужое (echo-suppression, V53).
  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0, metaRev: undefined });
  const syncCursors = useCallback(() => {
    viewsApi.state(null)
      .then((s) => { viewMetaRef.current = { version: s.version, graphRev: s.graph_rev, metaRev: s.meta_rev }; })
      .catch(() => { /* best-effort: сбой синхронизации курсора молчалив, следующий тик догонит */ });
  }, []);
  const patch = useNodePatch(initialNode, syncCursors);
  const node = patch.node;
  const shape = node.shape;
  const isContainer = canHaveChildren(shape) && node.has_children;
  const colors = getNodeColors(node.is_external, 0, node.status);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [doc, setDoc] = useState<{ mode: "flowchart" | "openapi"; docId?: string; create?: boolean } | null>(null);
  // Модалка «Доки от агента» (BYOA): область = текущий объект (node.id)
  const [docsAgentOpen, setDocsAgentOpen] = useState(false);

  // Мета узла обновилась в ДРУГОЙ сессии (вырос meta_rev): тянем свежий узел и
  // сверяем содержимое — совпало (своя запись уже применена локально) → молча;
  // отличается → применяем + тост «Данные обновлены в другой сессии».
  const [metaToast, showMetaToast] = useToast();
  const handleMetaChange = useCallback(() => {
    nodesApi.get(node.id)
      .then((fresh) => {
        if (metaSig(fresh) === metaSig(patch.node)) return;
        patch.refresh(fresh);
        showMetaToast();
      })
      .catch(() => { /* узел могли удалить — догонит навигация */ });
  }, [node.id, patch, showMetaToast]);

  // Мутация доков: применить к мете узла + тихо обновить курсоры (своя запись).
  const handleDocEvent = useCallback((evt: NodeDocEvent) => {
    patch.applyDocEvent(evt);
    syncCursors();
  }, [patch, syncCursors]);

  return (
    <div className="np-page">
      {metaToast && <div style={metaToastStyle}>Данные обновлены в другой сессии</div>}
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
                        <button onClick={() => {
                          setMenuOpen(false);
                          // Ф11: редактор на родительском слое, объект подсвечен, возврат на страницу
                          onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` });
                        }}>
                          Открыть в карте
                        </button>
                      )}
                      <button onClick={() => { setMenuOpen(false); setExportOpen(true); }}>
                        Экспорт поддерева
                      </button>
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

            {/* Описание — последняя строка таблицы свойств */}
            <span className="np-term np-term--top">Описание</span>
            <span className="np-value">
              {isArchitect ? (
                <textarea
                  className="np-field np-fieldarea"
                  value={patch.description}
                  onChange={(e) => patch.setDescription(e.target.value)}
                  onBlur={patch.commitDesc}
                  placeholder="Описание объекта"
                />
              ) : (
                <span style={{ lineHeight: 1.55 }}>
                  {node.description || <span className="np-value--empty">нет описания</span>}
                </span>
              )}
            </span>
          </div>
        </div>

        {/* ── Схема (single-schema: контекст объекта виртуальным корневым уровнем) ── */}
        <div className="np-card">
          <h3 className="np-card-title">Схема</h3>
          <SchemaSection
            node={node}
            ancestors={ancestors}
            isArchitect={isArchitect}
            onNavigateNode={onNavigateNode}
            onNavigateMap={onNavigateMap}
            onMetaChange={handleMetaChange}
            viewMeta={viewMetaRef}
          />
        </div>

        {/* ── Связи ─────────────────────────────────────────────── */}
        <div className="np-card">
          <h3 className="np-card-title">Связи</h3>
          {edges.length === 0 ? (
            <p className="np-empty">Связей нет</p>
          ) : (
            <table className="np-edges-table">
              <thead>
                <tr>
                  <th>Вызывающий</th>
                  <th className="np-edge-arrowcol" aria-hidden="true" />
                  <th>Вызываемый</th>
                  <th>Описание</th>
                  <th style={{ width: 140 }}>Технология</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((e) => (
                  <EdgeRow
                    key={e.id}
                    edge={e}
                    nodeName={node.name}
                    isArchitect={isArchitect}
                    onNavigateNode={onNavigateNode}
                    onReload={onEdgesReload}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Участвует в процессах ─────────────────────────────── */}
        <ProcessesSection nodeId={node.id} onNavigateProcess={onNavigateProcesses} />

        {/* ── Логика (node_docs) ────────────────────────────────── */}
        {node.shape !== "person" && (isArchitect || node.docs.length > 0) && (
          <div className="np-card">
            <h3 className="np-card-title">Логика</h3>
            {node.docs.length === 0 ? (
              <>
                <p className="np-empty">Схемы логики не заданы</p>
                {isArchitect && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="np-addbtn" onClick={() => setDoc({ mode: "flowchart", create: true })}>
                      + Добавить схему
                    </button>
                    <button className="np-addbtn" onClick={() => setDocsAgentOpen(true)}>
                      Доки от агента
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
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
                {isArchitect && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="np-addbtn" onClick={() => setDoc({ mode: "flowchart", create: true })}>
                      + Добавить схему
                    </button>
                    <button className="np-addbtn" onClick={() => setDocsAgentOpen(true)}>
                      Доки от агента
                    </button>
                  </div>
                )}
              </>
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
              <>
                <p className="np-empty">Спецификация не задана</p>
                {isArchitect && (
                  <button className="np-addbtn" onClick={() => setDoc({ mode: "openapi" })}>
                    + Добавить спецификацию
                  </button>
                )}
              </>
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
          autoCreate={doc.create}
          initialDocId={doc.docId}
          onCommitOpenapi={(value) => {
            // CAS-правка openapi_spec через useNodePatch
            void patch.commitOpenapi(value);
          }}
          onDocEvent={handleDocEvent}
          onClose={() => setDoc(null)}
          notice={patch.conflict}
        />
      )}

      {/* Экспорт поддерева (⋯-меню) */}
      {exportOpen && (
        <ExportModal
          title="Экспорт поддерева"
          loadKey={node.id}
          load={() => exportApi.subtree(node.id)}
          onClose={() => setExportOpen(false)}
        />
      )}

      {/* Доки от агента (BYOA, секция «Логика»): область = текущий объект */}
      {docsAgentOpen && (
        <DocsAgentModal
          currentParentId={node.id}
          currentParentName={node.name}
          onClose={() => setDocsAgentOpen(false)}
          onApplied={() => {
            setDocsAgentOpen(false);
            // Дозаливка изменила мету доков/спеки узла — тянем свежий узел и
            // применяем целиком (обновит секции «Логика» и «OpenAPI»).
            void nodesApi.get(node.id).then((fresh) => patch.refresh(fresh)).catch(() => {});
          }}
        />
      )}
    </div>
  );
}

// Строка таблицы связей с inline-правкой описания/технологии (архитектор).
// Колонки «Вызывающий»/«Вызываемый» (вместо «Направление»/«Объект»): источник и
// цель связи. Выводятся из direction + other_node: outgoing → текущий узел источник,
// incoming → текущий узел цель. Чужой узел — ссылка (переход), текущий — текст.
function EdgeRow({
  edge,
  nodeName,
  isArchitect,
  onNavigateNode,
  onReload,
}: {
  edge: NodeEdgeInfo;
  nodeName: string;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onReload: () => void;
}) {
  const [label, setLabel] = useState(edge.label ?? "");
  const [tech, setTech] = useState(edge.technology ?? "");
  const isOut = edge.direction === "outgoing";

  const commitLabel = () => {
    if (label === (edge.label ?? "")) return;
    edgesApi.update(edge.id, { label: label || null })
      .then(onReload)
      .catch(() => {
        // Запись не прошла (409 чужой правки / сеть): откат черновика и рефетч
        setLabel(edge.label ?? "");
        onReload();
      });
  };
  const commitTech = () => {
    if (tech === (edge.technology ?? "")) return;
    edgesApi.update(edge.id, { technology: tech || null })
      .then(onReload)
      .catch(() => {
        setTech(edge.technology ?? "");
        onReload();
      });
  };

  // Чужой узел — ссылка; текущий — текст (ссылка на самого себя бессмысленна).
  const otherLink = (
    <button className="np-edge-link" onClick={() => onNavigateNode(edge.other_node_id)}>
      {edge.other_node_name}
    </button>
  );
  const selfName = <span className="np-edge-self">{nodeName}</span>;
  const caller = isOut ? selfName : otherLink;
  const callee = isOut ? otherLink : selfName;

  return (
    <tr>
      <td>{caller}</td>
      <td className="np-edge-arrowcol">→</td>
      <td>{callee}</td>
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

// ── Секция «Участвует в процессах» ─────────────────────────────────
// Процессы, в которых участвует узел или его поддерево (GET /nodes/{id}/processes).
// Пустая секция скрывается вовсе: участие в процессах — не обязательная мета.
function ProcessesSection({ nodeId, onNavigateProcess }: {
  nodeId: string;
  onNavigateProcess?: (processId: string) => void;
}) {
  const [items, setItems] = useState<ProcessListItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    nodesApi.getNodeProcesses(nodeId)
      .then((ps) => { if (alive) setItems(ps); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [nodeId]);
  if (!items || items.length === 0) return null;
  return (
    <div className="np-card">
      <h3 className="np-card-title">Участвует в процессах</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((p) => (
          <button
            key={p.id}
            className="np-doc-row"
            onClick={() => onNavigateProcess?.(p.id)}
            title={`Открыть процесс «${p.name}»`}
          >
            <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>{p.message_count} {plural(p.message_count, ["сообщение", "сообщения", "сообщений"])}</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Секция «Схема» (single-schema) ──────────────────────────────────
// Контекст объекта как ВИРТУАЛЬНЫЙ КОРНЕВОЙ УРОВЕНЬ. Бэкенд (context-graph)
// отдаёт его в формате СЫРОГО графа уровня: локалы = фокус + представители
// соседей (связанные сиблинги), рёбра сырые, реестр концов с цепочками предков.
// Раскладка — ВСЕГДА свежий ELK (сохранённые координаты общего холста бэк не
// отдаёт: их гибрид со свежей раскладкой фокуса рождал тесноту и «рогалики»).
// Рендерит штатный level-конвейер без единой контекстной ветки; отличия от
// «отдельного проекта» — только рамки реальных предков (ancestorIds) и цвета по
// реальной глубине (depth). Просмотр read-only: персиста раскладки нет, драг и
// правка связей — в редакторе-карте.
function SchemaSection({
  node,
  ancestors,
  isArchitect,
  onNavigateNode,
  onNavigateMap,
  onMetaChange,
  viewMeta,
}: {
  node: Node;
  ancestors: AncestorRef[];
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onNavigateMap?: (level: string | null, opts?: { locate?: string; ret?: string }) => void;
  // Рост meta_rev (мета узла изменилась в другой сессии) — страница освежает
  // данные узла и показывает тост «Данные обновлены в другой сессии».
  onMetaChange?: () => void;
  // Общий с страницей курсор конкурентности (страница тихо обновляет его после
  // СВОИХ записей — echo-suppression, V53).
  viewMeta: { current: ViewMetaState };
}) {
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, schemaView); }, [schemaView]);

  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Курсоры изменений для remote-sync: context-graph несёт version/graph_rev/
  // meta_rev; рефетч обновляет курсоры. Схема read-only (сама не пишет) — ложных
  // срабатываний тоста схемы на собственные записи нет; свои правки меты
  // подавляются сверкой содержимого в onMetaChange страницы.
  const metaCursorRef = viewMeta; // алиас: eslint разрешает писать только в *Ref
  const gestureActiveRef = useRef(false); // жестов правки на странице нет
  const [remoteToast, showRemoteToast] = useToast();

  const refetch = useCallback(() => {
    nodesApi.getContextGraph(node.id)
      .then((g) => {
        metaCursorRef.current = { version: g.version, graphRev: g.graph_rev, metaRev: g.meta_rev };
        setGraph(g);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [node.id, metaCursorRef]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных схемы
    setLoading(true);
    refetch();
  }, [refetch]);

  // Поллинг удалённых изменений (как в редакторе-карте): graph_rev вырос →
  // тихий рефетч контекста + тост «Схема обновлена в другой сессии»; meta_rev
  // вырос → onMetaChange (тост «Данные обновлены» — хозяин страница).
  useRemoteSync({
    currentParentId: null,
    viewMeta: metaCursorRef,
    gestureActiveRef,
    onRemoteChange: () => {
      refetch();
      showRemoteToast();
    },
    onMetaChange: onMetaChange
      ? (rev) => {
          metaCursorRef.current = { ...metaCursorRef.current, metaRev: rev };
          onMetaChange();
        }
      : undefined,
  });

  if (loading) return <p className="np-empty">Загрузка схемы…</p>;
  if (!graph) return null;

  // «Внешних связей нет»: кроме фокуса нет ни локалов-представителей, ни гостей
  // вне его поддерева (глубокие концы внутренних рёбер несут фокус в предках).
  if (hasNoNeighbors(graph, node.id) && !node.has_children) {
    // Пустое состояние: секцию не прячем; архитектору — CTA в редактор-карту
    // (наполнить состав / создать связи — правка живёт только там).
    return (
      <div className="np-empty" style={{ textAlign: "center" }}>
        Внешних связей нет — объект пока не взаимодействует с соседями.
        <br />
        <span style={{ fontSize: 12, color: "#b0bec5" }}>Связи создаются в редакторе-карте</span>
        {isArchitect && onNavigateMap && (
          <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center" }}>
            {canHaveChildren(node.shape) && (
              <button className="esb-edit" onClick={() => onNavigateMap(node.id)}>
                Добавить компонент
              </button>
            )}
            <button
              className="esb-edit"
              onClick={() => onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` })}
            >
              Открыть в карте
            </button>
          </div>
        )}
      </div>
    );
  }

  // Рёбра уровня из GraphResponse (тот же маппинг, что у остальных потребителей
  // графа уровня — pageSchema.toLevelEdges).
  const edges = toLevelEdges(graph);

  // Высота до замера ширины: по числу видимых сущностей (локалы + внешние гости).
  const height = schemaSectionHeight(visibleEntityGuess(graph));
  const hasStatusInfo =
    graph.nodes.some((n) => n.status !== "existing") ||
    graph.endpoints.some((ep) => ep.status !== "existing");

  // «Редактировать» / «Открыть в карте» → родительский слой + подсветка + возврат (Ф11/Ф12).
  const onEdit = onNavigateMap
    ? () => onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` })
    : undefined;

  return (
    <div style={{ position: "relative" }}>
      {remoteToast && <div style={remoteToastStyle}>Схема обновлена в другой сессии</div>}
      <EmbeddedSchemaBlock
        nodes={graph.nodes}
        endpoints={graph.endpoints}
        edges={edges}
        viewLayout={{}}
        containerId={node.parent_id ?? null}
        ancestorNames={ancestors.map((a) => a.name)}
        ancestorIds={ancestors.map((a) => a.id)}
        depth={ancestors.length}
        isArchitect={isArchitect}
        schemaView={schemaView}
        onSchemaViewChange={setSchemaView}
        onNavigateNode={onNavigateNode}
        onEdit={onEdit}
        height={height}
        showViewFilter={hasStatusInfo}
        showCaption={false}
      />
    </div>
  );
}

// Тост «схема обновлена в другой сессии» (remote-sync) — поверх окна схемы.
const remoteToastStyle: CSSProperties = { position: "absolute", top: 12, right: 12, zIndex: 6, background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3", borderRadius: 10, padding: "7px 12px", fontSize: 13, boxShadow: "0 4px 12px rgba(30,41,59,.10)" };
