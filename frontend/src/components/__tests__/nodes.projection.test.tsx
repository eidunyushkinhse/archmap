// Рендер декора проекции (холст развёртывания, docs/specs/deployment.md):
//   • рамка площадки — класс lg-frame--site, зона: заливка и тонкая светлая граница,
//     иконка вида на плашке, без лупы; клик по плашке и крестик сворачивают площадку;
//   • группа «Размещение не указано» — пунктир, плашка без иконки и без крестика;
//   • карточка площадки (тип site) — имя, иконка, число объектов, лупа «Раскрыть площадку»;
//   • пометка карточки «1/2» — бейдж у блока.
import { fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { nodeTypes } from "../graph/nodes";
import type { BlockData, FrameData, SiteCardData } from "../graph/types";
import type { Node as AppNode } from "../../types";

const Frame = nodeTypes.frame as ComponentType<Partial<NodeProps>>;
const Block = nodeTypes.block as ComponentType<Partial<NodeProps>>;
const SiteCard = nodeTypes.site as ComponentType<Partial<NodeProps>>;

function renderFrame(data: FrameData) {
  const { container } = render(
    <ReactFlowProvider>
      <Frame id="deploy:site:S1" data={data} />
    </ReactFlowProvider>,
  );
  return container.querySelector(".lg-frame") as HTMLElement;
}

describe("рамка с декором проекции", () => {
  it("площадка: зона с заливкой и тонкой границей, иконка вида, сворачивается плашкой и крестиком", () => {
    const onCollapse = vi.fn();
    const frame = renderFrame({
      name: "Кластер prod · k8s", onCollapse, decor: { kind: "site", icon: "kubernetes", collapsible: true },
    });
    expect(frame.className).toBe("lg-frame lg-frame--site");
    expect(frame.style.border).toContain("solid");
    expect(frame.style.border).not.toContain("1.5");
    expect(frame.style.background).toContain("rgba(100, 116, 139, 0.07)");
    expect(screen.getByText("Кластер prod · k8s")).toBeInTheDocument();
    expect(screen.queryByText(/🔍/)).toBeNull();
    expect(frame.querySelector("svg")).not.toBeNull();
    fireEvent.click(screen.getByText("Кластер prod · k8s"));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onCollapse).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTitle("Свернуть площадку").length).toBeGreaterThan(0);
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

describe("карточка площадки", () => {
  const renderCard = (data: SiteCardData) => render(
    <ReactFlowProvider><SiteCard id="deploy:site:S1" data={data} /></ReactFlowProvider>,
  );

  it("свёрнутая: имя, иконка вида, число объектов и лупа «Раскрыть площадку»", () => {
    const onExpand = vi.fn();
    const { container } = renderCard({ name: "Кластер prod · k8s", icon: "kubernetes", count: 3, onExpand });
    expect(container.querySelector(".lg-site-card")).not.toBeNull();
    expect(screen.getByText("Кластер prod · k8s")).toBeInTheDocument();
    expect(container.querySelector(".lg-site-card svg")).not.toBeNull();
    expect(container.querySelector(".lg-site-count")?.textContent).toBe("3");
    fireEvent.click(screen.getByTitle("Раскрыть площадку"));
    expect(onExpand).toHaveBeenCalledWith("deploy:site:S1");
  });

  it("пустая на уровне: без числа и без лупы, подсказка «пуста»", () => {
    const { container } = renderCard({ name: "ВМ", icon: "vm", count: 0 });
    expect(container.querySelector(".lg-site-count")).toBeNull();
    expect(screen.queryByTitle("Раскрыть площадку")).toBeNull();
    expect(container.querySelector(".lg-site-card")?.getAttribute("title")).toBe("Площадка пуста на этом уровне");
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

  it("цельный контейнер: пунктирный контур и бейдж числа объектов внутри", () => {
    const box = { ...appNode, id: "deploy:C@S1", has_children: true, child_count: 4 } as AppNode;
    const { container } = render(
      <ReactFlowProvider>
        <Block id="deploy:C@S1" data={{ ...data(), appNode: box, badgeCount: 4, dashed: true }} />
      </ReactFlowProvider>,
    );
    expect(container.querySelector("rect")?.getAttribute("stroke-dasharray")).toBe("5 3");
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.queryByTitle("Раскрыть содержимое")).toBeNull();
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
