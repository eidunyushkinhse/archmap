import { describe, it, expect } from "vitest";
import { mustGet } from "../mustGet";

describe("mustGet", () => {
  it("отдаёт значение по ключу, в том числе ложное", () => {
    const m = new Map<string, number>([["a", 1], ["z", 0]]);
    expect(mustGet(m, "a")).toBe(1);
    expect(mustGet(m, "z")).toBe(0);
  });

  it("нет ключа — ошибка с его именем", () => {
    expect(() => mustGet(new Map<string, number>(), "e1")).toThrow("e1");
  });
});
