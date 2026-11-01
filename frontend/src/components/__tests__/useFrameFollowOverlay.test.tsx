// Оверлей рамок при драге ребёнка (container.md C17): у рамки в любой момент жеста ровно
// одна плашка. Плашка рамки живёт в слое подписей (C15), и прозрачность скрытой рамки до
// неё не доходит — рамка и плашка скрываются флагом FrameData.dragHidden, а оверлей рисует
// отражение плашки с крестиком (приёмка Ф12 2026-10-31: исходная плашка оставалась на месте,
// а за рамкой ехала вторая, без крестика).
import { act, render } from "@testing-library/react";
import { ReactFlowProvider, type Node as RFNode, type NodeProps } from "@xyflow/react";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFrameFollowOverlay } from "../graph/interaction/useFrameFollowOverlay";
import { nodeTypes } from "../graph/nodes";
import type { FrameData } from "../graph/types";

// Плашка рамки рисуется порталом в слой подписей холста; холста здесь нет — портал подменён
// на рендер на месте (как в nodes.projection.test.tsx).
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, EdgeLabelRenderer: ({ children }: { children?: ReactNode }) => <>{children}</> };
});

const Frame = nodeTypes.frame as ComponentType<Partial<NodeProps>>;

const frameData = (over: Partial<FrameData> = {}): FrameData => ({
  name: "Склад", element: "container", depth: 0, is_external: false, onCollapse: () => {}, ...over,
});

// Рамка «Склад» с одним ребёнком внутри.
const scene = (frame: Partial<FrameData> = {}): RFNode[] => [
  { id: "F", type: "frame", position: { x: 100, y: 100 }, width: 300, height: 200, data: frameData(frame) },
  { id: "A", type: "block", parentId: "F", position: { x: 40, y: 50 }, width: 190, height: 100, data: {} },
];

// Хук живёт в компоненте: стейт узлов — настоящий useState, оверлей рендерится на месте;
// хук и узлы текущего рендера тест читает через probe (наполняется эффектом, не в рендере).
type Api = ReturnType<typeof useFrameFollowOverlay>;
const probe: { api: Api | null; nodes: RFNode[] } = { api: null, nodes: [] };
function Harness({ initial }: { initial: RFNode[] }) {
  const [rfNodes, setRfNodes] = useState<RFNode[]>(initial);
  const api = useFrameFollowOverlay({ rfNodes, setRfNodes, getNodes: () => rfNodes });
  useEffect(() => { probe.api = api; probe.nodes = rfNodes; });
  return <>{api.overlay}</>;
}
const frameOf = (nodes: RFNode[]) => nodes.find((n) => n.id === "F");
const dragged = (nodes: RFNode[]) => nodes.filter((n) => n.id === "A");

describe("оверлей рамок при драге: одна плашка", () => {
  it("старт жеста: рамка получает dragHidden (не opacity), оверлей рисует плашку с крестиком; финал снимает флаг", () => {
    const { container } = render(<Harness initial={scene()} />);
    expect(container.querySelector("[data-drag-plaque]")).toBeNull();

    act(() => { probe.api?.snapshotPads(); probe.api?.begin(dragged(probe.nodes)); });
    expect(frameOf(probe.nodes)?.data.dragHidden).toBe(true);
    expect(frameOf(probe.nodes)?.style?.opacity).toBeUndefined();
    const plaque = container.querySelector('[data-drag-plaque="F"]');
    expect(plaque).not.toBeNull();
    expect(plaque?.textContent).toBe("🔍 Склад✕");
    // отражение неживое: крестик — не кнопка
    expect(plaque?.querySelector("button")).toBeNull();

    act(() => { probe.api?.finalize(); });
    expect(container.querySelector("[data-drag-plaque]")).toBeNull();
    expect(frameOf(probe.nodes)?.data.dragHidden).toBeUndefined();
  });

  it("рамка без сворачивания (read-only) — отражение плашки без крестика", () => {
    const { container } = render(<Harness initial={scene({ onCollapse: undefined })} />);
    act(() => { probe.api?.snapshotPads(); probe.api?.begin(dragged(probe.nodes)); });
    expect(container.querySelector('[data-drag-plaque="F"]')?.textContent).toBe("🔍 Склад");
  });

  it("FrameNode с dragHidden: рамка прозрачна, её плашка скрыта вместе с крестиком", () => {
    const { container } = render(
      <ReactFlowProvider><Frame id="F" data={frameData({ dragHidden: true })} /></ReactFlowProvider>,
    );
    const frame = container.querySelector<HTMLElement>(".lg-frame");
    expect(frame?.style.opacity).toBe("0");
    const plaque = container.querySelector<HTMLElement>(".lg-frame-plaque");
    expect(plaque?.style.visibility).toBe("hidden");
    expect(plaque?.textContent).toBe("🔍 Склад✕");
  });

  it("без флага рамка и плашка видны", () => {
    const { container } = render(
      <ReactFlowProvider><Frame id="F" data={frameData()} /></ReactFlowProvider>,
    );
    expect(container.querySelector<HTMLElement>(".lg-frame")?.style.opacity).toBe("");
    expect(container.querySelector<HTMLElement>(".lg-frame-plaque")?.style.visibility).toBe("");
  });
});
