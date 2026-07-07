import { describe, it, expect } from "vitest";
import { reconstructOwnedWaypoints, type BundleWaypoints } from "../graph/layout/ownedWaypoints";
import { bundleKey } from "../../types";

// Реконструкция изломов ПУЧКОВ к детям раскрытых рамок (own-on-first-render, Ф3/R3).
// Изломы живут на ключе пучка ("b:<src>><tgt>" в view_layout). Якорь — ЯВНАЯ
// идентичность узла (anchor): абсолют = офсет + позиция узла-якоря. Излом гаснет
// ровно при сворачивании СВОЕГО узла (его нет среди отображаемых), а не «любого
// показанного конца». Привязку приобретает абсолютный путь, чей конец — потомок
// раскрытой рамки (expandedChildIds).

const bundle = (
  source: string, target: string,
  waypoints: { x: number; y: number }[], anchor: string | null,
): Record<string, BundleWaypoints> =>
  ({ [bundleKey(source, target)]: { source, target, waypoints, anchor } });

describe("reconstructOwnedWaypoints (Ф3/R3, якорь по идентичности, ключ пучка)", () => {
  const k1 = bundleKey("g1", "La");
  // g1 — гостевой ребёнок раскрытой рамки на позиции (200,100); излом привязан к ней.
  const base = {
    pos: (id: string) => (id === "g1" ? { x: 200, y: 100 } : id === "La" ? { x: 0, y: 0 } : undefined),
    expandedChildIds: new Set(["g1"]),
  };

  it("офсетный путь → абсолют = офсет + позиция узла-якоря", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, bundles: bundle("g1", "La", [{ x: 10, y: 20 }], "g1"),
    });
    // позиция g1 = (200,100); абсолют = (210,120)
    expect(effective[k1]).toEqual([{ x: 210, y: 120 }]);
    expect(migrations.length).toBe(0);
  });

  it("излом едет ровно с узлом-якорем: сдвиг позиции на (+60,+5) сдвигает излом так же", () => {
    const a = reconstructOwnedWaypoints({ ...base, bundles: bundle("g1", "La", [{ x: 10, y: 20 }], "g1") });
    const moved = reconstructOwnedWaypoints({
      expandedChildIds: base.expandedChildIds,
      pos: (id) => (id === "g1" ? { x: 260, y: 105 } : id === "La" ? { x: 0, y: 0 } : undefined),
      bundles: bundle("g1", "La", [{ x: 10, y: 20 }], "g1"),
    });
    expect(moved.effective[k1][0].x - a.effective[k1][0].x).toBeCloseTo(60);
    expect(moved.effective[k1][0].y - a.effective[k1][0].y).toBeCloseTo(5);
  });

  it("свежий/легаси абсолют к ребёнку раскрытой рамки → приобретает якорь, на экране без сдвига", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, bundles: bundle("g1", "La", [{ x: 210, y: 120 }], null),
    });
    // абсолют на экране не двигаем (это и чинит баг «по отпусканию встаёт назад»)
    expect(effective[k1]).toEqual([{ x: 210, y: 120 }]);
    // приобретённый якорь = g1; офсет = абсолют − позиция g1 = (210−200, 120−100) = (10,20)
    expect(migrations).toEqual([{ itemId: k1, anchor: "g1", waypoints: [{ x: 10, y: 20 }] }]);
  });

  it("работает для АВТО-ребёнка (нет строки позиции) — приобретение по показу, не по владению", () => {
    // g1 в expandedChildIds, но позиция нигде не «владеется» — раньше так излом не
    // сохранялся; теперь якорь приобретается по факту показа потомком раскрытой рамки.
    const { effective, migrations } = reconstructOwnedWaypoints({
      ...base, bundles: bundle("g1", "La", [{ x: 300, y: 90 }], null),
    });
    expect(effective[k1]).toEqual([{ x: 300, y: 90 }]);
    expect(migrations).toEqual([{ itemId: k1, anchor: "g1", waypoints: [{ x: 100, y: -10 }] }]); // (300−200, 90−100)
  });

  it("узел-якорь не отображается (свёрнут) → авто-маршрут (пусто)", () => {
    const { effective, migrations } = reconstructOwnedWaypoints({
      expandedChildIds: new Set<string>(),
      pos: (id) => (id === "g1" ? undefined : { x: 0, y: 0 }), // g1 свёрнут — позиции нет
      bundles: bundle("g1", "La", [{ x: 10, y: 20 }], "g1"),
    });
    expect(effective[k1]).toEqual([]);
    expect(migrations.length).toBe(0);
  });

  it("баг 3: якорь свёрнут, но ДРУГОЙ конец — потомок раскрытой рамки → излом всё равно гаснет", () => {
    // Раньше якорь выводился из «любого показанного гостевого конца»: g1 (свой якорь) свёрнут,
    // но target g2 в раскрытой рамке → излом перепривязывался к g2 и зависал. Теперь привязка
    // по идентичности: anchor=g1 не отображается → авто-маршрут, на g2 НЕ перескакивает.
    const { effective, migrations } = reconstructOwnedWaypoints({
      expandedChildIds: new Set(["g2"]),
      pos: (id) => (id === "g2" ? { x: 500, y: 400 } : undefined), // g1 свёрнут
      bundles: bundle("g1", "g2", [{ x: 10, y: 20 }], "g1"),
    });
    expect(effective[bundleKey("g1", "g2")]).toEqual([]);
    expect(migrations.length).toBe(0);
  });

  it("обычный пучок (конец не в раскрытой рамке) → абсолютный путь как пришёл", () => {
    const kG = bundleKey("G", "La");
    const { effective, migrations } = reconstructOwnedWaypoints({
      expandedChildIds: new Set<string>(),
      pos: () => ({ x: 0, y: 0 }),
      bundles: bundle("G", "La", [{ x: 5, y: 5 }], null),
    });
    expect(effective[kG]).toEqual([{ x: 5, y: 5 }]);
    expect(migrations.length).toBe(0);
  });

  it("абсолют между двумя детьми раскрытых рамок приобретает source", () => {
    const { migrations } = reconstructOwnedWaypoints({
      expandedChildIds: new Set(["g1", "g2"]),
      pos: (id) => (id === "g1" ? { x: 200, y: 100 } : id === "g2" ? { x: 500, y: 400 } : undefined),
      bundles: bundle("g1", "g2", [{ x: 210, y: 120 }], null),
    });
    // якорь = source g1 (200,100); офсет = (10,20), а не от target g2
    expect(migrations).toEqual([{ itemId: bundleKey("g1", "g2"), anchor: "g1", waypoints: [{ x: 10, y: 20 }] }]);
  });
});
