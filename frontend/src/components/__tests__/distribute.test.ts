import { describe, it, expect } from "vitest";
import { distributeAxis, type LineBox } from "../graph/interaction/distribute";

// Distribution-снап: равные зазоры между соседями одной линии. Проверяем выбор
// зазора, продолжение ряда влево/вправо, порог, фильтр чужой линии и edge-кейсы.

// Два узла шириной 100: A в [0..100] (центр 50), B в [200..300] (центр 250).
// Зазор edge-to-edge = 100. Все на одной линии cross = 0.
const row: LineBox[] = [
  { main: 50, size: 100, cross: 0 },
  { main: 250, size: 100, cross: 0 },
];

describe("distributeAxis", () => {
  it("меньше пары — снапа нет", () => {
    expect(distributeAxis(500, 100, 0, [], 10)).toBeNull();
    expect(distributeAxis(500, 100, 0, [row[0]], 10)).toBeNull();
  });

  it("продолжает ряд справа тем же зазором", () => {
    // ряд кончается на x=300, зазор 100 → левый край нового на 400, центр 450
    const hit = distributeAxis(448, 100, 0, row, 10);
    expect(hit).not.toBeNull();
    expect(hit!.snap).toBe(450);
    expect(hit!.gap).toBe(100);
    // новый зазор у узла: [300..400]
    expect(hit!.fresh).toEqual({ start: 300, end: 400 });
    // эталон — зазор пары [100..200]
    expect(hit!.ref).toEqual({ start: 100, end: 200 });
  });

  it("продолжает ряд слева тем же зазором", () => {
    // ряд начинается на x=0, зазор 100 → правый край нового на -100, центр -150
    const hit = distributeAxis(-148, 100, 0, row, 10);
    expect(hit).not.toBeNull();
    expect(hit!.snap).toBe(-150);
    expect(hit!.fresh).toEqual({ start: -100, end: 0 });
  });

  it("за пределами порога — снапа нет", () => {
    // центр-кандидат справа 450, курсор 470 (Δ20 > 10)
    expect(distributeAxis(470, 100, 0, row, 10)).toBeNull();
  });

  it("узел другой линии (cross далеко) не входит в ряд", () => {
    const offRow: LineBox[] = [
      { main: 50, size: 100, cross: 0 },
      { main: 250, size: 100, cross: 500 }, // другая линия
    ];
    expect(distributeAxis(450, 100, 0, offRow, 10)).toBeNull();
  });

  it("ряд из трёх с разными зазорами: правый конец берёт ПОСЛЕДНИЙ зазор", () => {
    // A[0..100], B[200..300] (зазор 100), C[350..450] (зазор 50 — последняя пара)
    const three: LineBox[] = [
      { main: 50, size: 100, cross: 0 },
      { main: 250, size: 100, cross: 0 },
      { main: 400, size: 100, cross: 0 },
    ];
    // правый конец 450 + зазор 50 → левый край 500, центр 550
    const hit = distributeAxis(550, 100, 0, three, 10);
    expect(hit!.snap).toBe(550);
    expect(hit!.gap).toBe(50);
    expect(hit!.ref).toEqual({ start: 300, end: 350 }); // последняя пара B–C
  });

  it("выбирает ближайшего кандидата (правый vs левый)", () => {
    // курсор почти на левом кандидате (-150) — он и должен победить, хоть правый тоже есть
    const hit = distributeAxis(-151, 100, 0, row, 10);
    expect(hit!.snap).toBe(-150);
  });

  it("встаёт по центру между двумя соседями (равные зазоры)", () => {
    // A[0..100], B[300..400] — просвет 200. Узел шириной 100 → по центру просвета
    // (центр 200), зазор с каждой стороны (200-100)/2 = 50.
    const wide: LineBox[] = [
      { main: 50, size: 100, cross: 0 },
      { main: 350, size: 100, cross: 0 },
    ];
    const hit = distributeAxis(198, 100, 0, wide, 10);
    expect(hit).not.toBeNull();
    expect(hit!.snap).toBe(200);
    expect(hit!.gap).toBe(50);
    expect(hit!.ref).toEqual({ start: 100, end: 150 });   // зазор слева
    expect(hit!.fresh).toEqual({ start: 250, end: 300 });  // зазор справа (до левого края B)
  });

  it("центр-вставка между конкретной парой в ряду из трёх", () => {
    // A[0..100], B[400..500], C[600..700]. Просвет A–B = 300 (центр 250),
    // просвет B–C = 100 (для узла 100 не влезет). Курсор у 250 → центр A–B.
    const three: LineBox[] = [
      { main: 50, size: 100, cross: 0 },
      { main: 450, size: 100, cross: 0 },
      { main: 650, size: 100, cross: 0 },
    ];
    const hit = distributeAxis(252, 100, 0, three, 10);
    expect(hit!.snap).toBe(250);
    expect(hit!.gap).toBe(100); // (300-100)/2
  });

  it("узел шире просвета между соседями — центр-вставки нет", () => {
    // просвет A–B = 100, узел шириной 100 → gap=0, не влезает с зазором
    const tight: LineBox[] = [
      { main: 50, size: 100, cross: 0 },
      { main: 250, size: 100, cross: 0 },
    ];
    // курсор ровно на центре просвета (150), но центр-кандидата нет (gap<=0);
    // наружные кандидаты (-150 / 450) дальше порога → null
    expect(distributeAxis(150, 100, 0, tight, 10)).toBeNull();
  });

  it("перекрывающиеся узлы (зазор <= 0) не дают снапа", () => {
    const overlap: LineBox[] = [
      { main: 50, size: 100, cross: 0 },
      { main: 120, size: 100, cross: 0 }, // [70..170] — налезает на [0..100]
    ];
    expect(distributeAxis(300, 100, 0, overlap, 10)).toBeNull();
  });
});
