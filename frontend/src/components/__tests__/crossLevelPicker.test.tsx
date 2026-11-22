// Окно связи между уровнями (редизайн, фаза 9в): каркас окна нового языка, строка
// маршрута, дерево кандидатов значками вместо глифов, строки «Описание» и «Технология»,
// подвал. Выбор цели, направление и тело запроса — в edgeCreate.test.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CrossLevelEdgePicker from "../CrossLevelEdgePicker";
import { edgesApi } from "../../api/nodes";
import { ApiError, DEMO_LIMIT_CODE } from "../../api/client";
import type { Edge, Node } from "../../types";

vi.mock("../../api/nodes", () => ({ edgesApi: { create: vi.fn() } }));

const node = (id: string, name: string, parent_id: string | null = null, role: string | null = null): Node =>
  ({ id, name, parent_id, role, shape: "service", has_children: false }) as Node;

const NODES = [
  node("a", "Заказы", null, "сервис"),
  node("b", "Оплата", null, "система"),
  node("k", "Касса", "b", "кэш"),
];

function open(props: { subtitle?: string; nodes?: Node[] } = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <CrossLevelEdgePicker
      title="Связь внутрь «Оплата»"
      subtitle={props.subtitle}
      sourceId="a"
      sourceLabel="Заказы"
      loadNodes={() => Promise.resolve(props.nodes ?? NODES)}
      scopeKey="root"
      rootParentId={null}
      excludeIds={new Set(["a"])}
      slotPlaceholder="Объект внутри «Оплата»"
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return { onClose, onCreated };
}
const dialog = () => document.querySelector("dialog") as HTMLElement;
const tree = () => dialog().querySelector(".clp-tree") as HTMLElement;
const rowOf = (name: string) => within(tree()).getByText(name).closest(".clp-row") as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe("окно связи между уровнями: вид", () => {
  it("каркас окна: заголовок из пропа, крестик, подзаголовок первой строкой тела", async () => {
    const { onClose } = open({ subtitle: "Выберите объект внутри «Оплата», к которому ведёт связь." });
    await screen.findByText("Оплата");

    expect(screen.getByRole("heading", { name: "Связь внутрь «Оплата»" })).toHaveClass("ds-win-title");
    const lead = screen.getByText("Выберите объект внутри «Оплата», к которому ведёт связь.");
    expect(lead).toHaveClass("ds-win-lead");
    expect(lead.parentElement?.firstElementChild).toBe(lead);
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("маршрут: источник обычным текстом с полным именем в подсказке, кнопка разворота значком", async () => {
    open();
    await screen.findByText("Оплата");

    const src = dialog().querySelector(".clp-route .clp-src") as HTMLElement;
    expect(src).toHaveTextContent("Заказы");
    expect(src).toHaveAttribute("title", "Заказы");
    const swap = screen.getByRole("button", { name: "Поменять направление" });
    expect(swap).toHaveClass("ds-icon-btn");
    expect(swap).toHaveAttribute("title", "Поменять направление");
    expect(swap.querySelector("svg")).not.toBeNull();
    // Пустой слот — тихим текстом пропа.
    expect(screen.getByText("Объект внутри «Оплата»")).toHaveClass("ds-empty");
  });

  it("наконечник у цели: наружу — справа от линии, после разворота — слева", async () => {
    open();
    await screen.findByText("Оплата");
    const conn = dialog().querySelector(".clp-conn") as HTMLElement;
    const order = () => [...conn.children].map((c) => c.getAttribute("class")?.split(" ")[0]);

    expect(order()).toEqual(["clp-conn-line", "clp-conn-head", "ds-icon-btn"]);
    await userEvent.click(screen.getByRole("button", { name: "Поменять направление" }));
    expect(order()).toEqual(["clp-conn-head", "clp-conn-line", "ds-icon-btn"]);
  });

  it("глифов ▸ ● ✓ ⇄ в окне нет: шеврон и галочка — значки", async () => {
    open();
    await screen.findByText("Оплата");
    await userEvent.click(screen.getByText("Оплата"));

    expect(dialog().textContent).not.toMatch(/[▸●✓⇄]/);
    expect(rowOf("Оплата").querySelector(".clp-chev svg")).not.toBeNull();
    expect(rowOf("Оплата").querySelector(".clp-check svg")).not.toBeNull();
  });

  it("строки дерева: роль тихо без скобок, недоступная — тихая с «на этом уровне», у листа нет шеврона", async () => {
    open();
    await screen.findByText("Оплата");

    expect(rowOf("Оплата").textContent).toBe("Оплатасистема");
    expect(within(rowOf("Оплата")).getByText("система")).toHaveClass("clp-quiet");
    expect(rowOf("Заказы")).toHaveClass("is-off");
    expect(within(rowOf("Заказы")).getByText("на этом уровне")).toHaveClass("clp-quiet");
    await userEvent.click(within(rowOf("Оплата")).getByTitle("Развернуть"));
    expect(rowOf("Касса").querySelector(".clp-chev")).toBeNull();
    expect(rowOf("Касса").querySelector(".clp-leaf")).not.toBeNull();
  });

  it("шеврон раскрытой ветки повёрнут и называется «Свернуть»", async () => {
    open();
    await screen.findByText("Оплата");
    const chev = within(rowOf("Оплата")).getByTitle("Развернуть");
    expect(chev).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(chev);

    expect(chev).toHaveAttribute("title", "Свернуть");
    expect(chev).toHaveAttribute("aria-expanded", "true");
    expect(chev).toHaveClass("is-open");
  });

  it("выбранная строка: подложка и галочка справа; слот — значение-кнопка с путём", async () => {
    open();
    await screen.findByText("Оплата");
    await userEvent.click(within(rowOf("Оплата")).getByTitle("Развернуть"));

    await userEvent.click(screen.getByText("Касса"));

    expect(rowOf("Касса")).toHaveClass("is-picked");
    const slot = screen.getByTitle("Снять выбор");
    expect(slot.tagName).toBe("BUTTON");
    expect(slot).toHaveClass("ds-value-btn");
    expect(within(slot).getByText("Оплата")).toHaveClass("clp-slot-path");
    expect(within(slot).getByText("Касса")).toHaveClass("clp-slot-name");
    expect(slot.textContent).toBe("Оплата / Касса");
  });

  it("поиск — поле окна с подсказкой и автофокусом; совпадение подсвечено", async () => {
    open();
    await screen.findByText("Оплата");
    const search = screen.getByPlaceholderText("Поиск по имени");
    expect(search).toHaveClass("ds-input");
    expect(search).toHaveAttribute("data-autofocus");

    await userEvent.type(search, "кас");

    expect(tree().querySelector("mark.clp-mark")).toHaveTextContent("Кас");
  });

  it("«Загрузка», «Нет объектов», «Ничего не найдено» — тихим текстом", async () => {
    open({ nodes: [] });
    expect(screen.getByText("Загрузка")).toHaveClass("ds-empty");
    expect(await screen.findByText("Нет объектов")).toHaveClass("ds-empty");
  });

  it("поля строками «подпись — значение», подписи связаны с полями", async () => {
    open();
    await screen.findByText("Оплата");

    expect(screen.getByLabelText("Описание")).toHaveAttribute("placeholder", "например, запрос или событие");
    expect(screen.getByLabelText("Технология")).toHaveAttribute("placeholder", "например, REST или Kafka");
    expect(screen.getByLabelText("Описание")).toHaveClass("ds-field");
    expect(screen.getByLabelText("Описание").closest(".ds-prop")).not.toBeNull();
  });

  it("подвал: «Создать связь» первой и заперта без цели, «Отмена» за ней", async () => {
    open();
    await screen.findByText("Оплата");

    const foot = dialog().querySelector(".ds-win-foot") as HTMLElement;
    const btns = within(foot).getAllByRole("button");
    expect(btns.map((b) => b.textContent)).toEqual(["Создать связь", "Отмена"]);
    expect(btns[0]).toHaveClass("ds-btn", "ds-btn--primary");
    expect(btns[0]).toBeDisabled();
    expect(btns[1]).toHaveClass("ds-btn");
  });

  it("запись: «Создаём»; отказ — строкой опасности над кнопками", async () => {
    let fail: (e: Error) => void = () => {};
    vi.mocked(edgesApi.create).mockReturnValue(new Promise<Edge>((_, rej) => { fail = rej; }));
    open();
    await userEvent.click(await screen.findByText("Оплата"));

    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    expect(screen.getByRole("button", { name: "Создаём" })).toBeDisabled();
    fail(new ApiError(400, "Связь между этими объектами уже есть"));

    const err = await screen.findByText("Связь между этими объектами уже есть");
    expect(err).toHaveClass("ds-danger", "ds-win-err");
    await waitFor(() => expect(screen.getByRole("button", { name: "Создать связь" })).toBeEnabled());
  });

  it("отказ по пределу демо: «Не получилось добавить связь.» строкой опасности", async () => {
    const EDGES = "Демо-проект поддерживает до 120 связей. Удалите ненужные, чтобы добавить новые.";
    vi.mocked(edgesApi.create).mockRejectedValue(new ApiError(409, EDGES, DEMO_LIMIT_CODE));
    const { onCreated } = open();
    await userEvent.click(await screen.findByText("Оплата"));

    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Не получилось добавить связь. ${EDGES}`);
    expect(alert).toHaveClass("ds-danger", "ds-win-err");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("отказ загрузки объектов — строкой опасности, дерево пустое", async () => {
    const onClose = vi.fn();
    render(
      <CrossLevelEdgePicker title="Связь с объектом вне уровня" sourceId="a" sourceLabel="Заказы"
        loadNodes={() => Promise.reject(new Error("сеть"))} scopeKey="root" rootParentId={null}
        slotPlaceholder="Объект вне уровня" onClose={onClose} onCreated={vi.fn()} />,
    );

    expect(await screen.findByText("Не удалось загрузить объекты")).toHaveClass("ds-danger", "ds-win-err");
    expect(screen.getByText("Нет объектов")).toBeInTheDocument();
  });
});
