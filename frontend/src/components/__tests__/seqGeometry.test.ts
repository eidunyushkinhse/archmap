// Геометрия sequence-диаграммы (processes/sequence/geometry) — без DOM: колонки и живая
// перестановка участников, строки и высота подписей, фрагменты и их вложенность,
// перенос шага, строка-призрак и ограничения граней (аудит F-4: раньше геометрия
// проверялась только селекторами по готовой разметке).
import { describe, expect, it } from "vitest";
import { computeSeqGeometry, type SeqGeometryInput } from "../processes/sequence/geometry";
import type { SeqFragment, SeqMessage, SeqParticipant } from "../processes/sequence/layout";
import { SQ } from "../processes/tokens";

const P = (id: string): SeqParticipant =>
  ({ id, name: id, shape: "service", external: false, status: "existing", role: null }) as SeqParticipant;
const M = (id: string, r: number, from: string, to: string): SeqMessage =>
  ({ id, r, n: r + 1, from, to, kind: "forward", label: "", tech: null, valid: true, invalidReason: null }) as SeqMessage;
const F = (id: string, fromRow: number, toRow: number, branchRows: number[] = []): SeqFragment =>
  ({ id, kind: "alt", fromRow, toRow, guard: null, branches: branchRows.map((row) => ({ row, guard: null })) }) as unknown as SeqFragment;

const parts = [P("a"), P("b"), P("c"), P("d")];
const msgs = [M("m0", 0, "a", "b"), M("m1", 1, "b", "c"), M("m2", 2, "c", "d")];

function geo(over: Partial<SeqGeometryInput> = {}) {
  return computeSeqGeometry({
    participants: parts, messages: msgs, fragments: [], labelH: {},
    reorder: null, rowDrag: null, fragDrag: null, ghost: false, ...over,
  });
}

describe("геометрия sequence-диаграммы", () => {
  it("колонки по порядку участников, ширина — от крайних колонок", () => {
    const g = geo();
    expect(["a", "b", "c", "d"].map(g.colX)).toEqual([0, 1, 2, 3].map((k) => SQ.MARGIN + k * SQ.COL_W));
    expect(g.W).toBe(SQ.MARGIN * 2 + 3 * SQ.COL_W);
  });

  it("живая перестановка: тянущийся идёт за курсором, соседи до цели сдвигаются", () => {
    const px = SQ.MARGIN + 2 * SQ.COL_W; // курсор над колонкой «c»
    const g = geo({ reorder: { fromK: 0, px } });
    expect(g.colX("a")).toBe(px);
    expect(g.colX("b")).toBe(g.PX(0));
    expect(g.colX("c")).toBe(g.PX(1));
    expect(g.colX("d")).toBe(g.PX(3));
    expect(g.isDraggedK(0)).toBe(true);
    expect(g.isDraggedK(1)).toBe(false);
  });

  it("строки идут вниз, высокая подпись раздвигает свою строку", () => {
    const g = geo();
    expect(g.rowY(1)).toBeGreaterThan(g.rowY(0));
    const tall = geo({ labelH: { m1: 80 } });
    expect(tall.rowY(1) - tall.rowY(0)).toBeGreaterThan(g.rowY(1) - g.rowY(0));
    // Строки выше высокой подписи не сдвигаются.
    expect(tall.rowY(0)).toBe(g.rowY(0));
  });

  it("фрагмент добавляет шапку строкам от своего начала, вложенный — с отступом", () => {
    const base = geo();
    const outer = F("f1", 0, 2);
    const inner = F("f2", 1, 1);
    const g = geo({ fragments: [outer, inner] });
    expect(g.rowY(0) - base.rowY(0)).toBe(SQ.FRAG_HEAD);
    expect(g.rowY(1) - base.rowY(1)).toBe(2 * SQ.FRAG_HEAD);
    const [o, i] = g.fragBoxes;
    expect(o.f.id).toBe("f1");
    expect(i.f.id).toBe("f2");
    // Внутренний охватывает только шаг b→c, и рамка у́же на отступ вложенности.
    expect(i.left).toBe(g.colX("b") - 38 + 10);
    expect(i.right).toBe(g.colX("c") + 38 - 10);
  });

  it("фрагмент без шагов внутри рамки не получает", () => {
    const g = geo({ fragments: [F("f1", 5, 6)] });
    expect(g.fragBoxes).toEqual([]);
  });

  it("перенос шага: тянущийся идёт за курсором, остальные уступают место", () => {
    const py = geo().rowY(2) + 1; // курсор у строки 2
    const g = geo({ rowDrag: { fromR: 0, py, y0: 0, moved: true } });
    expect([0, 1, 2].map(g.shownRow)).toEqual([2, 0, 1]);
    expect(g.msgY(0)).toBe(py);
    expect(g.msgY(1)).toBe(g.rowY(0));
  });

  it("жест до порога (moved=false) раскладку не трогает", () => {
    const g = geo({ rowDrag: { fromR: 0, py: 999, y0: 0, moved: false } });
    expect([0, 1, 2].map(g.shownRow)).toEqual([0, 1, 2]);
  });

  it("строка-призрак — под последним шагом, холст дорастает до неё", () => {
    const g = geo({ ghost: true });
    expect(g.ghostY).toBe(g.rowY(3) - 6);
    expect(g.H).toBe(g.ghostY + 44);
  });

  it("верхняя грань фрагмента не проглатывает ветвь", () => {
    const frag = F("f1", 0, 2, [1]);
    const g = geo({ fragments: [frag], fragDrag: { id: "f1", edge: "top", bi: 0, row: 2, y0: 0, moved: true } });
    // Грань метит на строку 2, но ветвь на строке 1 обязана остаться внутри охвата.
    expect(g.fragRows(frag)).toEqual({ from: 0, to: 2 });
  });
});
