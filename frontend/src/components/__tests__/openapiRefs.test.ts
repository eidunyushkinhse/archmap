import { describe, expect, it } from "vitest";
import { EXTERNAL_REF_NOTE, refuseSwaggerRequest, stripExternalRefs } from "../openapiRefs";

describe("stripExternalRefs (аудит R-3)", () => {
  it("внутренние ссылки остаются, внешние и соседние файлы — заменяются пояснением", () => {
    const spec = {
      openapi: "3.0.3",
      paths: {
        "/a": { get: { responses: { 200: { $ref: "#/components/responses/Ok" } } } },
        "/b": { get: { responses: { 200: { $ref: "http://10.0.0.5/secret.yaml" } } } },
      },
      components: { schemas: { X: { allOf: [{ $ref: "./other.yaml#/X" }, { type: "object" }] } } },
    };

    const { spec: safe, dropped } = stripExternalRefs(spec);

    expect(dropped).toEqual(["http://10.0.0.5/secret.yaml", "./other.yaml#/X"]);
    expect(JSON.stringify(safe)).not.toMatch(/"\$ref":"(?!#)/);
    expect(safe).toMatchObject({
      paths: {
        "/a": { get: { responses: { 200: { $ref: "#/components/responses/Ok" } } } },
        "/b": { get: { responses: { 200: { description: EXTERNAL_REF_NOTE + "http://10.0.0.5/secret.yaml" } } } },
      },
      components: { schemas: { X: { allOf: [{ description: EXTERNAL_REF_NOTE + "./other.yaml#/X" }, { type: "object" }] } } },
    });
    // Исходник не тронут: спеку дальше показывают в редакторе как есть.
    expect(spec.paths["/b"].get.responses[200].$ref).toBe("http://10.0.0.5/secret.yaml");
  });

  it("общие и циклические узлы (якоря YAML) обходятся без зависания", () => {
    const shared: Record<string, unknown> = { $ref: "https://evil.example/x" };
    const loop: Record<string, unknown> = { a: shared, b: shared };
    loop.self = loop;

    const { spec: safe, dropped } = stripExternalRefs(loop);

    expect(dropped).toEqual(["https://evil.example/x"]);
    const out = safe as Record<string, unknown>;
    expect(out.self).toBe(out);
    expect(out.a).toBe(out.b);
  });

  it("запрос swagger-ui отклоняется", () => {
    expect(() => refuseSwaggerRequest()).toThrow("внешние ссылки");
  });
});
