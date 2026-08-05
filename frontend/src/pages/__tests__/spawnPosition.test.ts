// Тесты детерминированного спавна «+» (spawnPosition): новый узел получает
// владеемую позицию в момент создания — ELK не выбирает её произвольно.
import { describe, it, expect } from "vitest";
import { spawnPosition } from "../spawnPosition";
import { NODE_W, NODE_H } from "../../components/graph/constants";

const GAP = 60; // SPAWN_GAP внутри модуля

describe("spawnPosition", () => {
  const locals = new Set(["A", "B"]);
  const layout = {
    A: { x: 100, y: 100 },
    B: { x: 400, y: 300 },
  };

  it("«+» на локале текущего уровня — спавн справа от родителя, позиция в текущем виде", () => {
    const r = spawnPosition(layout, locals, "A", "L")!;
    expect(r).not.toBeNull();
    expect(r.pos).toEqual({ x: 100 + NODE_W + GAP, y: 100 });
    expect(r.viaCurrentView).toBe(true);
  });

  it("«+» на контейнере текущего уровня — спавн под нижним узлом, левый край по верхнему", () => {
    const r = spawnPosition(layout, locals, "L", "L")!;
    expect(r).not.toBeNull();
    expect(r.pos).toEqual({ x: 100, y: 300 + NODE_H + GAP });
    expect(r.viaCurrentView).toBe(false);
  });

  it("«+» в корне (parentId=null на корневом уровне) — тоже под нижним узлом", () => {
    const r = spawnPosition(layout, locals, null, null)!;
    expect(r.pos).toEqual({ x: 100, y: 300 + NODE_H + GAP });
    expect(r.viaCurrentView).toBe(false);
  });

  it("родитель вне текущего уровня (не локал) — null: вид родителя не виден, сеет ELK", () => {
    expect(spawnPosition(layout, locals, "X", "L")).toBeNull();
  });

  it("у родителя-локала нет владеемой позиции — null", () => {
    expect(spawnPosition({ A: { expanded: true } }, locals, "A", "L")).toBeNull();
  });

  it("пустой вид (нет владеемых позиций) — null для «+» на контейнере уровня", () => {
    expect(spawnPosition({}, new Set(), "L", "L")).toBeNull();
  });

  it("строки без координат игнорируются при поиске нижнего края", () => {
    const r = spawnPosition(
      { A: { x: 50, y: 20 }, B: { expanded: true } },
      locals, "L", "L",
    )!;
    expect(r.pos).toEqual({ x: 50, y: 20 + NODE_H + GAP });
  });
});
