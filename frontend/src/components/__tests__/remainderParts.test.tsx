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
import type { NewEdgeAnswer } from "../project/remainder/questions";
import { EMPTY_EDGE_DRAFT, mergeDraftFor } from "../project/remainder/drafts";
import type { EdgeDraft, MergeDraft } from "../project/remainder/drafts";
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
});

// Стенды с черновиком в состоянии вызывающего — ровно так формы держит блок
// (§4.6). Имена латиницей: правило react-hooks/rules-of-hooks узнаёт компонент
// по заглавной ЛАТИНСКОЙ букве и на кириллице ругается.
function EdgeFormStand({ onAdd, onBack }: { onAdd: (a: NewEdgeAnswer) => void; onBack: () => void }) {
  const [draft, setDraft] = useState<EdgeDraft>(EMPTY_EDGE_DRAFT);
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

describe("NewEdgeForm (§5.4)", () => {
  it("«Добавить связь» неактивна, пока нет обоих концов", async () => {
    render(<EdgeFormStand onAdd={vi.fn()} onBack={vi.fn()} />);
    const кнопка = screen.getByRole("button", { name: "Добавить связь" });
    expect(кнопка).toBeDisabled();
    // Пикер открыт на «Начале», после выбора сам переходит на «Конец».
    await userEvent.click(screen.getByText("Компонент 1"));
    expect(кнопка).toBeDisabled();
    expect(screen.getByText("выбираете")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Плагин"));
    expect(кнопка).toBeEnabled();
    // Оба конца выбраны — пикер закрылся, список объектов больше не висит.
    expect(screen.queryByText("Компонент 2")).toBeNull();
  });

  it("отдаёт связь с подписью, технологией и типом канала", async () => {
    const onAdd = vi.fn();
    render(<EdgeFormStand onAdd={onAdd} onBack={vi.fn()} />);
    await userEvent.click(screen.getByText("Компонент 1"));
    await userEvent.click(screen.getByText("Плагин"));
    await userEvent.type(screen.getByLabelText("Подпись"), "метрики");
    await userEvent.type(screen.getByLabelText("Технология"), "HTTP");
    await userEvent.click(screen.getByRole("button", { name: "Асинхронный" }));
    await userEvent.click(screen.getByRole("button", { name: "Добавить связь" }));
    expect(onAdd).toHaveBeenCalledWith({
      kind: "new_edge", fromPath: "Zabbix / Компонент 1", toPath: "Плагин",
      label: "метрики", tech: "HTTP", channel: "async",
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
