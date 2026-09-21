// Ответы разбора остатка доезжают до ЗАПРОСА (Ф-E, docs/plan-byoa-quality.md).
//
// Окна ввоза мокают api-модуль целиком и потери по дороге не увидят: разбор
// прошёл бы, кнопка сработала бы, а проект создался бы без единого решения
// пользователя. Здесь мокается транспорт, и проверяется собранная форма.
//
// Обратная проверка не менее важна: без ответов запрос обязан остаться прежним —
// поле decisions не должно появляться пустым объектом.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectsApi } from "../projects";
import { api } from "../client";

vi.mock("../client", () => ({ api: { upload: vi.fn() } }));

const form = (): FormData => vi.mocked(api.upload).mock.calls.at(-1)?.[1] as FormData;
const поле = (name: string): string | null => {
  const v = form().get(name);
  return typeof v === "string" ? v : null;
};

const zip = new File(["PK"], "archmap.zip", { type: "application/zip" });

describe("decisions в применении ввоза", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.upload).mockResolvedValue({});
  });

  it("создание проекта: решения уезжают JSON-строкой рядом с резолюциями", async () => {
    await projectsApi.importUnified([zip], {
      name: "Ярмарка",
      resolutions: { "doc|a|b": "cand:1" },
      decisions: {
        fields: { "field|Ярмарка / orders|technology": 1 },
        edges: { "edge|e1|target": { to_path: "Ярмарка / orders / api" } },
        new_edges: [{
          group_id: "group|g1", from_path: "Ярмарка / orders", to_path: "Ярмарка / billing",
          label: "оплата", tech: "HTTP/JSON", channel: "sync",
        }],
        merges: { "pair|a|b": { name: "Оператор" } },
      },
    });

    expect(поле("name")).toBe("Ярмарка");
    expect(поле("resolutions")).toBe('{"doc|a|b":"cand:1"}');
    expect(JSON.parse(поле("decisions") ?? "null")).toEqual({
      fields: { "field|Ярмарка / orders|technology": 1 },
      edges: { "edge|e1|target": { to_path: "Ярмарка / orders / api" } },
      new_edges: [{
        group_id: "group|g1", from_path: "Ярмарка / orders", to_path: "Ярмарка / billing",
        label: "оплата", tech: "HTTP/JSON", channel: "sync",
      }],
      merges: { "pair|a|b": { name: "Оператор" } },
    });
  });

  it("догрузка: решения едут вместе с fence превью", async () => {
    await projectsApi.importIntoApply("p-1", [zip], {
      decisions: { merges: { "pair|a|b": { name: "Оператор" } } },
      baseGraphRev: 7,
      baseMetaRev: 11,
    });

    expect(поле("decisions")).toBe('{"merges":{"pair|a|b":{"name":"Оператор"}}}');
    expect(поле("base_graph_rev")).toBe("7");
    expect(поле("base_meta_rev")).toBe("11");
  });

  it("ответов нет — поля нет вовсе (ни у null, ни у пустого словаря)", async () => {
    await projectsApi.importUnified([zip], { name: "Ярмарка", decisions: null });
    expect(поле("decisions")).toBeNull();
    await projectsApi.importUnified([zip], { name: "Ярмарка", decisions: {} });
    expect(поле("decisions")).toBeNull();
    await projectsApi.importIntoApply("p-1", [zip], { baseGraphRev: 1, baseMetaRev: 1 });
    expect(поле("decisions")).toBeNull();
  });
});
