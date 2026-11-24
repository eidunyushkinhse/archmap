// Окно «Связь» на странице объекта (редизайн, фаза 9в): те же строки, что в панели связи
// редактора-карты, на каркасе окна нового языка. Здесь вид и поведение строк: концы
// значением-кнопкой с поиском под строкой, разворот значком в строке «Откуда», подсказки
// пустых полей, Escape по шагам, подвал и вопрос об удалении. Тела запросов и закрытие —
// в edgeEditModal.test.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import EdgeEditModal from "../EdgeEditModal";
import { edgesApi, nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

// Поиск конца: заглушка с полем и кнопкой выбора (сам поиск покрыт своими тестами).
vi.mock("../NodeSearchPicker", () => ({
  default: ({ onChange }: { onChange: (id: string, label?: string) => void }) => (
    <>
      <input aria-label="Поиск по имени" />
      <button type="button" onClick={() => onChange("n3", "Payments")}>выбрать Payments</button>
    </>
  ),
}));
vi.mock("../../api/nodes", () => ({
  edgesApi: { get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() },
  nodesApi: { get: vi.fn() },
}));

const EDGE = {
  id: "e1", label: "создать заказ", technology: "REST", channel: null,
  source_id: "n1", target_id: "n2", version: 1, is_synchronous: true,
};
const NODES: Record<string, Partial<Node>> = {
  n1: { id: "n1", name: "Order API", shape: "service", has_children: false },
  n2: { id: "n2", name: "Kafka", shape: "broker", has_children: false },
  n3: { id: "n3", name: "Payments", shape: "database", has_children: false },
};

async function openForm(edge: object = EDGE) {
  vi.mocked(edgesApi.get).mockResolvedValue(edge as never);
  vi.mocked(edgesApi.list).mockResolvedValue([edge] as never);
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<EdgeEditModal edgeId="e1" onClose={onClose} onChanged={onChanged} />);
  await waitFor(
    () => expect(screen.getByText("Готово").closest("dialog")?.open).toBe(true),
    { timeout: 5000 },
  );
  return { onClose, onChanged };
}
const rowOf = (term: string) => screen.getByText(term, { selector: "dt, dt *" }).closest(".ds-prop") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodesApi.get).mockImplementation((id: string) => Promise.resolve(NODES[id] as Node));
});

describe("окно «Связь»: вид", () => {
  it("заголовок «Связь» и крестик; строки «Откуда», «Куда», «Описание», «Технология»", async () => {
    await openForm();

    expect(screen.getByRole("heading", { name: "Связь" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Закрыть" })).toHaveLength(1);
    const terms = [...document.querySelectorAll("dialog .ds-prop > dt")].map((d) => d.textContent);
    expect(terms).toEqual(["Откуда", "Куда", "Описание", "Технология"]);
    expect(screen.getByRole("button", { name: "Откуда: Order API" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Куда: Kafka" })).toBeInTheDocument();
    // Подписи строк связаны со своими полями.
    expect(screen.getByLabelText("Описание")).toHaveValue("создать заказ");
    expect(screen.getByLabelText("Технология")).toHaveValue("REST");
  });

  it("значки формы концов у значений: значение строки и значок — одна кнопка", async () => {
    await openForm();

    await waitFor(() => expect(within(screen.getByRole("button", { name: "Куда: Kafka" })).getByText("Kafka").parentElement?.querySelector(".ip-end-glyph svg")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Откуда: Order API" }).querySelector(".ip-end-glyph svg")).not.toBeNull();
  });

  it("пустые поля называют пустое значение прямо", async () => {
    await openForm({ ...EDGE, label: null, technology: null });

    expect(screen.getByLabelText("Описание")).toHaveAttribute("placeholder", "не указано");
    expect(screen.getByLabelText("Технология")).toHaveAttribute("placeholder", "не указана");
  });

  it("подвал: «Готово» первой, «Удалить связь» за ней; кнопки «Закрыть» в подвале нет", async () => {
    await openForm();

    const foot = document.querySelector("dialog .ds-win-foot") as HTMLElement;
    expect(within(foot).getAllByRole("button").map((b) => b.textContent)).toEqual(["Готово", "Удалить связь"]);
    expect(within(foot).getByRole("button", { name: "Готово" })).toHaveClass("ds-btn", "ds-btn--primary");
    expect(within(foot).getByRole("button", { name: "Удалить связь" })).toHaveClass("ip-delete");
  });

  it("разворот — значок в строке «Откуда»; после него концы поменялись местами", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...EDGE, source_id: "n2", target_id: "n1", version: 2 } as never);
    await openForm();
    const swap = screen.getByRole("button", { name: "Поменять местами «Откуда» и «Куда»" });
    expect(rowOf("Откуда")).toContainElement(swap);
    expect(swap).toHaveAttribute("title", "Поменять местами «Откуда» и «Куда»");
    expect(screen.queryByText("Развернуть направление")).toBeNull();

    await userEvent.click(swap);

    expect(screen.getByRole("button", { name: "Откуда: Kafka" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Куда: Order API" })).toBeInTheDocument();
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
  });

  it("отказ правки — предупреждением под строками", async () => {
    vi.mocked(edgesApi.update).mockRejectedValue(new Error("Сервер не принял правку"));
    await openForm();

    await userEvent.clear(screen.getByLabelText("Технология"));
    await userEvent.tab();

    const warn = await screen.findByText("Сервер не принял правку");
    expect(warn).toHaveClass("ds-warn");
    expect(warn.closest(".ds-win-body")).not.toBeNull();
  });
});

describe("окно «Связь»: конец связи", () => {
  it("щелчок по значению открывает поиск под строкой, выбор пишет конец и закрывает поиск", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...EDGE, target_id: "n3", version: 2 } as never);
    const { onChanged } = await openForm();
    const value = screen.getByRole("button", { name: "Куда: Kafka" });

    await userEvent.click(value);
    expect(value).toHaveAttribute("aria-expanded", "true");
    expect(within(rowOf("Куда")).getByRole("group", { name: "Куда" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "выбрать Payments" }));

    expect(screen.queryByRole("group", { name: "Куда" })).toBeNull();
    expect(screen.getByRole("button", { name: "Куда: Payments" })).toBeInTheDocument();
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    expect(JSON.stringify(vi.mocked(edgesApi.update).mock.calls[0]?.[1])).toBe(
      '{"label":"создать заказ","technology":"REST","channel":null,"source_id":"n1","target_id":"n3","base_version":1}',
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    // Значок нового конца: его форму окно узнаёт по id.
    await waitFor(() => expect(nodesApi.get).toHaveBeenCalledWith("n3"));
  });

  it("Escape в поиске закрывает только поиск: клавиша погашена, окно не закрывается", async () => {
    const { onClose } = await openForm();
    await userEvent.click(screen.getByRole("button", { name: "Откуда: Order API" }));
    const pick = screen.getByRole("button", { name: "выбрать Payments" });

    // false — обработчик погасил клавишу по умолчанию: нативный <dialog> окно не закроет.
    expect(fireEvent.keyDown(pick, { key: "Escape" })).toBe(false);

    expect(screen.queryByRole("group", { name: "Откуда" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("щелчок мимо поиска закрывает его без записи", async () => {
    await openForm();
    const value = screen.getByRole("button", { name: "Откуда: Order API" });
    await userEvent.click(value);

    await userEvent.click(document.querySelector("dialog .ds-backdrop") as HTMLElement);

    expect(screen.queryByRole("group", { name: "Откуда" })).toBeNull();
    expect(edgesApi.update).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(value);
  });

  it("Escape в поиске возвращает фокус на значение строки", async () => {
    await openForm();
    const value = screen.getByRole("button", { name: "Куда: Kafka" });
    await userEvent.click(value);
    const search = screen.getByRole("textbox", { name: "Поиск по имени" });
    search.focus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("group", { name: "Куда" })).toBeNull();
    expect(document.activeElement).toBe(value);
  });

  it("выбор в поиске возвращает фокус на значение строки", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...EDGE, target_id: "n3", version: 2 } as never);
    await openForm();
    const value = screen.getByRole("button", { name: "Куда: Kafka" });
    await userEvent.click(value);

    await userEvent.click(screen.getByRole("button", { name: "выбрать Payments" }));

    expect(document.activeElement).toBe(value);
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
  });

  it("Enter в поиске принадлежит поиску: окно не отправляется и не закрывается", async () => {
    const { onClose, onChanged } = await openForm();
    await userEvent.click(screen.getByRole("button", { name: "Откуда: Order API" }));
    const search = screen.getByRole("textbox", { name: "Поиск по имени" });

    await userEvent.type(search, "Pay{Enter}");

    expect(screen.getByRole("group", { name: "Откуда" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveProperty("open", true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });
});

describe("окно «Связь»: Escape в поле", () => {
  it("в поле с правкой возвращает записанное, клавиша погашена, правка не уходит", async () => {
    const { onClose } = await openForm();
    const tech = screen.getByLabelText("Технология");
    await userEvent.clear(tech);
    await userEvent.type(tech, "gRPC");

    expect(fireEvent.keyDown(tech, { key: "Escape" })).toBe(false);

    expect(tech).toHaveValue("REST");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("в поле без правки клавишу не трогает: её получает окно", async () => {
    await openForm();

    expect(fireEvent.keyDown(screen.getByLabelText("Описание"), { key: "Escape" })).toBe(true);
  });
});

describe("окно «Связь»: удаление и загрузка", () => {
  it("вопрос в подвале: текст абзацем, «Удалить» опасной кнопкой, «Отмена»", async () => {
    await openForm();

    await userEvent.click(screen.getByRole("button", { name: "Удалить связь" }));

    const foot = document.querySelector("dialog .ds-win-foot") as HTMLElement;
    expect(within(foot).getByText(/^Удалить связь\? Она исчезнет со схемы/)).toHaveClass("ew-ask");
    expect(within(foot).getAllByRole("button").map((b) => b.textContent)).toEqual(["Удалить", "Отмена"]);
    expect(within(foot).getByRole("button", { name: "Удалить" })).toHaveClass("ds-btn", "ds-btn--danger");
    expect(within(foot).getByRole("button", { name: "Отмена" })).toHaveClass("ds-btn");
  });

  it("запись удаления: «Удаляем» на запертой кнопке; отказ — строкой опасности над кнопками", async () => {
    let fail: (e: Error) => void = () => {};
    vi.mocked(edgesApi.delete).mockReturnValue(new Promise<void>((_, rej) => { fail = rej; }) as never);
    await openForm();
    await userEvent.click(screen.getByRole("button", { name: "Удалить связь" }));

    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(screen.getByRole("button", { name: "Удаляем" })).toBeDisabled();
    fail(new Error("Связь занята"));

    const err = await screen.findByText("Связь занята");
    expect(err).toHaveClass("ds-danger", "ds-win-err");
    expect(screen.getByRole("button", { name: "Удалить" })).toBeEnabled();
  });

  it("пока связь грузится: шапка «Связь» и «Загрузка»", async () => {
    vi.mocked(edgesApi.get).mockReturnValue(new Promise(() => {}) as never);
    render(<EdgeEditModal edgeId="e1" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.getByText("Загрузка")).toHaveClass("ds-empty");
    expect(screen.getByText("Связь").tagName).toBe("H2");
  });

  it("отказ загрузки: текст опасности в теле, «Закрыть» в подвале", async () => {
    vi.mocked(edgesApi.get).mockRejectedValue(new Error("нет связи"));
    render(<EdgeEditModal edgeId="e1" onClose={vi.fn()} onChanged={vi.fn()} />);

    const text = await screen.findByText("Не удалось загрузить данные связи");
    expect(text).toHaveClass("ds-danger");
    expect(text.closest(".ds-win-body")).not.toBeNull();
    const foot = document.querySelector("dialog .ds-win-foot") as HTMLElement;
    expect(within(foot).getByRole("button", { name: "Закрыть" })).toHaveClass("ds-btn");
  });
});
