// Рендер-тесты FlowchartDocs: список схем (select), создание, autoCreate,
// initialDocId, удаление. Тяжёлый редактор FlowchartDoc (mermaid) замокан —
// тестируем список и CRUD-оркестрацию.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FlowchartDocs from "../inspector/FlowchartDocs";
import { nodeDocsApi } from "../../api/nodes";
import type { NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodeDocsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Редактор схемы (mermaid) не нужен — заглушка показывает контент активного дока.
vi.mock("../inspector/FlowchartDoc", () => ({
  default: ({ initial }: { initial: string }) => <div data-testid="doc-editor">{initial}</div>,
}));

function doc(id: string, over: Partial<NodeDoc> = {}): NodeDoc {
  return {
    id,
    node_id: "n1",
    name: `Схема ${id}`,
    kind: "operation",
    operation: null,
    content: `content-${id}`,
    version: 1,
    ...over,
  } as NodeDoc;
}

describe("FlowchartDocs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("рендерит список схем в select после загрузки", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1"), doc("d2")]);
    render(<FlowchartDocs nodeId="n1" isArchitect onDocEvent={vi.fn()} showCode={false} />);
    // Опции select: «Обзор · Схема d1»
    await waitFor(() => expect(screen.getByRole("option", { name: /Схема d1/ })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /Схема d2/ })).toBeInTheDocument();
  });

  it("пустой список архитектору: «+ Схема» создаёт док и репортит событие", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.create).mockResolvedValue(doc("new", { name: "Новая схема" }));
    const onDocEvent = vi.fn();
    render(<FlowchartDocs nodeId="n1" isArchitect onDocEvent={onDocEvent} showCode={false} />);
    const addBtn = await screen.findByRole("button", { name: /схема/i });
    await userEvent.click(addBtn);
    await waitFor(() => expect(nodeDocsApi.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(onDocEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "create" }),
    ));
  });

  it("autoCreate: создаёт схему сразу при монтировании", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.create).mockResolvedValue(doc("auto"));
    render(<FlowchartDocs nodeId="n1" isArchitect onDocEvent={vi.fn()} showCode={false} autoCreate />);
    await waitFor(() => expect(nodeDocsApi.create).toHaveBeenCalledOnce());
  });

  it("initialDocId: открывает указанную схему активной (её контент в редакторе)", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([
      doc("d1", { content: "первый" }),
      doc("d2", { content: "целевой" }),
    ]);
    render(
      <FlowchartDocs nodeId="n1" isArchitect onDocEvent={vi.fn()} showCode={false} initialDocId="d2" />,
    );
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toHaveTextContent("целевой"));
  });

  it("двухшаговое удаление: первый клик взводит, второй удаляет", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1")]);
    vi.mocked(nodeDocsApi.delete).mockResolvedValue(undefined);
    const onDocEvent = vi.fn();
    render(<FlowchartDocs nodeId="n1" isArchitect onDocEvent={onDocEvent} showCode={false} />);
    const delBtn = await screen.findByRole("button", { name: "Удалить" });
    await userEvent.click(delBtn);
    // Первый клик — взвод (кнопка меняет текст)
    expect(await screen.findByRole("button", { name: "Точно удалить?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Точно удалить?" }));
    await waitFor(() => expect(nodeDocsApi.delete).toHaveBeenCalledWith("n1", "d1"));
    await waitFor(() => expect(onDocEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "delete" }),
    ));
  });

  it("наблюдателю без схем: нет кнопки создания", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    render(<FlowchartDocs nodeId="n1" isArchitect={false} onDocEvent={vi.fn()} showCode={false} />);
    await waitFor(() => expect(nodeDocsApi.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /схема/i })).not.toBeInTheDocument();
  });
});
