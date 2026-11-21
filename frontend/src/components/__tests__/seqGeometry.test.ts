// Геометрия sequence-диаграммы (processes/sequence/geometry) — без DOM: колонки и живая
// перестановка участников, строки и высота подписей, фрагменты и их вложенность,
// перенос шага, строка-призрак и ограничения граней (аудит F-4: раньше геометрия
// проверялась только селекторами по готовой разметке). Промежутки между колонками — по
// содержимому (редизайн, фаза 3а): ширины подписей и шапок тесты подают руками, в jsdom
// замеров нет.
import { describe, expect, it } from "vitest";
import { computeColumns, computeSeqGeometry, fitLabelCap, type SeqGeometryInput } from "../processes/sequence/geometry";
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

// Наименьший промежуток: две шапки наименьшей ширины и воздух между ними.
const MIN_GAP = SQ.HEAD_MIN + SQ.HEAD_GAP;
const gapsOf = (g: { colX: (id: string) => number }, ids = ["a", "b", "c", "d"]) =>
  ids.slice(1).map((id, k) => g.colX(id) - g.colX(ids[k]));

describe("колонки по содержимому", () => {
  it("без замеров промежутки задают шапки, ширина — от крайних колонок с полями", () => {
    const g = geo();
    expect(gapsOf(g)).toEqual([MIN_GAP, MIN_GAP, MIN_GAP]);
    expect(g.colX("a")).toBe(SQ.SIDE);
    expect(g.W).toBe(SQ.SIDE * 2 + 3 * MIN_GAP);
  });

  it("подпись между соседями раздвигает только их промежуток: не уже подписи плюс поля", () => {
    const g = geo({ labelW: { m1: 250 } }); // шаг b→c
    const [ab, bc, cd] = gapsOf(g);
    expect(bc).toBe(250 + SQ.LABEL_SIDE);
    expect(ab).toBe(MIN_GAP);
    expect(cd).toBe(MIN_GAP);
  });

  it("короткая подпись промежуток не сужает: минимум задают шапки", () => {
    const g = geo({ labelW: { m1: 40 } });
    expect(gapsOf(g)).toEqual([MIN_GAP, MIN_GAP, MIN_GAP]);
  });

  it("подпись шире предела считается по пределу — она переносится", () => {
    const g = geo({ labelW: { m1: 500 } });
    expect(gapsOf(g)[1]).toBe(SQ.LABEL_MAX + SQ.LABEL_SIDE);
    const narrow = geo({ labelW: { m1: 500 }, labelCap: 200 });
    expect(gapsOf(narrow)[1]).toBe(200 + SQ.LABEL_SIDE);
  });

  it("подпись через несколько колонок раскладывает недостачу поровну на свои промежутки", () => {
    // Шаг a→d накрывает три промежутка; суммы шапок (3 × MIN_GAP) ему мало.
    const wide = [M("m0", 0, "a", "d")];
    const need = 3 * MIN_GAP + 90;
    const g = geo({ messages: wide, labelW: { m0: need - SQ.LABEL_SIDE }, labelCap: 1000 });
    expect(gapsOf(g)).toEqual([MIN_GAP + 30, MIN_GAP + 30, MIN_GAP + 30]);
  });

  it("широкий шаг не трогает промежутки, которые уже раздвинули узкие", () => {
    // b→c раздвинут подписью 300; шагу a→c (две колонки) этой суммы хватает.
    const msgs2 = [M("m0", 0, "b", "c"), M("m1", 1, "a", "c")];
    const g = geo({ messages: msgs2, labelW: { m0: 260, m1: 300 } });
    const [ab, bc] = gapsOf(g);
    expect(bc).toBe(260 + SQ.LABEL_SIDE);
    expect(ab).toBe(MIN_GAP);
  });

  it("широкая шапка раздвигает соседей; ширина шапки зажата в пределы", () => {
    const g = geo({ headW: { b: 130 } });
    const [ab, bc] = gapsOf(g);
    expect(ab).toBe((SQ.HEAD_MIN + 130) / 2 + SQ.HEAD_GAP);
    expect(bc).toBe(ab);
    const huge = geo({ headW: { b: 900 } });
    expect(gapsOf(huge)[0]).toBe((SQ.HEAD_MIN + SQ.HEAD_MAX) / 2 + SQ.HEAD_GAP);
  });

  it("подпись не уже своего самого длинного слова: предел раздвигается под него", () => {
    // Слово в 200 px при пределе 110: подпись — по слову с запасом на масштаб.
    const g = geo({ labelW: { m1: 500 }, labelMinW: { m1: 200 }, labelCap: 110 });
    const floor = Math.ceil(200 * 1.03) + 2;
    expect(g.labelCapOf("m1")).toBe(floor);
    expect(gapsOf(g)[1]).toBe(floor + SQ.LABEL_SIDE);
    // Короткие слова предел не трогают.
    expect(geo({ labelMinW: { m1: 60 }, labelCap: 110 }).labelCapOf("m1")).toBe(110);
  });

  it("подпись занимает место, которое у неё уже есть: шапки раздвинули промежуток шире предела", () => {
    const heads = { a: 140, b: 140, c: 140, d: 140 };
    const g = geo({ headW: heads, labelW: { m1: 400 }, labelCap: 110 });
    // Промежуток b→c задан шапками (140 + воздух), подпись — во всю его ширину без полей.
    expect(g.labelCapOf("m1")).toBe(140 + SQ.HEAD_GAP - SQ.LABEL_SIDE);
    // Ширину холста это не меняет.
    expect(g.W).toBe(geo({ headW: heads, labelCap: 110 }).W);
  });

  it("шапка: по естественной ширине имени, длинное — не уже самого длинного слова", () => {
    expect(geo({ headW: { b: 80 } }).headWOf("b")).toBe(80);
    expect(geo({ headW: { b: 20 } }).headWOf("b")).toBe(SQ.HEAD_MIN);
    expect(geo({ headW: { b: 900 } }).headWOf("b")).toBe(SQ.HEAD_MAX);
    expect(geo({ headW: { b: 900 }, headMinW: { b: 200 } }).headWOf("b")).toBe(200);
  });

  it("подпись шага внутри последнего участника уходит в правое поле", () => {
    const self = [M("m0", 0, "d", "d")];
    const base = geo({ messages: self });
    const g = geo({ messages: self, labelW: { m0: 200 } });
    expect(g.W - g.colX("d")).toBe(SQ.SELF_OFF + 200 + SQ.LABEL_SIDE / 2);
    expect(g.W).toBeGreaterThan(base.W);
  });
});

describe("вписывание: предел ширины подписи", () => {
  const input = { participants: parts, messages: msgs, labelW: { m0: 400, m1: 400, m2: 400 } };

  it("влезает целиком — предел наибольший", () => {
    expect(fitLabelCap(input, 10_000)).toBe(SQ.LABEL_MAX);
  });

  it("не влезает — предел опускается ровно до того, при котором холст не шире окна", () => {
    const maxW = computeColumns({ ...input, labelCap: 220 }).W;
    const cap = fitLabelCap(input, maxW);
    expect(cap).toBe(220);
    expect(computeColumns({ ...input, labelCap: cap + 10 }).W).toBeGreaterThan(maxW);
  });

  it("не влезает и на нижнем пределе — остаётся нижний", () => {
    expect(fitLabelCap(input, 100)).toBe(SQ.LABEL_MIN);
  });

  it("не влезает, а промежутки задают шапки — наибольший предел с той же шириной", () => {
    // Шапки по 140: промежуток 152 вмещает подпись до 136 px, ниже холст не сужается —
    // лишний перенос только растил бы строки.
    const heads = { participants: parts, messages: msgs, labelW: input.labelW, headW: { a: 140, b: 140, c: 140, d: 140 } };
    const cap = fitLabelCap(heads, 100);
    expect(computeColumns({ ...heads, labelCap: cap }).W).toBe(computeColumns({ ...heads, labelCap: SQ.LABEL_MIN }).W);
    expect(computeColumns({ ...heads, labelCap: cap + 10 }).W).toBeGreaterThan(computeColumns({ ...heads, labelCap: cap }).W);
    expect(cap).toBeGreaterThan(SQ.LABEL_MIN);
  });
});

describe("геометрия sequence-диаграммы", () => {
  it("перестановка с разными промежутками: цель — ближайший центр колонки", () => {
    // Промежуток b→c широкий: курсор чуть правее середины между b и c — ещё «b».
    const g0 = geo({ labelW: { m1: 400 } });
    const mid = (g0.PX(1) + g0.PX(2)) / 2;
    expect(geo({ labelW: { m1: 400 }, reorder: { fromK: 0, px: mid - 5 } }).reorderToK).toBe(1);
    expect(geo({ labelW: { m1: 400 }, reorder: { fromK: 0, px: mid + 5 } }).reorderToK).toBe(2);
    // Деление на постоянную ширину колонки здесь дало бы другую колонку.
    expect(g0.slotAt(g0.PX(3) + 1000)).toBe(3);
    expect(g0.slotAt(-1000)).toBe(0);
  });

  it("живая перестановка: тянущийся идёт за курсором, соседи до цели сдвигаются", () => {
    const px = geo().PX(2); // курсор над колонкой «c»
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
