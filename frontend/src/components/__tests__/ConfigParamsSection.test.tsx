// Секция «Конфигурация» на странице объекта.
//
// Проверяется то, чем третья семья отличается от двух соседних:
//   • перечень плоский — ни групп, ни раскрывашек, строка исчерпывает параметр;
//   • «где используется» приходит РАЗВОРОТОМ пометок, своей формы ввода не имеет;
//     своя схема называется одним именем, схема компонента — с именем компонента;
//   • секция монтируется всегда, но у неподходящей формы молчит — кроме случая,
//     когда записи уже есть: тогда показывает их с предупреждением.
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

const onNavigateNode = vi.fn();
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
      onNavigateNode={onNavigateNode}
    />,
  );
}

describe("ConfigParamsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("показывает параметр со всей его метой", async () => {
    renderSection();

    await waitFor(() => expect(screen.getByText("Конфигурация")).toBeInTheDocument());
    expect(await screen.findByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument();
    expect(screen.getByDisplayValue("bool")).toBeInTheDocument();
    // «По умолчанию» — текст дефолта ИЗ КОДА, не значение среды: значений в модели нет.
    expect(screen.getByDisplayValue("false")).toBeInTheDocument();
    expect(screen.getByDisplayValue("включает новую корзину")).toBeInTheDocument();
  });

  it("зависимости показываются разворотом пометок и своей формы ввода не имеют", async () => {
    renderSection({ use: [usage(), usage({ doc_id: "d2", doc_name: "GET /cart" })] });

    await waitFor(() => expect(screen.getByText(/POST \/orders, GET \/cart/)).toBeInTheDocument());
    // Подсказка говорит, ОТКУДА это берётся: иначе пользователь ищет форму ввода,
    // которой нет. Она спрятана за «?» у заголовка (2026-09-28): видна по нажатию.
    expect(screen.queryByText(/зависит от: ИМЯ/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Откуда берётся «Зависит от»" }));
    expect(
      screen.getByText(
        "«Зависит от» собирается из пометок «зависит от: ИМЯ» в схемах логики этого"
        + " объекта. Своей формы ввода у зависимости нет.",
      ),
    ).toBeInTheDocument();
  });

  it("схема компонента называет компонент, своя — только имя схемы", async () => {
    renderSection({
      use: [
        usage(),
        usage({ node_id: "n2", node_name: "api", doc_id: "d2", doc_name: "GET /cart" }),
      ],
    });

    await waitFor(() =>
      expect(screen.getByText("POST /orders, GET /cart · api")).toBeInTheDocument(),
    );
  });

  it("без ссылок строка зависимости не рисуется вовсе", async () => {
    renderSection();

    await waitFor(() => expect(screen.getByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument());
    // «Ссылок нет» у каждой из двадцати ручек — шум, а не факт.
    expect(screen.queryByText("зависит:")).toBeNull();
  });

  it("наблюдателю — только чтение, без полей и кнопок", async () => {
    renderSection({ isArchitect: false, use: [usage()] });

    await waitFor(() => expect(screen.getByText("FEATURE_NEW_CHECKOUT")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeNull();
    expect(screen.queryByText("+ Параметр")).toBeNull();
    // Факты наблюдателю видны все — включая зависимости.
    expect(screen.getByText("POST /orders")).toBeInTheDocument();
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

  it("«+ Параметр» не упирается в занятое имя", async () => {
    vi.mocked(configParamsApi.create).mockResolvedValue(param({ id: "p2" }));
    renderSection({ params: [param({ name: "ПАРАМЕТР" })] });

    // Вход тот же, что у соседних секций: кнопка с шевроном, а способы — пунктами
    // меню. Два способа завести одну сущность не должны выглядеть как две кнопки.
    await userEvent.click(await screen.findByText("+ Параметр"));
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
    expect(container.querySelector(".np-card")).toBeNull();
  });

  it("форме не положено, а записи есть — показываем с предупреждением", async () => {
    // Спрятать применённое хуже, чем показать: унести его иначе было бы нечем.
    renderSection({ allowed: false });

    await waitFor(() => expect(screen.getByText("Конфигурация")).toBeInTheDocument());
    expect(screen.getByText(/перенесите её на сервис/)).toBeInTheDocument();
    // Заводить новые у неподходящей формы всё же не даём — это уже не спасение данных.
    expect(screen.queryByText("+ Параметр")).toBeNull();
  });

  it("пустая конфигурация сервиса зовёт описать, а не молчит", async () => {
    renderSection({ params: [] });

    await waitFor(() => expect(screen.getByText("Параметры не описаны")).toBeInTheDocument());
    expect(screen.getByText("+ Параметр")).toBeInTheDocument();
  });

  it("«Через ИИ-агента» — второй пункт того же меню", async () => {
    renderSection();

    await userEvent.click(await screen.findByText("+ Параметр"));
    await userEvent.click(screen.getByText("Через ИИ-агента"));

    // Окно называет объект в подзаголовке: к нему уедут параметры без адреса в файле.
    expect(await screen.findByText("Описать конфигурацию с помощью ИИ-агента")).toBeInTheDocument();
    // И честно предупреждает, что значения в ArchMap не едут, — ДО запуска агента на
    // репозиторий с .env, а не после.
    expect(screen.getByText(/вернет список параметров конфигурации по коду/)).toBeInTheDocument();
  });
});

// ── По элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md) ────────────────────
// Конфигурацию читает контейнер. У системы её нет: меню «+ Параметр» нет, старые
// параметры — с предупреждением и «Перенести документацию». У компонента — где его
// конфигурация и от каких параметров контейнера зависят его схемы.
describe("ConfigParamsSection: элемент архитектуры", () => {
  beforeEach(() => vi.clearAllMocks());
  const COMPONENT: PageElement = { kind: "component", container: { id: "c", name: "orders" } };

  it("система без параметров — своей конфигурации нет, меню «+ Параметр» нет", async () => {
    renderSection({ params: [], element: { kind: "system" } });
    expect(await screen.findByText(
      "Это система, своей конфигурации у неё нет. Параметры описывают у её контейнеров",
    )).toBeInTheDocument();
    expect(screen.queryByText("+ Параметр")).toBeNull();
    expect(screen.queryByText("Параметры не описаны")).toBeNull();
  });

  it("система с параметрами — предупреждение, список и «Перенести документацию»", async () => {
    renderSection({ element: { kind: "system" } });
    expect(await screen.findByText(
      "Конфигурацию читают контейнеры, у системы её нет. Перенесите параметры одному из них",
    )).toBeInTheDocument();
    expect(screen.getByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument();
    expect(screen.queryByText("+ Параметр")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Перенести документацию" }));
    expect(onTransfer).toHaveBeenCalled();
  });

  it("контейнер с компонентами — «Зависит от» из схем контейнера и его компонентов", async () => {
    renderSection({ element: { kind: "container" } });
    await userEvent.click(await screen.findByRole("button", { name: "Откуда берётся «Зависит от»" }));
    expect(screen.getByText(
      "«Зависит от» собирается из пометок «зависит от: ИМЯ» в схемах логики этого контейнера"
      + " и его компонентов. Своей формы ввода у зависимости нет.",
    )).toBeInTheDocument();
    expect(screen.getByText("+ Параметр")).toBeInTheDocument();
  });

  it("компонент — конфигурацию читает контейнер, «Открыть» ведёт к нему, зависимости его схем", async () => {
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
      "Схемы этого компонента зависят от: FEATURE_NEW_CHECKOUT, TOLERANCE_PERCENT",
    )).toBeInTheDocument();
    expect(configParamsApi.usage).toHaveBeenCalledWith("c");
    expect(screen.getByText(/Конфигурацию читает контейнер «orders», параметры описаны у него/)).toBeInTheDocument();
    expect(screen.queryByText("+ Параметр")).toBeNull();
    expect(screen.queryByText("Параметры не описаны")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Открыть" }));
    expect(onNavigateNode).toHaveBeenCalledWith("c");
  });

  it("компонент без зависимостей — строки нет", async () => {
    renderSection({ params: [], element: COMPONENT });
    await screen.findByText(/Конфигурацию читает контейнер «orders»/);
    await waitFor(() => expect(configParamsApi.usage).toHaveBeenCalledWith("c"));
    expect(screen.queryByText(/Схемы этого компонента зависят от/)).toBeNull();
  });

  it("свои параметры у компонента (старые данные) — куда их собрать, список без «+ Параметр»", async () => {
    renderSection({ element: COMPONENT });
    expect(await screen.findByText(
      "Конфигурацию читает контейнер целиком. Перенесите параметры в «orders»: на его странице есть"
      + " кнопка «Собрать с компонентов»",
    )).toBeInTheDocument();
    expect(screen.getByDisplayValue("FEATURE_NEW_CHECKOUT")).toBeInTheDocument();
    expect(screen.queryByText("+ Параметр")).toBeNull();
  });
});
