// Оболочка проекта (pages_pivot): шапка приложения + дерево слева + контент справа.
// Заменяет TreePage при включённом фиче-флаге. Фаза 1: шапка (лого, свитчер, режим,
// экспорт, профиль), дерево с навигацией на страницы, NodePage / ProcessWorkspace.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { getUserRole } from "../api/auth";
import type { Node } from "../types";
import { exportApi } from "../api/nodes";
import NodeTreePanel from "../components/NodeTreePanel";
import NodePage from "./NodePage";
import ProcessWorkspace from "../components/processes/ProcessWorkspace";
import { processesApi } from "../api/processes";
import { detailToMermaid } from "../components/processes/sequence/toMermaid";
import ExportModal from "../components/ExportModal";
import ProfileMenu from "../ui/ProfileMenu";
import ProjectSwitcher from "../components/ProjectSwitcher";
import { LogoMark, ExportIcon } from "../ui/icons";
import "../ui/chrome.css";
import "../components/NodeTreePanel.css";

type WorkMode = "schema" | "proc";
const MODE_KEY = "archmap_mode";

interface Props {
  projectId: string;
  // null = страница проекта (корень), иначе — страница узла
  nodeId: string | null;
  onLogout: () => void;
  onAllProjects: () => void;
  onSwitchProject: (id: string) => void;
  // Навигация внутри проекта
  onNavigateNode: (nodeId: string) => void;
  onNavigateProject: () => void;
}

export default function ProjectShell({
  projectId,
  nodeId,
  onLogout,
  onAllProjects,
  onSwitchProject,
  onNavigateNode,
  onNavigateProject,
}: Props) {
  const isArchitect = getUserRole() === "architect";
  const [mode, setMode] = useState<WorkMode>(
    () => (localStorage.getItem(MODE_KEY) === "proc" ? "proc" : "schema"),
  );
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  const [procSelection, setProcSelection] = useState<{ id: string; name: string } | null>(null);
  const [exportScope, setExportScope] = useState<{
    key: string;
    title: string;
    load: () => Promise<{ content: string }>;
  } | null>(null);

  // Сигнал перезагрузки дерева (после создания/удаления узла)
  const [treeReload, setTreeReload] = useState(0);

  const openExport = () => {
    if (mode === "proc") {
      if (!procSelection) return;
      const { id, name } = procSelection;
      setExportScope({
        key: `proc:${id}`,
        title: `Экспорт процесса «${name}» (Mermaid)`,
        load: () => processesApi.get(id).then((d) => ({ content: detailToMermaid(d) })),
      });
    } else if (nodeId) {
      setExportScope({
        key: nodeId,
        title: "Экспорт поддерева",
        load: () => exportApi.subtree(nodeId),
      });
    } else {
      setExportScope({ key: "all", title: "Экспорт схемы", load: () => exportApi.all() });
    }
  };

  return (
    <div style={page}>
      {/* ── Шапка ─────────────────────────────────────────────── */}
      <div style={topBar}>
        <div style={topLeft}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <LogoMark />
            <span style={{ fontSize: 16.5, fontWeight: 700, letterSpacing: "-0.01em", color: "#0f172a" }}>
              Arch<span style={{ color: "#2563eb" }}>Map</span>
            </span>
          </div>
          <span style={divider} />
          <ProjectSwitcher
            projectId={projectId}
            isArchitect={isArchitect}
            onAllProjects={onAllProjects}
            onSwitchProject={onSwitchProject}
          />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <ModeSwitch mode={mode} onChange={setMode} />
          <button
            className="icon-btn"
            onClick={openExport}
            style={iconBtn}
            disabled={mode === "proc" && !procSelection}
            title={mode === "proc" ? "Экспорт процесса в Mermaid" : "Экспорт в YAML"}
            aria-label="Экспорт"
          >
            <ExportIcon />
          </button>
          <ProfileMenu role={isArchitect ? "Архитектор" : "Наблюдатель"} onLogout={onLogout} />
        </div>
      </div>

      {/* ── Тело ──────────────────────────────────────────────── */}
      <div style={bodyRow}>
        {mode === "proc" ? (
          <ProcessWorkspace isArchitect={isArchitect} onSelectedChange={setProcSelection} />
        ) : (
          <>
            <NodeTreePanel
              isArchitect={isArchitect}
              reloadToken={treeReload}
              onNodePage={(node: Node) => onNavigateNode(node.id)}
            />
            {nodeId ? (
              <NodePage
                nodeId={nodeId}
                isArchitect={isArchitect}
                onNavigateNode={onNavigateNode}
                onNavigateProject={onNavigateProject}
                onNodeDeleted={(parentId) => {
                  setTreeReload((t) => t + 1);
                  if (parentId) onNavigateNode(parentId);
                  else onNavigateProject();
                }}
              />
            ) : (
              <ProjectHomePlaceholder />
            )}
          </>
        )}
      </div>

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

// Заглушка страницы проекта (Фаза 2).
function ProjectHomePlaceholder() {
  return (
    <div style={{
      flex: 1, minWidth: 0, overflowY: "auto", background: "#f8fafc",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <p style={{ color: "#94a3b8", fontSize: 14 }}>
        Выберите объект в дереве слева
      </p>
    </div>
  );
}

// Сегмент-переключатель «Схема / Процессы» (порт из TreePage).
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

// ── Стили (инлайн, как в TreePage) ──────────────────────────────────

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
const divider: CSSProperties = {
  width: 1,
  height: 22,
  background: "#e2e8f0",
  flex: "none",
  margin: "0 4px",
};
const bodyRow: CSSProperties = {
  flex: 1,
  display: "flex",
  minHeight: 0,
  overflow: "hidden",
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
};
