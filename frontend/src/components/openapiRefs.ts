// Внешние $ref спеки OpenAPI (аудит R-3). swagger-ui сам загружает их — из браузера
// ОТКРЫВШЕГО спеку: спека участника с `$ref: http://10.0.0.5/…` заставляла бы каждого
// читателя слать запрос во внутреннюю сеть со своей машины. Внутренние ссылки «#/…»
// остаются как есть; любая другая (адрес, соседний файл) заменяется пояснением, и
// загружать swagger-ui становится нечего.

export const EXTERNAL_REF_NOTE = "Внешняя ссылка не загружается: ";

export function stripExternalRefs(spec: object): { spec: object; dropped: string[] } {
  const dropped: string[] = [];
  // Якоря YAML дают общие и даже циклические узлы — каждый обходится один раз.
  const seen = new Map<object, unknown>();
  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const done = seen.get(value);
    if (done !== undefined) return done;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      for (const item of value) out.push(walk(item));
      return out;
    }
    const ref = (value as Record<string, unknown>).$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) {
      dropped.push(ref);
      const note = { description: EXTERNAL_REF_NOTE + ref };
      seen.set(value, note);
      return note;
    }
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) out[key] = walk(item);
    return out;
  };
  return { spec: walk(spec) as object, dropped };
}

// Второй слой: спека отдаётся swagger-ui объектом, своих запросов ему делать незачем —
// любой запрос (внешняя ссылка, которую не поймал разбор выше) отклоняется.
export function refuseSwaggerRequest(): never {
  throw new Error("ArchMap не загружает внешние ссылки спеки");
}
