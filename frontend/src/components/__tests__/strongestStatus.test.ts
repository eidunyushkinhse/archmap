import { describe, expect, it } from "vitest";
import { strongestStatus } from "../processes/sequence/layout";

// Цвет плеча на sequence-диаграмме задаёт «сильнейший» статус его концов:
// deprecated > planned > existing.
describe("strongestStatus — сильнейший статус концов сообщения", () => {
  it("deprecated перевешивает всё", () => {
    expect(strongestStatus("existing", "deprecated")).toBe("deprecated");
    expect(strongestStatus("deprecated", "planned")).toBe("deprecated");
    expect(strongestStatus("planned", "deprecated")).toBe("deprecated");
  });

  it("planned перевешивает existing", () => {
    expect(strongestStatus("existing", "planned")).toBe("planned");
    expect(strongestStatus("planned", "existing")).toBe("planned");
  });

  it("два existing → existing", () => {
    expect(strongestStatus("existing", "existing")).toBe("existing");
  });

  it("симметрична по аргументам", () => {
    expect(strongestStatus("deprecated", "existing")).toBe(strongestStatus("existing", "deprecated"));
  });
});
