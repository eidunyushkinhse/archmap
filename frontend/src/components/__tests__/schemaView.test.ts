import { describe, expect, it } from "vitest";
import { viewShows, SCHEMA_VIEWS } from "../schemaView";

describe("viewShows — видимость статусов по виду схемы", () => {
  it("as-is: показывает existing+deprecated, прячет planned", () => {
    expect(viewShows("asis", "existing")).toBe(true);
    expect(viewShows("asis", "deprecated")).toBe(true);
    expect(viewShows("asis", "planned")).toBe(false);
  });

  it("to-be: показывает existing+planned, прячет deprecated", () => {
    expect(viewShows("tobe", "existing")).toBe(true);
    expect(viewShows("tobe", "planned")).toBe(true);
    expect(viewShows("tobe", "deprecated")).toBe(false);
  });

  it("переход (all): показывает все три статуса", () => {
    for (const st of ["existing", "planned", "deprecated"] as const) {
      expect(viewShows("all", st)).toBe(true);
    }
    // existing виден всегда, в любом виде.
    expect(SCHEMA_VIEWS.every((v) => v.show.has("existing"))).toBe(true);
  });
});
