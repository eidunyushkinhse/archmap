// Характеристики окна схемы логики (DocOverlay): то, что обязано пережить переделку
// «просмотр → Изменить → Вручную / Через ИИ-агента» (docs/tasks/doc-viewer-v2.md).
//
// Окно рендерится НАСТОЯЩИМ (оболочка + FlowchartDocs + FlowchartDoc), замоканы только
// сеть, нативный <dialog> и тяжёлый mermaid. Проверяются контракты, а не кнопки:
//   • события onDocEvent (create/edit/delete) — их форма кормит мету страницы и
//     историю редактора, и менять её нельзя;
//   • CAS-конфликт: 409 не проглатывается, detail виден, данные подтянуты свежие;
//   • открытие на конкретной схеме (initialDocId);
//   • окно из шага процесса открывается на чтение.
// Как добраться до редактора и что нажать для сохранения — в драйверах ниже: их
// переписывают вместе с интерфейсом, утверждения остаются прежними.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocOverlay from "../inspector/DocOverlay";
import { nodeDocsApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { NodeDoc } from "../../types";
import type { NodeDocEvent } from "../inspector/FlowchartDocs";

vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));
vi.mock("../../api/nodes", () => ({
  nodeDocsApi: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    usage: vi.fn(() => Promise.resolve([])),
  },
  nodesApi: { get: vi.fn() },
}));
vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));
// Рендер диаграммы: показываем текст схемы — по нему видно, ЧТО открыто в окне.
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));

function doc(id: string, over: Partial<NodeDoc> = {}): NodeDoc {
  return {
    id, node_id: "n1", name: `Схема ${id}`, kind: "operation", operation: null,
    content: `graph TD\n  ${id}`, version: 1, ...over,
  } as NodeDoc;
}

const base = {
  mode: "flowchart" as const,
  nodeId: "n1",
  nodeName: "Заказы",
  openapi: "",
  onCommitOpenapi: vi.fn(),
  onClose: vi.fn(),
};

// ── драйверы интерфейса (вьюер v2: просмотр → «Изменить» → «Вручную») ─────────

const codeField = () => document.querySelector("textarea.doc-edta") as HTMLTextAreaElement | null;

// Окно открывается просмотром; до редактора — «Изменить → Вручную».
async function openEditor() {
  await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
  await waitFor(() => expect(codeField()).not.toBeNull());
}

function setCode(text: string) {
  fireEvent.change(codeField()!, { target: { value: text } });
}

// Сохранение явное — кнопкой в шапке окна.
async function save() {
  await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
}

async function deleteDoc() {
  await userEvent.click(await screen.findByRole("button", { name: "Удалить схему" }));
  await userEvent.click(screen.getByRole("button", { name: "Точно удалить?" }));
}

// Новая схема со страницы: «+ Добавить → Вручную» — окно сразу в редакторе, схема
// появляется в БД только по «Сохранить».
async function createNew(onDocEvent: (evt: NodeDocEvent) => void) {
  render(<DocOverlay {...base} isArchitect createNew onDocEvent={onDocEvent} />);
  await waitFor(() => expect(codeField()).not.toBeNull());
  setCode("graph TD\n  новая");
  await save();
}

// Окно из шага процесса: как его открывает ProcessCanvas (роль архитектора, окно
// само стартует просмотром).
function renderFromStep(docId: string) {
  render(<DocOverlay {...base} isArchitect initialDocId={docId} onDocEvent={vi.fn()} />);
}

// ── контракты ─────────────────────────────────────────────────────────────────

describe("окно схемы логики: контракты, переживающие переделку", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
  });

  it("открывается на запрошенной схеме", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([
      doc("d1", { content: "graph TD\n  первая" }),
      doc("d2", { content: "graph TD\n  целевая" }),
    ]);
    render(<DocOverlay {...base} isArchitect initialDocId="d2" onDocEvent={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("mmd")).toHaveTextContent("целевая"));
  });

  it("правка текста: PATCH под CAS и одно событие edit с полными доками до и после", async () => {
    const d2 = doc("d2");
    const saved = doc("d2", { content: "graph TD\n  новое", version: 2 });
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1"), d2]);
    vi.mocked(nodeDocsApi.update).mockResolvedValue(saved);
    const onDocEvent = vi.fn();
    render(<DocOverlay {...base} isArchitect initialDocId="d2" onDocEvent={onDocEvent} />);

    await openEditor();
    setCode("graph TD\n  новое");
    await save();

    await waitFor(() => expect(nodeDocsApi.update).toHaveBeenCalledTimes(1));
    expect(nodeDocsApi.update).toHaveBeenCalledWith(
      "n1", "d2", expect.objectContaining({ content: "graph TD\n  новое", base_version: 1 }),
    );
    await waitFor(() => expect(onDocEvent).toHaveBeenCalledTimes(1));
    expect(onDocEvent).toHaveBeenCalledWith({ type: "edit", nodeId: "n1", before: d2, after: saved });
  });

  it("CAS-конфликт: detail виден, свежие данные подтянуты, события нет", async () => {
    vi.mocked(nodeDocsApi.list)
      .mockResolvedValueOnce([doc("d2", { content: "graph TD\n  старое" })])
      .mockResolvedValueOnce([doc("d2", { content: "graph TD\n  свежее", version: 5 })]);
    vi.mocked(nodeDocsApi.update).mockRejectedValue(new ApiError(409, "Схема изменена в другой сессии"));
    const onDocEvent = vi.fn();
    render(<DocOverlay {...base} isArchitect initialDocId="d2" onDocEvent={onDocEvent} />);

    await openEditor();
    setCode("graph TD\n  моё");
    await save();

    expect(await screen.findByText("Схема изменена в другой сессии")).toBeInTheDocument();
    await waitFor(() => expect(nodeDocsApi.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("mmd")).toHaveTextContent("свежее"));
    expect(onDocEvent).not.toHaveBeenCalled();
  });

  it("новая схема: create и событие create с тем, что вернул сервер", async () => {
    const created = doc("new", { name: "Новая схема" });
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.create).mockResolvedValue(created);
    const onDocEvent = vi.fn();

    await createNew(onDocEvent);

    await waitFor(() => expect(nodeDocsApi.create).toHaveBeenCalledTimes(1));
    expect(nodeDocsApi.create).toHaveBeenCalledWith(
      "n1", expect.objectContaining({ name: "Новая схема", kind: "operation" }),
    );
    await waitFor(() => expect(onDocEvent).toHaveBeenCalledWith({ type: "create", nodeId: "n1", doc: created }));
  });

  it("удаление: DELETE и событие delete с полным доком", async () => {
    const d2 = doc("d2");
    vi.mocked(nodeDocsApi.list).mockResolvedValue([d2]);
    vi.mocked(nodeDocsApi.delete).mockResolvedValue(undefined);
    const onDocEvent = vi.fn();
    render(<DocOverlay {...base} isArchitect initialDocId="d2" onDocEvent={onDocEvent} />);

    await openEditor();
    await deleteDoc();

    await waitFor(() => expect(nodeDocsApi.delete).toHaveBeenCalledWith("n1", "d2"));
    await waitFor(() => expect(onDocEvent).toHaveBeenCalledWith({ type: "delete", nodeId: "n1", doc: d2 }));
  });

  it("из шага процесса окно открыто на чтение: схема видна, редактора нет", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1"), doc("d2", { content: "graph TD\n  шаг" })]);
    renderFromStep("d2");
    await waitFor(() => expect(screen.getByTestId("mmd")).toHaveTextContent("шаг"));
    expect(codeField()).toBeNull();
  });
});
