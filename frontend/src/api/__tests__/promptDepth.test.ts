// Глубина доезжает до ЗАПРОСА, а не только до окна.
//
// Известная дыра тестов окон: они мокают api-модуль целиком и потери параметра по
// дороге к URL не увидят (так когда-то ушёл variant). Цена именно здесь особая —
// у ручки свой дефолт depth=3 (публичный контракт MCP-агентов), поэтому пропавший
// параметр не сломает запрос, а тихо вернёт трёхслойный промпт.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectsApi } from "../projects";
import { api } from "../client";

vi.mock("../client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const url = () => vi.mocked(api.get).mock.calls.at(-1)?.[0] ?? "";

describe("глубина промпта в запросе", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ prompt: "текст" });
  });

  it("два слоя уезжают параметром depth", async () => {
    await projectsApi.importPrompt({ systemName: "Платформа", depth: 2, lang: "ru" });
    expect(url()).toContain("depth=2");
  });
});
