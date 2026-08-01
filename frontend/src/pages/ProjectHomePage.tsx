// Страница проекта (корень) — вход в проект открывает её (pages_pivot).
// Шапка: имя, описание, счётчики. Секция «Схема системы» = корневой уровень.
// Секция «Бизнес-процессы» — список со счётчиком участников.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Project, ProcessListItem } from "../types";
import { projectsApi } from "../api/projects";
import { processesApi } from "../api/processes";
import EmbeddedSchemaBlock from "../components/EmbeddedSchemaBlock";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "../components/schemaView";
import { useEditableLevel } from "./useEditableLevel";
import { useRemoteSync } from "./useRemoteSync";
import { projectSchemaHeight } from "../components/pageSchema";
import "./NodePage.css";

interface Props {
  projectId: string;
  isArchitect: boolean;
  onNavigateNode: (nodeId: string) => void;
}

export default function ProjectHomePage({ projectId, isArchitect, onNavigateNode }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [processes, setProcesses] = useState<ProcessListItem[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  const lvl = useEditableLevel({ containerId: null, isArchitect });

  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, schemaView); }, [schemaView]);

  // Поллинг удалённых изменений (как в редакторе-карте): graph_rev вырос →
  // перезагрузка уровня + тост. Собственные записи (драг архитектора) курсор
  // обновляют из ответов PUT — echo-suppression, ложных тостов нет.
  const [remoteToast, setRemoteToast] = useState(false);
  const remoteToastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (remoteToastTimer.current) window.clearTimeout(remoteToastTimer.current); }, []);
  useRemoteSync({
    currentParentId: null,
    viewMeta: lvl.viewMetaRef,
    gestureActiveRef: lvl.gestureActiveRef,
    onRemoteChange: () => {
      lvl.reload();
      setRemoteToast(true);
      if (remoteToastTimer.current) window.clearTimeout(remoteToastTimer.current);
      remoteToastTimer.current = window.setTimeout(() => setRemoteToast(false), 4000);
    },
  });

  // Мета проекта + процессы (граф уровня грузит useEditableLevel)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [proj, procs] = await Promise.all([
          projectsApi.get(projectId),
          processesApi.list(),
        ]);
        if (!alive) return;
        setProject(proj);
        setProcesses(procs);
      } finally {
        if (alive) setMetaLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [projectId]);

  if (metaLoading || lvl.loading || !project) {
    return <div className="np-loading">Загрузка…</div>;
  }

  const graphNodes = lvl.nodes;
  const endpoints = lvl.endpoints;
  const hasNodes = graphNodes.length + endpoints.length > 0;
  const hasStatusInfo =
    graphNodes.some((n) => n.status !== "existing") ||
    endpoints.some((g) => g.status !== "existing");
  const height = projectSchemaHeight(graphNodes.length);

  return (
    <div className="np-page">
      <div className="np-inner">
        {/* ── Шапка проекта ─────────────────────────────────────── */}
        <div className="np-header">
          <div className="np-breadcrumb">
            <span style={{ color: "#0f172a", fontWeight: 600 }}>Проект</span>
          </div>
          <div className="np-title-row">
            <span className="np-glyph" style={{ background: "#2563eb" }}>
              <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <rect x={2.5} y={3} width={15} height={14} rx={3} />
                <path d="M2.5 7h15" />
              </svg>
            </span>
            <span className="np-name">{project.name}</span>
          </div>
          {project.description && (
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "#475569", lineHeight: 1.55, maxWidth: 640 }}>
              {project.description}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <span className="np-count-chip">{project.object_count} объектов</span>
            <span className="np-count-chip">{project.edge_count} связей</span>
            <span className="np-count-chip">{processes.length} процессов</span>
          </div>
        </div>

        {/* ── Схема системы ─────────────────────────────────────── */}
        <div className="np-card">
          <h3 className="np-card-title">Схема системы</h3>
          <div style={{ position: "relative" }}>
            {remoteToast && <div style={remoteToastStyle}>Схема обновлена в другой сессии</div>}
            <EmbeddedSchemaBlock
            nodes={graphNodes}
            endpoints={endpoints}
            edges={lvl.edges}
            viewLayout={lvl.viewLayout}
            containerId={null}
            ancestorNames={[]}
            ancestorIds={[]}
            depth={0}
            isArchitect={isArchitect}
            schemaView={schemaView}
            onSchemaViewChange={setSchemaView}
            onNavigateNode={onNavigateNode}
            height={height}
            toolbarHint={hasNodes ? `корневой уровень · ${graphNodes.length} объектов` : undefined}
            showViewFilter={hasStatusInfo}
            nodesDraggable
            editing={{
              history: lvl.history,
              onLayoutChanged: lvl.handleLayoutChanged,
              viewMeta: lvl.viewMetaRef,
              gestureActiveRef: lvl.gestureActiveRef,
              onPersistError: lvl.onPersistError,
              onPersistConflict: lvl.onPersistConflict,
              retryPatch: lvl.retryPatch,
            }}
            onUndo={lvl.undo}
            onRedo={lvl.redo}
            canUndo={lvl.canUndo}
            canRedo={lvl.canRedo}
            onRelayout={() => { void lvl.relayout(); }}
            empty={
              hasNodes ? undefined : (
                <span>
                  Схема пуста
                  {isArchitect && (
                    <>
                      <br />
                      <button className="esb-edit" style={{ marginTop: 10 }} onClick={() => onNavigateNode("")}>
                        + Объект
                      </button>
                    </>
                  )}
                </span>
              )
            }
            />
          </div>
        </div>

        {/* ── Бизнес-процессы ───────────────────────────────────── */}
        {processes.length > 0 && (
          <div className="np-card">
            <h3 className="np-card-title">Бизнес-процессы</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {processes.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 14px", border: "1px solid #eef2f6",
                    borderRadius: 9, fontSize: 13, color: "#1e293b",
                  }}
                >
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="18" r="2.4" />
                    <path d="M8.4 6 H13 a2.6 2.6 0 0 1 2.6 2.6 V9.6 M8.4 18 H13 a2.6 2.6 0 0 0 2.6-2.6 V14.4" />
                  </svg>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span style={{ color: "#94a3b8", fontSize: 12 }}>
                    {p.message_count} сообщ.
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Тост «схема обновлена в другой сессии» (remote-sync) — поверх окна схемы.
const remoteToastStyle: CSSProperties = { position: "absolute", top: 12, right: 12, zIndex: 6, background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3", borderRadius: 10, padding: "7px 12px", fontSize: 13, boxShadow: "0 4px 12px rgba(30,41,59,.10)" };
