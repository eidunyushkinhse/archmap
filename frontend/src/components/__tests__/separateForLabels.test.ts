import { describe, it, expect } from "vitest";
import { separateForLabels, type LabelEdge } from "../graph/layout/separateForLabels";
import type { Rect } from "../graph/layout/overlapConstraints";
import type { Size } from "../graph/layout/labelBox";

const rect = (minX: number, minY: number, w: number, h: number): Rect => ({
  minX, minY, maxX: minX + w, maxY: minY + h,
});
const EPS = 1e-6;
const cx = (r: Rect): number => (r.minX + r.maxX) / 2;
const cy = (r: Rect): number => (r.minY + r.maxY) / 2;
const overlap = (a: Rect, b: Rect): boolean =>
  a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS;
const anyOverlap = (rs: Rect[]): boolean =>
  rs.some((a, i) => rs.some((b, j) => j > i && overlap(a, b)));
const sameSize = (a: Rect, b: Rect): boolean =>
  Math.abs((a.maxX - a.minX) - (b.maxX - b.minX)) < EPS &&
  Math.abs((a.maxY - a.minY) - (b.maxY - b.minY)) < EPS;
// зазор между обращёнными сторонами по X (узлы на одной высоте)
const gapX = (a: Rect, b: Rect): number =>
  cx(a) <= cx(b) ? b.minX - a.maxX : a.minX - b.maxX;
const gapY = (a: Rect, b: Rect): number =>
  cy(a) <= cy(b) ? b.minY - a.maxY : a.minY - b.maxY;

const box = (w: number, h: number): Size => ({ w, h });
const OPTS = { pad: 0, margin: 8 };

describe("separateForLabels (раздвижка узлов под плашку)", () => {
  it("нет рёбер — позиции не меняются (копия входа)", () => {
    const rects = [rect(0, 0, 190, 100), rect(300, 0, 190, 100)];
    const out = separateForLabels(rects, [1, 1], [], OPTS);
    expect(out).toEqual(rects);
    expect(out).not.toBe(rects);
  });

  it("размеры узлов не меняются — только трансляция", () => {
    const rects = [rect(0, 0, 190, 100), rect(248, 0, 190, 100)];
    const edges: LabelEdge[] = [{ source: 0, target: 1, box: box(200, 80) }];
    const out = separateForLabels(rects, [1, Infinity], edges, OPTS);
    out.forEach((r, i) => expect(sameSize(r, rects[i])).toBe(true));
  });

  it("сценарий HelixMon: цель прибита, источник едет — зазор вмещает плашку", () => {
    // ObsCore(источник, ELK) слева, Объекты(цель, владеемый гость) справа, одна высота
    const src = rect(340, 270, 190, 100); // зазор до цели = 588-530 = 58px
    const tgt = rect(588, 270, 190, 100);
    const edges: LabelEdge[] = [{ source: 0, target: 1, box: box(211, 96) }];
    const out = separateForLabels([src, tgt], [1, Infinity], edges, OPTS);
    // цель не сдвинулась (прибита)
    expect(out[1]).toEqual(tgt);
    // зазор по X теперь ≥ ширина плашки + 2·margin
    expect(gapX(out[0], out[1])).toBeGreaterThanOrEqual(211 + 16 - EPS);
    expect(anyOverlap(out)).toBe(false);
  });

  it("оба конца владеемы — ребро НЕ раздвигается (остаётся leader)", () => {
    const src = rect(340, 270, 190, 100);
    const tgt = rect(588, 270, 190, 100);
    const edges: LabelEdge[] = [{ source: 0, target: 1, box: box(211, 96) }];
    const out = separateForLabels([src, tgt], [Infinity, Infinity], edges, OPTS);
    expect(out[0]).toEqual(src);
    expect(out[1]).toEqual(tgt);
  });

  it("вертикальное ребро — раздвигается по Y, цель прибита", () => {
    const src = rect(0, 0, 190, 100);   // сверху (ELK)
    const tgt = rect(0, 158, 190, 100); // снизу (владеемый), зазор 58px
    const edges: LabelEdge[] = [{ source: 0, target: 1, box: box(120, 96) }];
    const out = separateForLabels([src, tgt], [1, Infinity], edges, OPTS);
    expect(out[1]).toEqual(tgt);
    expect(gapY(out[0], out[1])).toBeGreaterThanOrEqual(96 + 16 - EPS);
    expect(anyOverlap(out)).toBe(false);
  });

  it("зазор уже достаточный — минимальная (нулевая) подвижка", () => {
    const src = rect(0, 0, 190, 100);
    const tgt = rect(600, 0, 190, 100); // зазор 410px, плашка 200 влезает
    const edges: LabelEdge[] = [{ source: 0, target: 1, box: box(200, 80) }];
    const out = separateForLabels([src, tgt], [1, Infinity], edges, OPTS);
    expect(out[0]).toEqual(src);
    expect(out[1]).toEqual(tgt);
  });

  it("раздвижка наезжает на третий узел — каскадная зачистка убирает наложение", () => {
    const src = rect(340, 270, 190, 100);  // источник (ELK) поедет влево
    const tgt = rect(588, 270, 190, 100);  // цель (владеемая)
    const blk = rect(120, 270, 190, 100);  // мешающий узел (ELK) на пути источника влево
    const edges: LabelEdge[] = [{ source: 0, target: 1, box: box(211, 96) }];
    const out = separateForLabels([src, tgt, blk], [1, Infinity, 1], edges, OPTS);
    expect(out[1]).toEqual(tgt);          // цель неподвижна (прибита)
    expect(anyOverlap(out)).toBe(false);  // каскадная зачистка убрала наложение
  });

  it("два голодных ребра у одного источника — оба ограничения учтены", () => {
    // hub между прибитыми a (слева, тесно) и b (справа, с запасом).
    const a = rect(0, 0, 190, 100);     // center 95
    const hub = rect(300, 0, 190, 100); // center 395 (ELK, общий источник)
    const b = rect(760, 0, 190, 100);   // center 855
    // плашка 150 → нужный зазор по центрам 95+95+150+16 = 356.
    // hub→a: 395−95 = 300 < 356 (тесно, надо вправо); hub→b: 855−395 = 460 ≥ 356 (есть запас).
    const edges: LabelEdge[] = [
      { source: 1, target: 0, box: box(150, 60) },
      { source: 1, target: 2, box: box(150, 60) },
    ];
    const out = separateForLabels([a, hub, b], [Infinity, 1, Infinity], edges, OPTS);
    expect(out[0]).toEqual(a);  // прибит
    expect(out[2]).toEqual(b);  // прибит
    // hub уехал ровно настолько, чтобы вместить плашку слева, не потеряв запас справа
    expect(cx(out[1])).toBeGreaterThanOrEqual(451 - EPS); // 95 + 356
    expect(cx(out[1])).toBeLessThanOrEqual(499 + EPS);    // 855 − 356
    expect(gapX(out[0], out[1])).toBeGreaterThanOrEqual(150 + 16 - EPS);
    expect(anyOverlap(out)).toBe(false);
  });
});
