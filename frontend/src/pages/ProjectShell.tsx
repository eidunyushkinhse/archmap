// Оболочка проекта (pages_pivot): шапка (ProjectShellHeader: лого, список проектов, режим,
// рекомендации, действия со схемой, профиль), дерево с навигацией на страницы, NodePage /
// ProcessWorkspace / DeploymentPage (режим «Развёртывание»).
import { useEffect, useState } from "react";
import { workBodyRow as bodyRow, workPage as page } from "../ui/pageChrome";
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
import type { ExportScope } from "../components/SchemaActions";
import type { LocateTarget } from "../components/SchemaAlerts";
import ProjectShellHeader from "./ProjectShellHeader";
import CodeChangeNotice from "../components/project/CodeChangeNotice";
import { useSchemaAlerts, PENDING_ALERT_LOCATE_KEY, PENDING_PROCESS_KEY } from "./useSchemaAlerts";
import ConfirmDialog from "../ui/ConfirmDialog";
import "../components/NodeTreePanel.css";
import { safeSession } from "../lib/safeStorage";
import type { NavigateMap } from "../components/graph/types";
import type { WorkMode } from "./workMode";
import { warmLayoutWorker } from "../components/graph/layout/pipelineClient";

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
  // Прогрев воркера раскладки (эпик render-scale): конвейер и ELK грузятся, пока страница
  // ждёт данные схемы, — первый прогон холста не платит их загрузку.
  useEffect(() => { warmLayoutWorker(); }, []);
  // «Объекты» и «Процессы» — состояние оболочки, «Развёртывание» задаёт адрес
  // (#/p/<pid>/deploy — перезагрузка страницы его сохраняет). Памяти режима между заходами
  // нет (приёмка 2026-10-31): проект открывается в «Объектах», в «Процессах» — только когда
  // из редактора-карты пришли с процессом.
  const [shellMode, setShellMode] = useState<"schema" | "proc">(() => (pendingProc ? "proc" : "schema"));
  const mode: WorkMode = deploy ? "deploy" : shellMode;

  const [procSelection, setProcSelection] = useState<{ id: string; name: string } | null>(null);
  // Процесс, выбранный извне (клик по процессу на странице узла либо по строке
  // процессного алерта в редакторе-карте) — стартовый выбор ProcessWorkspace.
  const [procInitial, setProcInitial] = useState<string | null>(pendingProc);
  // Перейти в «Объекты» или «Процессы». Из «Развёртывания» уходим на страницу проекта,
  // если go не ведёт в другое место.
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
  // Модалка создания дочернего объекта («+» в дереве): варианты типа и предвыбор окно
  // решает само по родителю.
  const [createFor, setCreateFor] = useState<string | null>(null);

  // Алерты схемы — в интерфейсе «Рекомендации»: кнопка в шапке (глобальная
  // видимость, архитектор). In-context рейл с locate живёт в редакторе-карте (MapEditorPage).
  const { alerts, reload: reloadAlerts } = useSchemaAlerts(isArchitect);
  // Рекомендации считаются по ВСЕМУ проекту и грузятся один раз на маунте, а
  // оболочка живёт всё время работы — значит после каждой мутации они протухают.
  // Освежаем по двум поводам: явный сигнал мутации от содержимого (ниже) и смена
  // страницы/режима — дешёвая страховка для правок, у которых своего канала нет.
  useEffect(() => { reloadAlerts(); }, [mode, nodeId, reloadAlerts]);

  // Подтверждение «Открыть редактор схемы?» — для алертов про несколько объектов
  // (связь/группа), по которым одну страницу выбрать невозможно.
  const [editorConfirmTarget, setEditorConfirmTarget] = useState<LocateTarget | null>(null);

  // Клик по пункту алерта в шапке (режим просмотра страниц). Один объект (узел) →
  // на его СТРАНИЦУ. Связь/группа — объектов несколько, одну страницу не выбрать →
  // подтверждение «Открыть редактор схемы?».
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
        ? { key: nodeId, title: "Экспорт объекта с вложенными", load: () => exportApi.subtree(nodeId) }
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
      <ProjectShellHeader
        projectId={projectId}
        mode={mode}
        onModeChange={switchMode}
        isArchitect={isArchitect}
        alerts={alerts}
        onLocate={handleAlertLocate}
        // Повисшее сообщение чинят в процессе, а не на схеме: открываем его тем же путём,
        // что клик по процессу на странице объекта.
        onOpenProcess={(processId) => { setProcInitial(processId); leaveTo("proc"); }}
        exportScope={exportScope}
        onSynced={() => {
          setTreeReload((t) => t + 1);
          setSyncToken((t) => t + 1);
          // обновление из кода снимает напоминание о слиянии: плашка гаснет сразу
          reloadAlerts();
        }}
        onLogout={onLogout}
        onOpenUsers={onOpenUsers}
        onAllProjects={onAllProjects}
        onSwitchProject={onSwitchProject}
      />

      {/* Код ушёл вперёд документации: CI сообщил о слиянии в репозиторий проекта. */}
      {isArchitect && (
        <CodeChangeNotice
          projectId={projectId}
          changes={alerts.code_changes}
          onSynced={() => {
            setTreeReload((t) => t + 1);
            setSyncToken((t) => t + 1);
            reloadAlerts();
          }}
          onDismissed={reloadAlerts}
        />
      )}

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
              onCreateChild={setCreateFor}
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

      {/* Подтверждение перехода в редактор для алертов про несколько объектов: общее
          подтверждение нового языка, синяя главная кнопка (шаг не разрушает). */}
      {editorConfirmTarget && (
        <ConfirmDialog
          tone="neutral"
          title="Открыть редактор схемы?"
          lead="Эта рекомендация касается нескольких объектов, их можно показать только в редакторе схемы."
          confirmLabel="Открыть"
          onConfirm={confirmGoToEditor}
          onCancel={() => setEditorConfirmTarget(null)}
        />
      )}
    </div>
  );
}
