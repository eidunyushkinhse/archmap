// Модалка импорта процесса: превью → сопоставление → применение.
//
// Ключевые обещания, которые здесь и закреплены: превью ничего не пишет; пользователь
// НЕ обязан сопоставить каждого участника (несопоставленные заводятся непривязанными,
// и об этом сказано до применения); непонятые строки видны, а не выпадают молча.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessImportModal from "../processes/ProcessImportModal";
import { processesApi } from "../../api/processes";
import type { ProcessImportPreview, ProcessImportResult } from "../../types";

vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../api/processes", () => ({
  processesApi: { importPreview: vi.fn(), importProcess: vi.fn() },
}));

const PREVIEW: ProcessImportPreview = {
  name: "Импортированный процесс",
  participants: [
    { alias: "P1", name: "Покупатель", node_id: "n1", candidates: [{ id: "n1", name: "Покупатель", parent_name: null }] },
    { alias: "P2", name: "Биллинг", node_id: null, candidates: [] },
  ],
  message_count: 2,
  fragment_count: 1,
  unsupported: ["autonumber"],
  doc_refs: 0,
};

const RESULT: ProcessImportResult = {
  process_id: "p9", participants: 2, unbound: 1, messages: 2,
  attached: 1, dangling: 1, self_messages: 0, fragments: 1, unsupported: ["autonumber"],
  doc_linked: 0, doc_unresolved: 0,
};

function renderModal(onImported = vi.fn()) {
  render(<ProcessImportModal onClose={vi.fn()} onImported={onImported} />);
  return { onImported };
}

const textarea = () =>
  screen.getByPlaceholderText(/sequenceDiagram/) as HTMLTextAreaElement;

async function toPreview() {
  await userEvent.type(textarea(), "sequenceDiagram");
  await userEvent.click(screen.getByRole("button", { name: "Разобрать" }));
  await screen.findByText("Участники: с чем сопоставились");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.importPreview).mockResolvedValue(PREVIEW);
  vi.mocked(processesApi.importProcess).mockResolvedValue(RESULT);
});

describe("импорт процесса: превью", () => {
  it("пустой текст разбирать нечего", () => {
    renderModal();
    expect(screen.getByRole("button", { name: "Разобрать" })).toBeDisabled();
  });

  it("разбор ничего не создаёт — только показывает", async () => {
    renderModal();

    await toPreview();

    expect(processesApi.importProcess).not.toHaveBeenCalled();
  });

  it("единственное совпадение подставляется, несопоставленный остаётся пустым", async () => {
    renderModal();

    await toPreview();

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(selects[0].value).toBe("n1");
    expect(selects[1].value).toBe(""); // «без узла схемы» — кандидатов не нашлось
  });

  it("предупреждает, сколько участников останется без узла", async () => {
    renderModal();

    await toPreview();

    expect(screen.getByText(/без узла останется участников: 1/)).toBeTruthy();
  });

  it("непонятые строки показаны, а не выпали молча", async () => {
    renderModal();

    await toPreview();

    expect(screen.getAllByText("autonumber").length).toBeGreaterThan(0);
  });

  it("правка текста сбрасывает превью: оно про старый текст", async () => {
    renderModal();
    await toPreview();

    await userEvent.type(textarea(), "x");

    expect(screen.queryByText("Участники: с чем сопоставились")).toBeNull();
  });
});

describe("импорт процесса: применение", () => {
  it("отдаёт сопоставление алиасами, несопоставленный — null", async () => {
    renderModal();
    await toPreview();

    await userEvent.click(screen.getByRole("button", { name: "Импортировать" }));

    await waitFor(() =>
      expect(processesApi.importProcess).toHaveBeenCalledWith(
        expect.objectContaining({ mapping: { P1: "n1", P2: null } }),
      ),
    );
  });

  it("снятое сопоставление уходит как null", async () => {
    renderModal();
    await toPreview();
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];

    await userEvent.selectOptions(selects[0], "");
    await userEvent.click(screen.getByRole("button", { name: "Импортировать" }));

    await waitFor(() =>
      expect(processesApi.importProcess).toHaveBeenCalledWith(
        expect.objectContaining({ mapping: { P1: null, P2: null } }),
      ),
    );
  });

  it("итог показывает и подхваченное, и оставшееся сломанным", async () => {
    renderModal();
    await toPreview();

    await userEvent.click(screen.getByRole("button", { name: "Импортировать" }));

    await screen.findByText("Процесс создан");
    expect(screen.getByText(/без узла схемы: 1/)).toBeTruthy();
    expect(screen.getByText(/без связи: 1/)).toBeTruthy();
  });

  it("внутренние операции названы отдельно и не выданы за поломку", async () => {
    // Находка приёмки: самосообщение уходило в «без связи». Теперь у него своя графа,
    // и она не появляется, когда внутренних операций нет (проверка ниже, в RESULT — 0).
    vi.mocked(processesApi.importProcess).mockResolvedValue({
      ...RESULT, messages: 3, attached: 1, dangling: 1, self_messages: 1,
    });
    renderModal();
    await toPreview();

    await userEvent.click(screen.getByRole("button", { name: "Импортировать" }));

    await screen.findByText("Процесс создан");
    expect(screen.getByText(/внутренних операций: 1/)).toBeTruthy();
  });

  it("без внутренних операций графы для них нет", async () => {
    renderModal();
    await toPreview();

    await userEvent.click(screen.getByRole("button", { name: "Импортировать" }));

    await screen.findByText("Процесс создан");
    expect(screen.queryByText(/внутренних операций/)).toBeNull();
  });

  it("«Открыть процесс» отдаёт id созданного", async () => {
    const { onImported } = renderModal();
    await toPreview();
    await userEvent.click(screen.getByRole("button", { name: "Импортировать" }));
    await screen.findByText("Процесс создан");

    await userEvent.click(screen.getByRole("button", { name: "Открыть процесс" }));

    expect(onImported).toHaveBeenCalledWith("p9");
  });
});
