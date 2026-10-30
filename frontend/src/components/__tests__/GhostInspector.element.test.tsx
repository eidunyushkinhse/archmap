// Инспектор гостя: строка «Элемент архитектуры» тем же вычислением, что у своего узла
// (Ф8 эпика docs/plan-c4-elements.md), только для чтения; у компонента имя контейнера —
// ссылка на его страницу, контейнер — из пути гостя. У «Пользователя» строки нет.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GhostInspector from "../inspector/GhostInspector";
import type { GhostNode } from "../../types";

const ghost = (over: Partial<GhostNode>): GhostNode => ({
  id: "g1", name: "api", role: null, technology: null, is_external: false,
  shape: "service", status: "existing", node_depth: 2, has_children: false,
  child_count: 0, element_effective: "container", ancestors: [], is_ghost: true, ...over,
});

describe("GhostInspector: элемент архитектуры", () => {
  it("система с детьми — «Система», лист — «Контейнер», у «Пользователя» строки нет", () => {
    const cases = [
      [ghost({ has_children: true, child_count: 2, element_effective: "system" }), "Система"],
      [ghost({}), "Контейнер"],
    ] as const;
    for (const [g, text] of cases) {
      const { unmount } = render(<GhostInspector ghost={g} onGoToSource={vi.fn()} onNavigateNode={vi.fn()} />);
      expect(screen.getByText("Элемент архитектуры").nextElementSibling).toHaveTextContent(text);
      unmount();
    }
    render(<GhostInspector ghost={ghost({ shape: "person", element_effective: null })} onGoToSource={vi.fn()} onNavigateNode={vi.fn()} />);
    expect(screen.queryByText("Элемент архитектуры")).not.toBeInTheDocument();
  });

  it("компонент — ссылка на контейнер из пути гостя", async () => {
    const onNavigateNode = vi.fn();
    render(
      <GhostInspector
        ghost={ghost({
          element_effective: "component",
          ancestors: [
            { id: "s", name: "Торговля", is_external: false, element_effective: "system" },
            { id: "c", name: "orders", is_external: false, element_effective: "container" },
          ],
        })}
        onGoToSource={vi.fn()}
        onNavigateNode={onNavigateNode}
      />,
    );
    expect(screen.getByText("Элемент архитектуры").nextElementSibling).toHaveTextContent("Компонент контейнера «orders»");
    await userEvent.click(screen.getByRole("button", { name: "«orders»" }));
    expect(onNavigateNode).toHaveBeenCalledWith("c");
  });
});
