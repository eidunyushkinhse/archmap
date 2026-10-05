// Двойной клик по узлу — его панель свойств (решение пользователя 2026-10-05):
//   • плашка «🔍 имя ✕» раскрытой рамки по одиночному клику сворачивает рамку — но
//     после окна двойного клика: двойной клик по плашке открывает узел рамки в панели и
//     рамку не сворачивает; ✕ сворачивает сразу;
//   • панель гостя ведёт на страницу узла разделом «Документация → Открыть» (двойной клик
//     по гостю сам больше не уводит); у пользователя (person) документации нет.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeTypes } from "../graph/nodes";
import GhostInspector from "../inspector/GhostInspector";
import type { GhostNode } from "../../types";

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
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("одиночный клик сворачивает — после окна двойного клика", () => {
    const onCollapse = vi.fn();
    const plaque = renderFrame(onCollapse);
    fireEvent.click(plaque, { detail: 1 });
    expect(onCollapse).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("двойной клик рамку не сворачивает (он открывает её узел в панели)", () => {
    const onCollapse = vi.fn();
    const plaque = renderFrame(onCollapse);
    fireEvent.click(plaque, { detail: 1 });
    fireEvent.click(plaque, { detail: 2 });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("✕ сворачивает сразу", () => {
    const onCollapse = vi.fn();
    renderFrame(onCollapse);
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });
});

describe("панель гостя: «Документация → Открыть»", () => {
  const ghost = (over: Partial<GhostNode> = {}): GhostNode => ({
    id: "g1", name: "Банк", role: null, technology: null, is_external: true, shape: "service",
    status: "existing", node_depth: 0, has_children: false, child_count: 0, ancestors: [], is_ghost: true,
    ...over,
  });

  it("«Открыть» ведёт на страницу узла", () => {
    const onNavigateNode = vi.fn();
    render(<GhostInspector ghost={ghost()} onGoToSource={vi.fn()} onNavigateNode={onNavigateNode} />);
    expect(screen.getByText("Документация")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    expect(onNavigateNode).toHaveBeenCalledWith("g1");
  });

  it("у пользователя документации нет", () => {
    render(<GhostInspector ghost={ghost({ shape: "person" })} onGoToSource={vi.fn()} onNavigateNode={vi.fn()} />);
    expect(screen.queryByText("Документация")).toBeNull();
  });
});
