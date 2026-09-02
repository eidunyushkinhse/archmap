// Рендер/поведенческие тесты ProjectShell: свитч «Объекты/Процессы» (с сохранением
// режима в localStorage), открытие экспорта (схема/поддерево/процесс), навигация
// (переход в процессы со страницы узла, удаление узла), locate из алертов шапки.
// Тяжёлые потомки (дерево, страницы, ProcessWorkspace, модалки) замоканы —
// тестируем оркестрацию оболочки, а не внутренности детей.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ProjectShell from "../ProjectShell";
import { getUserRole } from "../../api/auth";
import { exportApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";

vi.mock("../../api/auth", () => ({ getUserRole: vi.fn(() => "architect") }));
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

// Знак алертов: кнопки, дёргающие onLocate разными типами целей (как клик по
// пунктам в реальном меню): узел / связь / группа.
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
  default: ({ currentNodeId }: { currentNodeId?: string | null }) => (
    <div data-testid="tree-panel">{currentNodeId ?? "root"}</div>
  ),
}));
vi.mock("../../components/NodeModal", () => ({
  default: () => <div data-testid="node-modal" />,
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
  default: () => <div data-testid="project-switcher" />,
}));

const nav = {
  onLogout: vi.fn(),
  onAllProjects: vi.fn(),
  onSwitchProject: vi.fn(),
  onNavigateNode: vi.fn(),
  onNavigateProject: vi.fn(),
  onNavigateMap: vi.fn(),
};

describe("ProjectShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(getUserRole).mockReturnValue("architect");
  });

  function setup(nodeId: string | null = null) {
    return render(<ProjectShell projectId="proj1" nodeId={nodeId} {...nav} />);
  }

  it("режим «Объекты» (по умолчанию): дерево + домашняя страница при nodeId=null", () => {
    setup(null);
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.getByTestId("project-home")).toBeInTheDocument();
    expect(screen.queryByTestId("node-page")).not.toBeInTheDocument();
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
    expect(localStorage.getItem("archmap_mode")).toBe("proc");
  });

  it("режим восстанавливается из localStorage при монтировании", () => {
    localStorage.setItem("archmap_mode", "proc");
    setup(null);
    expect(screen.getByTestId("process-workspace")).toBeInTheDocument();
    expect(screen.queryByTestId("tree-panel")).not.toBeInTheDocument();
  });

  it("возврат в «Объекты» снова показывает дерево", async () => {
    setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Процессы" }));
    await userEvent.click(screen.getByRole("button", { name: "Объекты" }));
    expect(screen.getByTestId("tree-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("process-workspace")).not.toBeInTheDocument();
    expect(localStorage.getItem("archmap_mode")).toBe("schema");
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

  it("ключ прихода одноразовый: следующий маунт не подставляет тот же процесс", () => {
    // Режим при этом остаётся «Процессы» — он живёт в localStorage и помнит, где
    // пользователь был в последний раз (приход алертом от переключения вкладки не
    // отличается). Одноразов именно ВЫБОР процесса: иначе оболочка возвращала бы в
    // него после каждой перезагрузки.
    sessionStorage.setItem("archmap.pendingProcess", "p9");
    setup(null).unmount();

    setup(null);

    expect(screen.getByTestId("proc-initial")).toHaveTextContent("none");
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

  it("наблюдателю не виден знак алертов в шапке", async () => {
    vi.mocked(getUserRole).mockReturnValue("viewer");
    setup(null);
    await waitFor(() => expect(screen.getByTestId("tree-panel")).toBeInTheDocument());
    expect(screen.queryByTestId("alert-node")).not.toBeInTheDocument();
  });
});
