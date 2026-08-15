// Вариант промпта доезжает до ЗАПРОСА, а не только до обёртки (Ф1 эпика аудита).
//
// Окна зовут четыре разные ручки с разной формой параметров (объект/один аргумент),
// и потерять variant по дороге легко: тесты окон мокают api-модуль целиком и такой
// потери не увидят — кнопка «с аудитом» молча копировала бы строительный промпт.
// Здесь мокается транспорт, и проверяется собранный URL.
//
// Вторая проверка — обратная: БЕЗ variant запрос обязан остаться прежним (дефолт
// ручек — builder байт-в-байт, на нём висят MCP-инструменты пользователя).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { channelsImportApi, dataImportApi, docsImportApi } from "../docsImport";
import { projectsApi } from "../projects";
import { api } from "../client";

vi.mock("../client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const url = () => vi.mocked(api.get).mock.calls.at(-1)?.[0] ?? "";

describe("variant промпта в запросе", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ prompt: "текст" });
  });

  it("доки: variant уезжает параметром рядом с прочими", async () => {
    await docsImportApi.prompt({ nodeId: "n1", include: "logic", lang: "ru", variant: "orchestrated" });
    expect(url()).toContain("variant=orchestrated");
    expect(url()).toContain("include=logic");
  });

  it("структура БД: variant — единственный параметр ручки", async () => {
    await dataImportApi.prompt("skeptic");
    expect(url()).toBe("/data-import/prompt?variant=skeptic");
  });

  it("каналы: variant — единственный параметр ручки", async () => {
    await channelsImportApi.prompt("builder");
    expect(url()).toBe("/channels-import/prompt?variant=builder");
  });

  it("импорт/синк: variant уезжает рядом с именем системы", async () => {
    await projectsApi.importPrompt({ systemName: "Платформа", depth: 3, lang: "ru", variant: "orchestrated" });
    expect(url()).toContain("variant=orchestrated");
    expect(url()).toContain("system_name=%D0%9F%D0%BB%D0%B0%D1%82%D1%84%D0%BE%D1%80%D0%BC%D0%B0");
  });

  it("без variant запрос прежний — параметра нет вовсе", async () => {
    await docsImportApi.prompt({ nodeId: "n1", include: "both", lang: "ru" });
    expect(url()).not.toContain("variant");
    await dataImportApi.prompt();
    expect(url()).toBe("/data-import/prompt");
    await channelsImportApi.prompt();
    expect(url()).toBe("/channels-import/prompt");
    await projectsApi.importPrompt({ systemName: "Платформа", depth: 3, lang: "ru" });
    expect(url()).not.toContain("variant");
  });
});
