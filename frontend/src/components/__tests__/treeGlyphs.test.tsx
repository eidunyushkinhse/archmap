// Глифы дерева и шапки страницы по элементу архитектуры (Ф8 эпика
// docs/plan-c4-elements.md, Р24): вид узла решает чистый types/treeNesting — система и
// составной компонент рисуются пунктирным прямоугольником (эхо рамки на холсте),
// контейнер с компонентами — «коробкой с крышкой», объект без вложенных — своей формой.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShapeGlyph } from "../nodeTree.shared";
import HeaderGlyph from "../nodePage/HeaderGlyph";
import { treeNesting } from "../../types";
import type { Node, TreeNesting } from "../../types";

type Subject = Pick<Node, "shape" | "has_children" | "element_effective">;
const subject = (over: Partial<Subject>): Subject => ({ shape: "service", has_children: false, element_effective: "container", ...over });

describe("treeNesting", () => {
  it("по вложенности и элементу с сервера", () => {
    expect(treeNesting(subject({}))).toBe("leaf");
    expect(treeNesting(subject({ element_effective: "component" }))).toBe("leaf");
    expect(treeNesting(subject({ has_children: true, element_effective: "system" }))).toBe("system");
    expect(treeNesting(subject({ has_children: true, element_effective: "container" }))).toBe("container");
    expect(treeNesting(subject({ has_children: true, element_effective: "component" }))).toBe("component");
    // база с детьми — по-прежнему своя форма (types/nodeNesting)
    expect(treeNesting(subject({ shape: "database", has_children: true, element_effective: "system" }))).toBe("leaf");
  });

  it("пустая система (лист, который сервер читает системой, Р39) — глиф системы", () => {
    expect(treeNesting(subject({ element_effective: "system" }))).toBe("system");
    // элемент задаётся только у сервиса: у другой формы лист — своя форма
    expect(treeNesting(subject({ shape: "database", element_effective: "system" }))).toBe("leaf");
  });
});

// Что нарисовано: пунктирная рамка, коробка с крышкой или форма.
function drawn(svg: SVGElement | null): "dashed" | "box" | "shape" {
  if (svg?.querySelector("rect[stroke-dasharray]")) return "dashed";
  if (svg?.querySelector("path")?.getAttribute("d")?.match(/^M\d+(\.\d+)? \d+(\.\d+)? V/)) return "box";
  return "shape";
}

describe("ShapeGlyph и HeaderGlyph", () => {
  const cases: [TreeNesting, "dashed" | "box" | "shape"][] = [
    ["system", "dashed"], ["component", "dashed"], ["container", "box"], ["leaf", "shape"],
  ];

  it("строка дерева: система и составной компонент — пунктир, контейнер — коробка, лист — форма", () => {
    for (const [nesting, look] of cases) {
      const { container, unmount } = render(<ShapeGlyph nesting={nesting} shape="service" />);
      expect(container.querySelector(".nt-glyph")?.getAttribute("data-nesting")).toBe(nesting);
      expect(drawn(container.querySelector("svg"))).toBe(look);
      unmount();
    }
  });

  it("шапка страницы — тот же словарь", () => {
    for (const [nesting, look] of cases) {
      const { container, unmount } = render(<HeaderGlyph nesting={nesting} shape="service" />);
      expect(container.querySelector("svg")?.getAttribute("data-nesting")).toBe(nesting);
      expect(drawn(container.querySelector("svg"))).toBe(look);
      unmount();
    }
  });

  it("лист-база — цилиндр, а не пунктир", () => {
    const { container } = render(<ShapeGlyph nesting="leaf" shape="database" />);
    expect(container.querySelector("ellipse")).not.toBeNull();
    expect(container.querySelector("rect[stroke-dasharray]")).toBeNull();
  });
});
