// Страж сигнатуры раскладки (Ф1 плавности): сигнатура обязана быть чувствительной
// к изменению КАЖДОГО поля LayoutResult — иначе скип идентичных применений молча
// глотал бы реальные изменения (класс риска «пропущенный ре-рендер»).
import { describe, it, expect } from "vitest";
import { layoutSig } from "../graph/layout/layoutSig";
import type { LayoutResult } from "../graph/layout/pipeline";

// Минимальный валидный LayoutResult: по одному непустому значению на поле, чтобы
// мутация каждого поля была представима. Доменные типы полей здесь не важны —
// проверяется механика сериализации, поэтому строим структурно и сужаем через unknown.
const base = (): LayoutResult =>
  ({
    nodes: [{ id: "n1", name: "A", parent_id: null }],
    entities: [{ id: "g1", name: "G", ancestors: [] }],
    positions: new Map([["n1", { x: 0, y: 0 }]]),
    edgeHandles: new Map([["e1", { sourceHandle: "r-0.5", targetHandle: "l-0.5" }]]),
    edgeShelves: new Map([["e1", { side: "top" }]]),
    edgeLoops: new Map([["e2", { r: 12 }]]),
    autoRoutes: new Map([["e1", [{ x: 0, y: 0 }, { x: 10, y: 0 }]]]),
    labelPlacements: new Map([["e1", { x: 5, y: 0, mode: "online" }]]),
    guestFrames: [{ id: "f1", depth: 0, rect: { x: 0, y: 0, w: 100, h: 80 } }],
    groupArr: [{ key: "n1>n2", members: [{ id: "e1" }] }],
    spacers: [{ id: "sp1", type: "spacer", position: { x: -10, y: -10 } }],
  } as unknown as LayoutResult);

// Мутация каждого поля БЕЗ ручного дублирования списка полей в ассертах: ключи
// берём с образца — появление нового поля в LayoutResult уронит тест «полноты»
// ниже, пока сюда не добавят непустое значение и мутацию.
const mutations: Record<string, (l: Record<string, unknown>) => void> = {
  nodes: (l) => ((l.nodes as { name: string }[])[0].name = "B"),
  entities: (l) => ((l.entities as { name: string }[])[0].name = "H"),
  positions: (l) => (l.positions as Map<string, object>).set("n1", { x: 1, y: 0 }),
  edgeHandles: (l) =>
    (l.edgeHandles as Map<string, object>).set("e1", { sourceHandle: "t-0.5", targetHandle: "l-0.5" }),
  edgeShelves: (l) => (l.edgeShelves as Map<string, object>).set("e1", { side: "bottom" }),
  edgeLoops: (l) => (l.edgeLoops as Map<string, object>).set("e2", { r: 16 }),
  autoRoutes: (l) => (l.autoRoutes as Map<string, object>).set("e1", [{ x: 0, y: 0 }]),
  labelPlacements: (l) => (l.labelPlacements as Map<string, object>).set("e1", { x: 6, y: 0, mode: "online" }),
  guestFrames: (l) => ((l.guestFrames as { rect: { w: number } }[])[0].rect.w = 120),
  groupArr: (l) => ((l.groupArr as { key: string }[])[0].key = "n1>n3"),
  spacers: (l) => ((l.spacers as { position: { x: number } }[])[0].position.x = -20),
};

describe("layoutSig", () => {
  it("идентичные раскладки дают одинаковую сигнатуру", () => {
    expect(layoutSig(base())).toBe(layoutSig(base()));
  });

  it("порядок вставки в Map не влияет на сигнатуру", () => {
    const a = base();
    const b = base();
    (b.positions as Map<string, { x: number; y: number }>).clear();
    // та же пара ключей, обратный порядок вставки
    const extraA = a.positions as Map<string, { x: number; y: number }>;
    extraA.set("n2", { x: 5, y: 5 });
    const extraB = b.positions as Map<string, { x: number; y: number }>;
    extraB.set("n2", { x: 5, y: 5 });
    extraB.set("n1", { x: 0, y: 0 });
    expect(layoutSig(a)).toBe(layoutSig(b));
  });

  it("чувствительна к изменению каждого поля LayoutResult", () => {
    const ref = layoutSig(base());
    for (const [field, mutate] of Object.entries(mutations)) {
      const l = base() as unknown as Record<string, unknown>;
      mutate(l);
      expect(layoutSig(l as unknown as LayoutResult), `поле ${field}`).not.toBe(ref);
    }
  });

  it("полнота: у образца есть мутация для каждого поля (новое поле — добавь сюда)", () => {
    const sample = base() as unknown as Record<string, unknown>;
    expect(Object.keys(sample).sort()).toEqual(Object.keys(mutations).sort());
  });
});
