// Фиче-флаги пивота страниц (featureFlags.ts): дефолты и семантика значений.
import { describe, it, expect, beforeEach } from "vitest";
import {
  isPagesPivot,
  isSingleObjectSchema,
  setPagesPivot,
  setSingleObjectSchema,
} from "../featureFlags";

describe("featureFlags", () => {
  beforeEach(() => localStorage.clear());

  it("дефолт (нет ключа): оба флага включены — пивот активен", () => {
    expect(isPagesPivot()).toBe(true);
    expect(isSingleObjectSchema()).toBe(true);
  });

  it("«1» — включён; «0» и любое другое значение — выключен", () => {
    localStorage.setItem("archmap_pages_pivot", "0");
    expect(isPagesPivot()).toBe(false);
    localStorage.setItem("archmap_pages_pivot", "1");
    expect(isPagesPivot()).toBe(true);
    localStorage.setItem("archmap_pages_pivot", "banana");
    expect(isPagesPivot()).toBe(false);

    localStorage.setItem("archmap_single_object_schema", "0");
    expect(isSingleObjectSchema()).toBe(false);
  });

  it("сеттеры пишут «1»/«0» в localStorage", () => {
    setPagesPivot(false);
    expect(localStorage.getItem("archmap_pages_pivot")).toBe("0");
    setPagesPivot(true);
    expect(localStorage.getItem("archmap_pages_pivot")).toBe("1");
    setSingleObjectSchema(false);
    expect(localStorage.getItem("archmap_single_object_schema")).toBe("0");
    expect(isSingleObjectSchema()).toBe(false);
  });
});
