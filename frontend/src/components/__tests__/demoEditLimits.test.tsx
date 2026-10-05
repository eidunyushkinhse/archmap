// Пределы демо-стенда при правке (docs/tasks/demo-mode.md, экраны 4 и 5 прототипа).
// Отказ сервера — 409 с code=demo_limit и текстом по прототипу; фронт добавляет
// жирное начало по действию. Экран 4: «Не получилось добавить объект / связь /
// процесс» — в окне «Новый объект», в окне новой связи и тостом внизу холста
// процессов. Экран 5: «Не сохранилось.» в подвале окна схемы и спеки, правка
// остаётся в редакторе; тем же текстом — секции конфигурации.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeModal from "../NodeModal";
import EdgeQuickCreate from "../EdgeQuickCreate";
import FlowchartDocs from "../inspector/FlowchartDocs";
import OpenApiPane from "../inspector/OpenApiPane";
import ConfigParamsSection from "../ConfigParamsSection";
import ProcessWorkspace from "../processes/ProcessWorkspace";
import DemoLimitToast from "../demo/DemoLimitToast";
import { useDemoLimitToast } from "../demo/useDemoLimitToast";
import { configParamsApi, edgesApi, nodeDocsApi, nodesApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";
import { ApiError, DEMO_LIMIT_CODE, isConflict, isDemoLimit } from "../../api/client";
import type { NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { create: vi.fn(), get: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
  edgesApi: { create: vi.fn() },
  nodeDocsApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), usage: vi.fn() },
  configParamsApi: { list: vi.fn(), usage: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock("../../api/processes", () => ({
  processesApi: { list: vi.fn(), create: vi.fn(), duplicate: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../api/docsImport", () => ({ docsImportApi: { prompt: vi.fn() } }));
vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../inspector/FlowchartDoc", () => ({
  default: ({ initial, isArchitect, onDraft }: {
    initial: string; isArchitect: boolean; onDraft?: (v: string) => void;
  }) => (
    <div data-testid="doc-editor" data-edit={String(isArchitect)}>
      {initial}
      {onDraft && <button onClick={() => onDraft("graph TD\n  длинная правка")}>набрать</button>}
    </div>
  ),
}));
vi.mock("../docsImport/DocsAgentPanel", () => ({ default: () => <div /> }));
vi.mock("../OpenApiViewer", () => ({ default: () => <div data-testid="swagger" /> }));
vi.mock("../docsImport/SpecAgentPanel", () => ({ default: () => <div /> }));
vi.mock("../processes/ProcessCanvas", () => ({ default: () => <div data-testid="process-canvas" /> }));
vi.mock("../processes/ProcessRail", () => ({
  default: ({ onNew, onDuplicate }: { onNew: () => void; onDuplicate: (id: string) => void }) => (
    <div>
      <button onClick={onNew}>Новый процесс</button>
      <button onClick={() => onDuplicate("bp1")}>Дублировать</button>
    </div>
  ),
}));

const limit = (detail: string) => new ApiError(409, detail, DEMO_LIMIT_CODE);
const NODES = "Демо-проект поддерживает до 100 объектов. Удалите ненужные, чтобы добавить новые.";
const EDGES = "Демо-проект поддерживает до 120 связей. Удалите ненужные, чтобы добавить новые.";
const PROCS = "Демо-проект поддерживает до 10 процессов. Удалите ненужные, чтобы добавить новые.";
const DOCS = "Демо-проект поддерживает до 75 схем логики. Удалите ненужные, чтобы добавить новые.";
const VOLUME = "Текста в проекте стало больше 250 КБ, это предел демо. Сократите схему или удалите ненужные.";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("отказ по пределу ≠ конфликт версий", () => {
  it("isDemoLimit различает code, isConflict его не ловит", () => {
    expect(isDemoLimit(limit(NODES))).toBe(true);
    expect(isConflict(limit(NODES))).toBe(false);
    const cas = new ApiError(409, "Конфликт версий");
    expect(isDemoLimit(cas)).toBe(false);
    expect(isConflict(cas)).toBe(true);
  });
});

describe("экран 4 · предел при правке схемы", () => {
  it("окно «Новый объект»: тот же текст, что в тосте, окно не закрывается", async () => {
    vi.mocked(nodesApi.create).mockRejectedValue(limit(NODES));
    const onSaved = vi.fn();
    render(<NodeModal parentId={null} onClose={vi.fn()} onSaved={onSaved} />);
    await userEvent.type(screen.getAllByRole("textbox")[0], "Сервис доставки");
    await userEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Не получилось добавить объект. ${NODES}`);
    expect(screen.getByText("Не получилось добавить объект.").tagName).toBe("B");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("новая связь: «Не получилось добавить связь.»", async () => {
    vi.mocked(edgesApi.create).mockRejectedValue(limit(EDGES));
    render(
      <EdgeQuickCreate sourceId="a" targetId="b" sourceLabel="Заказы" targetLabel="Оплата"
        onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Не получилось добавить связь. ${EDGES}`);
  });

  it("«Новый процесс» и дубль: тост внизу холста процессов", async () => {
    vi.mocked(processesApi.list).mockResolvedValue([]);
    vi.mocked(processesApi.create).mockRejectedValue(limit(PROCS));
    vi.mocked(processesApi.duplicate).mockRejectedValue(limit(PROCS));
    render(<ProcessWorkspace isArchitect />);
    await userEvent.click(screen.getByRole("button", { name: "Новый процесс" }));
    expect(await screen.findByRole("status")).toHaveTextContent(`Не получилось добавить процесс. ${PROCS}`);
    await userEvent.click(screen.getByRole("button", { name: "Дублировать" }));
    expect(screen.getByRole("status")).toHaveTextContent("Не получилось добавить процесс.");
  });

  it("тост холста: только для отказа по пределу, иное оставляет вызывающему", async () => {
    let show: (e: unknown, a: "node" | "edge") => boolean = () => false;
    function Harness() {
      const [msg, s] = useDemoLimitToast();
      show = s;
      return <DemoLimitToast message={msg} />;
    }
    render(<Harness />);
    let handled = true;
    await waitFor(() => { handled = show(new ApiError(500, "сбой"), "node"); });
    expect(handled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => { handled = show(limit(NODES), "node"); });
    expect(handled).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(`Не получилось добавить объект. ${NODES}`);
    await waitFor(() => { show(limit(EDGES), "edge"); });
    expect(screen.getByRole("status")).toHaveTextContent(`Не получилось добавить связь. ${EDGES}`);
  });
});

describe("экран 5 · предел при сохранении документации", () => {
  const doc = (over: Partial<NodeDoc> = {}): NodeDoc => ({
    id: "d1", node_id: "n1", name: "Создание заказа", kind: "operation", operation: null,
    content: "graph TD\n  A --> B", version: 1, ...over,
  } as NodeDoc);
  const docProps = { nodeId: "n1", nodeName: "Order API", onDocEvent: vi.fn(), onClose: vi.fn() };

  async function правка() {
    await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
  }

  it("объём текста: «Не сохранилось.» в подвале, правка остаётся в редакторе", async () => {
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc()]);
    vi.mocked(nodeDocsApi.update).mockRejectedValue(limit(VOLUME));
    render(<FlowchartDocs {...docProps} isArchitect initialDocId="d1" />);
    await правка();
    await userEvent.click(screen.getByText("набрать"));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Не сохранилось. ${VOLUME}`);
    expect(alert).toHaveClass("doc-limit");
    expect(alert.closest(".doc-foot")).not.toBeNull();
    // Окно осталось в правке: можно сократить и сохранить снова.
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "true");
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeEnabled();
  });

  it("число схем: новая схема не создаётся, текст про 75 схем", async () => {
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.create).mockRejectedValue(limit(DOCS));
    render(<FlowchartDocs {...docProps} isArchitect createNew />);
    await userEvent.click(await screen.findByRole("button", { name: "Сохранить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Не сохранилось. ${DOCS}`);
    expect(docProps.onClose).not.toHaveBeenCalled();
  });

  it("спека: отказ в подвале, черновик цел", async () => {
    const spec = "openapi: 3.0.3\ninfo:\n  title: Старая\n  version: 1.0.0\npaths: {}\n";
    const onCommitOpenapi = vi.fn(() => Promise.reject(limit(VOLUME)));
    render(<OpenApiPane nodeId="n1" nodeName="Каталог" onClose={vi.fn()} openapi={spec}
      isArchitect onCommitOpenapi={onCommitOpenapi} />);
    await правка();
    const field = document.querySelector("textarea.doc-edta") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: spec.replace("Старая", "Новая") } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Не сохранилось. ${VOLUME}`);
    expect((document.querySelector("textarea.doc-edta") as HTMLTextAreaElement).value).toContain("Новая");
  });

  it("конфигурация: тот же отказ плашкой секции", async () => {
    vi.mocked(configParamsApi.list).mockResolvedValue([{
      id: "p1", node_id: "n1", name: "FEATURE", description: "старое", value_type: "bool",
      required: false, default_value: "false", version: 1,
    }]);
    vi.mocked(configParamsApi.usage).mockResolvedValue([]);
    vi.mocked(configParamsApi.update).mockRejectedValue(limit(VOLUME));
    render(<ConfigParamsSection nodeId="n1" isArchitect allowed />);
    const поле = await screen.findByDisplayValue("старое");
    await userEvent.clear(поле);
    await userEvent.type(поле, "очень длинное описание");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent(`Не сохранилось. ${VOLUME}`);
    // Правка не потерялась: в поле всё ещё набранный текст.
    expect(screen.getByDisplayValue("очень длинное описание")).toBeInTheDocument();
  });
});
