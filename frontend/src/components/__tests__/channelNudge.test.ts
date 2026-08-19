import { describe, it, expect } from "vitest";
import { nudgeChannels } from "../graph/layout/channelNudge";
import type { EdgePoint } from "../../types";

// Канальный nudging (V2.3): наложенные плечи из разных хэндлов упорядочиваются и
// разводятся равными зазорами; стволы одного хэндла остаются слитыми (Т4).

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
      obstacles: [], gap: 12,
    });
    expect(nudged).toEqual(new Set(["A", "B"]));
    // A пришёл сверху → верхний слот (-6), B снизу → нижний (+6); зазор = gap
    expect(midY(out.get("A")!)).toBeCloseTo(94);
    expect(midY(out.get("B")!)).toBeCloseTo(106);
  });

  it("легальный ствол (общий префикс веера) не расщепляется, чужое плечо уходит в сторону", () => {
    // A и B — веер из одного порта (0,60): общий префикс до (360,100), расходятся
    // на последнем изломе (E25 v2) — их слитое плечо y=100 остаётся одним стволом
    const routes = new Map<string, EdgePoint[]>([
      ["A", [{ x: 0, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 40 }, { x: 400, y: 40 }]],
      ["B", [{ x: 0, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 220 }, { x: 400, y: 220 }]],
      ["C", zRoute(180, 100, 180)], // чужое (концы не совпадают ни с A, ни с B)
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      obstacles: [], gap: 12,
    });
    expect(midY(out.get("A")!)).toBeCloseTo(midY(out.get("B")!)); // ствол слит
    expect(Math.abs(midY(out.get("C")!) - midY(out.get("A")!))).toBeGreaterThanOrEqual(11);
  });

  it("РАЗОШЕДШИЕСЯ члены веера разводятся: повторное схождение — не ствол (E30 v2)", () => {
    // A и B делят только первый сегмент (y=0, до x=100), потом расходятся; ХВОСТ B
    // возвращается на линию плеча A (y=50) — прежний ключ «общий хэндл» склеивал их
    // навсегда, теперь нелегальное схождение разводится зазором
    const routes = new Map<string, EdgePoint[]>([
      ["A", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 90 }]],
      ["B", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -60 }, { x: 180, y: -60 }, { x: 180, y: 50 }, { x: 320, y: 50 }, { x: 320, y: 200 }]],
    ]);
    const { routes: out } = nudgeChannels({ routes, obstacles: [], gap: 12 });
    const aShoulder = out.get("A")![2].y;
    const bShoulder = out.get("B")![4].y;
    expect(Math.abs(bShoulder - aShoulder)).toBeGreaterThanOrEqual(11);
  });

  it("роль-микс (мой выход = его вход в одной точке) — НЕ ствол, плечи разводятся (E26)", () => {
    // A стартует в (0,0), B ЗАКАНЧИВАЕТСЯ в (0,0) — общая точка РАЗНЫХ ролей.
    // Их интерьерные плечи коллинеарны на y=60: легального куска нет (роли разные),
    // канал обязан развести; прежний ключ по строке хэндла склеил бы их навсегда.
    const routes = new Map<string, EdgePoint[]>([
      ["A", [{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 200, y: 60 }, { x: 200, y: 140 }]],
      ["B", [{ x: 300, y: 200 }, { x: 300, y: 60 }, { x: 20, y: 60 }, { x: 20, y: 0 }, { x: 0, y: 0 }]],
    ]);
    const { routes: out } = nudgeChannels({ routes, obstacles: [], gap: 12 });
    const aY = out.get("A")![1].y; // плечо A: (0,·)→(200,·)
    const bY = out.get("B")![1].y; // плечо B: (300,·)→(20,·)
    expect(Math.abs(aY - bY)).toBeGreaterThanOrEqual(11);
  });

  it("три чужих плеча → слоты -gap/0/+gap", () => {
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(100, 100, 100)],
      ["C", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
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
      obstacles: [], gap: 12,
    });
    expect(out.get("F")![0].y).toBe(100); // пришпиленный на месте
    expect(midY(out.get("A")!)).toBeCloseTo(88); // сосед ушёл на свой слот от нуля пришпиленного
  });

  it("канал на грани тела выталкивается в свободную сторону, зазор полный, клиренс держится", () => {
    // Исходные линии лежат РОВНО на нижней грани тела (y=100) — сама болезнь регрессии
    // T2. Старая лесенка оставляла A на грани (слот 0); теперь обе линии выталкиваются
    // из клиренс-полосы [52..108] вниз и разводятся полным gap: 108 и 120.
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      obstacles: [{ x: 100, y: 60, w: 100, h: 40 }], gap: 12,
    });
    expect(midY(out.get("A")!)).toBeCloseTo(108); // край клиренс-полосы тела (100 + NUDGE_CLEAR)
    expect(midY(out.get("B")!)).toBeCloseTo(120); // полный gap от A
  });

  it("плечо в теле узла вытаскивается на клиренс (репро «Инициации оплаты», реальные числа)", () => {
    // Сцена «Ярмарки»: коридор 235.33..262 между двумя узлами; канал из плеча r1 (250),
    // плеча r2 (262) и пришпиленного 20px-хвоста r1 у дока (262). Жёсткая шкала слала
    // r1 на 234 — внутрь верхнего узла. Теперь VPSC со стенками и деградацией gap→8:
    // r1 на 246 (клиренс ≥8 от обоих тел), r2 на 254, хвост на месте.
    const r1: EdgePoint[] = [
      { x: 715, y: 287 }, { x: 956, y: 287 }, { x: 956, y: 250 },
      { x: 1321, y: 250 }, { x: 1321, y: 262 }, { x: 1341, y: 262 },
    ];
    const r2: EdgePoint[] = [
      { x: 1158, y: 287 }, { x: 1178, y: 287 }, { x: 1178, y: 262 },
      { x: 1329, y: 262 }, { x: 1329, y: -14 }, { x: 1360, y: -14 },
    ];
    const upper = { x: 960, y: 135.33, w: 190, h: 100 };  // низ 235.33
    const lower = { x: 968, y: 262, w: 190, h: 100 };     // верх 262
    const { routes: out } = nudgeChannels({
      routes: new Map([["r1", r1], ["r2", r2]]),
      obstacles: [upper, lower],
    });
    const shoulder1 = out.get("r1")![2].y; // плечо r1
    const shoulder2 = out.get("r2")![2].y; // плечо r2
    expect(shoulder1).toBeGreaterThanOrEqual(235.33 + 8 - 0.5); // клиренс от нижней грани верхнего тела
    expect(shoulder1).toBeLessThanOrEqual(262 - 8 + 0.5);       // и от верхней грани нижнего
    expect(shoulder2 - shoulder1).toBeGreaterThanOrEqual(7.5);  // разведены (деградация до 8)
    expect(out.get("r1")![4].y).toBe(262); // пришпиленный хвост у дока не тронут
  });

  it("замурованное плечо (щель теснее клиренсов) пинится на месте — канал не делает хуже", () => {
    // Две линии в 12px-щели между телами: клиренс-полосы перекрываются, свободного
    // зазора нет, выталкивание дальше 2×gap — обе пинятся, канал невыполним → не тронут.
    const routes = new Map([
      ["A", zRoute(20, 106, 20)],
      ["B", zRoute(200, 106, 200)],
    ]);
    const { nudged } = nudgeChannels({
      routes,
      obstacles: [
        { x: 100, y: 0, w: 200, h: 100 },    // низ 100
        { x: 100, y: 112, w: 200, h: 100 },  // верх 112
      ], gap: 12,
    });
    expect(nudged.size).toBe(0);
  });

  it("тесный коридор: полный gap не влезает → деградация до 8, обе линии в клиренс-зазоре", () => {
    // рабочая полоса [8..17] (9px) между телами: gap 12 невыполним, 8 — влезает
    const routes = new Map([
      ["A", zRoute(-40, 12, -40)],
      ["B", zRoute(60, 13, 60)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      obstacles: [
        { x: 100, y: -100, w: 200, h: 100 }, // низ 0 → полоса до 8
        { x: 100, y: 25, w: 200, h: 100 },   // верх 25 → полоса от 17
      ], gap: 12,
    });
    const a = midY(out.get("A")!), b = midY(out.get("B")!);
    expect(b - a).toBeGreaterThanOrEqual(7.5);  // разведены деградированным зазором
    expect(a).toBeGreaterThanOrEqual(7.5);      // обе в свободном зазоре [8..17]
    expect(b).toBeLessThanOrEqual(17.5);
  });

  it("лесенке некуда уехать (коридор зажат с обеих сторон) → прежний фолбэк: что можно", () => {
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
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
      obstacles: [], gap: 12,
    });
    expect(nudged).toEqual(new Set(["A", "B"]));
    expect(midY(out.get("A")!)).toBeCloseTo(98);
    expect(midY(out.get("B")!)).toBeCloseTo(110);
    // идемпотентность: повторный прогон уже разведённого канала ничего не двигает
    const again = nudgeChannels({
      routes: out,
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
      obstacles: [], gap: 12,
    });
    expect(out.get("P")![0].y).toBe(100); // пины на месте
    expect(out.get("Q")![0].y).toBe(117);
    expect(nudged).toEqual(new Set(["M"]));
    expect(midY(out.get("M")!)).toBeCloseTo(88); // 100 − gap
  });

  it("МНОГОПИНОВЫЙ канал: подвижная МЕЖДУ тесными пинами выпрыгивает к ближней стороне", () => {
    // между пинами 100 и 117 нужно 2×gap=24 — места нет ПО ПОСТРОЕНИЮ; прежний закон
    // «канал не трогаем» оставлял M в 8px от обоих пинов (плетёнка). Новый (фикс
    // 2026-08-19): пины сливаются в кластер, M выпрыгивает к ближнему краю: 100−12=88.
    const pinTop: EdgePoint[] = [{ x: 0, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 200 }];
    const pinBot: EdgePoint[] = [{ x: 0, y: 117 }, { x: 360, y: 117 }, { x: 360, y: 240 }];
    const routes = new Map([
      ["P", pinTop],
      ["Q", pinBot],
      ["M", zRoute(20, 108, 20)],
    ]);
    const { routes: out, nudged } = nudgeChannels({
      routes,
      obstacles: [], gap: 12,
    });
    expect(out.get("P")![0].y).toBe(100); // пины на месте
    expect(out.get("Q")![0].y).toBe(117);
    expect(nudged).toEqual(new Set(["M"]));
    expect(midY(out.get("M")!)).toBeCloseTo(88);
  });

  it("пины ОДНОГО ребра вплотную (прогон + стыковочный стаб) не запирают чужую подвижную", () => {
    // Репро «Ярмарки» (2026-08-19): у ребра F длинный концевой прогон на 102.2 и
    // 20px-стаб стыковки на 105 — оба пришпилены, 2.8px друг от друга. Подвижное
    // плечо M чужого ребра лежит на 105. Прежний солвер требовал sepGap и между
    // пинами → ложная невыполнимость → канал бросался целиком, наложение 2.8px
    // оставалось. Теперь: пин-пара сепарации не требует, M выпрыгивает из пролёта
    // кластера наружу — на 105 + gap.
    const F: EdgePoint[] = [
      { x: 184, y: 102.2 }, { x: 664, y: 102.2 }, { x: 664, y: 105 }, { x: 684, y: 105 },
    ];
    const M: EdgePoint[] = [
      { x: 484, y: 218 }, { x: 484, y: 105 }, { x: 669, y: 105 }, { x: 669, y: -53 }, { x: 960, y: -53 },
    ];
    const { routes: out, nudged } = nudgeChannels({
      routes: new Map([["F", F], ["M", M]]),
      obstacles: [], gap: 14,
    });
    expect(out.get("F")).toEqual(F); // оба пина нетронуты
    expect(nudged).toEqual(new Set(["M"]));
    const shoulder = out.get("M")![1].y; // плечо M (точки 1–2)
    expect(shoulder).toBeCloseTo(119); // 105 + gap: выпрыгнула к ближней стороне
    // наложение разведено: до чужого прогона (102.2) и стаба (105) не меньше gap
    expect(Math.abs(shoulder - 102.2)).toBeGreaterThanOrEqual(14);
    expect(Math.abs(shoulder - 105)).toBeGreaterThanOrEqual(14);
  });

  it("уже разведённые (≥gap) плечи не трогаются", () => {
    const routes = new Map([
      ["A", zRoute(20, 94, 20)],
      ["B", zRoute(200, 106, 200)],
    ]);
    const { nudged } = nudgeChannels({
      routes,
      obstacles: [], gap: 12,
    });
    expect(nudged.size).toBe(0);
  });
});
