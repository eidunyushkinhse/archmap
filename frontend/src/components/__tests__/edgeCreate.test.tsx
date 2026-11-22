// Создание связи из поповеров жеста: прямой (EdgeQuickCreate — концы заданы жестом) и
// межуровневой (CrossLevelEdgePicker — дальний конец выбирают в дереве).
//
// Страховка перед выносом общей машинерии в useEdgeCreate (аудит F-15): что уходит в
// запрос, куда смотрит направление и что видно при отказе. Предел демо-стенда
// проверяет demoEditLimits.test.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EdgeQuickCreate from "../EdgeQuickCreate";
import CrossLevelEdgePicker from "../CrossLevelEdgePicker";
import { edgesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { Edge, Node } from "../../types";

vi.mock("../../api/nodes", () => ({ edgesApi: { create: vi.fn() } }));
// Modal настоящий (test-setup открывает <dialog> атрибутом open): подтверждение по Enter
// идёт через него.

const created = { id: "e1", source_id: "a", target_id: "b", version: 1 } as Edge;

const node = (id: string, name: string, parent_id: string | null = null): Node =>
  ({ id, name, parent_id, role: null, shape: "service", has_children: false }) as Node;

describe("EdgeQuickCreate", () => {
  beforeEach(() => vi.clearAllMocks());

  function open() {
    const onCreated = vi.fn();
    render(
      <EdgeQuickCreate sourceId="a" targetId="b" sourceLabel="Заказы" targetLabel="Оплата"
        onClose={vi.fn()} onCreated={onCreated} />,
    );
    return onCreated;
  }

  it("создаёт связь между концами жеста с заполненными полями", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await userEvent.type(screen.getByPlaceholderText("например, запрос или событие"), "оплата заказа");
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    // Пустая технология уходит null, а не пустой строкой.
    expect(edgesApi.create).toHaveBeenCalledWith({
      source_id: "a", target_id: "b", label: "оплата заказа", technology: null,
    });
  });

  it("отказ сервера показан текстом, кнопка снова доступна", async () => {
    vi.mocked(edgesApi.create).mockRejectedValue(new ApiError(400, "Связь между этими объектами уже есть"));
    const onCreated = open();
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    expect(await screen.findByText("Связь между этими объектами уже есть")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать связь" })).toBeEnabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("Enter в поле подтверждает, как «Создать связь»", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await userEvent.type(screen.getByPlaceholderText("например, REST или Kafka"), "gRPC{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(edgesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      source_id: "a", target_id: "b", technology: "gRPC",
    }));
  });

  // Страховка фазы 9б редизайна: тело запроса байт в байт, с порядком ключей.
  it("оба поля заполнены: тело запроса строкой JSON", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await userEvent.type(screen.getByPlaceholderText("например, запрос или событие"), "оплата заказа");
    await userEvent.type(screen.getByPlaceholderText("например, REST или Kafka"), "gRPC");
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(JSON.stringify(vi.mocked(edgesApi.create).mock.calls[0][0]))
      .toBe('{"source_id":"a","target_id":"b","label":"оплата заказа","technology":"gRPC"}');
  });

  it("«Отмена» закрывает окно без запроса", async () => {
    const onClose = vi.fn();
    render(
      <EdgeQuickCreate sourceId="a" targetId="b" sourceLabel="Заказы" targetLabel="Оплата"
        onClose={onClose} onCreated={vi.fn()} />,
    );
    await userEvent.type(screen.getByPlaceholderText("например, запрос или событие"), "оплата");
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(edgesApi.create).not.toHaveBeenCalled();
  });

  it("концы связи — строкой под заголовком; крестик закрывает окно без запроса", async () => {
    const onClose = vi.fn();
    render(
      <EdgeQuickCreate sourceId="a" targetId="b" sourceLabel="Заказы" targetLabel="Оплата"
        onClose={onClose} onCreated={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "Новая связь" })).toBeInTheDocument();
    expect(screen.getByText("Заказы → Оплата")).toBeInTheDocument();
    // Подписи строк связаны со своими полями.
    expect(screen.getByLabelText("Описание")).toHaveAttribute("placeholder", "например, запрос или событие");
    expect(screen.getByLabelText("Технология")).toHaveAttribute("placeholder", "например, REST или Kafka");
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(edgesApi.create).not.toHaveBeenCalled();
  });
});

describe("CrossLevelEdgePicker", () => {
  beforeEach(() => vi.clearAllMocks());

  function open() {
    const onCreated = vi.fn();
    render(
      <CrossLevelEdgePicker
        title="Связь с объектом вне уровня"
        sourceId="a"
        sourceLabel="Заказы"
        loadNodes={() => Promise.resolve([node("a", "Заказы"), node("b", "Оплата")])}
        scopeKey="root"
        rootParentId={null}
        excludeIds={new Set(["a"])}
        slotPlaceholder="выберите объект"
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    return onCreated;
  }

  it("без выбранного конца создать нельзя", async () => {
    open();
    await screen.findByText("Оплата");
    expect(screen.getByRole("button", { name: "Создать связь" })).toBeDisabled();
  });

  it("по умолчанию связь идёт от источника к выбранному", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await userEvent.click(await screen.findByText("Оплата"));
    await userEvent.type(screen.getByPlaceholderText("например, REST или Kafka"), "gRPC");
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(edgesApi.create).toHaveBeenCalledWith({
      source_id: "a", target_id: "b", label: null, technology: "gRPC",
    });
  });

  it("⇄ разворачивает направление: выбранный → источник", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    open();
    await userEvent.click(await screen.findByText("Оплата"));
    await userEvent.click(screen.getByTitle("Поменять направление"));
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    await waitFor(() => expect(edgesApi.create).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.create).mock.calls[0][0]).toMatchObject({ source_id: "b", target_id: "a" });
  });

  it("Enter: без выбранного конца молчит, с выбранным — создаёт", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await screen.findByText("Оплата");
    const tech = () => screen.getByPlaceholderText("например, REST или Kafka");
    await userEvent.type(tech(), "gRPC{Enter}");
    expect(edgesApi.create).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Оплата"));
    await userEvent.type(tech(), "{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(edgesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      source_id: "a", target_id: "b", technology: "gRPC",
    }));
  });
});

// Страховка фазы 9в редизайна (окно связи между уровнями на новом языке): выбор цели в
// дереве, тело запроса в обоих направлениях, недоступные объекты, поиск по дереву. Тесты не
// опираются на вид окна: строки берутся по имени, ветки раскрываются по подсказке
// «Развернуть», выбор снимается по подсказке «Снять выбор». Зелёные и на прежнем окне.
describe("CrossLevelEdgePicker: страховка выбора цели", () => {
  beforeEach(() => vi.clearAllMocks());

  // Дерево: «Заказы» (источник, недоступен) и «Оплата» с двумя вложенными — «Касса» и
  // «Шлюз оплаты», у шлюза свой вложенный «Карты». «Склад» недоступен, но его вложенный
  // «Полка» выбрать можно.
  const NODES = [
    node("a", "Заказы"),
    node("b", "Оплата"),
    node("k", "Касса", "b"),
    node("c", "Шлюз оплаты", "b"),
    node("d", "Карты", "c"),
    node("s", "Склад"),
    node("p", "Полка", "s"),
  ];

  function open(nodes: Node[] = NODES) {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <CrossLevelEdgePicker
        title="Связь с объектом вне уровня"
        sourceId="a"
        sourceLabel="Заказы"
        loadNodes={() => Promise.resolve(nodes)}
        scopeKey="root"
        rootParentId={null}
        excludeIds={new Set(["a", "s"])}
        slotPlaceholder="Объект вне уровня"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    return { onCreated, onClose };
  }
  const createBtn = () => screen.getByRole("button", { name: "Создать связь" });
  // Раскрыть ветку объекта: кнопка «Развернуть» в строке с его именем.
  async function expand(name: string) {
    const row = screen.getAllByText(name).map((e) => e.closest("div")).find((d) => d?.querySelector('[title="Развернуть"]'));
    const btn = row?.querySelector<HTMLElement>('[title="Развернуть"]');
    if (!btn) throw new Error(`нет ветки «${name}»`);
    await userEvent.click(btn);
  }

  // Имя совпадения при поиске разбито подсветкой: элемент имени — тот, у кого подсветка
  // прямым ребёнком, а весь текст — имя.
  const isHit = (el: Element | null, name: string) =>
    el?.textContent === name && el.querySelector(":scope > mark") !== null;

  it("сначала видны только корни, вложенные — после раскрытия ветки", async () => {
    open();
    await screen.findByText("Оплата");
    expect(screen.queryByText("Касса")).toBeNull();

    await expand("Оплата");

    expect(screen.getByText("Касса")).toBeInTheDocument();
    expect(screen.getByText("Шлюз оплаты")).toBeInTheDocument();
    expect(screen.queryByText("Карты")).toBeNull();
  });

  it("выбор вложенного объекта: слот называет его и путь, связь наружу — от источника", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const { onCreated } = open();
    await screen.findByText("Оплата");
    await expand("Оплата");

    await userEvent.click(screen.getByText("Касса"));

    expect(screen.getByTitle("Снять выбор")).toHaveTextContent("Касса");
    expect(screen.getByTitle("Снять выбор")).toHaveTextContent("Оплата");
    expect(createBtn()).toBeEnabled();
    await userEvent.type(screen.getByPlaceholderText("например, запрос или событие"), "оплата заказа");
    await userEvent.type(screen.getByPlaceholderText("например, REST или Kafka"), "gRPC");
    await userEvent.click(createBtn());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(JSON.stringify(vi.mocked(edgesApi.create).mock.calls[0][0]))
      .toBe('{"source_id":"a","target_id":"k","label":"оплата заказа","technology":"gRPC"}');
  });

  it("связь внутрь: после разворота — от выбранного к источнику, поля те же", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    open();
    await screen.findByText("Оплата");
    await userEvent.click(screen.getByText("Оплата"));
    await userEvent.click(screen.getByTitle("Поменять направление"));
    await userEvent.type(screen.getByPlaceholderText("например, запрос или событие"), "возврат");
    await userEvent.click(createBtn());
    await waitFor(() => expect(edgesApi.create).toHaveBeenCalledOnce());
    expect(JSON.stringify(vi.mocked(edgesApi.create).mock.calls[0][0]))
      .toBe('{"source_id":"b","target_id":"a","label":"возврат","technology":null}');
  });

  it("второй разворот возвращает направление наружу", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    open();
    await userEvent.click(await screen.findByText("Оплата"));
    await userEvent.click(screen.getByTitle("Поменять направление"));
    await userEvent.click(screen.getByTitle("Поменять направление"));
    await userEvent.click(createBtn());
    await waitFor(() => expect(edgesApi.create).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.create).mock.calls[0][0]).toMatchObject({ source_id: "a", target_id: "b" });
  });

  it("недоступный объект не выбирается, но его ветка проходима", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    open();
    await screen.findByText("Склад");

    await userEvent.click(screen.getByText("Склад"));
    // «Заказы» дважды: источник в маршруте и строка дерева (она ниже в разметке).
    const source = screen.getAllByText("Заказы");
    await userEvent.click(source[source.length - 1]);

    expect(screen.queryByTitle("Снять выбор")).toBeNull();
    expect(screen.getByText("Объект вне уровня")).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();

    await expand("Склад");
    await userEvent.click(screen.getByText("Полка"));
    expect(screen.getByTitle("Снять выбор")).toHaveTextContent("Полка");
    expect(createBtn()).toBeEnabled();
  });

  it("щелчок по выбранной цели снимает выбор, кнопка снова заперта", async () => {
    open();
    await userEvent.click(await screen.findByText("Оплата"));
    expect(createBtn()).toBeEnabled();

    await userEvent.click(screen.getByTitle("Снять выбор"));

    expect(screen.queryByTitle("Снять выбор")).toBeNull();
    expect(screen.getByText("Объект вне уровня")).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
  });

  it("поиск показывает совпадения с их предками, остальное прячет", async () => {
    open();
    await screen.findByText("Оплата");

    await userEvent.type(screen.getByPlaceholderText("Поиск по имени"), "карт");

    // Совпадение и путь к нему раскрыты без щелчков; имя совпадения разбито подсветкой.
    expect(screen.getByText("Оплата")).toBeInTheDocument();
    expect(screen.getByText("Шлюз оплаты")).toBeInTheDocument();
    expect(screen.getByText((_, el) => isHit(el, "Карты"))).toBeInTheDocument();
    expect(screen.queryByText("Касса")).toBeNull();
    expect(screen.queryByText("Склад")).toBeNull();
  });

  it("выбор из поиска чистит поиск и оставляет путь к цели раскрытым", async () => {
    open();
    await screen.findByText("Оплата");
    const search = screen.getByPlaceholderText("Поиск по имени");
    await userEvent.type(search, "карт");

    await userEvent.click(screen.getByText((_, el) => isHit(el, "Карты")));

    expect(search).toHaveValue("");
    expect(screen.getByTitle("Снять выбор")).toHaveTextContent("Карты");
    expect(screen.getByTitle("Снять выбор")).toHaveTextContent("Оплата / Шлюз оплаты");
    // Обычное дерево: ветки к цели раскрыты, соседи видны.
    expect(screen.getByText("Касса")).toBeInTheDocument();
    expect(screen.getAllByText("Карты").length).toBeGreaterThanOrEqual(2);
  });

  it("недоступный объект не считается совпадением; пусто — «Ничего не найдено»", async () => {
    open();
    await screen.findByText("Оплата");

    await userEvent.type(screen.getByPlaceholderText("Поиск по имени"), "склад");

    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("пустой список: «Нет объектов»; пока грузится — «Загрузка»", async () => {
    open([]);
    expect(screen.getByText("Загрузка")).toBeInTheDocument();
    expect(await screen.findByText("Нет объектов")).toBeInTheDocument();
  });

  it("«Отмена» закрывает окно без запроса", async () => {
    const { onClose } = open();
    await userEvent.click(await screen.findByText("Оплата"));

    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(edgesApi.create).not.toHaveBeenCalled();
  });
});
