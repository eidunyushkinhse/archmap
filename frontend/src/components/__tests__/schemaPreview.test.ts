import { describe, expect, it } from "vitest";
import { resolvePoints, resolvePointsElk } from "../project/schemaPreviewLayout";
import type { ProjectPreview } from "../../types";

// Узел-хелпер: координаты null = нет сохранённой позиции (на холсте кладёт ELK).
function node(id: string, x: number | null, y: number | null): ProjectPreview["nodes"][number] {
  return { id, is_external: false, x, y };
}

describe("resolvePoints — раскладка превью", () => {
  it("узел без координат садится в центроид связанных соседей (середина ряда)", () => {
    // Кейс из проекта «Тест»: три по горизонтали (средний без координат) + один сверху.
    const raw = [
      node("gw", -110, 190), // API Gateway (слева в ряду)
      node("orders", null, null), // Сервис заказов — не двигали, координат нет
      node("pg", 790, 190), // PostgreSQL (справа в ряду)
      node("pay", -110, -48), // Сервис оплаты (над gw)
    ];
    const edges: ProjectPreview["edges"] = [
      { source: "gw", target: "orders" },
      { source: "orders", target: "pg" },
      { source: "gw", target: "pay" },
    ];
    const pts = resolvePoints(raw, edges);
    // orders → центроид (gw, pg) = ((-110+790)/2, (190+190)/2) = (340, 190): ровно в ряд.
    expect(pts[1]).toEqual({ x: 340, y: 190 });
    // Узлы с координатами не трогаем.
    expect(pts[0]).toEqual({ x: -110, y: 190 });
    expect(pts[3]).toEqual({ x: -110, y: -48 });
  });

  it("без единой сохранённой координаты — декоративная окружность (не наложены в точку)", () => {
    const raw = [node("a", null, null), node("b", null, null), node("c", null, null)];
    const pts = resolvePoints(raw, []);
    const uniq = new Set(pts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    expect(uniq.size).toBe(3); // все точки различны
  });

  it("цепочка из узлов без координат доезжает за несколько проходов", () => {
    // a(коорд) — b(null) — c(null): b встаёт у a, затем c встаёт у b.
    const raw = [node("a", 0, 0), node("b", null, null), node("c", null, null)];
    const edges: ProjectPreview["edges"] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const pts = resolvePoints(raw, edges);
    expect(pts[1]).toEqual({ x: 0, y: 0 }); // b у единственного соседа a
    expect(pts[2]).toEqual({ x: 0, y: 0 }); // c у уже размещённого b
  });
});

// Основной путь превью (с 2026-07-22) — ELK layered через layoutLevel, тот же движок,
// что и холст. resolvePoints выше — синхронный фолбэк на случай недоступности ELK.
describe("resolvePointsElk — раскладка превью движком холста (ELK)", () => {
  it("цепочка без сохранённых позиций раскладывается ELK слева-направо (не окружность)", async () => {
    const raw = [node("a", null, null), node("b", null, null), node("c", null, null)];
    const edges: ProjectPreview["edges"] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const pts = await resolvePointsElk(raw, edges);
    // ELK layered RIGHT: ранги слева-направо → x растёт вдоль цепочки (кейс HelixMon:
    // раньше при отсутствии позиций была декоративная окружность).
    expect(pts[0].x).toBeLessThan(pts[1].x);
    expect(pts[1].x).toBeLessThan(pts[2].x);
    const uniq = new Set(pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    expect(uniq.size).toBe(3);
  });

  it("один владеемый узел: связанные без позиций НЕ схлопываются в его точку (кейс «Ярмарки»)", async () => {
    const raw = [
      node("owned", 500, 500),
      node("n1", null, null),
      node("n2", null, null),
      node("n3", null, null),
    ];
    const edges: ProjectPreview["edges"] = [
      { source: "owned", target: "n1" },
      { source: "owned", target: "n2" },
      { source: "n1", target: "n3" },
    ];
    const pts = await resolvePointsElk(raw, edges);
    // Владеемый узел — на сохранённой позиции (ELK перезаписан).
    expect(pts[0]).toEqual({ x: 500, y: 500 });
    // Остальные НЕ в точке владеемого (центроид-фолбэк схлопывал их в (500,500)).
    for (let i = 1; i < pts.length; i++) {
      const collapsed = Math.abs(pts[i].x - 500) < 1 && Math.abs(pts[i].y - 500) < 1;
      expect(collapsed).toBe(false);
    }
    const uniq = new Set(pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    expect(uniq.size).toBe(4);
  });

  it("сохранённые позиции всех узлов перезаписывают ELK", async () => {
    const raw = [node("a", 10, 20), node("b", 300, 40)];
    const edges: ProjectPreview["edges"] = [{ source: "a", target: "b" }];
    const pts = await resolvePointsElk(raw, edges);
    expect(pts[0]).toEqual({ x: 10, y: 20 });
    expect(pts[1]).toEqual({ x: 300, y: 40 });
  });

  it("пустой список узлов — пустой результат", async () => {
    expect(await resolvePointsElk([], [])).toEqual([]);
  });
});
