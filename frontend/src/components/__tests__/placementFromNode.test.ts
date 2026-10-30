// Объект окна «Размещение» из узла страницы (components/deployment/placementFromNode):
// instances — площадки узла без пометки partial (у объекта — все его площадки, у
// контейнера — где стоят все его объекты), пустое — пусто; поля узла переезжают как есть.
import { describe, expect, it } from "vitest";
import { placementFromNode } from "../deployment/placementFromNode";
import type { Node } from "../../types";

function node(sites: Node["sites"], has_children = false): Node {
  return {
    id: "n1", name: "Витрина", description: null, role: null, technology: null, parent_id: "p1",
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: has_children ? 2 : 0, has_children, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: has_children ? "system" : "container", container_name: null,
    version: 3, created_at: "", updated_at: "", sites,
  };
}

describe("placementFromNode", () => {
  it("объект: экземпляры — все его площадки", () => {
    const out = placementFromNode(node([
      { id: "k8s", name: "Кластер prod", kind: "kubernetes", parent_id: "aws", parent_name: "AWS", partial: false },
      { id: "vm1", name: "vm-1", kind: "vm", partial: false },
    ]));
    expect(out.instances).toEqual(["k8s", "vm1"]);
    // Поля узла — те же: окно берёт из них имя в подзаголовок и площадки для галочек.
    expect(out.id).toBe("n1");
    expect(out.name).toBe("Витрина");
    expect(out.version).toBe(3);
    expect(out.sites).toHaveLength(2);
  });

  it("контейнер: экземпляры — только площадки, где стоят все его объекты", () => {
    const out = placementFromNode(node([
      { id: "k8s", name: "Кластер prod", kind: "kubernetes", partial: false },
      { id: "vm1", name: "vm-1", kind: "vm", partial: true },
    ], true));
    expect(out.instances).toEqual(["k8s"]);
    expect(out.sites.map((s) => s.id)).toEqual(["k8s", "vm1"]);
  });

  it("без размещения — пусто", () => {
    expect(placementFromNode(node([])).instances).toEqual([]);
  });
});
