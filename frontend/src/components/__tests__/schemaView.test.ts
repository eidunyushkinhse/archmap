import { beforeEach, describe, expect, it } from "vitest";
import { readSchemaView, viewShows, writeSchemaView, SCHEMA_VIEWS } from "../schemaView";
import { setCurrentProjectId } from "../../api/projectScope";

const LEGACY_KEY = "archmap-schema-view";

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

// П4 челленджа дизайна (2026-08-16): ключ выбранного вида был ОДИН на всё
// приложение. Вид, выставленный на C4-схеме одного проекта, гасил узлы и шаги
// процесса в другом — без объяснения, потому что там его никто не выставлял.
describe("вид схемы хранится по проектам", () => {
  beforeEach(() => {
    localStorage.clear();
    setCurrentProjectId(null);
  });

  it("вид пишется в ключ ТЕКУЩЕГО проекта", () => {
    setCurrentProjectId("p-one");

    writeSchemaView("asis");

    expect(localStorage.getItem("archmap-schema-view:p-one")).toBe("asis");
  });

  it("вид одного проекта не действует в другом", () => {
    setCurrentProjectId("p-one");
    writeSchemaView("asis");

    setCurrentProjectId("p-two");

    expect(readSchemaView()).toBe("all"); // дефолт, а не чужой «Как есть»
  });

  it("каждый проект помнит свой вид", () => {
    setCurrentProjectId("p-one");
    writeSchemaView("asis");
    setCurrentProjectId("p-two");
    writeSchemaView("tobe");

    setCurrentProjectId("p-one");
    expect(readSchemaView()).toBe("asis");
    setCurrentProjectId("p-two");
    expect(readSchemaView()).toBe("tobe");
  });

  it("старый общий ключ достаётся текущему проекту семенем", () => {
    // Миграция: у кого уже лежит глобальное значение, тот не должен увидеть, как
    // картинка сменилась под руками в проекте, где он работает.
    localStorage.setItem(LEGACY_KEY, "tobe");
    setCurrentProjectId("p-one");

    expect(readSchemaView()).toBe("tobe");
  });

  it("первая запись убирает старый общий ключ — чужим проектам он не достанется", () => {
    localStorage.setItem(LEGACY_KEY, "tobe");
    setCurrentProjectId("p-one");
    writeSchemaView(readSchemaView());

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    setCurrentProjectId("p-two");
    expect(readSchemaView()).toBe("all");
  });
});
