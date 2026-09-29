// Окно спеки (OpenApiPane) — тот же порядок, что у схемы логики (вьюер v2):
// просмотр Swagger без кода → «Изменить ▾» → «Вручную» (YAML с превью, «Отмена» /
// «Сохранить») или «Через ИИ-агента» (шаги и панель пакета в том же окне).
// Редактор настоящий (OpenApiDoc), замоканы Swagger UI, панель пакета и сеть.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenApiPane from "../inspector/OpenApiPane";
import { nodesApi } from "../../api/nodes";
import { docsImportApi } from "../../api/docsImport";
import type { Node } from "../../types";

vi.mock("../OpenApiViewer", () => ({
  default: ({ spec }: { spec: { info?: { title?: string } } }) => (
    <div data-testid="swagger">{spec.info?.title ?? "без заголовка"}</div>
  ),
}));
vi.mock("../../api/nodes", () => ({ nodesApi: { get: vi.fn() } }));
vi.mock("../../api/docsImport", () => ({ docsImportApi: { prompt: vi.fn() } }));
vi.mock("../docsImport/SpecAgentPanel", () => ({
  default: ({ onApplied }: { onApplied: () => void }) => (
    <div data-testid="spec-panel"><button onClick={onApplied}>применить-пакет</button></div>
  ),
}));

const spec = (title: string) => `openapi: 3.0.3\ninfo:\n  title: ${title}\n  version: 1.0.0\npaths: {}\n`;

const props = {
  nodeId: "n1",
  nodeName: "Каталог",
  onClose: vi.fn(),
};

const field = () => document.querySelector("textarea.doc-edta") as HTMLTextAreaElement | null;

async function открытьВручную() {
  await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
}

describe("OpenApiPane · просмотр", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Swagger без кода; тег с версией OAS; архитектору «Изменить» с двумя способами", async () => {
    render(<OpenApiPane {...props} openapi={spec("Витрина")} isArchitect onCommitOpenapi={vi.fn()} />);
    expect(screen.getByTestId("swagger")).toHaveTextContent("Витрина");
    expect(field()).toBeNull();
    expect(screen.getByText("OAS 3.0 · YAML")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Вручную", "Через ИИ-агента"]);
  });

  it("наблюдателю правки нет, «Показать код» даёт код только для чтения", async () => {
    render(<OpenApiPane {...props} openapi={spec("Витрина")} isArchitect={false} onCommitOpenapi={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Показать код" }));
    expect(field()).not.toBeNull();
    expect(field()).toHaveAttribute("readonly");
  });

  it("конфликт от страницы — плашкой в шапке", () => {
    render(<OpenApiPane {...props} openapi={spec("Витрина")} isArchitect notice="Спека изменена в другой сессии" onCommitOpenapi={vi.fn()} />);
    expect(screen.getByText("Спека изменена в другой сессии")).toBeInTheDocument();
  });
});

describe("OpenApiPane · «Вручную»", () => {
  beforeEach(() => vi.clearAllMocks());

  it("«Сохранить» пишет черновик и возвращает к просмотру уже новой спеки", async () => {
    const onCommitOpenapi = vi.fn(() => Promise.resolve(true));
    render(<OpenApiPane {...props} openapi={spec("Старая")} isArchitect onCommitOpenapi={onCommitOpenapi} />);
    await открытьВручную();
    fireEvent.change(field()!, { target: { value: spec("Новая") } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onCommitOpenapi).toHaveBeenCalledWith(spec("Новая"));
    await waitFor(() => expect(screen.getByTestId("swagger")).toHaveTextContent("Новая"));
    expect(field()).toBeNull();
  });

  it("невалидная спека сохраняется черновиком, превью ждёт исправления", async () => {
    const onCommitOpenapi = vi.fn(() => Promise.resolve(true));
    render(<OpenApiPane {...props} openapi={spec("Старая")} isArchitect onCommitOpenapi={onCommitOpenapi} />);
    await открытьВручную();
    expect(screen.getByText(/Невалидная спека сохраняется как черновик/)).toBeInTheDocument();
    fireEvent.change(field()!, { target: { value: "openapi: [\n  broken" } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onCommitOpenapi).toHaveBeenCalledWith("openapi: [\n  broken");
    expect(await screen.findByText("Спека не распарсилась — превью недоступно")).toBeInTheDocument();
  });

  it("«Отмена» отбрасывает черновик", async () => {
    const onCommitOpenapi = vi.fn(() => Promise.resolve(true));
    render(<OpenApiPane {...props} openapi={spec("Старая")} isArchitect onCommitOpenapi={onCommitOpenapi} />);
    await открытьВручную();
    fireEvent.change(field()!, { target: { value: spec("Новая") } });
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onCommitOpenapi).not.toHaveBeenCalled();
    expect(screen.getByTestId("swagger")).toHaveTextContent("Старая");
  });

  it("конфликт при записи: окно в просмотре, черновик не выдаётся за сохранённое", async () => {
    const onCommitOpenapi = vi.fn(() => Promise.resolve(false));
    render(<OpenApiPane {...props} openapi={spec("Старая")} isArchitect onCommitOpenapi={onCommitOpenapi} />);
    await открытьВручную();
    fireEvent.change(field()!, { target: { value: spec("Новая") } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(field()).toBeNull());
    expect(screen.getByTestId("swagger")).toHaveTextContent("Старая");
  });

  it("«+ Добавить → Вручную»: сразу редактор; «Отмена» без спеки закрывает окно", async () => {
    const onClose = vi.fn();
    render(<OpenApiPane {...props} onClose={onClose} openapi="" isArchitect initialStage="manual" onCommitOpenapi={vi.fn()} />);
    expect(field()).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("OpenApiPane · «Через ИИ-агента»", () => {
  beforeEach(() => vi.clearAllMocks());

  it("шаги с промптом спеки, после «Применить» окно перечитывает спеку", async () => {
    vi.mocked(docsImportApi.prompt).mockResolvedValue({ prompt: "промпт" });
    vi.mocked(nodesApi.get).mockResolvedValue({ id: "n1", openapi_spec: spec("От агента") } as Node);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
    const onApplied = vi.fn();
    render(<OpenApiPane {...props} openapi="" isArchitect initialStage="agent" onApplied={onApplied} onCommitOpenapi={vi.fn()} />);

    expect(screen.getByText(/Запустите агента с этим промптом в репозитории сервиса «Каталог»/)).toBeInTheDocument();
    // Спеки ещё нет — возвращаться не к чему.
    expect(screen.queryByRole("button", { name: "← К спецификации" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await waitFor(() => expect(docsImportApi.prompt).toHaveBeenCalled());
    expect(vi.mocked(docsImportApi.prompt).mock.calls[0][0]).toMatchObject({ nodeId: "n1", include: "api" });

    await userEvent.click(screen.getByText("применить-пакет"));
    await waitFor(() => expect(screen.getByTestId("swagger")).toHaveTextContent("От агента"));
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it("со спекой — «← К спецификации» возвращает к просмотру", async () => {
    render(<OpenApiPane {...props} openapi={spec("Витрина")} isArchitect onCommitOpenapi={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    expect(screen.getByTestId("spec-panel")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "← К спецификации" }));
    expect(screen.getByTestId("swagger")).toHaveTextContent("Витрина");
  });
});
