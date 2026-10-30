// Бросок плитки палитры на схему (canvas.md CV20, view.md V27a): плитка несёт тип объекта
// (Р41 раздела 13 docs/plan-c4-elements.md), превью рисуется формой этого типа, отпускание
// отдаёт тип вызывающему; строка, которая не тип (чужой драг), ничего не создаёт.
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { DragEvent } from "react";
import { useTemplateDrop } from "../graph/interaction/useTemplateDrop";
import { NODE_DRAG_MIME } from "../nodeTree.mime";
import type { NodeType } from "../nodeTerms";

function dragEvent(raw: string): DragEvent {
  return {
    clientX: 300, clientY: 200,
    preventDefault: vi.fn(),
    dataTransfer: { types: [NODE_DRAG_MIME], getData: () => raw, dropEffect: "" },
  } as unknown as DragEvent;
}

function setup(dragType: NodeType | null) {
  const onDropNode = vi.fn();
  const { result } = renderHook(() => useTemplateDrop({
    rfNodes: [], screenToFlowPosition: (p) => p,
    setGuides: vi.fn(), clearGuides: vi.fn(),
    isArchitect: true, disabled: false, onDropNode, dragType, expandedFrames: [],
  }));
  return { result, onDropNode };
}

describe("useTemplateDrop: тип объекта с плитки палитры", () => {
  it("превью — форма типа: система, контейнер и компонент рисуются сервисом", () => {
    for (const type of ["system", "container", "component"] as const) {
      const { result } = setup(type);
      act(() => { result.current.handleDragOver(dragEvent(type)); });
      expect(result.current.dropPreview?.shape).toBe("service");
    }
    const { result } = setup("broker");
    act(() => { result.current.handleDragOver(dragEvent("broker")); });
    expect(result.current.dropPreview?.shape).toBe("broker");
  });

  it("отпускание отдаёт тип и позицию на уровень (рамки под курсором нет)", () => {
    const { result, onDropNode } = setup("component");
    act(() => { result.current.handleDrop(dragEvent("component")); });
    expect(onDropNode).toHaveBeenCalledTimes(1);
    expect(onDropNode.mock.calls[0][0]).toBe("component");
    expect(onDropNode.mock.calls[0][2]).toBeNull();
  });

  it("строка, которая не тип объекта, ничего не создаёт", () => {
    const { result, onDropNode } = setup("system");
    act(() => { result.current.handleDrop(dragEvent("service")); });
    act(() => { result.current.handleDrop(dragEvent("")); });
    expect(onDropNode).not.toHaveBeenCalled();
  });
});
