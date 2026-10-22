// Рендер декора проекции (холст развёртывания, docs/specs/deployment.md):
//   • рамка площадки — класс lg-frame--site, сплошная граница, иконка вида на плашке,
//     ни лупы, ни крестика, клик по плашке ничего не сворачивает;
//   • группа «Размещение не указано» — пунктир, плашка без иконки и без крестика;
//   • пометка карточки «1/2» — бейдж у блока.
import { fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { nodeTypes } from "../graph/nodes";
import type { BlockData, FrameData } from "../graph/types";
import type { Node as AppNode } from "../../types";

const Frame = nodeTypes.frame as ComponentType<Partial<NodeProps>>;
const Block = nodeTypes.block as ComponentType<Partial<NodeProps>>;

function renderFrame(data: FrameData) {
  const { container } = render(
    <ReactFlowProvider>
      <Frame id="deploy:site:S1" data={data} />
    </ReactFlowProvider>,
  );
  return container.querySelector(".lg-frame") as HTMLElement;
}

describe("рамка с декором проекции", () => {
  it("площадка: сплошная граница, иконка вида, без лупы и крестика", () => {
    const frame = renderFrame({ name: "Кластер prod · k8s", decor: { kind: "site", icon: "kubernetes", collapsible: false } });
    expect(frame.className).toBe("lg-frame lg-frame--site");
    expect(frame.style.border).toContain("solid");
    expect(screen.getByText("Кластер prod · k8s")).toBeInTheDocument();
    expect(screen.queryByText(/🔍/)).toBeNull();
    expect(screen.queryByRole("button", { name: "✕" })).toBeNull();
    expect(frame.querySelector("svg")).not.toBeNull();
    expect(screen.queryByTitle("Свернуть")).toBeNull();
    fireEvent.click(screen.getByText("Кластер prod · k8s")); // ничего не падает и не сворачивает
  });

  it("группа «не указано»: пунктир, без иконки и без крестика", () => {
    const frame = renderFrame({ name: "Размещение не указано", decor: { kind: "group", collapsible: false } });
    expect(frame.className).toBe("lg-frame lg-frame--group");
    expect(frame.style.border).toContain("dashed");
    expect(frame.querySelector(".nopan svg")).toBeNull();
    expect(screen.queryByRole("button", { name: "✕" })).toBeNull();
  });

  it("без декора — прежняя рамка: класс lg-frame и лупа в подписи", () => {
    const frame = renderFrame({ name: "Витрина", onCollapse: () => {} });
    expect(frame.className).toBe("lg-frame");
    expect(screen.getByText("🔍 Витрина")).toBeInTheDocument();
  });
});

describe("пометка карточки", () => {
  const appNode = {
    id: "deploy:A@S1", name: "Каталог", role: null, technology: null, shape: "service",
    is_external: false, status: "existing", has_children: false, child_count: 0,
  } as unknown as AppNode;
  const data = (mark?: string): BlockData => ({
    appNode, badgeCount: 0, isArchitect: false,
    colors: { bg: "#fff", border: "#000", text: "#111" },
    ...(mark ? { mark } : null),
  });

  it("mark рисуется бейджем, без mark бейджа нет", () => {
    const { container, unmount } = render(
      <ReactFlowProvider><Block id="deploy:A@S1" data={data("1/2")} /></ReactFlowProvider>,
    );
    expect(container.querySelector(".lg-node-mark")?.textContent).toBe("1/2");
    unmount();
    const r2 = render(<ReactFlowProvider><Block id="deploy:A@S1" data={data()} /></ReactFlowProvider>);
    expect(r2.container.querySelector(".lg-node-mark")).toBeNull();
  });
});
