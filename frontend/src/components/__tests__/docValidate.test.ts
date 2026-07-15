import { describe, expect, it } from "vitest";
import { parseOpenApiText } from "../inspector/docValidate";

describe("parseOpenApiText", () => {
  it("корректная YAML-спека → ok с версией и объектом", () => {
    const res = parseOpenApiText(
      [
        "openapi: 3.0.3",
        "info:",
        "  title: Zabbix Web API",
        "  version: 2.4.0",
        "paths:",
        "  /metrics:",
        "    get:",
        "      summary: Список метрик",
      ].join("\n"),
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.version).toBe("3.0.3");
    expect(res.spec).toMatchObject({ info: { title: "Zabbix Web API" } });
  });

  it("ошибка YAML → yaml-error с номером строки (1-базным)", () => {
    // Кейс из макета: «required true» без двоеточия после валидных пар мапы
    const res = parseOpenApiText(
      [
        "openapi: 3.0.3",
        "paths:",
        "  /metrics:",
        "    get:",
        "      parameters:",
        "        - name: hostId",
        "          in: query",
        "          required true",
        "      responses: {}",
      ].join("\n"),
    );
    expect(res.kind).toBe("yaml-error");
    if (res.kind !== "yaml-error") return;
    expect(res.message).toBeTruthy();
    expect(res.line).toBeTypeOf("number");
    expect(res.line).toBeGreaterThanOrEqual(8);
  });

  it("JSON-вход парсится тем же путём (JSON ⊂ YAML)", () => {
    const res = parseOpenApiText('{"openapi": "3.1.0", "info": {"title": "T"}, "paths": {}}');
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.version).toBe("3.1.0");
  });

  it("валидный YAML без openapi/paths → not-openapi", () => {
    const res = parseOpenApiText("hello: world\nfoo: 1");
    expect(res.kind).toBe("not-openapi");
    if (res.kind !== "not-openapi") return;
    expect(res.spec).toMatchObject({ hello: "world" });
  });

  it("paths-скаляр — тоже не спека", () => {
    expect(parseOpenApiText("openapi: 3.0.0\npaths: oops").kind).toBe("not-openapi");
  });

  it("скаляр и массив — валидный YAML, но not-openapi", () => {
    expect(parseOpenApiText("просто текст").kind).toBe("not-openapi");
    expect(parseOpenApiText("- a\n- b").kind).toBe("not-openapi");
  });

  it("пустая строка и пробелы → empty", () => {
    expect(parseOpenApiText("").kind).toBe("empty");
    expect(parseOpenApiText("   \n\t").kind).toBe("empty");
  });
});
