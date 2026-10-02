// Сцена превью страницы входа: чистый кадр по t — свёрнутый и раскрытый вид,
// переключение связей, цвета из палитры холста; цикл по времени и путь со скруглением.
import { describe, it, expect } from "vitest";
import {
  easeInOutCubic, roundedPath, sceneFrame, sceneTAt, SCENE_EDGE_COLOR, SCENE_MOVE_MS, SCENE_PERIOD_MS,
} from "../login/loginScene";
import { getNodeColors, STATUS_META } from "../graph/colors";

const ids = (t: number) => sceneFrame(t).edges.map((e) => e.id);

describe("sceneFrame", () => {
  it("t=0: контейнер свёрнут, детей нет, две связи в его бока", () => {
    const f = sceneFrame(0);
    expect(f.children).toHaveLength(0);
    expect(f.frame).toBeNull();
    expect(f.container?.name).toBe("Сервис заказов");
    expect(f.container?.alpha).toBe(1);
    expect(ids(0)).toEqual(["checkout", "shipment"]);
    expect(f.edges.every((e) => e.alpha === 1)).toBe(true);
  });

  it("t=1: рамка с двумя детьми, связи раскрытого вида", () => {
    const f = sceneFrame(1);
    expect(f.children.map((c) => c.name)).toEqual(["Order API", "Оркестратор"]);
    expect(f.children.every((c) => c.alpha === 1)).toBe(true);
    expect(f.container).toBeNull();
    expect(f.frame).toEqual(expect.objectContaining({ name: "Сервис заказов", alpha: 1 }));
    expect(ids(1)).toEqual(["checkout-api", "api-orchestrator", "orchestrator-shipment"]);
    expect(f.edges.map((e) => e.label.join(" "))).toEqual([
      "Оформление заказа · REST", "События заказа · Kafka", "Создание отправки · REST",
    ]);
  });

  it("середина перехода: связи обоих видов погашены, рамка уже видна", () => {
    const f = sceneFrame(0.5);
    expect(f.edges).toHaveLength(0);
    expect(f.container).toBeNull();
    expect(f.children).toHaveLength(0);
    expect(f.frame?.alpha).toBe(1);
  });

  it("связи свёрнутого вида гаснут, раскрытого — проявляются", () => {
    expect(sceneFrame(0.2).edges.map((e) => e.id)).toEqual(["checkout", "shipment"]);
    expect(sceneFrame(0.2).edges[0].alpha).toBeLessThan(1);
    expect(sceneFrame(0.8).edges.map((e) => e.id)).toHaveLength(3);
    expect(sceneFrame(0.8).edges[0].alpha).toBeLessThan(1);
  });

  it("соседи раздвигаются при раскрытии", () => {
    const [gw0, dl0] = sceneFrame(0).services;
    const [gw1, dl1] = sceneFrame(1).services;
    expect(gw1.x).toBeLessThan(gw0.x);
    expect(dl1.x).toBeGreaterThan(dl0.x);
  });

  it("t вне [0,1] прижимается к краю", () => {
    expect(sceneFrame(-1)).toEqual(sceneFrame(0));
    expect(sceneFrame(2)).toEqual(sceneFrame(1));
  });

  it("цвета — из палитры холста", () => {
    const f = sceneFrame(1);
    const [gateway, delivery] = f.services;
    expect(gateway.colors).toEqual(getNodeColors(false, 1));
    expect(delivery.colors).toEqual(getNodeColors(true, 0));
    expect(f.children[0].colors).toEqual(getNodeColors(false, 2));
    expect(sceneFrame(0).container?.colors).toEqual(getNodeColors(false, 1));
    expect(SCENE_EDGE_COLOR).toBe(STATUS_META.existing.edge);
  });
});

describe("sceneTAt", () => {
  it("старт со свёрнутого кадра, раскрытие через окно, затем обратно", () => {
    const openAt = SCENE_PERIOD_MS - SCENE_MOVE_MS; // начало первого раскрытия
    expect(sceneTAt(0)).toBe(0);
    expect(sceneTAt(openAt - 1)).toBe(0);
    expect(sceneTAt(openAt + SCENE_MOVE_MS / 2)).toBeCloseTo(0.5);
    expect(sceneTAt(openAt + SCENE_MOVE_MS)).toBe(1);
    expect(sceneTAt(openAt + SCENE_PERIOD_MS - 1)).toBe(1);
    expect(sceneTAt(openAt + SCENE_PERIOD_MS + SCENE_MOVE_MS)).toBe(0);
  });

  it("сглаживание: концы точные, середина — половина", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
  });
});

describe("roundedPath", () => {
  it("прямой отрезок — без изломов, ломаная — со скруглением", () => {
    expect(roundedPath([[0, 0], [10, 0]])).toBe("M0,0 L10,0");
    expect(roundedPath([[0, 0], [20, 0], [20, 20]])).toBe("M0,0 L12,0 Q20,0 20,8 L20,20");
  });
});
