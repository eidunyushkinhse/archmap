// Секция «Конфигурация» на странице объекта.
//
// Проверяется то, чем третья семья отличается от двух соседних:
//   • перечень плоский — ни групп, ни раскрывашек, строка исчерпывает параметр;
//   • «где используется» приходит РАЗВОРОТОМ пометок, своей формы ввода не имеет;
//     своя схема называется одним именем, схема компонента — с именем компонента;
//   • секция монтируется всегда, но у неподходящей формы молчит — кроме случая,
//     когда записи уже есть: тогда показывает их с предупреждением;
//   • видимость (редизайн, направление А): пустая подходящая конфигурация у редактора —
//     заголовок и «Добавить», у читателя раздела нет.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ConfigParamsSection from "../ConfigParamsSection";
import { configParamsApi } from "../../api/nodes";
import type { ConfigParam, ConfigParamUsage } from "../../types";
import type { PageElement } from "../element/elementView";

vi.mock("../../api/nodes", () => ({
  configParamsApi: {
    list: vi.fn(),
    usage: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

const param = (over: Partial<ConfigParam> = {}): ConfigParam => ({
  id: "p1",
  node_id: "n1",
  name: "FEATURE_NEW_CHECKOUT",
  description: "включает новую корзину",
  value_type: "bool",
  required: false,
  default_value: "false",
  version: 1,
  ...over,
});

const usage = (over: Partial<ConfigParamUsage> = {}): ConfigParamUsage => ({
  param_id: "p1",
  param_name: "FEATURE_NEW_CHECKOUT",
  node_id: "n1",
  node_name: "orders",
  doc_id: "d1",
  doc_name: "POST /orders",
  ...over,
});

const onTransfer = vi.fn();

function renderSection({
  params = [param()], use = [] as ConfigParamUsage[], isArchitect = true, allowed = true,
  element = { kind: "leaf" } as PageElement, containerUse = [] as ConfigParamUsage[],
} = {}) {
  vi.mocked(configParamsApi.list).mockResolvedValue(params);
  // Обратный индекс: свой — по id объекта, контейнера компонента — по id контейнера.
  vi.mocked(configParamsApi.usage).mockImplementation((id) => Promise.resolve(id === "n1" ? use : containerUse));
  return render(
    <ConfigParamsSection
      nodeId="n1" element={element} isArchitect={isArchitect} allowed={allowed}
      onTransfer={element.kind === "system" ? onTransfer : undefined}
    />,
  );
}

describe("ConfigParamsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("показывает параметр со всей его метой — тихой таблицей с шапкой", async () => {
    renderSection();

    await waitFor(() => expect(screen.getByText("Конфигурация")).toBeInTheDocument());
    for (const заголовок of ["Параметр", "Тип", "Обязательный", "По умолчанию", "Что переключает"]) {
      expect(screen.getByRole("columnheader", { name: заголовок })).toBeInTheDocument();
    }
    expect(await screen.findByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument();
    expect(screen.getByDisplayValue("bool")).toBeInTheDocument();
    // «По умолчанию» — текст дефолта ИЗ КОДА, не значение среды: значений в модели нет.
    expect(screen.getByDisplayValue("false")).toBeInTheDocument();
    expect(screen.getByDisplayValue("включает новую корзину")).toBeInTheDocument();
  });

  it("зависимости показываются разворотом пометок тихой строкой и своей формы ввода не имеют", async () => {
    renderSection({ use: [usage(), usage({ doc_id: "d2", doc_name: "GET /cart" })] });

    await waitFor(() => expect(screen.getByText("Зависит: POST /orders, GET /cart")).toBeInTheDocument());
    // Пояснения «?» у заголовка больше нет (редизайн): строка «Зависит» сама говорит,
    // из каких схем она собрана, а полей ввода у неё нет.
    expect(screen.queryByRole("button", { name: "Откуда берётся «Зависит от»" })).toBeNull();
    expect(screen.getByText("Зависит: POST /orders, GET /cart").closest("textarea, input")).toBeNull();
  });

  it("схема компонента называет компонент, своя — только имя схемы", async () => {
    renderSection({
      use: [
        usage(),
        usage({ node_id: "n2", node_name: "api", doc_id: "d2", doc_name: "GET /cart" }),
      ],
    });

    await waitFor(() =>
      expect(screen.getByText("Зависит: POST /orders, GET /cart · api")).toBeInTheDocument(),
    );
  });

  it("без ссылок строка зависимости не рисуется вовсе", async () => {
    renderSection();

    await waitFor(() => expect(screen.getByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument());
    // «Ссылок нет» у каждой из двадцати ручек — шум, а не факт.
    expect(screen.queryByText(/Зависит:/)).toBeNull();
  });

  it("наблюдателю — только чтение, без полей и кнопок", async () => {
    renderSection({ isArchitect: false, use: [usage()] });

    await waitFor(() => expect(screen.getByText("FEATURE_NEW_CHECKOUT")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Удалить параметр/ })).toBeNull();
    // Факты наблюдателю видны все — включая зависимости.
    expect(screen.getByText("Зависит: POST /orders")).toBeInTheDocument();
  });

  it("правка уходит с CAS-версией параметра", async () => {
    vi.mocked(configParamsApi.update).mockResolvedValue(param({ version: 2 }));
    renderSection();

    const поле = await screen.findByDisplayValue("включает новую корзину");
    await userEvent.clear(поле);
    await userEvent.type(поле, "включает корзину v2");
    await userEvent.tab();

    await waitFor(() =>
      expect(configParamsApi.update).toHaveBeenCalledWith("n1", "p1", {
        description: "включает корзину v2",
        base_version: 1,
      }),
    );
  });

  it("отказ правки показан текстом, а список перечитан с сервера", async () => {
    vi.mocked(configParamsApi.update).mockRejectedValue(new Error("Параметр с таким именем уже есть"));
    renderSection();

    const поле = await screen.findByDisplayValue("FEATURE_NEW_CHECKOUT");
    await userEvent.clear(поле);
    await userEvent.type(поле, "ДРУГОЕ_ИМЯ");
    await userEvent.tab();

    expect(await screen.findByText("Параметр с таким именем уже есть")).toBeInTheDocument();
    // CAS-версия приходит с сервера — после любой правки, и неудачной тоже, список
    // перечитывается, а не склеивается локально.
    await waitFor(() => expect(configParamsApi.list).toHaveBeenCalledTimes(2));
  });

  it("«Добавить» не упирается в занятое имя", async () => {
    vi.mocked(configParamsApi.create).mockResolvedValue(param({ id: "p2" }));
    renderSection({ params: [param({ name: "ПАРАМЕТР" })] });

    // Вход тот же, что у соседних секций: кнопка с шевроном, а способы — пунктами
    // меню. Два способа завести одну сущность не должны выглядеть как две кнопки.
    await userEvent.click(await screen.findByRole("button", { name: "Добавить" }));
    await userEvent.click(screen.getByText("Вручную"));

    await waitFor(() =>
      expect(configParamsApi.create).toHaveBeenCalledWith("n1", {
        name: "ПАРАМЕТР_2",
        value_type: "",
        required: false,
        default_value: "",
      }),
    );
  });

  it("форме не положено и записей нет — секции не существует", async () => {
    const { container } = renderSection({ params: [], allowed: false });

    await waitFor(() => expect(configParamsApi.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("форме не положено, а записи есть — показываем с предупреждением", async () => {
    // Спрятать применённое хуже, чем показать: унести его иначе было бы нечем.
    renderSection({ allowed: false });

    await waitFor(() => expect(screen.getByText("Конфигурация")).toBeInTheDocument());
    const warn = screen.getByText(/Перенесите параметры на контейнер, который с ним работает/);
    expect(warn.textContent).toContain("Параметры конфигурации описывают настройки контейнера");
    expect(warn.textContent).not.toMatch(/ручк|сервис/);
    // Заводить новые у неподходящей формы всё же не даём — это уже не спасение данных.
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("пустая конфигурация сервиса у редактора — заголовок и «Добавить», без пустой строки", async () => {
    renderSection({ params: [] });

    expect(await screen.findByRole("heading", { name: "Конфигурация" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Добавить" })).toBeInTheDocument();
    expect(screen.queryByText("Параметры не описаны")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("пустая конфигурация у читателя — раздела нет", async () => {
    const { container } = renderSection({ params: [], isArchitect: false });

    await waitFor(() => expect(configParamsApi.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("крестик удаления назван по параметру и удаляет его", async () => {
    vi.mocked(configParamsApi.delete).mockResolvedValue(undefined as never);
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: "Удалить параметр FEATURE_NEW_CHECKOUT" }));
    await waitFor(() => expect(configParamsApi.delete).toHaveBeenCalledWith("n1", "p1"));
  });

  it("длинное описание растёт по тексту: поле многострочное, Enter в имени заканчивает правку", async () => {
    vi.mocked(configParamsApi.update).mockResolvedValue(param({ version: 2 }));
    renderSection();

    const описание = await screen.findByDisplayValue("включает новую корзину");
    expect(описание.tagName).toBe("TEXTAREA");
    const имя = screen.getByDisplayValue("FEATURE_NEW_CHECKOUT");
    await userEvent.clear(имя);
    await userEvent.type(имя, "НОВОЕ{Enter}");
    await waitFor(() =>
      expect(configParamsApi.update).toHaveBeenCalledWith("n1", "p1", { name: "НОВОЕ", base_version: 1 }),
    );
    expect(имя).toHaveValue("НОВОЕ");
  });

  it("«Через ИИ-агента» — второй пункт того же меню", async () => {
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: "Добавить" }));
    await userEvent.click(screen.getByText("Через ИИ-агента"));

    // Открывается окно конфигурации. Вступления у окна больше нет (редизайн, фаза 6г):
    // задание и ответы агента, механика — в подсказках.
    expect(await screen.findByText("Описать конфигурацию с помощью ИИ-агента")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скопировать задание" })).toBeInTheDocument();
  });
});

// ── По элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md) ────────────────────
// Конфигурацию читает контейнер. У системы её нет: «Добавить» нет, старые параметры — с
// предупреждением и «Перенести документацию». У компонента раздел есть, только если его
// схемы зависят от параметров контейнера (одной строкой) или у него старые параметры.
describe("ConfigParamsSection: элемент архитектуры", () => {
  beforeEach(() => vi.clearAllMocks());
  const COMPONENT: PageElement = { kind: "component", container: { id: "c", name: "orders" } };

  it("система без параметров — раздела нет", async () => {
    const { container } = renderSection({ params: [], element: { kind: "system" } });
    await waitFor(() => expect(configParamsApi.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("система с параметрами — предупреждение, список и «Перенести документацию»", async () => {
    renderSection({ element: { kind: "system" } });
    expect(await screen.findByText(
      "Конфигурацию читают контейнеры, у системы её нет. Перенесите параметры одному из них",
    )).toBeInTheDocument();
    expect(screen.getByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Перенести документацию" }));
    expect(onTransfer).toHaveBeenCalled();
  });

  it("контейнер с компонентами — «Добавить» есть, схема компонента названа с компонентом", async () => {
    renderSection({ element: { kind: "container" }, use: [usage({ node_id: "n2", node_name: "api" })] });
    expect(await screen.findByText("Зависит: POST /orders · api")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Добавить" })).toBeInTheDocument();
  });

  it("компонент — одна строка: от каких параметров контейнера зависят его схемы", async () => {
    renderSection({
      params: [],
      element: COMPONENT,
      containerUse: [
        usage({ param_name: "FEATURE_NEW_CHECKOUT", node_id: "n1" }),
        usage({ param_id: "p2", param_name: "TOLERANCE_PERCENT", node_id: "n1", doc_id: "d2" }),
        usage({ param_id: "p2", param_name: "TOLERANCE_PERCENT", node_id: "n1", doc_id: "d3" }),
        usage({ param_id: "p3", param_name: "CHEF_MODE", node_id: "other" }),
      ],
    });
    expect(await screen.findByText(
      "Схемы этого компонента зависят от параметров контейнера «orders»: FEATURE_NEW_CHECKOUT, TOLERANCE_PERCENT",
    )).toBeInTheDocument();
    expect(configParamsApi.usage).toHaveBeenCalledWith("c");
    // Пояснение «конфигурацию читает контейнер» с кнопкой «Открыть» убрано: контейнер
    // назван в строке «Тип» свойств, и ссылка на него там же.
    expect(screen.queryByText(/параметры описаны у него/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("компонент без зависимостей и параметров — раздела нет", async () => {
    const { container } = renderSection({ params: [], element: COMPONENT });
    await waitFor(() => expect(configParamsApi.usage).toHaveBeenCalledWith("c"));
    expect(container).toBeEmptyDOMElement();
  });

  it("свои параметры у компонента (старые данные) — куда их собрать, список без «Добавить»", async () => {
    renderSection({ element: COMPONENT });
    expect(await screen.findByText(
      "Конфигурацию читает контейнер целиком. Параметры можно перенести в «orders» кнопкой"
      + " «Собрать с компонентов» на его странице",
    )).toBeInTheDocument();
    expect(screen.getByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });
});
