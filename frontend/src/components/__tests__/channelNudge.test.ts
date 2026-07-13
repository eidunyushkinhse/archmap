import { describe, it, expect } from "vitest";
import { nudgeChannels } from "../graph/layout/channelNudge";
import type { EdgePoint } from "../../types";

// Канальный nudging (V2.3): наложенные плечи из разных хэндлов упорядочиваются и
// разводятся равными зазорами; стволы одного хэндла остаются слитыми (Т4).

const H = (id: string, s: string, t: string) => [id, { sourceHandle: s, targetHandle: t }] as const;

// горизонтальный маршрут с интерьерным плечом на y=axis: старт слева-сверху, финиш справа
const zRoute = (y0: number, axis: number, y1: number): EdgePoint[] => [
  { x: 0, y: y0 }, { x: 40, y: y0 }, { x: 40, y: axis }, { x: 360, y: axis }, { x: 360, y: y1 }, { x: 400, y: y1 },
];
const midY = (pts: EdgePoint[]): number => pts[2].y; // ось интерьерного плеча zRoute

describe("nudgeChannels", () => {
  it("два плеча из разных хэндлов на одной линии → разведены на gap, порядок по подходам", () => {
    const routes = new Map([
      ["A", zRoute(40, 100, 40)],   // приходит сверху (ref < 100)
      ["B", zRoute(160, 100, 160)], // приходит снизу (ref > 100)
    ]);
    const { routes: out, nudged } = nudgeChannels({
      routes,
      handles: new Map([H("A", "n1--right--1", "n2--left--1"), H("B", "n3--right--1", "n4--left--1")]),
      obstacles: [], gap: 12,
    });
    expect(nudged).toEqual(new Set(["A", "B"]));
    // A пришёл сверху → верхний слот (-6), B снизу → нижний (+6); зазор = gap
    expect(midY(out.get("A")!)).toBeCloseTo(94);
    expect(midY(out.get("B")!)).toBeCloseTo(106);
  });

  it("ствол одного хэндла не расщепляется, чужое плечо уходит в сторону", () => {
    const routes = new Map([
      ["A", zRoute(40, 100, 40)],
      ["B", zRoute(60, 100, 60)],   // общий хэндл с A → один ствол
      ["C", zRoute(180, 100, 180)], // чужое
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([
        H("A", "n1--right--1", "n2--left--1"),
        H("B", "n1--right--1", "n5--left--1"), // тот же источник, что у A
        H("C", "n3--right--1", "n4--left--1"),
      ]),
      obstacles: [], gap: 12,
    });
    expect(midY(out.get("A")!)).toBeCloseTo(midY(out.get("B")!)); // ствол слит
    expect(Math.abs(midY(out.get("C")!) - midY(out.get("A")!))).toBeGreaterThanOrEqual(11);
  });

  it("три чужих плеча → слоты -gap/0/+gap", () => {
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(100, 100, 100)],
      ["C", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([
        H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1"), H("C", "e--right--1", "f--left--1"),
      ]),
      obstacles: [], gap: 12,
    });
    expect(midY(out.get("A")!)).toBeCloseTo(88);
    expect(midY(out.get("B")!)).toBeCloseTo(100);
    expect(midY(out.get("C")!)).toBeCloseTo(112);
  });

  it("пришпиленное (концевое) плечо не двигается — шкала слотов сдвигается вокруг него", () => {
    const fixed: EdgePoint[] = [{ x: 0, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 200 }]; // первый сегмент = концевой
    const routes = new Map([
      ["F", fixed],
      ["A", zRoute(20, 100, 20)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([H("F", "x--right--1", "y--top--1"), H("A", "a--right--1", "b--left--1")]),
      obstacles: [], gap: 12,
    });
    expect(out.get("F")![0].y).toBe(100); // пришпиленный на месте
    expect(midY(out.get("A")!)).toBeCloseTo(88); // сосед ушёл на свой слот от нуля пришпиленного
  });

  it("ЛЕСЕНКА: верхний слот упирается в тело → вся шкала уезжает вниз, зазор ПОЛНЫЙ", () => {
    // Прежнее по-сегментное вето оставляло A на исходной линии, а B уводило лишь на
    // полузазор — канал фактически не разводился (жалоба: коллинеальная встречная
    // пара в щели под «Базами данных»). Теперь шкала сдвигается целиком: A остаётся
    // на линии (слот 0), B получает полный gap.
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1")]),
      // тело точно там, куда уехал бы A (y=94): верхний слот заблокирован
      obstacles: [{ x: 100, y: 60, w: 100, h: 40 }], gap: 12,
    });
    expect(midY(out.get("A")!)).toBeCloseTo(100); // слот 0 после сдвига шкалы
    expect(midY(out.get("B")!)).toBeCloseTo(112); // полный gap, не половина
  });

  it("лесенке некуда уехать (коридор зажат с обеих сторон) → прежний фолбэк: что можно", () => {
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1")]),
      // тела сверху И снизу вплотную: ни один сдвиг шкалы не проходит целиком
      obstacles: [
        { x: 100, y: 60, w: 100, h: 38 },   // низ 98: блокирует всё выше 100
        { x: 100, y: 102, w: 100, h: 38 },  // верх 102: блокирует всё ниже 100
      ], gap: 12,
    });
    // оба слота вето → обе линии на исходной (наложение остаётся — физически некуда)
    expect(midY(out.get("A")!)).toBeCloseTo(100);
    expect(midY(out.get("B")!)).toBeCloseTo(100);
  });

  it("ПОЧТИ-параллельные линии разных рёбер (T2) сходятся в канал с равным зазором", () => {
    // две линии в 8px друг от друга с большим совместным пробегом — «плетёнка»;
    // канал разводит их вокруг центра (y=104) на полный gap: 98 и 110
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(200, 108, 200)],
    ]);
    const { routes: out, nudged } = nudgeChannels({
      routes,
      handles: new Map([H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1")]),
      obstacles: [], gap: 12,
    });
    expect(nudged).toEqual(new Set(["A", "B"]));
    expect(midY(out.get("A")!)).toBeCloseTo(98);
    expect(midY(out.get("B")!)).toBeCloseTo(110);
    // идемпотентность: повторный прогон уже разведённого канала ничего не двигает
    const again = nudgeChannels({
      routes: out,
      handles: new Map([H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1")]),
      obstacles: [], gap: 12,
    });
    expect(again.nudged.size).toBe(0);
  });

  it("короткое соседство стабов (малый пробег) НЕ считается каналом", () => {
    // параллельные куски в 8px, но совместный пробег ~20px — доковая мелочь, не коридор
    const routes = new Map<string, EdgePoint[]>([
      ["A", [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 100 }]],
      ["B", [{ x: 40, y: 8 }, { x: 300, y: 8 }, { x: 300, y: 100 }]],
    ]);
    const { nudged } = nudgeChannels({
      routes,
      handles: new Map([H("A", "a--right--1", "b--top--1"), H("B", "c--right--1", "d--top--1")]),
      obstacles: [], gap: 12,
    });
    expect(nudged.size).toBe(0);
  });

  it("МНОГОПИНОВЫЙ канал (T2): подвижная ВНЕ интервала пинов отъезжает на gap (VPSC)", () => {
    // два пришпиленных ствола на y=100 и y=117 (пины), подвижная на y=92 в 8px над
    // верхним пином (геометрия аллеи Kafka): пины держат оси, подвижная уезжает до 88
    const pinTop: EdgePoint[] = [{ x: 0, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 200 }];
    const pinBot: EdgePoint[] = [{ x: 0, y: 117 }, { x: 360, y: 117 }, { x: 360, y: 240 }];
    const routes = new Map([
      ["P", pinTop],
      ["Q", pinBot],
      ["M", zRoute(20, 92, 20)],
    ]);
    const { routes: out, nudged } = nudgeChannels({
      routes,
      handles: new Map([
        H("P", "p--right--1", "x--top--1"), H("Q", "q--right--1", "y--top--1"),
        H("M", "m--right--1", "z--left--1"),
      ]),
      obstacles: [], gap: 12,
    });
    expect(out.get("P")![0].y).toBe(100); // пины на месте
    expect(out.get("Q")![0].y).toBe(117);
    expect(nudged).toEqual(new Set(["M"]));
    expect(midY(out.get("M")!)).toBeCloseTo(88); // 100 − gap
  });

  it("МНОГОПИНОВЫЙ канал: подвижной МЕЖДУ тесными пинами места нет → канал не трогаем", () => {
    // между пинами 100 и 117 нужно 2×gap=24 — невыполнимо; честный фолбэк: как есть
    const pinTop: EdgePoint[] = [{ x: 0, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 200 }];
    const pinBot: EdgePoint[] = [{ x: 0, y: 117 }, { x: 360, y: 117 }, { x: 360, y: 240 }];
    const routes = new Map([
      ["P", pinTop],
      ["Q", pinBot],
      ["M", zRoute(20, 108, 20)],
    ]);
    const { nudged } = nudgeChannels({
      routes,
      handles: new Map([
        H("P", "p--right--1", "x--top--1"), H("Q", "q--right--1", "y--top--1"),
        H("M", "m--right--1", "z--left--1"),
      ]),
      obstacles: [], gap: 12,
    });
    expect(nudged.size).toBe(0);
  });

  it("уже разведённые (≥gap) плечи не трогаются", () => {
    const routes = new Map([
      ["A", zRoute(20, 94, 20)],
      ["B", zRoute(200, 106, 200)],
    ]);
    const { nudged } = nudgeChannels({
      routes,
      handles: new Map([H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1")]),
      obstacles: [], gap: 12,
    });
    expect(nudged.size).toBe(0);
  });
});
