import { beforeEach, describe, expect, it } from "vitest";
import { readEdgeLabelsHidden, writeEdgeLabelsHidden } from "../graph/labelsPref";
import { setCurrentProjectId } from "../../api/projectScope";

// Настройка «Скрыть подписи связей» (CV32): персист по проектам, дефолт «видны».
describe("labelsPref — настройка «Скрыть подписи связей» по проектам", () => {
  beforeEach(() => {
    localStorage.clear();
    setCurrentProjectId(null);
  });

  it("дефолт — подписи видны", () => {
    setCurrentProjectId("p-one");
    expect(readEdgeLabelsHidden()).toBe(false);
  });

  it("запись и чтение в пределах одного проекта", () => {
    setCurrentProjectId("p-one");
    writeEdgeLabelsHidden(true);
    expect(readEdgeLabelsHidden()).toBe(true);
    writeEdgeLabelsHidden(false);
    expect(readEdgeLabelsHidden()).toBe(false);
  });

  it("настройка одного проекта не действует в другом (урок П4 вида схемы)", () => {
    setCurrentProjectId("p-one");
    writeEdgeLabelsHidden(true);

    setCurrentProjectId("p-two");
    expect(readEdgeLabelsHidden()).toBe(false);
  });

  it("выключение стирает ключ — дефолт не хранится", () => {
    setCurrentProjectId("p-one");
    writeEdgeLabelsHidden(true);
    writeEdgeLabelsHidden(false);
    expect(localStorage.getItem("archmap-hide-edge-labels:p-one")).toBeNull();
  });
});
