// Примитивы блока разбора остатка (§5 ТЗ): список объектов, форма новой связи,
// шаг имени склейки и вьюер тела кандидата.
//
// Что закрепляем: кап списка и фильтр (в крупной системе путей сотни, а решение
// принимается по первым строкам); форма новой связи не отдаёт ответ, пока нет
// обоих концов, и сама переходит на конец после выбора начала; «Склеить» со
// своим именем отдаёт именно его; Escape закрывает ВЬЮЕР и не уходит выше — под
// ним нативный <dialog> окна, который иначе закрылся бы заодно.
import { useState } from "react";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { ComponentOut, FuzzyPairOut } from "../../types";
import type { NewEdgesAnswer } from "../project/remainder/questions";
import { draftFromAnswer, emptyEdgesDraft, mergeDraftFor } from "../project/remainder/drafts";
import type { EdgesDraft, MergeDraft } from "../project/remainder/drafts";
import ObjectList from "../project/remainder/ObjectList";
import NewEdgeForm from "../project/remainder/NewEdgeForm";
import MergeNameStep from "../project/remainder/MergeNameStep";
import ObjectCombobox from "../project/remainder/ObjectCombobox";
import DocViewer from "../project/remainder/DocViewer";

vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));

const дерево = (n: number): ComponentOut[] =>
  Array.from({ length: n }, (_, i) => ({ path: `Zabbix / Компонент ${i + 1}`, has_children: i === 0 }));

describe("ObjectList (§5.3)", () => {
  it("показывает первые четыре и раскрывается по ссылке", async () => {
    render(<ObjectList items={дерево(7)} base="Zabbix" onPick={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(5); // 4 варианта + «Показать остальные»
    expect(screen.getByText("Компонент 4")).toBeInTheDocument();
    expect(screen.queryByText("Компонент 5")).toBeNull();
    // Кнопка-текст и поле поиска — примитивы нового языка (фаза 8а).
    expect(screen.getByRole("button", { name: "Показать остальные 3" })).toHaveClass("ds-add");
    await userEvent.click(screen.getByRole("button", { name: "Показать остальные 3" }));
    expect(screen.getByLabelText("Поиск по имени")).toHaveClass("ds-input");
    expect(screen.getByText("Компонент 7")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Показать остальные/ })).toBeNull();
  });

  it("до шести объектов — все сразу, без «Показать остальные» и без поиска (фаза 8б)", () => {
    for (const n of [5, 6]) {
      const { unmount } = render(<ObjectList items={дерево(n)} base="Zabbix" onPick={vi.fn()} />);
      expect(screen.getAllByRole("button")).toHaveLength(n);
      expect(screen.getByText(`Компонент ${n}`)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Показать остальные/ })).toBeNull();
      expect(screen.queryByLabelText("Поиск по имени")).toBeNull();
      unmount();
    }
  });

  it("раскрытый список встаёт в вид окна: поле поиска и начало списка (фаза 8б)", async () => {
    const вид = vi.spyOn(Element.prototype, "scrollIntoView");
    // В jsdom метод — общая заглушка (test-setup): вызовы прошлых тестов не в счёт.
    вид.mockClear();
    render(<ObjectList items={дерево(9)} base="Zabbix" onPick={vi.fn()} />);
    expect(вид).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Показать остальные 5" }));
    expect(вид).toHaveBeenCalledWith({ block: "nearest" });
    // Прокручивается в вид блок, где поле поиска стоит первым, а список за ним.
    const блок = вид.mock.contexts.at(-1) as Element;
    expect(блок.firstElementChild).toBe(screen.getByLabelText("Поиск по имени"));
    expect(блок.querySelector(".rq-scroll")).not.toBeNull();
    вид.mockRestore();
  });

  it("у объекта с вложенными — тег, у пути — серый префикс и полужирный хвост", () => {
    render(<ObjectList items={[{ path: "Grafana / Сервер / Рантайм", has_children: true }]} base="Grafana" onPick={vi.fn()} />);
    // Без элемента (ответ прежнего сервера) объект с вложенными — система.
    expect(screen.getByText("система")).toBeInTheDocument();
    expect(screen.getByText("Сервер /")).toBeInTheDocument();
    expect(screen.getByText("Рантайм").tagName).toBe("B");
  });

  it("тег — по действующему элементу: система, контейнер; у листа тега нет", () => {
    render(<ObjectList
      items={[
        { path: "Grafana / Сервер", has_children: true, element_effective: "container" },
        { path: "Grafana / Плагины", has_children: true, element_effective: "system" },
        { path: "Grafana / Сервер / Рантайм", has_children: true, element_effective: "component" },
        { path: "Grafana / Веб", has_children: false, element_effective: "container" },
      ]}
      onPick={vi.fn()}
    />);
    expect(screen.getAllByText("контейнер")).toHaveLength(2);
    expect(screen.getAllByText("система")).toHaveLength(1);
  });

  it("фильтр сужает список, а пустой ответ говорит словами", async () => {
    render(<ObjectList items={[...дерево(6), { path: "Zabbix / Поллер", has_children: false }]} onPick={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Показать остальные/ }));
    const поле = screen.getByLabelText("Поиск по имени");
    expect(поле).toHaveAttribute("placeholder", "Поиск по имени");
    await userEvent.type(поле, "поллер");
    expect(screen.getByText("Поллер")).toBeInTheDocument();
    expect(screen.queryByText("Компонент 1")).toBeNull();
    await userEvent.clear(поле);
    await userEvent.type(поле, "нетути");
    expect(screen.getByText("Ничего не нашлось")).toBeInTheDocument();
  });

  it("отдаёт выбранный путь целиком", async () => {
    const onPick = vi.fn();
    render(<ObjectList items={дерево(2)} base="Zabbix" onPick={onPick} />);
    await userEvent.click(screen.getByText("Компонент 2"));
    expect(onPick).toHaveBeenCalledWith("Zabbix / Компонент 2");
  });

  it("два объекта с ОДНИМ путём — обе строки и без спора ключей", () => {
    // Полевой случай: тёзки с противоречащими якорями мердж оставляет
    // раздельно, и в пикере честно два «Ярмарка / Каталог-БД». По одному пути
    // React ругался на дубль ключей, а строки могли схлопнуться в одну.
    const ошибки = vi.spyOn(console, "error").mockImplementation(() => {});
    const тёзки: ComponentOut[] = [
      { path: "Ярмарка / Каталог-БД", has_children: false },
      { path: "Ярмарка / Каталог-БД", has_children: false },
    ];
    render(<ObjectList items={тёзки} base="Ярмарка" onPick={vi.fn()} />);

    expect(screen.getAllByText("Каталог-БД")).toHaveLength(2);
    expect(ошибки.mock.calls.map((c) => String(c[0])).join("\n"))
      .not.toMatch(/same key|unique/i);
    ошибки.mockRestore();
  });
});

// Стенды с черновиком в состоянии вызывающего — ровно так формы держит блок
// (§4.6). Имена латиницей: правило react-hooks/rules-of-hooks узнаёт компонент
// по заглавной ЛАТИНСКОЙ букве и на кириллице ругается.
const ГРУППА = ["Плагин", "Плагин / Датасорс"];

function EdgeFormStand({ onAdd, onBack, start }: {
  onAdd: (a: NewEdgesAnswer) => void; onBack: () => void; start?: EdgesDraft;
}) {
  const [draft, setDraft] = useState<EdgesDraft>(start ?? emptyEdgesDraft(ГРУППА));
  return (
    <NewEdgeForm
      nodes={[...дерево(3), { path: "Плагин", has_children: false }]}
      draft={draft}
      onDraft={setDraft}
      onAdd={onAdd}
      onBack={onBack}
    />
  );
}

describe("NewEdgeForm (§5.4, П4 v2)", () => {
  const поле = (n = 0) => screen.getAllByRole("combobox")[n]!;

  it("строка на каждый объект группы: видно, у кого связей нет", () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    // Слева — сами объекты группы, они не редактируются.
    expect(screen.getByText("Плагин")).toBeInTheDocument();
    expect(screen.getByText("Датасорс")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(поле()).toHaveAttribute("placeholder", "Имя объекта");
    // Поля описания и технологии — только у строки с выбранным соседом (фаза 8б).
    expect(screen.queryAllByLabelText(/^Описание связи/)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/^Технология связи/)).toHaveLength(0);
    // Типа канала в форме нет вовсе — его задают в «Процессах».
    expect(screen.queryByText("Синхронный")).toBeNull();
    expect(screen.queryByText("Асинхронный")).toBeNull();
  });

  it("объект слева — текст: имя отдельно от тихого префикса, полный путь в подсказке (фаза 8б)", () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    const имя = screen.getByText("Датасорс");
    expect(имя).toHaveClass("rq-eobj-name");
    const объект = имя.closest(".rq-eobj")!;
    expect(объект).toHaveAttribute("title", "Плагин / Датасорс");
    expect(объект.querySelector(".rq-eobj-pre")?.textContent).toBe("Плагин /");
    // Ни поля, ни кнопки: объект строки не выбирается.
    expect(объект.closest("input, button")).toBeNull();
    expect(объект.querySelector("input, button")).toBeNull();
    // У объекта без префикса — одно имя.
    expect(screen.getByText("Плагин").closest(".rq-eobj")?.querySelector(".rq-eobj-pre")).toBeNull();
  });

  it("поля связи появляются с выбором соседа; очищенный сосед их прячет, тексты остаются (фаза 8б)", async () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    await userEvent.click(поле());
    await userEvent.click(screen.getByRole("option", { name: /Компонент 1/ }));
    const описание = screen.getByLabelText("Описание связи от «Плагин»");
    expect(описание).toHaveAttribute("placeholder", "Что ходит по связи");
    expect(screen.getByLabelText("Технология связи от «Плагин»")).toHaveAttribute("placeholder", "Технология, например HTTP");
    // Вторая строка формы — только у первой строки, у второй соседа нет.
    expect(screen.getAllByLabelText(/^Описание связи/)).toHaveLength(1);
    await userEvent.type(описание, "метрики");
    await userEvent.type(screen.getByLabelText("Технология связи от «Плагин»"), "HTTP");
    await userEvent.click(screen.getByLabelText("Очистить выбор"));
    expect(screen.queryAllByLabelText(/^Описание связи/)).toHaveLength(0);
    await userEvent.click(поле());
    await userEvent.click(screen.getByRole("option", { name: /Компонент 2/ }));
    expect(screen.getByLabelText("Описание связи от «Плагин»")).toHaveValue("метрики");
    expect(screen.getByLabelText("Технология связи от «Плагин»")).toHaveValue("HTTP");
  });

  it("поле само фильтрует список под собой, свой объект в нём не предлагается", async () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(поле());
    // Фокус раскрывает список целиком; отдельной панели с поиском нет.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(поле()).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByLabelText("Поиск по имени")).toBeNull();
    const строки = () => screen.getAllByRole("option").map((o) => o.textContent);
    expect(строки().some((t) => t?.includes("Компонент 1"))).toBe(true);
    // Левый объект строки в соседи не годится.
    expect(строки().some((t) => t === "Плагин")).toBe(false);
    await userEvent.type(поле(), "компонент 2");
    expect(строки()).toEqual(["Zabbix / Компонент 2"]);
    await userEvent.clear(поле());
    await userEvent.type(поле(), "нетути");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Ничего не нашлось")).toBeInTheDocument();
  });

  it("клавиатура: ↓ подсвечивает, Enter выбирает, Escape гасит только список", async () => {
    const onClose = vi.fn();
    // Родительское окно слушает Escape так же, как ui/Modal через <dialog>.
    document.addEventListener("keydown", onClose);
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    await userEvent.click(поле());
    // Подсвечена первая строка, ↓ уводит на вторую, Enter её выбирает.
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(поле()).toHaveValue("Zabbix / Компонент 2");
    expect(screen.queryByRole("listbox")).toBeNull();
    // ↓ на закрытом списке снова его раскрывает.
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    onClose.mockClear();
    await userEvent.keyboard("{Escape}");
    // Список закрылся, а до окна ввоза клавиша не дошла — иначе Escape закрыл бы
    // заодно и его (ui/Modal слушает cancel нативного <dialog>).
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onClose);
  });

  it("«×» очищает выбор, «Провести связь» гаснет без соседей", async () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    const кнопка = () => screen.getByRole("button", { name: /^Провести связ/ });
    expect(кнопка()).toBeDisabled();
    await userEvent.click(поле());
    await userEvent.click(screen.getByRole("option", { name: /Компонент 1/ }));
    expect(поле()).toHaveValue("Zabbix / Компонент 1");
    expect(кнопка()).toBeEnabled();
    expect(кнопка().textContent).toBe("Провести связь");
    await userEvent.click(screen.getByLabelText("Очистить выбор"));
    expect(поле()).toHaveValue("");
    expect(кнопка()).toBeDisabled();
  });

  it("соединитель переворачивает направление кнопкой посередине", async () => {
    const onAdd = vi.fn();
    render(<EdgeFormStand onAdd={onAdd} onBack={vi.fn()} />);
    await userEvent.click(поле());
    await userEvent.click(screen.getByRole("option", { name: /Компонент 1/ }));
    await userEvent.click(screen.getAllByRole("button", { name: "Поменять направление" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: /^Провести связ/ }));
    expect(onAdd).toHaveBeenCalledWith({
      kind: "new_edges",
      edges: [{ fromPath: "Zabbix / Компонент 1", toPath: "Плагин", label: "", tech: "" }],
    });
  });

  it("отдаёт по связи на заполненную строку, пустые пропускает", async () => {
    const onAdd = vi.fn();
    render(<EdgeFormStand onAdd={onAdd} onBack={vi.fn()} />);
    await userEvent.click(поле(0));
    await userEvent.click(screen.getByRole("option", { name: /Компонент 1/ }));
    await userEvent.type(screen.getByLabelText("Описание связи от «Плагин»"), "метрики");
    await userEvent.type(screen.getByLabelText("Технология связи от «Плагин»"), "HTTP");
    await userEvent.click(поле(1));
    await userEvent.click(screen.getByRole("option", { name: /Компонент 2/ }));
    const кнопка = screen.getByRole("button", { name: /^Провести связ/ });
    // Заполнены две строки — кнопка во множественном числе.
    expect(кнопка.textContent).toBe("Провести связи");
    await userEvent.click(кнопка);
    expect(onAdd).toHaveBeenCalledWith({
      kind: "new_edges",
      edges: [
        { fromPath: "Плагин", toPath: "Zabbix / Компонент 1", label: "метрики", tech: "HTTP" },
        { fromPath: "Плагин / Датасорс", toPath: "Zabbix / Компонент 2", label: "", tech: "" },
      ],
    });
  });

  it("кнопки и поля нового языка: «Провести связь» первой, подписей над полями нет", async () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    const провести = screen.getByRole("button", { name: /^Провести связ/ });
    const назад = screen.getByRole("button", { name: "Назад к вопросу" });
    expect(провести).toHaveClass("ds-btn", "ds-btn--primary");
    expect(назад).toHaveClass("ds-btn");
    expect(провести.compareDocumentPosition(назад) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(поле());
    await userEvent.click(screen.getByRole("option", { name: /Компонент 1/ }));
    for (const поле of screen.getAllByLabelText(/^(Описание|Технология) связи/)) expect(поле).toHaveClass("ds-input");
    for (const поле of screen.getAllByRole("combobox")) expect(поле).toHaveClass("ds-input");
    // Подписи «Описание» и «Технология» над полями убраны: поле называет плейсхолдер.
    expect(screen.queryByText("Описание")).toBeNull();
    expect(screen.queryByText("Технология")).toBeNull();
    // Переключатель направления — тихая кнопка-значок.
    expect(screen.getAllByRole("button", { name: "Поменять направление" })[0]).toHaveClass("ds-icon-btn");
  });

  it("«Назад к вопросу» ничего не отдаёт", async () => {
    const onAdd = vi.fn();
    const onBack = vi.fn();
    render(<EdgeFormStand onAdd={onAdd} onBack={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: "Назад к вопросу" }));
    expect(onBack).toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("черновик из ответа открывает форму заполненной, включая переворот", () => {
    const из = draftFromAnswer(
      { kind: "new_edges", edges: [{ fromPath: "Zabbix / Компонент 3", toPath: "Плагин", label: "чтение", tech: "SQL" }] },
      ГРУППА,
    );
    expect(из).toEqual([
      { nodePath: "Плагин", toPath: "Zabbix / Компонент 3", reversed: true, label: "чтение", tech: "SQL" },
      { nodePath: "Плагин / Датасорс", toPath: null, reversed: false, label: "", tech: "" },
    ]);
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} start={из} />);
    expect(screen.getAllByRole("combobox")[0]!).toHaveValue("Zabbix / Компонент 3");
    expect(screen.getByLabelText("Описание связи от «Плагин»")).toHaveValue("чтение");
  });
});

describe("ObjectCombobox: список поверх окна (фаза 8б)", () => {
  // jsdom раскладку не считает: прямоугольник поля и высоту содержимого списка задаём сами.
  // Экран jsdom — 1024×768.
  // Высота содержимого списка — своим свойством прототипа HTMLElement (у jsdom она 0 и
  // живёт на Element.prototype); после теста свойство снимается.
  afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight"); });

  function открыть(rect: { top: number; left: number; width: number }, высота = 600) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("rq-cbo-list") ? высота : 0; },
    });
    const onChange = vi.fn();
    render(<ObjectCombobox items={дерево(30)} value={null} onChange={onChange} label="Сосед" />);
    const поле = screen.getByRole("combobox");
    const прямоугольник = { ...rect };
    поле.getBoundingClientRect = () => ({
      top: прямоугольник.top, bottom: прямоугольник.top + 30, left: прямоугольник.left,
      right: прямоугольник.left + прямоугольник.width, width: прямоугольник.width, height: 30,
      x: прямоугольник.left, y: прямоугольник.top, toJSON: () => ({}),
    }) as DOMRect;
    return {
      поле, прямоугольник, onChange,
      список: () => screen.getByRole("listbox"),
    };
  }

  it("снизу хватает места — под полем: ширина не меньше 320, высота не больше 320", async () => {
    const с = открыть({ top: 100, left: 40, width: 200 });
    await userEvent.click(с.поле);
    const s = с.список().style;
    expect(s.top).toBe("134px");
    expect(s.bottom).toBe("auto");
    expect(s.left).toBe("40px");
    expect(s.width).toBe("320px");
    expect(s.maxHeight).toBe("320px");
  });

  it("у нижнего края — над полем, нижним краем к полю; правый край экрана не переходит", async () => {
    const с = открыть({ top: 700, left: 900, width: 100 });
    await userEvent.click(с.поле);
    const s = с.список().style;
    // 768 − 700 + 4: нижний край списка в 4px над полем.
    expect(s.bottom).toBe("72px");
    expect(s.top).toBe("auto");
    expect(s.maxHeight).toBe("320px");
    // 1024 − 12 − 320: список прижат к правому краю экрана с полем 12px.
    expect(s.left).toBe("692px");
  });

  it("высота не больше свободного места до края экрана без 12px", async () => {
    const с = открыть({ top: 500, left: 40, width: 400 });
    await userEvent.click(с.поле);
    // Снизу 768 − 530 − 4 − 12 = 222 < 320 и меньше, чем сверху (484): список над полем.
    expect(с.список().style.bottom).toBe("272px");
    expect(с.список().style.width).toBe("400px");
    cleanup();
    const м = открыть({ top: 500, left: 40, width: 400 }, 120);
    await userEvent.click(м.поле);
    // Короткий список помещается снизу: под полем, предел — свободное место (222).
    expect(м.список().style.top).toBe("534px");
    expect(м.список().style.maxHeight).toBe("222px");
  });

  it("прокрутка тела окна двигает список за полем, прокрутка списка его не закрывает", async () => {
    const с = открыть({ top: 100, left: 40, width: 200 });
    await userEvent.click(с.поле);
    с.прямоугольник.top = 60;
    fireEvent.scroll(document.body);
    expect(с.список().style.top).toBe("94px");
    fireEvent.scroll(с.список());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("щелчок по строке выбирает её, Escape закрывает только список", async () => {
    const выше = vi.fn();
    document.addEventListener("keydown", выше);
    const с = открыть({ top: 100, left: 40, width: 200 });
    await userEvent.click(с.поле);
    await userEvent.click(within(с.список()).getByRole("option", { name: /Компонент 3$/ }));
    expect(с.onChange).toHaveBeenCalledWith("Zabbix / Компонент 3");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    выше.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(выше).not.toHaveBeenCalled();
    document.removeEventListener("keydown", выше);
  });

  it("подсвеченная клавиатурой строка прокручивается в вид списка", async () => {
    const вид = vi.spyOn(Element.prototype, "scrollIntoView");
    const с = открыть({ top: 100, left: 40, width: 200 });
    await userEvent.click(с.поле);
    вид.mockClear();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(вид).toHaveBeenCalledWith({ block: "nearest" });
    expect(вид.mock.contexts.at(-1)).toHaveClass("rq-cbo-row--on");
    expect(вид.mock.contexts.at(-1)).toHaveTextContent("Компонент 3");
    вид.mockRestore();
  });
});

const пара: FuzzyPairOut = {
  id: "pair|Пользователь Zabbix|Пользователь",
  a_path: "Пользователь Zabbix", b_path: "Пользователь",
  a_source: "Из файла zabbix.yaml", b_source: "Из проекта",
  a_edges: 2, b_edges: 1, where: "на верхнем уровне", a_current: false, b_current: true,
};

function MergeStepStand({ onApply }: { onApply: (name: string) => void }) {
  const [draft, setDraft] = useState<MergeDraft>(mergeDraftFor(пара, null));
  return <MergeNameStep pair={пара} draft={draft} onDraft={setDraft} onApply={onApply} onBack={vi.fn()} />;
}

describe("MergeNameStep (§4.5, шаг 2)", () => {
  it("подписывает имена только источником, у «Своё имя» подписи нет; без «·» (фаза 8б)", () => {
    render(<MergeStepStand onApply={vi.fn()} />);
    expect(screen.getByText("Из файла zabbix.yaml")).toBeInTheDocument();
    expect(screen.getByText("Из проекта")).toBeInTheDocument();
    // Сумму связей называет строка контекста над шагом, в вариантах числа связей нет.
    expect(document.body.textContent).not.toMatch(/связ/);
    expect(document.body.textContent).not.toContain("ни одно из двух не годится");
    expect(screen.getByRole("button", { name: "Своё имя" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("·");
  });

  it("«Назад к вопросу» есть всегда и ничего не отдаёт", async () => {
    const onApply = vi.fn();
    const onBack = vi.fn();
    render(<MergeNameStep pair={пара} draft={mergeDraftFor(пара, "Пользователь")} onDraft={vi.fn()} onApply={onApply} onBack={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: "Назад к вопросу" }));
    expect(onBack).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("кнопки нового языка: «Объединить» первой, «Назад к вопросу» за ней; поле ds-input", async () => {
    render(<MergeStepStand onApply={vi.fn()} />);
    const кнопки = [screen.getByRole("button", { name: "Объединить" }), screen.getByRole("button", { name: "Назад к вопросу" })];
    expect(кнопки[0]).toHaveClass("ds-btn", "ds-btn--primary");
    expect(кнопки[1]).toHaveClass("ds-btn");
    expect(кнопки[1]).not.toHaveClass("ds-btn--primary");
    expect(кнопки[0]!.compareDocumentPosition(кнопки[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByText("Своё имя"));
    expect(screen.getByLabelText("Своё имя")).toHaveClass("ds-input");
  });

  it("своё имя: пока пусто — «Объединить» неактивна, потом отдаёт введённое", async () => {
    const onApply = vi.fn();
    render(<MergeStepStand onApply={onApply} />);
    await userEvent.click(screen.getByText("Своё имя"));
    const склеить = screen.getByRole("button", { name: "Объединить" });
    expect(склеить).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Своё имя"), "Оператор мониторинга");
    await userEvent.click(склеить);
    expect(onApply).toHaveBeenCalledWith("Оператор мониторинга");
  });

  it("по умолчанию склеивает под именем A", async () => {
    const onApply = vi.fn();
    render(<MergeStepStand onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: "Объединить" }));
    expect(onApply).toHaveBeenCalledWith("Пользователь Zabbix");
  });

  it("черновик узнаёт уже выбранное имя", () => {
    expect(mergeDraftFor(пара, "Пользователь")).toEqual({ pick: "b", own: "" });
    expect(mergeDraftFor(пара, "Оператор")).toEqual({ pick: "own", own: "Оператор" });
    expect(mergeDraftFor(пара, null)).toEqual({ pick: "a", own: "" });
  });
});

describe("DocViewer (§5.5, Р8)", () => {
  const вьюер = (props: Partial<Parameters<typeof DocViewer>[0]> = {}) => {
    const onClose = vi.fn();
    const onPick = vi.fn();
    const { unmount } = render(
      <DocViewer
        title="Оформление заказа" source="Из файла zabbix.yaml"
        body="flowchart TD" diagram onPick={onPick} onClose={onClose} {...props}
      />,
    );
    return { onClose, onPick, unmount };
  };

  it("рисует схему логики и называет ключ с источником: два элемента, без «·» и тега", () => {
    вьюер();
    expect(screen.getByTestId("mmd")).toHaveTextContent("flowchart TD");
    expect(screen.getByText("Оформление заказа")).toHaveClass("rq-ov-t");
    expect(screen.getByText("Из файла zabbix.yaml")).toHaveClass("rq-ov-src");
    const окно = screen.getByRole("dialog", { name: "Оформление заказа" });
    // Шапка — только название и источник: ни «·», ни тега формата.
    expect(окно.querySelector(".rq-ov-hd")?.textContent).toBe("Оформление заказаИз файла zabbix.yaml");
    // Корень — в области нового языка, крестик — кнопка-значок.
    expect(окно.closest(".rq-ov")).toHaveClass("ds");
    expect(within(окно.querySelector(".rq-ov-hd") as HTMLElement).getByRole("button", { name: "Закрыть" }))
      .toHaveClass("ds-icon-btn");
  });

  it("подвал: «Выбрать этот вариант» первой, «Закрыть» за ней", () => {
    вьюер();
    const подвал = document.querySelector(".rq-ov-ft") as HTMLElement;
    const кнопки = within(подвал).getAllByRole("button");
    expect(кнопки.map((b) => b.textContent)).toEqual(["Выбрать этот вариант", "Закрыть"]);
    expect(кнопки[0]).toHaveClass("ds-btn", "ds-btn--primary");
    expect(кнопки[1]).toHaveClass("ds-btn");
    expect(кнопки[1]).not.toHaveClass("ds-btn--primary");
  });

  it("не-схему показывает текстом", () => {
    вьюер({ diagram: false, body: "PGHOST=localhost" });
    expect(screen.queryByTestId("mmd")).toBeNull();
    expect(screen.getByText("PGHOST=localhost")).toBeInTheDocument();
  });

  it("«Выбрать этот вариант» отвечает на вопрос", async () => {
    const { onPick } = вьюер();
    await userEvent.click(screen.getByRole("button", { name: "Выбрать этот вариант" }));
    expect(onPick).toHaveBeenCalled();
  });

  it("закрывается кнопкой и крестиком", async () => {
    const { onClose } = вьюер();
    // Крестик в шапке и «Закрыть» в подвале — два пути к одному выходу.
    const выходы = screen.getAllByRole("button", { name: "Закрыть" });
    expect(выходы).toHaveLength(2);
    for (const кнопка of выходы) await userEvent.click(кнопка);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("колёсико над сценой прокручивает, Ctrl с колёсиком зумит; окно под ним не прокручивается (П9)", () => {
    вьюер();
    const сцена = document.querySelector(".doc-pvstage");
    expect(сцена).not.toBeNull();
    expect(screen.getByText("100%")).toBeInTheDocument();
    // fireEvent возвращает false, когда обработчик погасил дефолт: окно под
    // вьюером не прокручивается (хук вешает wheel с passive:false). Колёсико без
    // Ctrl масштаб не меняет (редизайн, фаза 7а: колесо прокручивает схему).
    expect(fireEvent.wheel(сцена as Element, { deltaY: -100 })).toBe(false);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(fireEvent.wheel(сцена as Element, { deltaY: -100, ctrlKey: true })).toBe(false);
    expect(screen.getByText("115%")).toBeInTheDocument();
    // Кнопки пилюли — те же, что у превью доков.
    expect(screen.getByLabelText("Уменьшить")).toBeInTheDocument();
    expect(screen.getByLabelText("Вписать")).toBeInTheDocument();
  });

  it("текстовое тело сцены не заводит — зумить нечего", () => {
    вьюер({ diagram: false, body: "PGHOST=localhost" });
    expect(document.querySelector(".doc-pvstage")).toBeNull();
  });

  it("Escape закрывает вьюер и НЕ уходит в окно под ним", () => {
    const { onClose } = вьюер();
    const выше = vi.fn();
    window.addEventListener("keydown", выше);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    window.removeEventListener("keydown", выше);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Именно эти два факта защищают окно снизу: отменённый дефолт гасит запрос
    // браузера на закрытие <dialog>, остановленное всплытие — слушателей выше.
    expect(ev.defaultPrevented).toBe(true);
    expect(выше).not.toHaveBeenCalled();
  });

  it("снятый вьюер клавишу больше не слушает", () => {
    const { onClose, unmount } = вьюер();
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
