// Бросок плитки палитры на схему (canvas.md CV20, view.md V27a): плитка несёт тип объекта
// (Р41 раздела 13 docs/plan-c4-elements.md), превью рисуется формой этого типа, отпускание
// отдаёт тип вызывающему; строка, которая не тип (чужой драг), ничего не создаёт. Цель
// броска проверяет тип (приёмка Ф12 2026-10-31, CV20c): место, где тип невозможен, объект
// не создаёт, а отдаёт отказ.
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { DragEvent } from "react";
import { useTemplateDrop } from "../graph/interaction/useTemplateDrop";
import { NODE_DRAG_MIME } from "../nodeTree.mime";
import type { NodeType } from "../nodeTerms";
import type { DropEligible } from "../graph/types";
import type { DropFrame } from "../graph/interaction/useTemplateDrop";

function dragEvent(raw: string): DragEvent {
  return {
    clientX: 300, clientY: 200,
    preventDefault: vi.fn(),
    dataTransfer: { types: [NODE_DRAG_MIME], getData: () => raw, dropEffect: "" },
  } as unknown as DragEvent;
}

function setup(dragType: NodeType | null, opts: { frames?: DropFrame[]; eligible?: DropEligible | null } = {}) {
  const onDropNode = vi.fn();
  const onDropRefused = vi.fn();
  const { result } = renderHook(() => useTemplateDrop({
    rfNodes: [], screenToFlowPosition: (p) => p,
    setGuides: vi.fn(), clearGuides: vi.fn(),
    isArchitect: true, disabled: false, onDropNode, dragType, expandedFrames: opts.frames ?? [],
    eligible: opts.eligible, onDropRefused,
  }));
  return { result, onDropNode, onDropRefused };
}

// Рамка под курсором (центр будущего узла — точка 300×200 событий) и рамка в стороне.
const under: DropFrame = { id: "orders", depth: 1, rect: { x: 200, y: 100, w: 300, h: 300 } };
const aside: DropFrame = { id: "billing", depth: 1, rect: { x: 900, y: 900, w: 300, h: 300 } };

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

describe("useTemplateDrop: цель броска проверяет тип", () => {
  it("тип невозможен на уровне, бросок мимо рамок — отказ уровня, объект не создаётся", () => {
    const { result, onDropNode, onDropRefused } = setup("component", {
      frames: [aside], eligible: { levelOk: false, frameIds: new Set(["billing"]) },
    });
    act(() => { result.current.handleDragOver(dragEvent("component")); });
    act(() => { result.current.handleDrop(dragEvent("component")); });
    expect(onDropNode).not.toHaveBeenCalled();
    expect(onDropRefused).toHaveBeenCalledWith("component", null);
    expect(result.current.dropPreview).toBeNull();
  });

  it("бросок в принимающую рамку — объект с родителем рамки", () => {
    const { result, onDropNode, onDropRefused } = setup("component", {
      frames: [under], eligible: { levelOk: false, frameIds: new Set(["orders"]) },
    });
    act(() => { result.current.handleDrop(dragEvent("component")); });
    expect(onDropRefused).not.toHaveBeenCalled();
    expect(onDropNode.mock.calls[0][0]).toBe("component");
    expect(onDropNode.mock.calls[0][2]).toBe("orders");
  });

  it("бросок в рамку, которая тип не принимает, — отказ этой рамки, даже если уровень его принимает", () => {
    const { result, onDropNode, onDropRefused } = setup("database", {
      frames: [under], eligible: { levelOk: true, frameIds: new Set() },
    });
    act(() => { result.current.handleDrop(dragEvent("database")); });
    expect(onDropNode).not.toHaveBeenCalled();
    expect(onDropRefused).toHaveBeenCalledWith("database", "orders");
  });

  it("без сведений о целях — как до приёмки: бросок открывает окно", () => {
    const { result, onDropNode, onDropRefused } = setup("component", { frames: [under], eligible: null });
    act(() => { result.current.handleDrop(dragEvent("component")); });
    expect(onDropRefused).not.toHaveBeenCalled();
    expect(onDropNode.mock.calls[0][2]).toBe("orders");
  });

  it("над запретным местом drop остаётся разрешён — иначе браузер не отдаст событие и отказа не будет", () => {
    const { result } = setup("component", { eligible: { levelOk: false, frameIds: new Set() } });
    const e = dragEvent("component");
    act(() => { result.current.handleDragOver(e); });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.dataTransfer.dropEffect).toBe("copy");
  });
});
