import { describe, it, expect } from "vitest";
import { guestLayerSides } from "../graph/layout/guestLayers";
import type { DisplayExternal } from "../graph/types";
import type { GhostNode, AncestorRef } from "../../types";

// Крайние слои ELK для гостей (Ф4б, шаг 1): сторона гостя по связям со стороной уровня.

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });
function ghost(id: string, ancestors: AncestorRef[], shape: GhostNode["shape"] = "service"): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape, status: "existing", node_depth: ancestors.length, has_children: false, child_count: 0, ancestors, is_ghost: true,
  };
}
// по умолчанию гость — корневой лист (без предков): своя группа; общий предок F делает членов одной группой
const leaf = (id: string, ancestors: AncestorRef[] = [], shape?: GhostNode["shape"]): DisplayExternal =>
  ({ kind: "leaf", id, ghost: ghost(id, ancestors, shape) });
const g = (source: string, target: string) => ({ source, target });
const locals = new Set(["L1", "L2"]);
const none = new Set<string>();

describe("guestLayerSides — сторона гостя по связям со стороной уровня", () => {
  it("источник → first, приёмник → last", () => {
    const m = guestLayerSides({
      entities: [leaf("S"), leaf("T")], localIds: locals, frameEndIds: none,
      groups: [g("S", "L1"), g("L2", "T")], ancestorIds: ["A"],
    });
    expect(m.get("S")).toBe("first");
    expect(m.get("T")).toBe("last");
  });

  it("встречные связи: большинство направлений", () => {
    const m = guestLayerSides({
      entities: [leaf("M")], localIds: locals, frameEndIds: none,
      groups: [g("L1", "M"), g("L2", "M"), g("M", "L1")], ancestorIds: ["A"],
    });
    expect(m.get("M")).toBe("last");
  });

  it("ничья: пользователь (person) наверх, внешняя система вниз", () => {
    const m = guestLayerSides({
      entities: [leaf("P", [], "person"), leaf("X")], localIds: locals, frameEndIds: none,
      groups: [g("P", "L1"), g("L1", "P"), g("X", "L2"), g("L2", "X")], ancestorIds: ["A"],
    });
    expect(m.get("P")).toBe("first");
    expect(m.get("X")).toBe("last");
  });

  it("связь в рамку-конец (контейнер уровня) считается связью со стороной уровня", () => {
    const m = guestLayerSides({
      entities: [leaf("S")], localIds: locals, frameEndIds: new Set(["C"]),
      groups: [g("S", "C")], ancestorIds: ["C"],
    });
    expect(m.get("S")).toBe("first");
  });

  it("гость без связей со стороной уровня наследует сторону соседа-гостя; совсем без соседей — last", () => {
    const m = guestLayerSides({
      entities: [leaf("S"), leaf("S2"), leaf("Iso")], localIds: locals, frameEndIds: none,
      // S2 связан только с гостем-источником S (в любом направлении) → тоже first
      groups: [g("S", "L1"), g("S", "S2")], ancestorIds: ["A"],
    });
    expect(m.get("S")).toBe("first");
    expect(m.get("S2")).toBe("first");
    expect(m.get("Iso")).toBe("last");
  });

  it("группа гостевой рамки решается целиком: члены получают одну сторону", () => {
    // дети раскрытого гостевого контейнера F: c1 — источник к L1, c2 — приёмник от L2 и
    // ещё один приёмник от L1 → группа в сумме 1 out / 2 in → last у обоих
    const m = guestLayerSides({
      entities: [leaf("c1", [a("F")]), leaf("c2", [a("F")])], localIds: locals, frameEndIds: none,
      groups: [g("c1", "L1"), g("L2", "c2"), g("L1", "c2")], ancestorIds: ["A"],
    });
    expect(m.get("c1")).toBe("last");
    expect(m.get("c2")).toBe("last");
  });

  it("связи гость↔гость в счёт стороны не идут", () => {
    const m = guestLayerSides({
      entities: [leaf("S"), leaf("T")], localIds: locals, frameEndIds: none,
      groups: [g("S", "L1"), g("L2", "T"), g("T", "S"), g("T", "S")], ancestorIds: ["A"],
    });
    expect(m.get("S")).toBe("first");
    expect(m.get("T")).toBe("last");
  });

  it("без сущностей — пустая карта", () => {
    expect(guestLayerSides({ entities: [], localIds: locals, frameEndIds: none, groups: [], ancestorIds: [] }).size).toBe(0);
  });
});
