// Примитивы блока разбора остатка (§5 ТЗ): список объектов, форма новой связи,
// шаг имени склейки и вьюер тела кандидата.
//
// Что закрепляем: кап списка и фильтр (в крупной системе путей сотни, а решение
// принимается по первым строкам); форма новой связи не отдаёт ответ, пока нет
// обоих концов, и сама переходит на конец после выбора начала; «Склеить» со
// своим именем отдаёт именно его; Escape закрывает ВЬЮЕР и не уходит выше — под
// ним нативный <dialog> окна, который иначе закрылся бы заодно.
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type { ComponentOut, FuzzyPairOut } from "../../types";
import type { NewEdgesAnswer } from "../project/remainder/questions";
import { draftFromAnswer, emptyEdgesDraft, mergeDraftFor } from "../project/remainder/drafts";
import type { EdgesDraft, MergeDraft } from "../project/remainder/drafts";
import ObjectList from "../project/remainder/ObjectList";
import NewEdgeForm from "../project/remainder/NewEdgeForm";
import MergeNameStep from "../project/remainder/MergeNameStep";
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
    await userEvent.click(screen.getByRole("button", { name: "Показать остальные 3" }));
    expect(screen.getByText("Компонент 7")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Показать остальные/ })).toBeNull();
  });

  it("у контейнера — тег, у пути — серый префикс и полужирный хвост", () => {
    render(<ObjectList items={[{ path: "Grafana / Сервер / Рантайм", has_children: true }]} base="Grafana" onPick={vi.fn()} />);
    expect(screen.getByText("контейнер")).toBeInTheDocument();
    expect(screen.getByText("Сервер /")).toBeInTheDocument();
    expect(screen.getByText("Рантайм").tagName).toBe("B");
  });

  it("фильтр сужает список, а пустой ответ говорит словами", async () => {
    render(<ObjectList items={[...дерево(6), { path: "Zabbix / Поллер", has_children: false }]} onPick={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Показать остальные/ }));
    const поле = screen.getByLabelText("Фильтр по имени");
    expect(поле).toHaveAttribute("placeholder", "Фильтр по имени — 7 объектов");
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

describe("NewEdgeForm (§5.4, переделана по приёмке)", () => {
  it("строка на каждый объект группы: видно, у кого связей нет", () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    // Левые поля — сами объекты группы, они не редактируются.
    expect(screen.getByText("Плагин")).toBeInTheDocument();
    expect(screen.getByText("Датасорс")).toBeInTheDocument();
    expect(screen.getAllByText("Выберите объект")).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Описание связи/)).toHaveLength(2);
    // Типа канала в форме нет вовсе — его задают в «Процессах».
    expect(screen.queryByText("Синхронный")).toBeNull();
    expect(screen.queryByText("Асинхронный")).toBeNull();
  });

  it("«Провести связь» неактивна, пока не выбран ни один сосед", async () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    const кнопка = () => screen.getByRole("button", { name: /^Провести связ/ });
    expect(кнопка()).toBeDisabled();
    await userEvent.click(screen.getAllByText("Выберите объект")[0]!);
    // Дропдаун соседа открыт сразу с полем поиска и без капа.
    expect(screen.getByLabelText("Фильтр по имени")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Компонент 1"));
    expect(кнопка()).toBeEnabled();
    expect(кнопка().textContent).toBe("Провести связь");
    // После выбора список свернулся, в поле — выбранный объект.
    expect(screen.queryByLabelText("Фильтр по имени")).toBeNull();
  });

  it("сам объект в соседи не предлагается, а поиск сужает список", async () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    await userEvent.click(screen.getAllByText("Выберите объект")[0]!);
    // Строка «Плагина» — своего же пути в списке нет.
    expect(screen.queryByRole("button", { name: /^Плагин$/ })).toBeNull();
    await userEvent.type(screen.getByLabelText("Фильтр по имени"), "компонент 2");
    expect(screen.getByText("Компонент 2")).toBeInTheDocument();
    expect(screen.queryByText("Компонент 1")).toBeNull();
  });

  it("направление переворачивается кнопкой между полями", async () => {
    const onAdd = vi.fn();
    render(<EdgeFormStand onAdd={onAdd} onBack={vi.fn()} />);
    await userEvent.click(screen.getAllByText("Выберите объект")[0]!);
    await userEvent.click(screen.getByText("Компонент 1"));
    const стрелки = screen.getAllByRole("button", { name: "Поменять направление" });
    expect(стрелки[0]!.textContent).toBe("→");
    await userEvent.click(стрелки[0]!);
    expect(screen.getAllByRole("button", { name: "Поменять направление" })[0]!.textContent).toBe("←");
    await userEvent.click(screen.getByRole("button", { name: /^Провести связ/ }));
    expect(onAdd).toHaveBeenCalledWith({
      kind: "new_edges",
      edges: [{ fromPath: "Zabbix / Компонент 1", toPath: "Плагин", label: "", tech: "" }],
    });
  });

  it("отдаёт по связи на заполненную строку, пустые пропускает", async () => {
    const onAdd = vi.fn();
    render(<EdgeFormStand onAdd={onAdd} onBack={vi.fn()} />);
    await userEvent.click(screen.getAllByText("Выберите объект")[0]!);
    await userEvent.click(screen.getByText("Компонент 1"));
    await userEvent.type(screen.getByLabelText("Описание связи — Плагин"), "метрики");
    await userEvent.type(screen.getByLabelText("Технология связи — Плагин"), "HTTP");
    await userEvent.click(screen.getByText("Выберите объект"));
    await userEvent.click(screen.getByText("Компонент 2"));
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
    expect(screen.getAllByRole("button", { name: "Поменять направление" })[0]!.textContent).toBe("←");
    expect(screen.getByLabelText("Описание связи — Плагин")).toHaveValue("чтение");
  });
});

const пара: FuzzyPairOut = {
  id: "pair|Пользователь Zabbix|Пользователь",
  a_path: "Пользователь Zabbix", b_path: "Пользователь",
  a_source: "От агента Zabbix", b_source: "Из проекта",
  a_edges: 2, b_edges: 1, where: "на верхнем уровне", a_current: false, b_current: true,
};

function MergeStepStand({ onApply }: { onApply: (name: string) => void }) {
  const [draft, setDraft] = useState<MergeDraft>(mergeDraftFor(пара, null));
  return <MergeNameStep pair={пара} draft={draft} onDraft={setDraft} onApply={onApply} onBack={vi.fn()} />;
}

describe("MergeNameStep (§4.5, шаг 2)", () => {
  it("подписывает варианты источником и числом связей", () => {
    render(<MergeStepStand onApply={vi.fn()} />);
    expect(screen.getByText("От агента Zabbix · 2 связи")).toBeInTheDocument();
    expect(screen.getByText("Из проекта · 1 связь")).toBeInTheDocument();
  });

  it("своё имя: пока пусто — «Склеить» неактивна, потом отдаёт введённое", async () => {
    const onApply = vi.fn();
    render(<MergeStepStand onApply={onApply} />);
    await userEvent.click(screen.getByText("Своё имя"));
    const склеить = screen.getByRole("button", { name: "Склеить" });
    expect(склеить).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Своё имя"), "Оператор мониторинга");
    await userEvent.click(склеить);
    expect(onApply).toHaveBeenCalledWith("Оператор мониторинга");
  });

  it("по умолчанию склеивает под именем A", async () => {
    const onApply = vi.fn();
    render(<MergeStepStand onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: "Склеить" }));
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
        title="Оформление заказа" source="От агента Zabbix" tag="mermaid · flowchart"
        body="flowchart TD" diagram onPick={onPick} onClose={onClose} {...props}
      />,
    );
    return { onClose, onPick, unmount };
  };

  it("рисует схему логики и называет ключ с источником", () => {
    вьюер();
    expect(screen.getByTestId("mmd")).toHaveTextContent("flowchart TD");
    expect(screen.getByText(/Оформление заказа/)).toBeInTheDocument();
    expect(screen.getByText(/От агента Zabbix/)).toBeInTheDocument();
    expect(screen.getByText("mermaid · flowchart")).toBeInTheDocument();
  });

  it("не-схему показывает текстом", () => {
    вьюер({ diagram: false, body: "PGHOST=localhost", tag: "параметр" });
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
