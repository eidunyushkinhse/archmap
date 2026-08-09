// Рендер-тесты DocOverlay: тонкий shell вокруг FlowchartDocs (Логика) и
// OpenApiDoc (OpenAPI). Проверяем выбор режима, тег формата в шапке (включая
// версию OAS из колбэка onVersion), баннер notice, переключение «Показать код»
// для наблюдателя, футер-подсказку по роли/режиму и закрытие. Тяжёлые редакторы
// (FlowchartDocs/OpenApiDoc) замоканы — тестируем оркестрацию оболочки.
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

// Редактор схем логики: отражает полученные пропы (showCode/autoCreate/initialDocId).
vi.mock("../inspector/FlowchartDocs", () => ({
  default: ({
    showCode,
    autoCreate,
    initialDocId,
  }: {
    showCode: boolean;
    autoCreate?: boolean;
    initialDocId?: string;
  }) => (
    <div data-testid="flowchart-docs">
      <span data-testid="flow-showcode">{String(showCode)}</span>
      <span data-testid="flow-autocreate">{String(Boolean(autoCreate))}</span>
      <span data-testid="flow-initial">{initialDocId ?? "none"}</span>
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

  it("режим «Логика»: заголовок, тег mermaid, редактор схем, футер про «Сохранить»", () => {
    render(<DocOverlay {...base} mode="flowchart" isArchitect />);
    expect(screen.getByText("Сервис оплаты")).toBeInTheDocument();
    expect(screen.getByText(/Логика/)).toBeInTheDocument();
    expect(screen.getByText("mermaid · flowchart")).toBeInTheDocument();
    expect(screen.getByTestId("flowchart-docs")).toBeInTheDocument();
    expect(screen.getByText(/Сохраняет кнопка/)).toBeInTheDocument();
  });

  it("прокидывает autoCreate и initialDocId в FlowchartDocs", () => {
    render(
      <DocOverlay {...base} mode="flowchart" isArchitect autoCreate initialDocId="d7" />,
    );
    expect(screen.getByTestId("flow-autocreate")).toHaveTextContent("true");
    expect(screen.getByTestId("flow-initial")).toHaveTextContent("d7");
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

  it("наблюдателю: кнопка «Показать код» переключает showCode редактора, футер про недоступность", async () => {
    render(<DocOverlay {...base} mode="flowchart" isArchitect={false} />);
    expect(screen.getByText("Наблюдателю редактирование недоступно")).toBeInTheDocument();
    expect(screen.getByTestId("flow-showcode")).toHaveTextContent("false");
    await userEvent.click(screen.getByRole("button", { name: "Показать код" }));
    expect(screen.getByTestId("flow-showcode")).toHaveTextContent("true");
    await userEvent.click(screen.getByRole("button", { name: "Скрыть код" }));
    expect(screen.getByTestId("flow-showcode")).toHaveTextContent("false");
  });

  it("архитектору кнопка «Показать код» недоступна (код всегда виден)", () => {
    render(<DocOverlay {...base} mode="flowchart" isArchitect />);
    expect(screen.queryByRole("button", { name: "Показать код" })).not.toBeInTheDocument();
  });

  it("крестик закрывает оверлей (onClose)", async () => {
    render(<DocOverlay {...base} mode="flowchart" isArchitect />);
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(base.onClose).toHaveBeenCalledOnce();
  });
});
