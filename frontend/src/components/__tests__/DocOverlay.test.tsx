// Рендер-тесты DocOverlay: тонкий shell вокруг FlowchartDocs (Логика) и
// OpenApiPane (OpenAPI) — у каждого окна своя шапка и стадии. Проверяем выбор
// режима и проброс пропсов; сами окна замоканы. Стадии окна схемы —
// FlowchartDocs.test, окна спеки — openApiPane.test.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DocOverlay from "../inspector/DocOverlay";

// Модалка на нативном <dialog>: в jsdom showModal() не выставляет open, и контент
// закрытого диалога выпадает из accessible-дерева (getByRole его не видит).
// Заменяем на прозрачную обёртку — тестируем shell, а не фокус-менеджмент Modal.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));

// Окно схемы логики: отражает полученные пропы и умеет закрыть окно своей шапкой.
vi.mock("../inspector/FlowchartDocs", () => ({
  default: (p: {
    nodeName: string;
    isArchitect: boolean;
    createNew?: boolean;
    initialDocId?: string;
    onApplied?: () => void;
    onOpenProcess?: (id: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="flowchart-docs">
      <span data-testid="flow-node">{p.nodeName}</span>
      <span data-testid="flow-architect">{String(p.isArchitect)}</span>
      <span data-testid="flow-create">{String(Boolean(p.createNew))}</span>
      <span data-testid="flow-initial">{p.initialDocId ?? "none"}</span>
      {p.onApplied && <button onClick={p.onApplied}>flow-applied</button>}
      {p.onOpenProcess && <button onClick={() => p.onOpenProcess?.("pr1")}>flow-process</button>}
      <button onClick={p.onClose}>flow-close</button>
    </div>
  ),
}));
// Окно спеки: отражает пропы и умеет записать спеку и закрыть окно.
vi.mock("../inspector/OpenApiPane", () => ({
  default: (p: {
    openapi: string;
    isArchitect: boolean;
    initialStage?: string;
    notice?: string | null;
    onCommitOpenapi: (v: string) => Promise<boolean>;
    onApplied?: () => void;
    onClose: () => void;
  }) => (
    <div data-testid="openapi-pane">
      <span data-testid="oas-spec">{p.openapi}</span>
      <span data-testid="oas-stage">{p.initialStage ?? "none"}</span>
      <span data-testid="oas-notice">{p.notice ?? ""}</span>
      <button onClick={() => void p.onCommitOpenapi("новая спека").then((ok) => { if (!ok) p.onClose(); })}>oas-save</button>
      {p.onApplied && <button onClick={p.onApplied}>oas-applied</button>}
    </div>
  ),
}));

const base = {
  nodeId: "n1",
  nodeName: "Сервис оплаты",
  openapi: "openapi: 3.0.3",
  onCommitOpenapi: vi.fn(() => Promise.resolve(true)),
  onDocEvent: vi.fn(),
  onClose: vi.fn(),
};

describe("DocOverlay", () => {
  beforeEach(() => vi.clearAllMocks());

  it("режим «Логика»: всё окно — FlowchartDocs со своей шапкой", () => {
    render(<DocOverlay {...base} mode="flowchart" isArchitect />);
    expect(screen.getByTestId("flowchart-docs")).toBeInTheDocument();
    expect(screen.getByTestId("flow-node")).toHaveTextContent("Сервис оплаты");
    // Шапки и подвала оболочки в этом режиме нет — их рисует окно схемы.
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();
  });

  it("прокидывает createNew, initialDocId, onApplied и переход в процесс", async () => {
    const onApplied = vi.fn();
    const onOpenProcess = vi.fn();
    render(
      <DocOverlay {...base} mode="flowchart" isArchitect createNew initialDocId="d7"
        onApplied={onApplied} onOpenProcess={onOpenProcess} />,
    );
    expect(screen.getByTestId("flow-create")).toHaveTextContent("true");
    expect(screen.getByTestId("flow-initial")).toHaveTextContent("d7");
    await userEvent.click(screen.getByText("flow-applied"));
    expect(onApplied).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByText("flow-process"));
    expect(onOpenProcess).toHaveBeenCalledWith("pr1");
  });

  it("окно схемы закрывает оверлей своей шапкой (onClose)", async () => {
    render(<DocOverlay {...base} mode="flowchart" isArchitect={false} />);
    expect(screen.getByTestId("flow-architect")).toHaveTextContent("false");
    await userEvent.click(screen.getByText("flow-close"));
    expect(base.onClose).toHaveBeenCalledOnce();
  });

  it("режим OpenAPI: всё окно — OpenApiPane, спека и стадия открытия доезжают", () => {
    render(<DocOverlay {...base} mode="openapi" isArchitect initialStage="agent" notice="Конфликт версий" />);
    expect(screen.getByTestId("openapi-pane")).toBeInTheDocument();
    expect(screen.getByTestId("oas-spec")).toHaveTextContent("openapi: 3.0.3");
    expect(screen.getByTestId("oas-stage")).toHaveTextContent("agent");
    expect(screen.getByTestId("oas-notice")).toHaveTextContent("Конфликт версий");
  });

  it("запись спеки идёт через onCommitOpenapi страницы", async () => {
    const onCommitOpenapi = vi.fn(() => Promise.resolve(true));
    render(<DocOverlay {...base} mode="openapi" isArchitect onCommitOpenapi={onCommitOpenapi} />);
    await userEvent.click(screen.getByText("oas-save"));
    expect(onCommitOpenapi).toHaveBeenCalledWith("новая спека");
    expect(base.onClose).not.toHaveBeenCalled();
  });

  it("без колбэка записи (окно из процесса) спека не пишется", async () => {
    render(<DocOverlay {...base} mode="openapi" isArchitect onCommitOpenapi={undefined} />);
    await userEvent.click(screen.getByText("oas-save"));
    // Заглушка отвечает «не сохранено» — мок окна закрывается на отказе.
    await vi.waitFor(() => expect(base.onClose).toHaveBeenCalledOnce());
  });
});
