// Двойной клик по узлу — его панель свойств (решение пользователя 2026-10-05):
//   • рамка раскрытого узла — не узел и в этом не участвует: клик по плашке «🔍 имя ✕»
//     сворачивает рамку сразу, как и прежде (попытка ждать двойного клика отменена
//     пользователем);
//   • панель гостя ведёт на страницу узла кнопкой заголовка «Открыть страницу объекта»
//     (двойной клик по гостю сам больше не уводит); у пользователя (person) страницы нет.
import { fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { ComponentType, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { nodeTypes } from "../graph/nodes";
import GhostInspector from "../inspector/GhostInspector";
import type { GhostNode } from "../../types";

// Плашка рамки рисуется порталом в слой плашек подписей холста (FramePlaque →
// EdgeLabelRenderer); холста здесь нет — портал подменён на рендер на месте.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, EdgeLabelRenderer: ({ children }: { children?: ReactNode }) => <>{children}</> };
});

const Frame = nodeTypes.frame as ComponentType<Partial<NodeProps>>;

function renderFrame(onCollapse: () => void) {
  render(
    <ReactFlowProvider>
      <Frame id="f1" data={{ name: "Маркетплейс", onCollapse }} />
    </ReactFlowProvider>,
  );
  // подсказку «Свернуть» несут и плашка, и её ✕ — нужна плашка
  return screen.getAllByTitle("Свернуть").find((el) => el.tagName === "DIV")!;
}

describe("плашка раскрытой рамки", () => {
  it("клик по плашке сворачивает сразу", () => {
    const onCollapse = vi.fn();
    fireEvent.click(renderFrame(onCollapse));
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("✕ сворачивает сразу", () => {
    const onCollapse = vi.fn();
    renderFrame(onCollapse);
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });
});

describe("панель гостя: «Открыть страницу объекта»", () => {
  const ghost = (over: Partial<GhostNode> = {}): GhostNode => ({
    id: "g1", name: "Банк", role: null, technology: null, is_external: true, shape: "service",
    status: "existing", node_depth: 0, has_children: false, child_count: 0, element_effective: "container",
    ancestors: [], is_ghost: true,
    ...over,
  });

  it("кнопка заголовка ведёт на страницу узла", () => {
    const onNavigateNode = vi.fn();
    render(<GhostInspector ghost={ghost()} onShowOnMap={vi.fn()} onNavigateNode={onNavigateNode} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Открыть страницу объекта" }));
    expect(onNavigateNode).toHaveBeenCalledWith("g1");
  });

  it("у пользователя страницы нет", () => {
    render(<GhostInspector ghost={ghost({ shape: "person" })} onShowOnMap={vi.fn()} onNavigateNode={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Открыть страницу объекта" })).toBeNull();
  });
});
