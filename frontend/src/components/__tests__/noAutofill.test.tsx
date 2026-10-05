// Автозаполнение браузера в формах продукта (приёмка тура демо, 2026-10-05): Chrome
// предложил «Сохранить данные о транспортном средстве?» после создания связи. Все
// текстовые поля НЕ-логинных форм несут autocomplete="off" и своё нейтральное имя
// `archmap-…` (ui/noAutofill.ts — почему именно так). Логин свои подсказки сохраняет.
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EdgeQuickCreate from "../EdgeQuickCreate";
import NodeModal from "../NodeModal";
import EdgeEditModal from "../EdgeEditModal";
import NodeInspector from "../inspector/NodeInspector";
import EdgeInspector from "../inspector/EdgeInspector";
import CreateProjectDialog from "../project/CreateProjectDialog";
import ProcessImportModal from "../processes/ProcessImportModal";
import LoginPage from "../../pages/LoginPage";
import { edgesApi, nodesApi } from "../../api/nodes";
import { noAutofill } from "../../ui/noAutofill";
import type { LevelEdge, Node } from "../../types";

vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../NodeSearchPicker", () => ({ default: () => null }));
vi.mock("../../api/nodes", () => ({
  nodesApi: {
    create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn(), deletionSnapshot: vi.fn(),
    getDescendants: vi.fn(() => Promise.resolve([])), anchorPreview: vi.fn(),
  },
  viewsApi: { saveLayout: vi.fn() },
  edgesApi: {
    create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn(), deletionSnapshot: vi.fn(),
  },
  brokerChannelsApi: { list: vi.fn(() => Promise.resolve([])) },
}));
vi.mock("../../api/projects", () => ({
  projectsApi: { importPrompt: vi.fn(), create: vi.fn(), unifiedPreview: vi.fn(), importUnified: vi.fn() },
}));
vi.mock("../../api/processes", () => ({
  processesApi: { importPreview: vi.fn(), importProcess: vi.fn() },
}));
vi.mock("../../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth")>()),
  login: vi.fn(), saveToken: vi.fn(),
}));
vi.mock("../login/LoginScenePreview", () => ({ default: () => null }));

const NODE = {
  id: "n1", name: "orders", description: null, role: null, technology: null,
  parent_id: null, shape: "service", is_external: false, status: "existing",
  openapi_spec: null, version: 1, docs: [], has_children: false, child_count: 0,
  created_at: "", updated_at: "",
} as Node;

const EDGE = {
  id: "e1", label: "событие", technology: "REST", channel: null, is_synchronous: true,
  source_id: "n1", target_id: "n2", version: 2, created_at: "",
  original_source_id: "n1", original_target_id: "n2",
  original_source_name: "orders", original_target_name: "billing",
} as LevelEdge;

// Текстовые поля формы: всё, что браузер мог бы заполнить (не флажки и не файлы).
const TEXT_FIELDS = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea';

function expectNoAutofill(root: HTMLElement): void {
  const fields = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELDS));
  expect(fields.length).toBeGreaterThan(0);
  for (const f of fields) {
    expect(f.getAttribute("autocomplete")).toBe("off");
    expect(f.getAttribute("name") ?? "").toMatch(/^archmap-[a-z0-9-]+$/);
  }
  // своё имя у каждого поля формы: одинаковые имена снова склеили бы сигнатуры
  const names = fields.map((f) => f.getAttribute("name"));
  expect(new Set(names).size).toBe(names.length);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodesApi.get).mockImplementation((id: string) => Promise.resolve({ ...NODE, id }));
  vi.mocked(edgesApi.get).mockResolvedValue(EDGE as never);
  vi.mocked(edgesApi.list).mockResolvedValue([EDGE] as never);
});

describe("автозаполнение браузера в формах продукта", () => {
  it("помощник: имя archmap-… и autocomplete=off", () => {
    expect(noAutofill("edge-quick-create-1")).toEqual({ name: "archmap-edge-quick-create-1", autoComplete: "off" });
  });

  it("окно новой связи", () => {
    const { container } = render(
      <EdgeQuickCreate sourceId="a" targetId="b" sourceLabel="A" targetLabel="B" onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expectNoAutofill(container);
  });

  it("«Новый объект»", () => {
    const { container } = render(<NodeModal parentId={null} shape="service" onClose={vi.fn()} onSaved={vi.fn()} />);
    expectNoAutofill(container);
  });

  it("правка связи со страницы объекта", async () => {
    const { container } = render(<EdgeEditModal edgeId="e1" onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("textarea, input")).not.toBeNull());
    expectNoAutofill(container);
  });

  it("инспекторы объекта и связи", async () => {
    const node = render(
      <NodeInspector node={NODE} isArchitect onNodeSaved={vi.fn()} onNodeDeleted={vi.fn()} onNavigateNode={vi.fn()} />,
    );
    expectNoAutofill(node.container);
    node.unmount();
    const edge = render(<EdgeInspector edge={EDGE} isArchitect onEdgeSaved={vi.fn()} onEdgeDeleted={vi.fn()} />);
    await waitFor(() => expect(edge.container.querySelector("textarea, input")).not.toBeNull());
    expectNoAutofill(edge.container);
  });

  it("окно нового проекта: пустой и импорт", async () => {
    const { container, getByText } = render(
      <CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expectNoAutofill(container);
    await userEvent.click(getByText("Импорт"));
    expectNoAutofill(container);
  });

  it("импорт процесса", () => {
    const { container } = render(<ProcessImportModal onClose={vi.fn()} onImported={vi.fn()} />);
    expectNoAutofill(container);
  });

  it("вход не тронут: логин и пароль подсказывает браузер", () => {
    const { container } = render(<LoginPage onLogin={vi.fn()} />);
    const fields = Array.from(container.querySelectorAll("input"));
    expect(fields.map((f) => f.getAttribute("autocomplete"))).toEqual(["username", "current-password"]);
    expect(fields.some((f) => (f.getAttribute("name") ?? "").startsWith("archmap-"))).toBe(false);
  });
});
