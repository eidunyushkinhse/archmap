// Раскрытые рамки холста как цели броска плитки палитры (приёмка Ф12 2026-10-31): объект
// рамки в виде, который понимают правила поля «Тип». Чистая функция — без DOM.
import { describe, it, expect } from "vitest";
import { dropFrameTargets } from "../graph/dropFrameTargets";
import type { FrameRect } from "../graph/layout/frames";
import type { FrameElement } from "../graph/types";

function frameRect(id: string, depth: number, element: FrameElement, members: string[]): FrameRect {
  return {
    id, name: id, depth, native: false, memberIds: new Set(members), element, is_external: false,
    content: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, rect: { x: 0, y: 0, w: 10, h: 10 },
  };
}
const noAncestors = { names: [], elements: [] };

describe("dropFrameTargets", () => {
  it("рамка — сервис с вложенными; «контейнер» хранится явно, у системы элемента нет", () => {
    const [sys, box] = dropFrameTargets(
      [frameRect("shop", 0, "system", ["a"]), frameRect("orders", 1, "container", ["b"])], noAncestors,
    );
    expect(sys).toEqual({
      id: "shop", name: "shop",
      subject: {
        name: "shop", shape: "service", element: null, element_effective: "system",
        has_children: true, container_name: null,
      },
    });
    expect(box.subject.element).toBe("container");
    expect(box.subject.element_effective).toBe("container");
  });

  it("составной компонент называет контейнер ближайшей рамки-предка", () => {
    const targets = dropFrameTargets([
      frameRect("orders", 1, "container", ["auth-1", "auth-2"]),
      frameRect("auth", 2, "component", ["auth-1"]),
    ], noAncestors);
    expect(targets[1].subject.container_name).toBe("orders");
  });

  it("рамки контейнера на холсте нет — контейнер из крошек уровня", () => {
    const targets = dropFrameTargets(
      [frameRect("auth", 2, "component", ["x"])],
      { names: ["shop", "orders"], elements: ["system", "container"] },
    );
    expect(targets[0].subject.container_name).toBe("orders");
  });
});
