// Советующая валидация OpenAPI-спеки для DocOverlay: текст парсится js-yaml
// (JSON — подмножество YAML, парсится им же), затем проверяется «похожесть» на
// OpenAPI. Бэкенд хранит сырой текст даже невалидным — статус влияет только на
// превью и статус-строку редактора, сохранение он не блокирует.
import { load, YAMLException } from "js-yaml";

export type SpecStatus =
  | { kind: "ok"; spec: object; version?: string } // version — "3.0.3" из openapi/swagger
  | { kind: "empty" }
  | { kind: "yaml-error"; line?: number; message: string }
  | { kind: "not-openapi"; spec: object }; // валидный YAML, но не спека

// Фиксированное сообщение для статус-строки при kind === "not-openapi".
export const NOT_OPENAPI_MESSAGE = "Файл валиден, но не похож на OpenAPI: нет openapi/paths";

// Локальное «HH:MM» для подписей дока: «сохранено · 12:41», amber-баннер
// (живёт здесь: docShared.tsx экспортирует только компоненты — react-refresh).
export function nowHHMM(): string {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function parseOpenApiText(text: string): SpecStatus {
  if (!text.trim()) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch (e) {
    if (e instanceof YAMLException) {
      return {
        kind: "yaml-error",
        // mark.line нулебазный; у части ошибок позиции нет вовсе
        line: typeof e.mark?.line === "number" ? e.mark.line + 1 : undefined,
        message: e.reason || e.message,
      };
    }
    return { kind: "yaml-error", message: e instanceof Error ? e.message : String(e) };
  }
  // Скаляр или массив — валидный YAML, но заведомо не спека (объекта нет — отдаём пустой).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "not-openapi", spec: {} };
  }
  const obj = parsed as Record<string, unknown>;
  const ver = obj.openapi ?? obj.swagger;
  const paths = obj.paths;
  if (ver === undefined || typeof paths !== "object" || paths === null || Array.isArray(paths)) {
    return { kind: "not-openapi", spec: obj };
  }
  return {
    kind: "ok",
    spec: obj,
    version: typeof ver === "string" || typeof ver === "number" ? String(ver) : undefined,
  };
}
