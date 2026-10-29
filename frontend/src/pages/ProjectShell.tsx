// Оболочка проекта (pages_pivot): шапка (лого, свитчер, режим, экспорт, профиль,
// индикатор алертов), дерево с навигацией на страницы, NodePage / ProcessWorkspace /
// DeploymentPage (режим «Развёртывание»).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { workBodyRow as bodyRow, workDivider as divider, workPage as page, workTopBar, workTopLeft as topLeft } from "../ui/pageChrome";
import { getUserRole } from "../api/auth";
import { canEditProject, useProjectRole } from "./projectRole";
import type { Node } from "../types";
import { exportApi } from "../api/nodes";
import NodeTreePanel from "../components/NodeTreePanel";
import NodeModal from "../components/NodeModal";
import NodePage from "./NodePage";
import ProjectHomePage from "./ProjectHomePage";
import ProcessWorkspace from "../components/processes/ProcessWorkspace";
import DeploymentPage from "./DeploymentPage";
import { processesApi } from "../api/processes";
import SchemaActions, { type ExportScope } from "../components/SchemaActions";
import AccountMenu from "../components/users/AccountMenu";
import ProjectSwitcher from "../components/ProjectSwitcher";
import SchemaAlerts, { type LocateTarget } from "../components/SchemaAlerts";
import { useSchemaAlerts, PENDING_ALERT_LOCATE_KEY, PENDING_PROCESS_KEY } from "./useSchemaAlerts";
import Modal from "../ui/Modal";
import { primaryBtn, secondaryBtn } from "../ui/styles";
import BrandLink from "../ui/BrandLink";
import "../ui/chrome.css";
import "../components/NodeTreePanel.css";
import { safeSession } from "../lib/safeStorage";
import type { NavigateMap } from "../components/graph/types";
import DialogTitle from "../ui/DialogTitle";
import { storedMode, storeMode, type WorkMode } from "./workMode";
import { useMessageToast } from "./useToast";
import { useFirstChild } from "../components/element/useFirstChild";

interface Props {
  projectId: string;
  // null = страница проекта (корень), иначе — страница узла
  nodeId: string | null;
  // Режим «Развёртывание» живёт в адресе (#/p/<pid>/deploy/<уровень?>): задан — оболочка
  // в этом режиме на уровне level (null — весь проект); не задан — «Объекты» или «Процессы».
  deploy?: { level: string | null };
  onLogout: () => void;
  // Экран «Пользователи» — пункт меню профиля, виден только администратору.
  onOpenUsers: () => void;
  onAllProjects: () => void;
  onSwitchProject: (id: string) => void;
  // Навигация внутри проекта
  onNavigateNode: (nodeId: string) => void;
  onNavigateProject: () => void;
  onNavigateMap: NavigateMap;
  // «Развёртывание» на уровне level (null — весь проект): переключатель режима, выбор
  // уровня и вход в контейнер двойным кликом — навигацией, «назад» браузера работает.
  onNavigateDeploy: (level: string | null) => void;
}

export default function ProjectShell({
  projectId,
  nodeId,
  deploy,
  onLogout,
  onOpenUsers,
  onAllProjects,
  onSwitchProject,
  onNavigateNode,
  onNavigateProject,
  onNavigateMap,
  onNavigateDeploy,
}: Props) {
  // isArchitect теперь значит «может править этот проект» (роль в проекте owner/editor).
  const isArchitect = canEditProject(useProjectRole());
  // Пришли из редактора-карты по строке процессного алерта (AL26/AL27)? Ключ
  // одноразовый, поэтому читаем его при маунте, а гасим эффектом: инициализатор
  // useState под StrictMode вызывается дважды, и удаление прямо в нём потеряло бы
  // процесс на втором проходе.
  const [pendingProc] = useState<string | null>(() => safeSession.getItem(PENDING_PROCESS_KEY));
  useEffect(() => { safeSession.removeItem(PENDING_PROCESS_KEY); }, []);
  // «Объекты» и «Процессы» — состояние оболочки, «Развёртывание» задаёт адрес. Режим
  // запоминается (archmap_mode): App по запомненному «Развёртыванию» открывает страницу
  // проекта сразу на #/p/<pid>/deploy.
  const [shellMode, setShellMode] = useState<"schema" | "proc">(
    () => (pendingProc || storedMode() === "proc" ? "proc" : "schema"),
  );
  const mode: WorkMode = deploy ? "deploy" : shellMode;
  useEffect(() => { storeMode(mode); }, [mode]);

  const [procSelection, setProcSelection] = useState<{ id: string; name: string } | null>(null);
  // Процесс, выбранный извне (клик по процессу на странице узла либо по строке
  // процессного алерта в редакторе-карте) — стартовый выбор ProcessWorkspace.
  const [procInitial, setProcInitial] = useState<string | null>(pendingProc);
  // Перейти в «Объекты» или «Процессы». Из «Развёртывания» уходим на страницу проекта,
  // если go не ведёт в другое место (#/p/<pid> внутри открытой оболочки App не
  // перенаправляет обратно в «Развёртывание»).
  function leaveTo(next: "schema" | "proc", go?: () => void) {
    setShellMode(next);
    if (go) go();
    else if (deploy) onNavigateProject();
  }
  // Переключатель режима: «Развёртывание» — адрес уровня «Весь проект».
  function switchMode(next: WorkMode) {
    setProcInitial(null);
    if (next === "deploy") {
      if (!deploy) onNavigateDeploy(null);
      return;
    }
    leaveTo(next);
  }
  // Сигнал перезагрузки дерева (после создания/удаления узла)
  const [treeReload, setTreeReload] = useState(0);
  // Счётчик применений синка: перемонтирует страницу — схема грузится свежей, не
  // ждём поллинга. Само окно и тост-итог живут в SchemaActions.
  const [syncToken, setSyncToken] = useState(0);
  // Модалка создания дочернего объекта («+» в дереве)
  const [createFor, setCreateFor] = useState<string | null>(null);
  // Первый вложенный объект у листа (Р4 эпика элементов): окно выбора элемента — ДО окна
  // «Новый объект»; отказ записи — тостом, объект тогда не создаётся.
  const [createError, showCreateError] = useMessageToast();
  const firstChild = useFirstChild(showCreateError);

  // Алерты схемы — в интерфейсе «Рекомендации»: кнопка в шапке (глобальная
  // видимость, архитектор). In-context рейл с locate живёт в редакторе-карте (MapEditorPage).
  const { alerts, reload: reloadAlerts } = useSchemaAlerts(isArchitect);
  // Рекомендации считаются по ВСЕМУ проекту и грузятся один раз на маунте, а
  // оболочка живёт всё время работы — значит после каждой мутации они протухают.
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
      // страница узла живёт в режиме «Объекты»
      leaveTo("schema", () => onNavigateNode(target.id));
      return;
    }
    setEditorConfirmTarget(target);
  }

  // «Ок» в подтверждении → в редактор-карту к проблемному месту. Цель (связь/группа)
  // передаём через sessionStorage: URL-locate умеет только узел. Карту открываем в
  // корне — MapEditorPage сам перейдёт на нужный уровень, применив цель после загрузки.
  function confirmGoToEditor() {
    if (!editorConfirmTarget) return;
    safeSession.setItem(PENDING_ALERT_LOCATE_KEY, JSON.stringify(editorConfirmTarget));
    setEditorConfirmTarget(null);
    onNavigateMap(null);
  }

  // Что экспортировать сейчас — производное от режима и открытой страницы
  // (null в «Процессах» без выбранного процесса и в «Развёртывании»: кнопка гаснет).
  const exportScope: ExportScope | null =
    mode === "deploy"
      ? null
      : mode === "proc"
      ? procSelection
        ? {
            key: `proc:${procSelection.id}`,
            title: `Экспорт процесса «${procSelection.name}» (Mermaid)`,
            load: () => processesApi.exportMermaid(procSelection.id),
          }
        : null
      : nodeId
        ? { key: nodeId, title: "Экспорт поддерева", load: () => exportApi.subtree(nodeId) }
        : {
            key: "all",
            title: "Экспорт схемы",
            load: () => exportApi.all(),
            // Полный архив знания — только у скоупа «вся схема»: у поддерева и
            // процесса архива нет (архив — операция над проектом целиком).
            archive: { filename: "archmap.zip", load: () => exportApi.archive() },
          };

  return (
    <div style={page}>
      {/* ── Шапка ─────────────────────────────────────────────── */}
      <div style={topBar}>
        <div style={topLeft}>
          <BrandLink onClick={onAllProjects} />
          <span style={divider} />
          <ProjectSwitcher
            projectId={projectId}
            // Свитчеру нужна ГЛОБАЛЬНАЯ роль: «+ Новый проект» — право architect.
            isArchitect={getUserRole() === "architect"}
            onAllProjects={onAllProjects}
            onSwitchProject={onSwitchProject}
          />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <ModeSwitch mode={mode} onChange={switchMode} />
          {/* Кнопка «Рекомендации» (архитектор): в шапке для глобальной видимости;
              клик по пункту ведёт на страницу объекта или в редактор-карту.
              Размер — как у соседних «трёх точек» (34). */}
          {isArchitect && (
            <SchemaAlerts
              alerts={alerts}
              size={34}
              onLocate={handleAlertLocate}
              // Повисшее сообщение чинят в процессе, а не на схеме: открываем его
              // тем же путём, что клик по процессу на странице объекта.
              onOpenProcess={(processId) => { setProcInitial(processId); leaveTo("proc"); }}
            />
          )}
          <SchemaActions
            projectId={projectId}
            isArchitect={isArchitect}
            exportScope={exportScope}
            syncHidden={mode === "proc"}
            onSynced={() => {
              setTreeReload((t) => t + 1);
              setSyncToken((t) => t + 1);
            }}
          />
          <AccountMenu onLogout={onLogout} onOpenUsers={onOpenUsers} />
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
            // Обратный ход к переходу «страница объекта → процесс»: страница узла
            // живёт в режиме «Объекты», поэтому режим переключаем тем же приёмом,
            // что и клик по узловому алерту в шапке (handleAlertLocate).
            onOpenNode={(nid) => leaveTo("schema", () => onNavigateNode(nid))}
          />
        ) : deploy ? (
          <DeploymentPage
            key={`deploy-${syncToken}`}
            isArchitect={isArchitect}
            level={deploy.level}
            onNavigateLevel={onNavigateDeploy}
            // Страница объекта живёт в режиме «Объекты» — тот же приём, что у процессов.
            onOpenNode={(nid) => leaveTo("schema", () => onNavigateNode(nid))}
          />
        ) : (
          <>
            <NodeTreePanel
              mode="pages"
              isArchitect={isArchitect}
              reloadToken={treeReload}
              currentNodeId={nodeId}
              onNodePage={(node: Node) => onNavigateNode(node.id)}
              onCreateChild={(parentId) => {
                void firstChild.ensure(parentId, "service").then((go) => {
                  if (go) setCreateFor(parentId);
                });
              }}
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
                  leaveTo("proc");
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
                  leaveTo("proc");
                }}
              />
            )}
          </>
        )}
      </div>

      {firstChild.dialog}
      {createError && <div role="alert" style={errorToast}>{createError}</div>}
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
          <DialogTitle lead={<>
            Это замечание касается нескольких объектов — перейти к нему можно только
            в редакторе-карте.
          </>}>
            Открыть в редакторе?
          </DialogTitle>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={confirmGoToEditor} style={primaryBtn}>Ок</button>
            <button type="button" onClick={() => setEditorConfirmTarget(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Сегмент-переключатель «Объекты / Процессы / Развёртывание» со скользящей подсветкой
// активной вкладки (плавный transition transform). Вкладки равной ширины — по трети.
const MODE_INDEX: Record<WorkMode, number> = { schema: 0, proc: 1, deploy: 2 };

function ModeSwitch({ mode, onChange }: { mode: WorkMode; onChange: (m: WorkMode) => void }) {
  const tab = (active: boolean): CSSProperties => ({
    position: "relative",
    zIndex: 1,
    flex: 1,
    height: 30,
    padding: "0 12px",
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
    <div style={{ position: "relative", display: "inline-flex", alignItems: "stretch", width: 450, padding: 3, background: "#f1f5f9", borderRadius: 9 }}>
      {/* Скользящая подсветка активной вкладки */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 3,
          bottom: 3,
          left: 3,
          width: "calc((100% - 6px) / 3)",
          background: "#fff",
          borderRadius: 7,
          boxShadow: "0 1px 2px rgba(15,23,42,.10)",
          transform: `translateX(${MODE_INDEX[mode] * 100}%)`,
          transition: "transform .22s cubic-bezier(.4,0,.2,1)",
        }}
      />
      <button style={tab(mode === "schema")} data-tour="mode-schema" onClick={() => onChange("schema")} title="Объекты: схема и страницы">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="4.5" rx="1" /><rect x="3" y="16.5" width="6" height="4.5" rx="1" /><rect x="15" y="16.5" width="6" height="4.5" rx="1" /><path d="M12 7.5 V11 M6 16.5 V13 H18 V16.5" />
        </svg>
        Объекты
      </button>
      <button style={tab(mode === "proc")} data-tour="mode-proc" onClick={() => onChange("proc")} title="Бизнес-процессы">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="18" r="2.4" /><path d="M8.4 6 H13 a2.6 2.6 0 0 1 2.6 2.6 V9.6 M8.4 18 H13 a2.6 2.6 0 0 0 2.6-2.6 V14.4" />
        </svg>
        Процессы
      </button>
      <button style={tab(mode === "deploy")} data-tour="mode-deploy" onClick={() => onChange("deploy")} title="Развёртывание: где крутятся объекты">
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3.5" width="16" height="7.5" rx="1.5" /><rect x="4" y="13" width="16" height="7.5" rx="1.5" /><path d="M8 7.25 H8.01 M8 16.75 H8.01" strokeWidth={2.6} />
        </svg>
        Развёртывание
      </button>
    </div>
  );
}

// ── Стили ───────────────────────────────────────────────────────────

// Своя плоскость наложения выше тела страницы: панель алертов раскрывается ИЗ шапки,
// и без этого её z-index (50) ничего не решал бы — тело страницы рисуется позже и
// перекрывало бы её целиком.
const topBar: CSSProperties = { ...workTopBar, position: "relative", zIndex: 50 };
// Стиль иконочных кнопок шапки и тост синка переехали в SchemaActions вместе с
// самими кнопками — здесь их больше нет намеренно.
// Тост отказа создания (запись элемента родителю не прошла) — как тост редактора-карты.
const errorToast: CSSProperties = {
  position: "fixed", top: 74, right: 24, zIndex: 60,
  background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b",
  borderRadius: 10, padding: "7px 12px", fontSize: 13,
  boxShadow: "0 4px 12px rgba(30,41,59,.10)",
};
