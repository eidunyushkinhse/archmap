// Рендер-тесты DocOverlay: тонкий shell вокруг FlowchartDocs (Логика — окно одной
// схемы со своей шапкой) и OpenApiDoc (OpenAPI). Проверяем выбор режима, проброс
// пропсов окна схемы, тег формата в шапке спеки (включая версию OAS из колбэка
// onVersion), баннер notice, переключение «Показать код» для наблюдателя,
// футер-подсказку по роли и закрытие. Тяжёлые редакторы замоканы — тестируем
// оркестрацию оболочки. Стадии окна схемы — FlowchartDocs.test.
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
// Редактор OpenAPI: показывает initial/showCode и умеет сообщить версию OAS.
vi.mock("../inspector/OpenApiDoc", () => ({
  default: ({
    initial,
    showCode,
    onVersion,
  }: {
    initial: string;
    showCode: boolean;
    onVersion: (v: string) => void;
  }) => (
    <div data-testid="openapi-doc">
      <span data-testid="oas-showcode">{String(showCode)}</span>
      <span data-testid="oas-initial">{initial}</span>
      <button onClick={() => onVersion("3.0.3")}>set-version</button>
    </div>
  ),
}));

const base = {
  nodeId: "n1",
  nodeName: "Сервис оплаты",
  openapi: "openapi: 3.0.3",
  onCommitOpenapi: vi.fn(),
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

  it("режим OpenAPI: тег без версии, редактор получает исходную спеку, футер про черновик", () => {
    render(<DocOverlay {...base} mode="openapi" isArchitect />);
    expect(screen.getByText("· OpenAPI")).toBeInTheDocument();
    expect(screen.getByText("OpenAPI · YAML")).toBeInTheDocument();
    expect(screen.getByTestId("oas-initial")).toHaveTextContent("openapi: 3.0.3");
    expect(screen.getByText(/черновик/)).toBeInTheDocument();
  });

  it("версия OAS из onVersion попадает в тег (3.0.3 → «OAS 3.0 · YAML»)", async () => {
    render(<DocOverlay {...base} mode="openapi" isArchitect />);
    await userEvent.click(screen.getByRole("button", { name: "set-version" }));
    expect(screen.getByText("OAS 3.0 · YAML")).toBeInTheDocument();
  });

  it("баннер notice показывается в шапке", () => {
    render(
      <DocOverlay {...base} mode="openapi" isArchitect notice="Конфликт версий" />,
    );
    expect(screen.getByText("Конфликт версий")).toBeInTheDocument();
  });

  it("наблюдателю спеки: «Показать код» переключает showCode редактора, футер про недоступность", async () => {
    render(<DocOverlay {...base} mode="openapi" isArchitect={false} />);
    expect(screen.getByText("Наблюдателю редактирование недоступно")).toBeInTheDocument();
    expect(screen.getByTestId("oas-showcode")).toHaveTextContent("false");
    await userEvent.click(screen.getByRole("button", { name: "Показать код" }));
    expect(screen.getByTestId("oas-showcode")).toHaveTextContent("true");
    await userEvent.click(screen.getByRole("button", { name: "Скрыть код" }));
    expect(screen.getByTestId("oas-showcode")).toHaveTextContent("false");
  });

  it("архитектору спеки кнопка «Показать код» недоступна (код всегда виден)", () => {
    render(<DocOverlay {...base} mode="openapi" isArchitect />);
    expect(screen.queryByRole("button", { name: "Показать код" })).not.toBeInTheDocument();
  });

  it("крестик спеки закрывает оверлей (onClose)", async () => {
    render(<DocOverlay {...base} mode="openapi" isArchitect />);
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(base.onClose).toHaveBeenCalledOnce();
  });
});
