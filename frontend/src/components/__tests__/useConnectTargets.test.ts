// Цель протяжки новой связи (useConnectTargets.resolveTarget) — характеризация Ф0 эпика
// «Элемент архитектуры» (docs/plan-c4-elements.md). Норма, которую эпик НЕ меняет
// (решение 2026-10-29, Р22): связь в объект с вложенными замкнуть на него самого нельзя —
// отпускание открывает выбор потомка (into); лист и гость связываются напрямую (direct).
// Зона входа — только сервис с детьми: база или брокер с детьми связываются напрямую.
import { renderHook } from "@testing-library/react";
import type { Node as RFNode } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { useConnectTargets } from "../graph/interaction/useConnectTargets";
import type { BlockData, ContainerData, FrameData, GhostData } from "../graph/types";
import type { GhostNode, Node as AppNode } from "../../types";

const appNode = (id: string, over: Partial<AppNode> = {}): AppNode => ({
  id, name: id, description: null, role: null, technology: null, parent_id: null,
  shape: "service", is_external: false, status: "existing", openapi_spec: null,
  version: 1, docs: [], has_children: false, child_count: 0, created_at: "", updated_at: "",
  ...over,
}) as AppNode;

const block = (id: string, over: Partial<AppNode> = {}): RFNode =>
  ({ id, type: "block", position: { x: 0, y: 0 }, data: { appNode: appNode(id, over) } as unknown as BlockData });

const rfNodes: RFNode[] = [
  block("Ядро", { has_children: true, child_count: 3 }),
  block("Платежи"),
  block("Склад", { shape: "database", has_children: true, child_count: 1 }),
  block("Kafka", { shape: "broker" }),
  {
    id: "Гость", type: "ghost", position: { x: 0, y: 0 },
    data: { appNode: { id: "Гость", name: "Гость", has_children: true, shape: "service" } as GhostNode } as unknown as GhostData,
  },
  {
    id: "Витрина", type: "container", position: { x: 0, y: 0 },
    data: { id: "Витрина", name: "Витрина", depth: 1, ancestors: [] } as unknown as ContainerData,
  },
  { id: "Рамка", type: "frame", position: { x: 0, y: 0 }, data: { name: "Рамка" } as FrameData },
  { id: "Распорка", type: "spacer", position: { x: 0, y: 0 }, data: {} },
];

const targets = () => renderHook(() => useConnectTargets(rfNodes)).result.current;

describe("useConnectTargets", () => {
  it("узел с детьми и свёрнутый гостевой контейнер — зона входа (выбор потомка)", () => {
    const { resolveTarget } = targets();
    expect(resolveTarget("Ядро")).toEqual({ kind: "into", name: "Ядро" });
    expect(resolveTarget("Витрина")).toEqual({ kind: "into", name: "Витрина" });
  });

  it("лист, база и брокер (даже с детьми) и гость — напрямую", () => {
    const { resolveTarget } = targets();
    expect(resolveTarget("Платежи")).toEqual({ kind: "direct" });
    expect(resolveTarget("Склад")).toEqual({ kind: "direct" });
    expect(resolveTarget("Kafka")).toEqual({ kind: "direct" });
    expect(resolveTarget("Гость")).toEqual({ kind: "direct" });
  });

  it("рамка, распорка и неизвестный id — не цель", () => {
    const { resolveTarget } = targets();
    expect(resolveTarget("Рамка")).toBeNull();
    expect(resolveTarget("Распорка")).toBeNull();
    expect(resolveTarget("нет-такого")).toBeNull();
  });

  it("имя отображаемого узла — у блока, гостя и контейнера; у рамки нет", () => {
    const { displayNameOf } = targets();
    expect(displayNameOf("Ядро")).toBe("Ядро");
    expect(displayNameOf("Гость")).toBe("Гость");
    expect(displayNameOf("Витрина")).toBe("Витрина");
    expect(displayNameOf("Рамка")).toBeUndefined();
  });
});
