// Оболочка проекта (pages_pivot): шапка (лого, свитчер, режим, экспорт, профиль,
// индикатор алертов), дерево с навигацией на страницы, NodePage / ProcessWorkspace.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { getUserRole } from "../api/auth";
import type { Node } from "../types";
import { exportApi } from "../api/nodes";
import NodeTreePanel from "../components/NodeTreePanel";
import NodeModal from "../components/NodeModal";
import NodePage from "./NodePage";
import ProjectHomePage from "./ProjectHomePage";
import ProcessWorkspace from "../components/processes/ProcessWorkspace";
import { processesApi } from "../api/processes";
import { detailToMermaid } from "../components/processes/sequence/toMermaid";
import SchemaActions, { type ExportScope } from "../components/SchemaActions";
import ProfileMenu from "../ui/ProfileMenu";
import ProjectSwitcher from "../components/ProjectSwitcher";
import SchemaAlerts, { type LocateTarget } from "../components/SchemaAlerts";
import { useSchemaAlerts, PENDING_ALERT_LOCATE_KEY, PENDING_PROCESS_KEY } from "./useSchemaAlerts";
import Modal from "../ui/Modal";
import { primaryBtn, secondaryBtn } from "../ui/styles";
import { LogoMark } from "../ui/icons";
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
  onNavigateMap: (level: string | null, opts?: { locate?: string; ret?: string }) => void;
}

export default function ProjectShell({
  projectId,
  nodeId,
  onLogout,
  onAllProjects,
  onSwitchProject,
  onNavigateNode,
  onNavigateProject,
  onNavigateMap,
}: Props) {
  const isArchitect = getUserRole() === "architect";
  // Пришли из редактора-карты по строке процессного алерта (AL26/AL27)? Ключ
  // одноразовый, поэтому читаем его при маунте, а гасим эффектом: инициализатор
  // useState под StrictMode вызывается дважды, и удаление прямо в нём потеряло бы
  // процесс на втором проходе.
  const [pendingProc] = useState<string | null>(() => sessionStorage.getItem(PENDING_PROCESS_KEY));
  useEffect(() => { sessionStorage.removeItem(PENDING_PROCESS_KEY); }, []);
  const [mode, setMode] = useState<WorkMode>(() =>
    pendingProc ? "proc" : localStorage.getItem(MODE_KEY) === "proc" ? "proc" : "schema",
  );
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  const [procSelection, setProcSelection] = useState<{ id: string; name: string } | null>(null);
  // Процесс, выбранный извне (клик по процессу на странице узла либо по строке
  // процессного алерта в редакторе-карте) — стартовый выбор ProcessWorkspace.
  const [procInitial, setProcInitial] = useState<string | null>(pendingProc);
  // Сигнал перезагрузки дерева (после создания/удаления узла)
  const [treeReload, setTreeReload] = useState(0);
  // Счётчик применений синка: перемонтирует страницу — схема грузится свежей, не
  // ждём поллинга. Само окно и тост-итог живут в SchemaActions.
  const [syncToken, setSyncToken] = useState(0);
  // Модалка создания дочернего объекта («+» в дереве)
  const [createFor, setCreateFor] = useState<string | null>(null);

  // Алерты незавершённости схемы: знак в шапке (глобальная видимость, архитектор).
  // In-context рейл с locate живёт в редакторе-карте (MapEditorPage).
  const { alerts, reload: reloadAlerts } = useSchemaAlerts(isArchitect);
  // Знак незавершённости считается по ВСЕМУ проекту и грузится один раз на маунте,
  // а оболочка живёт всё время работы — значит после каждой мутации он протухает.
  // Освежаем по двум поводам: явный сигнал мутации от содержимого (ниже) и смена
  // страницы/режима — дешёвая страховка для правок, у которых своего канала нет.
  useEffect(() => { reloadAlerts(); }, [mode, nodeId, reloadAlerts]);

  // Подтверждение «Открыть в редакторе?» — для алертов про несколько объектов
  // (связь/группа), по которым одну страницу выбрать невозможно.
  const [editorConfirmTarget, setEditorConfirmTarget] = useState<LocateTarget | null>(null);

  // Клик по пункту алерта в шапке (режим просмотра страниц). Один объект (узел) →
  // на его СТРАНИЦУ. Связь/группа — объектов несколько, одну страницу не выбрать →
  // подтверждение «Открыть в редакторе?».
  function handleAlertLocate(target: LocateTarget) {
    if (target.kind === "node") {
      setMode("schema"); // страница узла живёт в режиме «Объекты»
      onNavigateNode(target.id);
      return;
    }
    setEditorConfirmTarget(target);
  }

  // «Ок» в подтверждении → в редактор-карту к проблемному месту. Цель (связь/группа)
  // передаём через sessionStorage: URL-locate умеет только узел. Карту открываем в
  // корне — MapEditorPage сам перейдёт на нужный уровень, применив цель после загрузки.
  function confirmGoToEditor() {
    if (!editorConfirmTarget) return;
    sessionStorage.setItem(PENDING_ALERT_LOCATE_KEY, JSON.stringify(editorConfirmTarget));
    setEditorConfirmTarget(null);
    onNavigateMap(null);
  }

  // Что экспортировать сейчас — производное от режима и открытой страницы
  // (null в «Процессах» без выбранного процесса: кнопка гаснет).
  const exportScope: ExportScope | null =
    mode === "proc"
      ? procSelection
        ? {
            key: `proc:${procSelection.id}`,
            title: `Экспорт процесса «${procSelection.name}» (Mermaid)`,
            load: () => processesApi.get(procSelection.id).then((d) => ({ content: detailToMermaid(d) })),
          }
        : null
      : nodeId
        ? { key: nodeId, title: "Экспорт поддерева", load: () => exportApi.subtree(nodeId) }
        : { key: "all", title: "Экспорт схемы", load: () => exportApi.all() };

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
          <ModeSwitch mode={mode} onChange={(m) => { setMode(m); setProcInitial(null); }} />
          {/* Индикатор незавершённости схемы (архитектор): знак в шапке для
              глобальной видимости; клик по пункту ведёт в редактор-карту. */}
          {isArchitect && (
            <SchemaAlerts
              alerts={alerts}
              onLocate={handleAlertLocate}
              // Повисшее сообщение чинят в процессе, а не на схеме: открываем его
              // тем же путём, что клик по процессу на странице объекта.
              onOpenProcess={(processId) => { setProcInitial(processId); setMode("proc"); }}
            />
          )}
          <SchemaActions
            projectId={projectId}
            isArchitect={isArchitect}
            exportScope={exportScope}
            exportHint={mode === "proc" ? "Экспорт процесса в Mermaid" : "Экспорт в YAML"}
            syncHidden={mode === "proc"}
            onSynced={() => {
              setTreeReload((t) => t + 1);
              setSyncToken((t) => t + 1);
            }}
          />
          <ProfileMenu role={isArchitect ? "Архитектор" : "Наблюдатель"} onLogout={onLogout} />
        </div>
      </div>

      {/* ── Тело ──────────────────────────────────────────────── */}
      <div style={bodyRow}>
        {mode === "proc" ? (
          <ProcessWorkspace
            isArchitect={isArchitect}
            initialProcessId={procInitial ?? undefined}
            // Пришли из редактора по строке алерта — значит чинить: открываем правку.
            openForFix={!!pendingProc}
            onSelectedChange={setProcSelection}
            onChanged={reloadAlerts}
          />
        ) : (
          <>
            <NodeTreePanel
              isArchitect={isArchitect}
              reloadToken={treeReload}
              currentNodeId={nodeId}
              onNodePage={(node: Node) => onNavigateNode(node.id)}
              onCreateChild={(parentId) => setCreateFor(parentId)}
            />
            {nodeId ? (
              <NodePage
                key={`node-${nodeId}-${syncToken}`}
                nodeId={nodeId}
                isArchitect={isArchitect}
                onNavigateNode={onNavigateNode}
                onNavigateProject={onNavigateProject}
                onNavigateMap={onNavigateMap}
                onNavigateProcesses={(processId) => {
                  setProcInitial(processId);
                  setMode("proc");
                }}
                onNodeDeleted={(parentId) => {
                  setTreeReload((t) => t + 1);
                  reloadAlerts();
                  if (parentId) onNavigateNode(parentId);
                  else onNavigateProject();
                }}
              />
            ) : (
              <ProjectHomePage
                key={`home-${syncToken}`}
                projectId={projectId}
                isArchitect={isArchitect}
                onNavigateNode={onNavigateNode}
                onNavigateMap={onNavigateMap}
                onNavigateProcesses={(processId) => {
                  setProcInitial(processId);
                  setMode("proc");
                }}
              />
            )}
          </>
        )}
      </div>

      {createFor && (
        <NodeModal
          parentId={createFor}
          onClose={() => setCreateFor(null)}
          onSaved={(saved) => {
            setCreateFor(null);
            setTreeReload((t) => t + 1);
            onNavigateNode(saved.id);
          }}
        />
      )}

      {/* Подтверждение перехода в редактор для алертов про несколько объектов */}
      {editorConfirmTarget && (
        <Modal onClose={() => setEditorConfirmTarget(null)} boxStyle={{ width: 420 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 17, fontWeight: 700, color: "#1e293b", lineHeight: 1.3 }}>
            Открыть в редакторе?
          </h3>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "#475569" }}>
            Это замечание касается нескольких объектов — перейти к нему можно только
            в редакторе-карте.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <button type="button" onClick={confirmGoToEditor} style={primaryBtn}>Ок</button>
            <button type="button" onClick={() => setEditorConfirmTarget(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Сегмент-переключатель «Объекты / Процессы» со скользящей подсветкой активной
// вкладки (плавный transition transform).
function ModeSwitch({ mode, onChange }: { mode: WorkMode; onChange: (m: WorkMode) => void }) {
  const tab = (active: boolean): CSSProperties => ({
    position: "relative",
    zIndex: 1,
    flex: 1,
    height: 30,
    padding: "0 14px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 7,
    cursor: "pointer",
    border: "none",
    fontFamily: "inherit",
    color: active ? "#2563eb" : "#64748b",
    background: "transparent",
    transition: "color .22s",
  });
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "stretch", width: 236, padding: 3, background: "#f1f5f9", borderRadius: 9 }}>
      {/* Скользящая подсветка активной вкладки */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 3,
          bottom: 3,
          left: 3,
          width: "calc(50% - 3px)",
          background: "#fff",
          borderRadius: 7,
          boxShadow: "0 1px 2px rgba(15,23,42,.10)",
          transform: mode === "proc" ? "translateX(100%)" : "translateX(0)",
          transition: "transform .22s cubic-bezier(.4,0,.2,1)",
        }}
      />
      <button style={tab(mode === "schema")} onClick={() => onChange("schema")} title="Объекты: схема и страницы">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="4.5" rx="1" /><rect x="3" y="16.5" width="6" height="4.5" rx="1" /><rect x="15" y="16.5" width="6" height="4.5" rx="1" /><path d="M12 7.5 V11 M6 16.5 V13 H18 V16.5" />
        </svg>
        Объекты
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
  // Своя плоскость наложения выше тела страницы: панель алертов раскрывается
  // ИЗ шапки, и без этого её z-index (50) ничего не решал бы — тело страницы
  // рисуется позже и перекрывало бы её целиком.
  position: "relative",
  zIndex: 50,
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
// Стиль иконочных кнопок шапки и тост синка переехали в SchemaActions вместе с
// самими кнопками — здесь их больше нет намеренно.
