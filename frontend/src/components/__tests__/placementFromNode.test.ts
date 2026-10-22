// Объект окна «Размещение» из узла страницы (components/deployment/placementFromNode):
// своё размещение — в instances и effective без пометки, унаследованное — только в
// effective с предком, пустое — пусто; поля узла переезжают как есть.
import { describe, expect, it } from "vitest";
import { placementFromNode } from "../deployment/placementFromNode";
import type { Node } from "../../types";

function node(sites: Node["sites"]): Node {
  return {
    id: "n1", name: "Витрина", description: null, role: null, technology: null, parent_id: "p1",
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    version: 3, created_at: "", updated_at: "", sites,
  };
}

describe("placementFromNode", () => {
  it("своё размещение: экземпляры — свои, действующие — без предка", () => {
    const out = placementFromNode(node([
      { id: "k8s", name: "Кластер prod", kind: "kubernetes", parent_id: "aws", parent_name: "AWS" },
      { id: "vm1", name: "vm-1", kind: "vm", inherited_from_id: null },
    ]));
    expect(out.instances).toEqual(["k8s", "vm1"]);
    expect(out.effective).toEqual([
      { site_id: "k8s", inherited_from_id: null },
      { site_id: "vm1", inherited_from_id: null },
    ]);
    // Поля узла — те же: окно берёт из них имя в подзаголовок и подписи наследования.
    expect(out.id).toBe("n1");
    expect(out.name).toBe("Витрина");
    expect(out.version).toBe(3);
    expect(out.sites).toHaveLength(2);
  });

  it("унаследованное: своих экземпляров нет, действующие помнят предка", () => {
    const out = placementFromNode(node([
      { id: "k8s", name: "Кластер prod", kind: "kubernetes", inherited_from_id: "p1", inherited_from_name: "Магазин" },
    ]));
    expect(out.instances).toEqual([]);
    expect(out.effective).toEqual([{ site_id: "k8s", inherited_from_id: "p1" }]);
  });

  it("без размещения — пусто", () => {
    const out = placementFromNode(node([]));
    expect(out.instances).toEqual([]);
    expect(out.effective).toEqual([]);
  });
});
