// Вход в экран редактора схемы из строки заголовка раздела «Схема» (EmbeddedSchemaBlock,
// проп onEdit). Страховочная сетка фазы 13д редизайна: кнопка стоит в блоке действий строки
// справа от вкладок вида, несёт цель обучения data-tour="schema-edit" и зовёт onEdit; без
// onEdit кнопки нет. Холст заглушён: здесь проверяется разметка строки заголовка.
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EmbeddedSchemaBlock from "../EmbeddedSchemaBlock";
import type { Node } from "../../types";

vi.mock("../LevelGraph", () => ({ default: () => <div data-testid="level-graph" /> }));
vi.mock("../SchemaViewFilter", () => ({ SchemaViewFilter: () => <div data-testid="view-tabs" /> }));

const nodes = [{ id: "n1", name: "Заказы", shape: "service" }] as Node[];

function mount(over: { isArchitect: boolean; onEdit?: () => void; showViewFilter?: boolean }) {
  return render(
    <EmbeddedSchemaBlock
      title="Схема"
      nodes={nodes}
      endpoints={[]}
      edges={[]}
      viewLayout={{}}
      containerId={null}
      ancestorNames={[]}
      ancestorIds={[]}
      ancestorElements={[]}
      depth={0}
      isArchitect={over.isArchitect}
      schemaView="all"
      onSchemaViewChange={vi.fn()}
      onNavigateNode={vi.fn()}
      onEdit={over.onEdit}
      height={400}
      showViewFilter={over.showViewFilter ?? true}
    />,
  );
}

const head = (c: HTMLElement) => c.querySelector(".ds-sec-head") as HTMLElement;

describe("EmbeddedSchemaBlock: вход в экран схемы из строки заголовка", () => {
  it("архитектор с onEdit: «Редактировать» после вкладок вида, ds-btn с целью обучения, зовёт onEdit", async () => {
    const onEdit = vi.fn();
    const { container } = mount({ isArchitect: true, onEdit });
    const acts = head(container).querySelector(".ds-sec-acts") as HTMLElement;
    expect(acts).not.toBeNull();
    const btn = within(acts).getByRole("button", { name: "Редактировать" });
    expect(btn.className).toBe("ds-btn");
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).toHaveAttribute("data-tour", "schema-edit");
    expect(btn).not.toHaveAttribute("style");
    // Порядок в строке: вкладки вида, затем кнопка (правый край строки).
    expect(acts.lastElementChild).toBe(btn);
    expect(within(acts).getByTestId("view-tabs").compareDocumentPosition(btn) & document.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(btn);
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("архитектор без onEdit: кнопки нет; без вкладок вида нет и блока действий", () => {
    const { container } = mount({ isArchitect: true, showViewFilter: false });
    expect(head(container).querySelectorAll("button")).toHaveLength(0);
    expect(head(container).querySelector(".ds-sec-acts")).toBeNull();
    expect(container.querySelector('[data-tour="schema-edit"]')).toBeNull();
  });

  it("читатель без onEdit: кнопки нет", () => {
    const { container } = mount({ isArchitect: false, showViewFilter: false });
    expect(head(container).querySelectorAll("button")).toHaveLength(0);
    expect(head(container).querySelector(".ds-sec-acts")).toBeNull();
  });

  it("читатель с onEdit: в строке заголовка только вкладки вида, кнопки нет", () => {
    const { container } = mount({ isArchitect: false, onEdit: vi.fn() });
    expect(head(container).querySelectorAll("button")).toHaveLength(0);
    expect(within(head(container)).getByTestId("view-tabs")).toBeInTheDocument();
    expect(container.querySelector('[data-tour="schema-edit"]')).toBeNull();
  });

  it("читатель с onEdit без вкладок вида: блока действий нет", () => {
    const { container } = mount({ isArchitect: false, onEdit: vi.fn(), showViewFilter: false });
    expect(head(container).querySelector(".ds-sec-acts")).toBeNull();
  });
});
