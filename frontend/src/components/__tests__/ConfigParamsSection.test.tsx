// Секция «Конфигурация» на странице объекта.
//
// Проверяется то, чем третья семья отличается от двух соседних:
//   • перечень плоский — ни групп, ни раскрывашек, строка исчерпывает параметр;
//   • «где используется» приходит РАЗВОРОТОМ пометок, своей формы ввода не имеет,
//     и в строке нет колонки «кто» (сослаться может только схема этого же объекта);
//   • секция монтируется всегда, но у неподходящей формы молчит — кроме случая,
//     когда записи уже есть: тогда показывает их с предупреждением.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ConfigParamsSection from "../ConfigParamsSection";
import { configParamsApi } from "../../api/nodes";
import type { ConfigParam, ConfigParamUsage } from "../../types";

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
  doc_id: "d1",
  doc_name: "POST /orders",
  ...over,
});

function renderSection(
  { params = [param()], use = [] as ConfigParamUsage[], isArchitect = true, allowed = true } = {},
) {
  vi.mocked(configParamsApi.list).mockResolvedValue(params);
  vi.mocked(configParamsApi.usage).mockResolvedValue(use);
  return render(
    <ConfigParamsSection nodeId="n1" nodeName="Платежи" isArchitect={isArchitect} allowed={allowed} />,
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
    // которой нет.
    expect(screen.getByText(/зависит от: ИМЯ/)).toBeInTheDocument();
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
    expect(screen.getByText(/значения сред и секреты не хранятся/)).toBeInTheDocument();
  });
});
