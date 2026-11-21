// «Заменить из Mermaid» (редизайн, фаза 3б): пункт в меню строки процесса, окно импорта в
// режиме замены, потеря привязок к схемам логики, тост с номером версии, сброс холста.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessImportModal from "../processes/ProcessImportModal";
import ProcessWorkspace from "../processes/ProcessWorkspace";
import ProcessRail from "../processes/ProcessRail";
import { processesApi } from "../../api/processes";
import type { ProcessDetail, ProcessImportPreview, ProcessListItem, ProcessReplaceResult } from "../../types";

vi.mock("../../api/processes", () => ({
  processesApi: {
    list: vi.fn(), get: vi.fn(), remove: vi.fn(), duplicate: vi.fn(), create: vi.fn(),
    importPreview: vi.fn(), importProcess: vi.fn(), replaceProcess: vi.fn(),
  },
}));
// Холст подменён: считаем его монтирования (замена обязана сбросить его историю).
const canvas = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("../processes/ProcessCanvas", async () => {
  const { useEffect } = await import("react");
  return {
    default: function CanvasStub({ name }: { name: string }) {
      useEffect(() => { canvas.mounts += 1; }, []);
      return <div data-testid="canvas">{name}</div>;
    },
  };
});

const WAIT = { timeout: 3000 };
const SEQ = "sequenceDiagram\n    P1->>P2: шаг";

type Step = ProcessImportPreview["steps"][number];
const step = (order: number, doc: Step["doc_status"]): Step => ({
  order, from_name: "Покупатель", to_name: "Веб-витрина", caption: null, status: "attached",
  doc_address: doc ? "Ярмарка / Веб-витрина / Корзина" : null, doc_status: doc,
});
const preview = (docs: Step["doc_status"][]): ProcessImportPreview => ({
  name: "Импортированный процесс",
  participants: [
    { alias: "P1", name: "Покупатель", node_id: "n1", candidates: [{ id: "n1", name: "Покупатель", parent_name: null }] },
    { alias: "P2", name: "Веб-витрина", node_id: "n2", candidates: [{ id: "n2", name: "Веб-витрина", parent_name: null }] },
  ],
  message_count: docs.length, fragment_count: 0, unsupported: [], doc_refs: 0,
  steps: docs.map((d, i) => step(i, d)), attached: docs.length, dangling: 0, self_messages: 0,
});
// У процесса сейчас K = 3 шага с привязкой к схеме логики.
const DETAIL = {
  id: "p1", name: "Оплата заказа",
  messages: [{ id: "m1", doc_id: "d1" }, { id: "m2", doc_id: "d2" }, { id: "m3", doc_id: "d3" }, { id: "m4", doc_id: null }],
} as unknown as ProcessDetail;
const RESULT: ProcessReplaceResult = {
  process_id: "p1", participants: 2, unbound: 0, messages: 3, attached: 3, dangling: 0,
  self_messages: 0, fragments: 0, unsupported: [], doc_linked: 1, doc_unresolved: 0,
  version_number: 7, version_created: true,
};
const ITEM = (id: string, name: string) =>
  ({ id, name, scope_node_id: null, scope_name: null, message_count: 3, statuses: [] }) as ProcessListItem;

const textarea = () => screen.getByRole("textbox", { name: "Новый текст процесса" }) as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  canvas.mounts = 0;
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.replaceProcess).mockResolvedValue(RESULT);
});

describe("окно замены процесса", () => {
  function renderReplace() {
    const onReplaced = vi.fn();
    render(
      <ProcessImportModal replace={{ id: "p1", name: "Оплата заказа" }} onClose={vi.fn()} onReplaced={onReplaced} />,
    );
    return { onReplaced };
  }

  it("заголовок, текущее название, пустой текст, один файл, кнопка «Заменить»", async () => {
    renderReplace();
    expect(screen.getByText("Заменить процесс")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Название процесса" }) as HTMLInputElement).value).toBe("Оплата заказа");
    expect(textarea().value).toBe("");
    expect((document.querySelector("dialog input[type=file]") as HTMLInputElement).multiple).toBe(false);
    expect(screen.getByRole("button", { name: "Заменить" })).toBeDisabled();
    await waitFor(() => expect(processesApi.get).toHaveBeenCalledWith("p1"));
  });

  it("привязки теряются: строка «останется M из K»; замена отдаёт итог", async () => {
    vi.mocked(processesApi.importPreview).mockResolvedValue(preview(["linked", null, null]));
    const { onReplaced } = renderReplace();
    await userEvent.click(textarea());
    await userEvent.paste(SEQ);

    expect(await screen.findByText("Привязок к схемам логики останется 1 из 3", undefined, WAIT)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Заменить" });
    await waitFor(() => expect(btn).not.toBeDisabled(), WAIT);
    await userEvent.click(btn);

    await waitFor(() => expect(processesApi.replaceProcess).toHaveBeenCalledWith("p1", {
      text: SEQ, name: "Оплата заказа", mapping: { P1: "n1", P2: "n2" },
    }));
    expect(onReplaced).toHaveBeenCalledWith(RESULT, "Оплата заказа");
    expect(processesApi.importProcess).not.toHaveBeenCalled();
  });

  it("все привязки разрешаются — строки о потере нет", async () => {
    vi.mocked(processesApi.importPreview).mockResolvedValue(preview(["linked", "linked", "linked"]));
    renderReplace();
    await userEvent.click(textarea());
    await userEvent.paste(SEQ);

    await waitFor(() => expect(screen.getByRole("button", { name: "Заменить" })).not.toBeDisabled(), WAIT);
    expect(screen.queryByText(/Привязок к схемам логики останется/)).toBeNull();
  });
});

describe("меню строки процесса", () => {
  function renderRail(isArchitect: boolean) {
    const onReplace = vi.fn();
    render(
      <ProcessRail
        processes={[ITEM("p1", "Оплата заказа")]}
        selectedId="p1"
        onSelect={vi.fn()}
        onImport={vi.fn()}
        creating={false}
        onStartCreate={vi.fn()}
        onCreate={vi.fn()}
        onCancelCreate={vi.fn()}
        expanded
        onToggle={vi.fn()}
        isArchitect={isArchitect}
        onDuplicate={vi.fn()}
        onReplace={onReplace}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    return { onReplace };
  }

  it("у редактора «Заменить из Mermaid» между «Дублировать» и «Удалить»", async () => {
    const { onReplace } = renderRail(true);
    await userEvent.click(screen.getByTitle("Действия"));
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(items).toEqual(["Дублировать", "Заменить из Mermaid", "Удалить"]);

    await userEvent.click(screen.getByRole("menuitem", { name: "Заменить из Mermaid" }));
    expect(onReplace).toHaveBeenCalledWith("p1");
  });

  it("читатель пункта «Заменить из Mermaid» не видит", () => {
    renderRail(false);
    expect(screen.queryByTitle("Действия")).toBeNull();
    expect(screen.queryByText("Заменить из Mermaid")).toBeNull();
  });
});

describe("замена в воркспейсе", () => {
  it("после замены: окно закрыто, имя в рейле новое, холст с нуля, тост с номером версии", async () => {
    vi.mocked(processesApi.list)
      .mockResolvedValueOnce([ITEM("p1", "Оплата заказа")])
      .mockResolvedValue([ITEM("p1", "Оплата заказа v2")]);
    vi.mocked(processesApi.importPreview).mockResolvedValue(preview(["linked", null, null]));
    render(<ProcessWorkspace isArchitect />);
    await screen.findByTestId("canvas");
    expect(canvas.mounts).toBe(1);

    await userEvent.click(screen.getByTitle("Действия"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Заменить из Mermaid" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Название процесса" });
    await userEvent.clear(name);
    await userEvent.type(name, "Оплата заказа v2");
    await userEvent.click(within(dialog).getByRole("textbox", { name: "Новый текст процесса" }));
    await userEvent.paste(SEQ);
    const btn = within(dialog).getByRole("button", { name: "Заменить" });
    await waitFor(() => expect(btn).not.toBeDisabled(), WAIT);
    await userEvent.click(btn);

    const toast = await screen.findByRole("status");
    expect(toast.textContent).toBe("Процесс заменён. Прежний вариант сохранён в версии 7");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByText("Оплата заказа v2").length).toBeGreaterThan(0);
    // Шаги и участники получили новые id: холст перемонтирован, история отмены сброшена.
    await waitFor(() => expect(canvas.mounts).toBe(2));
  });

  it("без номера версии тост короче", async () => {
    vi.mocked(processesApi.list).mockResolvedValue([ITEM("p1", "Оплата заказа")]);
    vi.mocked(processesApi.importPreview).mockResolvedValue(preview(["linked"]));
    vi.mocked(processesApi.replaceProcess).mockResolvedValue({ ...RESULT, version_number: null });
    render(<ProcessWorkspace isArchitect />);
    await screen.findByTestId("canvas");

    await userEvent.click(screen.getByTitle("Действия"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Заменить из Mermaid" }));
    await userEvent.click(await screen.findByRole("textbox", { name: "Новый текст процесса" }));
    await userEvent.paste(SEQ);
    const btn = screen.getByRole("button", { name: "Заменить" });
    await waitFor(() => expect(btn).not.toBeDisabled(), WAIT);
    await userEvent.click(btn);

    expect((await screen.findByRole("status")).textContent?.trim()).toBe("Процесс заменён.");
  });
});
