// Тост поверх встроенной схемы (EmbeddedSchemaBlock, проп notice; редизайн, фаза 13б, хвост
// приёмки 13а): «Схему только что изменили в другом окне» стоит ВНУТРИ рамки схемы, а не на
// строке заголовка раздела. Вид — тост нового языка (ds-toast, место ds-toast--frame), без
// роли и инлайн-стиля; есть и у пустой схемы. Холст заглушён: здесь проверяется разметка
// блока, а не конвейер раскладки.
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EmbeddedSchemaBlock from "../EmbeddedSchemaBlock";
import type { Node } from "../../types";

vi.mock("../LevelGraph", () => ({ default: () => <div data-testid="level-graph" /> }));

const TEXT = "Схему только что изменили в другом окне";
const nodes = [{ id: "n1", name: "Заказы", shape: "service" }] as Node[];

function mount(over: { notice?: string | null; empty?: ReactNode } = {}) {
  return render(
    <EmbeddedSchemaBlock
      title="Схема"
      nodes={over.empty ? [] : nodes}
      endpoints={[]}
      edges={[]}
      viewLayout={{}}
      containerId={null}
      ancestorNames={[]}
      ancestorIds={[]}
      ancestorElements={[]}
      depth={0}
      isArchitect
      schemaView="all"
      onSchemaViewChange={vi.fn()}
      onNavigateNode={vi.fn()}
      onEdit={vi.fn()}
      height={400}
      showViewFilter
      empty={over.empty}
      notice={over.notice}
    />,
  );
}

describe("EmbeddedSchemaBlock: тост внутри рамки схемы", () => {
  it("notice задан: тост в рамке схемы, не в строке заголовка; без роли и инлайн-стиля", () => {
    const { container } = mount({ notice: TEXT });
    const toast = screen.getByText(TEXT);
    expect(toast).toHaveClass("ds-toast", "ds-toast--frame");
    expect(toast).not.toHaveAttribute("style");
    expect(toast).not.toHaveAttribute("role");
    expect(toast).not.toHaveAttribute("aria-live");
    expect(toast.parentElement).toHaveClass("esb-wrap");
    expect(container.querySelector(".ds-sec-head")).not.toContainElement(toast);
    // Холст и слой активации остаются на месте: тост их не заменяет.
    expect(screen.getByTestId("level-graph")).toBeInTheDocument();
    expect(container.querySelector(".esb-activate")).not.toBeNull();
  });

  it("notice пуст или не задан: тоста нет", () => {
    const { container, rerender } = mount({ notice: null });
    expect(container.querySelector(".ds-toast")).toBeNull();
    rerender(
      <EmbeddedSchemaBlock
        title="Схема" nodes={nodes} endpoints={[]} edges={[]} viewLayout={{}} containerId={null}
        ancestorNames={[]} ancestorIds={[]} ancestorElements={[]} depth={0} isArchitect
        schemaView="all" onSchemaViewChange={vi.fn()} onNavigateNode={vi.fn()} height={400} showViewFilter={false}
      />,
    );
    expect(container.querySelector(".ds-toast")).toBeNull();
  });

  it("пустая схема: тост тоже в рамке, рядом с пустым состоянием", () => {
    mount({ notice: TEXT, empty: <span>Схема пуста</span> });
    const toast = screen.getByText(TEXT);
    expect(toast).toHaveClass("ds-toast", "ds-toast--frame");
    expect(toast.parentElement).toHaveClass("esb-wrap");
    expect(toast.parentElement).toContainElement(screen.getByText("Схема пуста"));
    expect(screen.queryByTestId("level-graph")).toBeNull();
  });
});
