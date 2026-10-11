import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assignPorts, flowAxisOf, sidesFor, PORT_MARGIN, FRAME_PORT_GAP, PORT_SHARE } from "../graph/layout/ports";
import type { NodeRect } from "../graph/edgePath";

// Порт на связь (эпик «стрелки без жёстких хэндлов», Ф1): сторона по оси потока (R2),
// порядок по дальнему концу (R3), равный шаг у узла и проекция с зазором у рамки (R4).

const R = (x: number, y: number, w = 190, h = 100): NodeRect => ({ x, y, w, h });
const g = (id: string, source: string, target: string) => ({ id, source, target });

describe("flowAxisOf — ось потока по геометрии", () => {
  it("слоистая раскладка сверху вниз: веер хаба голосует за вертикаль даже у крайних детей", () => {
    const hub = R(1000, 0);
    const kids = [R(0, 220), R(500, 220), R(1000, 220), R(1500, 220), R(2000, 220)];
    expect(flowAxisOf(kids.map((b) => ({ a: hub, b })))).toBe("v");
  });
  it("раскладка слева направо: колонна детей справа от хаба голосует за горизонталь", () => {
    const hub = R(0, 1000);
    const kids = [R(310, 0), R(310, 500), R(310, 1000), R(310, 1500), R(310, 2000)];
    expect(flowAxisOf(kids.map((b) => ({ a: hub, b })))).toBe("h");
  });
  it("без голосов — вертикаль; прежняя ось держится, пока против неё меньше 60 %", () => {
    expect(flowAxisOf([])).toBe("v");
    expect(flowAxisOf([], "h")).toBe("h");
    const a = R(0, 0);
    const pairs = [{ a, b: R(0, 300) }, { a, b: R(0, 600) }, { a, b: R(400, 0) }];
    expect(flowAxisOf(pairs)).toBe("v");
    expect(flowAxisOf(pairs, "h")).toBe("v");      // 2 из 3 против "h" — переворот
    expect(flowAxisOf(pairs.slice(0, 2).concat([{ a, b: R(400, 0) }, { a, b: R(800, 0) }]), "h")).toBe("h"); // 2 из 4 — держим
  });
});

describe("sidesFor — стороны пары (R2)", () => {
  const a = R(0, 0);
  it("разнесены вдоль оси потока: низ → верх, даже если второй узел далеко вбок", () => {
    expect(sidesFor(a, R(1500, 300), "v")).toEqual({ s: "bottom", t: "top" });
    expect(sidesFor(a, R(-900, 300), "v")).toEqual({ s: "bottom", t: "top" });
    expect(sidesFor(a, R(60, -700), "v")).toEqual({ s: "top", t: "bottom" });
  });
  it("стоят рядом на одной высоте: поперечные стороны, обращённые друг к другу", () => {
    expect(sidesFor(a, R(400, 30), "v")).toEqual({ s: "right", t: "left" });
    expect(sidesFor(a, R(-400, -30), "v")).toEqual({ s: "left", t: "right" });
  });
  it("ось слева направо: роли сторон меняются местами", () => {
    expect(sidesFor(a, R(400, 900), "h")).toEqual({ s: "right", t: "left" });
    expect(sidesFor(a, R(30, 400), "h")).toEqual({ s: "bottom", t: "top" });
  });
  it("гистерезис: прежний режим держится в полосе ±16 px у границы", () => {
    // b чуть ПЕРЕКРЫВАЕТ a по вертикали (зазор −10): без prev — рядом, с prev «по оси» — ещё по оси
    const b = R(400, 90);
    expect(sidesFor(a, b, "v")).toEqual({ s: "right", t: "left" });
    expect(sidesFor(a, b, "v", { s: "bottom", t: "top" })).toEqual({ s: "bottom", t: "top" });
    // b чуть НИЖЕ a (зазор +10): без prev — по оси, с prev «рядом» — ещё рядом
    const c = R(400, 110);
    expect(sidesFor(a, c, "v")).toEqual({ s: "bottom", t: "top" });
    expect(sidesFor(a, c, "v", { s: "right", t: "left" })).toEqual({ s: "right", t: "left" });
    // далеко за полосой прежний режим не держится
    expect(sidesFor(a, R(400, 200), "v", { s: "right", t: "left" })).toEqual({ s: "bottom", t: "top" });
  });
});

describe("assignPorts — порядок и шаг (R3, R4) без общих плеч", () => {
  // механика «порт на связь» (Ф1) в чистом виде: плеча (E95) выключены
  beforeEach(() => { PORT_SHARE.on = false; });
  afterEach(() => { PORT_SHARE.on = true; });
  it("веер из пяти связей: у каждой своя точка, равный шаг с полями, порядок по дальнему концу", () => {
    const hub = R(1000, 0);
    const rects = new Map<string, NodeRect>([["H", hub]]);
    const ids = ["k0", "k1", "k2", "k3", "k4"];
    const xs = [2000, 0, 1500, 500, 1000];                 // нарочно вразнобой
    ids.forEach((id, i) => rects.set(id, R(xs[i], 220)));
    const { ports, axis } = assignPorts({ groups: ids.map((id) => g(`e-${id}`, "H", id)), rects });
    expect(axis).toBe("v");
    const srcX = ids.map((id) => ports.get(`e-${id}`)!.s.point.x);
    // все на нижней стороне хаба
    for (const id of ids) expect(ports.get(`e-${id}`)!.s).toMatchObject({ side: "bottom", point: { y: 100 } });
    // порядок слева направо по x дальнего конца: k1(0) k3(500) k4(1000) k2(1500) k0(2000)
    const order = ids.map((_, i) => [xs[i], srcX[i]] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    expect(order).toEqual([...order].sort((p, q) => p - q));
    // равный шаг: (190 − 2·10) / 6 = 28.33 → точки на 1038.33…1151.67, округление до 0.5
    const step = (190 - 2 * PORT_MARGIN) / 6;
    order.forEach((x, i) => expect(Math.abs(x - (1000 + PORT_MARGIN + step * (i + 1)))).toBeLessThanOrEqual(0.5));
    // входы детей — верхняя сторона, по центру (единственный порт на стороне)
    expect(ports.get("e-k1")!.t).toEqual({ side: "top", point: { x: 95, y: 220 } });
    // общих точек нет
    expect(new Set(srcX).size).toBe(5);
  });

  it("входы и выходы вперемешку на одной стороне: порядок только по дальнему концу", () => {
    const rects = new Map<string, NodeRect>([["H", R(0, 0)], ["L", R(-600, 300)], ["M", R(0, 300)], ["Rt", R(600, 300)]]);
    const { ports } = assignPorts({ groups: [g("out-r", "H", "Rt"), g("in-l", "L", "H"), g("out-m", "H", "M")], rects });
    const xl = ports.get("in-l")!.t.point.x, xm = ports.get("out-m")!.s.point.x, xr = ports.get("out-r")!.s.point.x;
    expect(ports.get("in-l")!.t.side).toBe("bottom");
    expect(xl).toBeLessThan(xm);
    expect(xm).toBeLessThan(xr);
  });

  it("рамка-конец: порт — проекция дальнего конца на сторону, соседи разведены не ближе зазора", () => {
    const frame = R(0, 0, 800, 400);
    const rects = new Map<string, NodeRect>([["F", frame], ["A", R(100, 600)], ["B", R(130, 900)], ["C", R(700, 600)]]);
    const { ports } = assignPorts({
      groups: [g("a", "A", "F"), g("b", "B", "F"), g("c", "C", "F")], rects, frameIds: new Set(["F"]),
    });
    const pa = ports.get("a")!.t.point, pb = ports.get("b")!.t.point, pc = ports.get("c")!.t.point;
    expect([pa.y, pb.y, pc.y]).toEqual([400, 400, 400]);          // нижняя сторона рамки
    expect(Math.abs(pc.x - 790)).toBeLessThanOrEqual(0.5);        // C под правым краем: центр 795 зажат полем до 790
    expect(Math.abs(pb.x - pa.x)).toBeGreaterThanOrEqual(FRAME_PORT_GAP - 0.5); // A и B почти под одной x — разведены
    expect(Math.abs((pa.x + pb.x) / 2 - 210)).toBeLessThanOrEqual(1);          // симметрично вокруг желаемых (195, 225)
  });

  it("прямоугольник уже полей: поле ужимается до четверти стороны, порт остаётся на стороне", () => {
    const rects = new Map<string, NodeRect>([["A", R(0, 0, 24, 24)], ["B", R(0, 200, 24, 24)]]);
    const { ports } = assignPorts({ groups: [g("e", "A", "B")], rects });
    expect(ports.get("e")!.s.point).toEqual({ x: 12, y: 24 });
  });

  it("петля: два разных борта одного узла", () => {
    const rects = new Map<string, NodeRect>([["A", R(0, 0)]]);
    const { ports } = assignPorts({ groups: [g("loop", "A", "A")], rects });
    expect(ports.get("loop")!.s.side).not.toBe(ports.get("loop")!.t.side);
  });

  it("конец без прямоугольника — группа пропускается", () => {
    const rects = new Map<string, NodeRect>([["A", R(0, 0)]]);
    const { ports } = assignPorts({ groups: [g("e", "A", "ghost")], rects });
    expect(ports.size).toBe(0);
  });
});

describe("assignPorts — общие плеча (E95)", () => {
  it("веер хаба делится по крыльям: концы одного крыла — одна точка, крылья разные, слоты по среднему ключу", () => {
    const hub = R(1000, 0);                                // центр x = 1095
    const rects = new Map<string, NodeRect>([["H", hub]]);
    const ids = ["k0", "k1", "k2", "k3", "k4"];
    const xs = [2000, 0, 1500, 500, 1000];                 // k1, k3 — левое крыло; k0, k2, k4 — правое
    ids.forEach((id, i) => rects.set(id, R(xs[i], 220)));
    const { ports, shares } = assignPorts({ groups: ids.map((id) => g(`e-${id}`, "H", id)), rects });
    const sx = (id: string) => ports.get(`e-${id}`)!.s.point.x;
    expect(sx("k1")).toBe(sx("k3"));
    expect(sx("k0")).toBe(sx("k2"));
    expect(sx("k2")).toBe(sx("k4"));
    expect(sx("k1")).toBeLessThan(sx("k0"));
    // два слота на стороне: равный шаг (190 − 20) / 3
    const step = (190 - 2 * PORT_MARGIN) / 3;
    expect(Math.abs(sx("k1") - (1000 + PORT_MARGIN + step))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(sx("k0") - (1000 + PORT_MARGIN + 2 * step))).toBeLessThanOrEqual(0.5);
    for (const id of ids) expect(shares.get(`e-${id}`)?.s).toBeDefined();
    // входы детей — свои, по центру верхней стороны
    expect(ports.get("e-k1")!.t).toEqual({ side: "top", point: { x: 95, y: 220 } });
  });

  it("связь делит плечо не больше чем на одном конце: где группа больше, при равенстве — отправление", () => {
    // A → B и D → B приходят в B слева (крыло прибытия из двух); у A исходящие в левое
    // крыло — A → C и A → F (двое), A → B из A уходит в правое крыло одна
    const rects = new Map<string, NodeRect>([
      ["A", R(0, 0)], ["D", R(100, 0)], ["B", R(300, 300)], ["C", R(-400, 300)], ["F", R(-200, 300)],
    ]);
    const groups = [g("ab", "A", "B"), g("db", "D", "B"), g("ac", "A", "C"), g("af", "A", "F")];
    const { ports, shares } = assignPorts({ groups, rects });
    expect(shares.get("ab")).toEqual({ t: expect.any(String) });
    expect(shares.get("db")).toEqual({ t: shares.get("ab")!.t });
    expect(shares.get("ac")).toEqual({ s: expect.any(String) });
    expect(shares.get("af")).toEqual({ s: shares.get("ac")!.s });
    expect(ports.get("ab")!.t.point).toEqual(ports.get("db")!.t.point);     // общий порт прибытия у B
    expect(ports.get("ac")!.s.point).toEqual(ports.get("af")!.s.point);     // общий порт отправления у A
    expect(ports.get("ab")!.s.point).not.toEqual(ports.get("ac")!.s.point); // свой порт у A → B
    // группа из одного распускается: у D только одна исходящая
    expect(shares.get("db")!.s).toBeUndefined();
  });

  it("сближенная пара: порты в общей колонне внутри пересечения сторон, плеча не делит", () => {
    const rects = new Map<string, NodeRect>([["A", R(0, 0)], ["B", R(40, 110)], ["C", R(-100, 600)], ["E", R(-300, 600)]]);
    const { ports, shares } = assignPorts({ groups: [g("ab", "A", "B"), g("ac", "A", "C"), g("ae", "A", "E")], rects });
    const ab = ports.get("ab")!;
    expect(ab.s.point.x).toBe(ab.t.point.x);
    expect(ab.s.point.x).toBe(115);                // середина пересечения [50, 180] сторон
    expect(ab.s.point.y).toBe(100);
    expect(ab.t.point.y).toBe(110);
    expect(shares.has("ab")).toBe(false);
    // остальные концы нижней стороны A распределены без неё (двое в левое крыло — один слот)
    expect(ports.get("ac")!.s.point).toEqual(ports.get("ae")!.s.point);
    expect(ports.get("ac")!.s.point.x).not.toBe(115);
  });
});
