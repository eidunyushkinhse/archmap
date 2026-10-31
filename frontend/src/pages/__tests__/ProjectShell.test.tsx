// Рендер/поведенческие тесты ProjectShell: свитч «Объекты/Процессы» (проект всегда
// открывается в «Объектах» — памяти режима нет с приёмки 2026-10-31), «Развёртывание» из
// адреса (уровень, переходы туда и обратно навигацией), открытие экспорта (схема/поддерево/процесс), навигация
// (переход в процессы со страницы узла, удаление узла), locate из алертов шапки,
// право правки по роли в проекте (my_role через контекст гейта), а не по глобальной.
// Тяжёлые потомки (дерево, страницы, ProcessWorkspace, модалки) замоканы —
// тестируем оркестрацию оболочки, а не внутренности детей.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ProjectShell from "../ProjectShell";
import { ProjectRoleContext } from "../projectRole";
import type { ProjectRole } from "../../types";
import { getUserRole } from "../../api/auth";
import { exportApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";

vi.mock("../../api/auth", () => ({
  getUserRole: vi.fn(() => "architect"),
  getIsAdmin: vi.fn(() => false),
  getIsGuest: vi.fn(() => false),
}));
vi.mock("../../api/nodes", () => ({
  exportApi: { all: vi.fn(), subtree: vi.fn() },
}));
// Экспорт процесса — ручка бэка (Ф2 архива): конвертер с фронта переехал целиком.
vi.mock("../../api/processes", () => ({ processesApi: { exportMermaid: vi.fn() } }));

// Алерты шапки: хук отдаёт пустой набор, ключ sessionStorage — настоящая константа.
vi.mock("../useSchemaAlerts", () => ({
  useSchemaAlerts: () => ({
    alerts: { disconnected_nodes: [], intermediate_edges: [], isolated_groups: [], container_own_docs: [] },
    loaded: true,
    reload: vi.fn(),
  }),
  PENDING_ALERT_LOCATE_KEY: "archmap.pendingAlertLocate",
  PENDING_PROCESS_KEY: "archmap.pendingProcess",
}));

// Модалка: прозрачная обёртка (jsdom не выставляет содержимое <dialog> в
// a11y-дерево — паттерн DocOverlay.test). Кнопки подтверждения рендерятся в children.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Кнопка «Рекомендации» (алерты): кнопки, дёргающие onLocate разными типами целей
// (как клик по пунктам в реальной панели): узел / связь / группа.
vi.mock("../../components/SchemaAlerts", () => ({
  default: ({ onLocate }: { onLocate: (t: { kind: string; id?: string; ids?: string[] }) => void }) => (
    <>
      <button data-testid="alert-node" onClick={() => onLocate({ kind: "node", id: "n1" })}>алерт-узел</button>
      <button data-testid="alert-edge" onClick={() => onLocate({ kind: "edge", id: "e1" })}>алерт-связь</button>
      <button data-testid="alert-group" onClick={() => onLocate({ kind: "group", ids: ["n1", "n2"] })}>алерт-группа</button>
    </>
  ),
}));

vi.mock("../../components/NodeTreePanel", () => ({
  default: ({ currentNodeId, isArchitect, onCreateChild }: {
    currentNodeId?: string | null; isArchitect: boolean; onCreateChild?: (parentId: string) => void;
  }) => (
    <div data-testid="tree-panel" data-can-edit={String(isArchitect)}>
      {currentNodeId ?? "root"}
      {/* «+» у листа дерева. */}
      <button data-testid="tree-plus" onClick={() => onCreateChild?.("leaf1")}>+</button>
    </div>
  ),
}));
vi.mock("../../components/NodeModal", () => ({
  default: ({ parentId }: { parentId: string | null }) => <div data-testid="node-modal" data-parent={parentId ?? ""} />,
}));
vi.mock("../ProjectHomePage", () => ({
  default: () => <div data-testid="project-home" />,
}));
// Страница узла: кнопки-триггеры навигационных колбэков оболочки.
vi.mock("../NodePage", () => ({
  default: ({
    onNavigateProcesses,
    onNodeDeleted,
  }: {
    onNavigateProcesses: (id: string) => void;
    onNodeDeleted: (parentId: string | null) => void;
  }) => (
    <div data-testid="node-page">
      <button onClick={() => onNavigateProcesses("p1")}>to-proc</button>
      <button onClick={() => onNodeDeleted(null)}>del-root</button>
    </div>
  ),
}));
// ProcessWorkspace: показывает стартовый процесс и умеет «выбрать» процесс.
vi.mock("../../components/processes/ProcessWorkspace", () => ({
  default: ({
    initialProcessId,
    onSelectedChange,
  }: {
    initialProcessId?: string;
    onSelectedChange: (s: { id: string; name: string } | null) => void;
  }) => (
    <div data-testid="process-workspace">
      <span data-testid="proc-initial">{initialProcessId ?? "none"}</span>
      <button onClick={() => onSelectedChange({ id: "p9", name: "Процесс X" })}>select-proc</button>
    </div>
  ),
}));
// Режим «Развёртывание»: маркер страницы с уровнем из адреса, триггеры перехода на
// страницу объекта и смены уровня.
vi.mock("../DeploymentPage", () => ({
  default: ({ onOpenNode, level, onNavigateLevel }: {
    onOpenNode: (id: string) => void;
    level: string | null;
    onNavigateLevel: (level: string | null) => void;
  }) => (
    <div data-testid="deployment-page" data-level={level ?? "root"}>
      <button onClick={() => onOpenNode("n7")}>open-node</button>
      <button onClick={() => onNavigateLevel("c2")}>to-level</button>
    </div>
  ),
}));
// Экспорт-модалка: показывает заголовок и запускает load (как реальный fetch контента).
vi.mock("../../components/ExportModal", () => ({
  default: ({ title, load }: { title: string; load: () => Promise<{ content: string }> }) => (
    <div data-testid="export-modal">
      <span>{title}</span>
      <button onClick={() => void load()}>run-load</button>
    </div>
  ),
}));
vi.mock("../../ui/ProfileMenu", () => ({ default: () => <div data-testid="profile-menu" /> }));
vi.mock("../../components/ProjectSwitcher", () => ({
  default: ({ isArchitect }: { isArchitect: boolean }) => (
    <div data-testid="project-switcher" data-can-create={String(isArchitect)} />
  ),
}));

const nav = {
  onLogout: vi.fn(),
  onOpenUsers: vi.fn(),
  onAllProjects: vi.fn(),
  onSwitchProject: vi.fn(),
  onNavigateNode: vi.fn(),
  onNavigateProject: vi.fn(),
  onNavigateMap: vi.fn(),
  onNavigateDeploy: vi.fn(),
};

describe("ProjectShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(getUserRole).mockReturnValue("architect");
  });

  // Роль в проекте приходит контекстом гейта маршрутов (ProjectAccessGate); режим
  // «Развёртывание» — адресом (deploy: уровень из #/p/<pid>/deploy/<уровень?>).
  function shell(nodeId: string | null, role: ProjectRole | null, deploy?: { level: string | null }) {
    return (
      <ProjectRoleContext.Provider value={role}>
        <ProjectShell projectId="proj1" nodeId={nodeId} deploy={deploy} {...nav} />
      </ProjectRoleContext.Provider>
    );
  }
  function setup(nodeId: string | null = null, role: ProjectRole | null = "owner", deploy?: { level: string | null }) {
    return render(shell(nodeId, role, deploy));
  }

  it("режим «Объекты» (по умолчанию): дерево + домашняя страница при nodeId=null", () => {
    setup(null);
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.getByTestId("project-home")).toBeInTheDocument();
    expect(screen.queryByTestId("node-page")).not.toBeInTheDocument();
  });

  it("«+» в дереве сразу открывает «Новый объект» с родителем — без окна первого вложенного объекта (Р38)", async () => {
    setup(null);
    await userEvent.click(screen.getByTestId("tree-plus"));
    // Родителя окно загружает само; оболочка ничего не спрашивает и не пишет.
    expect(screen.getByTestId("node-modal")).toHaveAttribute("data-parent", "leaf1");
    expect(screen.queryByText(/внутри/)).not.toBeInTheDocument();
  });

  it("при выбранном узле рендерит NodePage вместо домашней страницы", () => {
    setup("n1");
    expect(screen.getByTestId("node-page")).toBeInTheDocument();
    expect(screen.queryByTestId("project-home")).not.toBeInTheDocument();
  });

  it("переключение в «Процессы» показывает ProcessWorkspace и прячет дерево", async () => {
    setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    expect(screen.getByTestId("process-workspace")).toBeInTheDocument();
    expect(screen.queryByTestId("tree-panel")).not.toBeInTheDocument();
  });

  // Приёмка 2026-10-31: памяти режима нет — прежний ключ archmap_mode ничего не значит.
  it("проект открывается в «Объектах», даже если в localStorage лежит прежний режим", () => {
    localStorage.setItem("archmap_mode", "proc");
    const view = setup(null);
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("process-workspace")).not.toBeInTheDocument();
    view.unmount();
    localStorage.setItem("archmap_mode", "deploy");
    setup("n1");
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.getByTestId("node-page")).toBeInTheDocument();
    expect(screen.queryByTestId("deployment-page")).toBeNull();
  });

  it("переключение режима ничего не запоминает", async () => {
    setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    expect(localStorage.getItem("archmap_mode")).toBeNull();
  });

  it("возврат в «Объекты» снова показывает дерево", async () => {
    setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    await userEvent.click(screen.getByRole("button", { name: "Объекты" }));
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("process-workspace")).not.toBeInTheDocument();
  });

  it("экспорт из корня: заголовок «Экспорт схемы», load зовёт exportApi.all", async () => {
    vi.mocked(exportApi.all).mockResolvedValue({ format: "yaml", content: "yaml" });
    setup(null);
    // Действия схемы живут в кебаб-меню (П1 приёмки 2026-09-02): пункты словами.
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Экспорт схемы" }));
    expect(screen.getByTestId("export-modal")).toHaveTextContent("Экспорт схемы");
    await userEvent.click(screen.getByRole("button", { name: "run-load" }));
    expect(exportApi.all).toHaveBeenCalledOnce();
  });

  it("экспорт при выбранном узле: load зовёт exportApi.subtree(nodeId)", async () => {
    vi.mocked(exportApi.subtree).mockResolvedValue({ format: "yaml", content: "yaml" });
    setup("n1");
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Экспорт поддерева" }));
    expect(screen.getByTestId("export-modal")).toHaveTextContent("Экспорт поддерева");
    await userEvent.click(screen.getByRole("button", { name: "run-load" }));
    expect(exportApi.subtree).toHaveBeenCalledWith("n1");
  });

  it("вкладка «Развёртывание» ведёт на адрес режима — уровень «Весь проект»", async () => {
    setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Развёртывание" }));
    expect(nav.onNavigateDeploy).toHaveBeenCalledWith(null);
    // якоря тура на вкладках на месте
    expect(document.querySelector('[data-tour="mode-proc"]')).not.toBeNull();
    expect(document.querySelector('[data-tour="mode-deploy"]')).not.toBeNull();
  });

  it("режим «Развёртывание» — из адреса: страница уровня без дерева, экспорт погашен", async () => {
    setup(null, "owner", { level: "c1" });
    expect(screen.getByTestId("deployment-page")).toHaveAttribute("data-level", "c1");
    expect(screen.queryByTestId("tree-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-workspace")).not.toBeInTheDocument();
    // вкладка уже активна — повторный клик адрес не трогает
    await userEvent.click(screen.getByRole("button", { name: "Развёртывание" }));
    expect(nav.onNavigateDeploy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    expect(screen.getByRole("menuitem", { name: "Экспорт" })).toBeDisabled();
  });

  it("смена уровня на странице развёртывания — навигация по адресу; новый адрес — новый уровень", async () => {
    const view = setup(null, "owner", { level: null });
    expect(screen.getByTestId("deployment-page")).toHaveAttribute("data-level", "root");
    await userEvent.click(screen.getByRole("button", { name: "to-level" }));
    expect(nav.onNavigateDeploy).toHaveBeenCalledWith("c2");
    view.rerender(shell(null, "owner", { level: "c2" }));
    expect(screen.getByTestId("deployment-page")).toHaveAttribute("data-level", "c2");
  });

  it("из «Развёртывания» в «Объекты» — на страницу проекта, там «Объекты»", async () => {
    const view = setup(null, "owner", { level: "c1" });
    await userEvent.click(screen.getByRole("button", { name: "Объекты" }));
    expect(nav.onNavigateProject).toHaveBeenCalledOnce();
    view.rerender(shell(null, "owner"));
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.getByTestId("project-home")).toBeInTheDocument();
  });

  it("из «Развёртывания» в «Процессы» — на страницу проекта в режиме «Процессы»", async () => {
    const view = setup(null, "owner", { level: null });
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    expect(nav.onNavigateProject).toHaveBeenCalledOnce();
    view.rerender(shell(null, "owner"));
    expect(screen.getByTestId("process-workspace")).toBeInTheDocument();
  });

  it("«назад» из «Развёртывания» на адрес проекта возвращает прежний режим", async () => {
    const view = setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    await userEvent.click(screen.getByRole("button", { name: "Развёртывание" }));
    expect(nav.onNavigateDeploy).toHaveBeenCalledWith(null);
    view.rerender(shell(null, "owner", { level: null }));
    expect(screen.getByTestId("deployment-page")).toBeInTheDocument();
    view.rerender(shell(null, "owner"));
    expect(screen.getByTestId("process-workspace")).toBeInTheDocument();
  });

  it("из «Развёртывания» карточка ведёт на страницу объекта в режиме «Объекты»", async () => {
    const view = setup(null, "owner", { level: null });
    await userEvent.click(screen.getByRole("button", { name: "open-node" }));
    expect(nav.onNavigateNode).toHaveBeenCalledWith("n7");
    expect(nav.onNavigateProject).not.toHaveBeenCalled();
    // адрес сменился на страницу объекта — оболочка в «Объектах»
    view.rerender(shell("n7", "owner"));
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.getByTestId("node-page")).toBeInTheDocument();
  });

  it("в «Процессы» без выбранного процесса пункт экспорта заблокирован", async () => {
    setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    expect(screen.getByRole("menuitem", { name: "Экспорт" })).toBeDisabled();
  });

  it("в «Процессы» с выбранным процессом экспорт грузит Mermaid процесса", async () => {
    vi.mocked(processesApi.exportMermaid).mockResolvedValue(
      { format: "mermaid", content: "sequenceDiagram" } as never);
    setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    await userEvent.click(screen.getByRole("button", { name: "select-proc" }));
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    const exportItem = screen.getByRole("menuitem", { name: /Экспорт процесса «Процесс X»/ });
    expect(exportItem).toBeEnabled();
    await userEvent.click(exportItem);
    expect(screen.getByTestId("export-modal")).toHaveTextContent("Экспорт процесса «Процесс X»");
    await userEvent.click(screen.getByRole("button", { name: "run-load" }));
    expect(processesApi.exportMermaid).toHaveBeenCalledWith("p9");
  });

  it("переход в процессы со страницы узла: режим «Процессы» со стартовым процессом", async () => {
    setup("n1");
    await userEvent.click(screen.getByRole("button", { name: "to-proc" }));
    expect(screen.getByTestId("process-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("proc-initial")).toHaveTextContent("p1");
  });

  // Обратное направление алертов (2026-08-11): процессные классы чинят не на холсте,
  // поэтому редактор-карта кладёт процесс в sessionStorage и закрывается, а оболочка
  // должна открыться сразу в «Процессах» на нужном процессе.
  it("приход из редактора открывает «Процессы» с переданным процессом", () => {
    sessionStorage.setItem("archmap.pendingProcess", "p9");

    setup(null);

    expect(screen.getByTestId("process-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("proc-initial")).toHaveTextContent("p9");
  });

  it("ключ прихода одноразовый: следующий маунт открывает «Объекты»", () => {
    // Иначе оболочка возвращала бы в процесс после каждой перезагрузки; памяти режима
    // нет, поэтому следующий заход — снова «Объекты».
    sessionStorage.setItem("archmap.pendingProcess", "p9");
    setup(null).unmount();
    expect(sessionStorage.getItem("archmap.pendingProcess")).toBeNull();

    setup(null);

    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("process-workspace")).not.toBeInTheDocument();
  });

  it("удаление узла без родителя ведёт на страницу проекта", async () => {
    setup("n1");
    await userEvent.click(screen.getByRole("button", { name: "del-root" }));
    expect(nav.onNavigateProject).toHaveBeenCalledOnce();
  });

  it("клик по узлу-алерту ведёт на СТРАНИЦУ узла, а не в редактор", async () => {
    setup(null);
    await userEvent.click(screen.getByTestId("alert-node"));
    expect(nav.onNavigateNode).toHaveBeenCalledWith("n1");
    expect(nav.onNavigateMap).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("archmap.pendingAlertLocate")).toBeNull();
  });

  it("клик по связи-алерту показывает подтверждение «Открыть в редакторе?»", async () => {
    setup(null);
    await userEvent.click(screen.getByTestId("alert-edge"));
    // Ещё не в редакторе — ждём подтверждения.
    expect(nav.onNavigateMap).not.toHaveBeenCalled();
    expect(screen.getByText("Открыть в редакторе?")).toBeInTheDocument();
    // «Ок» → цель в sessionStorage и карта в корне.
    await userEvent.click(screen.getByRole("button", { name: "Ок" }));
    const raw = sessionStorage.getItem("archmap.pendingAlertLocate");
    expect(JSON.parse(raw!)).toEqual({ kind: "edge", id: "e1" });
    expect(nav.onNavigateMap).toHaveBeenCalledWith(null);
  });

  it("«Отмена» в подтверждении не открывает редактор", async () => {
    setup(null);
    await userEvent.click(screen.getByTestId("alert-group"));
    expect(screen.getByText("Открыть в редакторе?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(nav.onNavigateMap).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("archmap.pendingAlertLocate")).toBeNull();
    expect(screen.queryByText("Открыть в редакторе?")).not.toBeInTheDocument();
  });

  it("читателю проекта кнопки «Рекомендации» в шапке нет", async () => {
    setup(null, "reader");
    await waitFor(() => expect(screen.getByTestId("tree-panel")).toBeInTheDocument());
    expect(screen.queryByTestId("alert-node")).not.toBeInTheDocument();
  });

  it("владельцу и редактору проекта кнопка «Рекомендации» в шапке есть", () => {
    const { unmount } = setup(null, "owner");
    expect(screen.getByTestId("alert-node")).toBeInTheDocument();
    unmount();
    setup(null, "editor");
    expect(screen.getByTestId("alert-node")).toBeInTheDocument();
  });

  // ── Право правки — роль в проекте, а не глобальная роль ──────────────────
  it("viewer, редактор проекта: может править", () => {
    vi.mocked(getUserRole).mockReturnValue("viewer");
    setup(null, "editor");
    expect(screen.getByTestId("tree-panel")).toHaveAttribute("data-can-edit", "true");
    expect(screen.getByTestId("alert-node")).toBeInTheDocument();
    // «+ Новый проект» в свитчере — по-прежнему глобальная роль.
    expect(screen.getByTestId("project-switcher")).toHaveAttribute("data-can-create", "false");
  });

  it("architect, читатель проекта: только смотрит", () => {
    setup(null, "reader");
    expect(screen.getByTestId("tree-panel")).toHaveAttribute("data-can-edit", "false");
    expect(screen.getByTestId("project-switcher")).toHaveAttribute("data-can-create", "true");
  });

  it("роль не загрузилась: только чтение", () => {
    setup(null, null);
    expect(screen.getByTestId("tree-panel")).toHaveAttribute("data-can-edit", "false");
  });
});
