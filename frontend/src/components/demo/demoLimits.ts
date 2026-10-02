// Пределы демо-стенда во фронте (docs/tasks/demo-mode.md): тексты отказов по
// прототипу, размер файла до отправки (предел из /auth/config) и подписи превышения.
// Превышение проекта считает сервер (demo_excess в превью, 409 с code=demo_limit);
// фронт только подписывает. Компоненты плашек — DemoLimitNotice.tsx.
import { getDemoLimits } from "../../api/auth";
import { isDemoLimit } from "../../api/client";
import type { DemoExcess } from "../../types";
import { plural } from "../../ui/plural";

type Kind = DemoExcess["kind"];

// Что превышено: склонения для текста и подпись полоски.
const NOUNS: Record<Exclude<Kind, "text">, [string, string, string]> = {
  nodes: ["объект", "объекта", "объектов"],
  edges: ["связь", "связи", "связей"],
  docs: ["схема логики", "схемы логики", "схем логики"],
  processes: ["процесс", "процесса", "процессов"],
};
export const METER_LABEL: Record<Kind, string> = {
  nodes: "Объекты",
  edges: "Связи",
  docs: "Схемы логики",
  processes: "Процессы",
  text: "Текст",
};

/** Размер по-русски, как на сервере: «251 КБ», «1,4 МБ» (КБ — вверх, чтобы файл чуть
 *  больше предела не «весил» ровно предел). */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
  return `${Math.ceil(bytes / 1024)} КБ`;
}

export const kb = (bytes: number): string => `${Math.floor(bytes / 1024)} КБ`;

function amount(kind: Kind, value: number): string {
  return kind === "text" ? `${humanSize(value)} текста` : `${value} ${plural(value, NOUNS[kind])}`;
}

/** Где считается итог: в файлах нового проекта или в проекте после загрузки. */
export type ExcessScope = "files" | "project";

export function excessText(excess: DemoExcess, scope: ExcessScope): string {
  const limit = excess.kind === "text" ? kb(excess.limit) : String(excess.limit);
  const where = scope === "files" ? "В файлах" : "После загрузки в проекте будет";
  return `${where} ${amount(excess.kind, excess.actual)}, а в демо можно до ${limit}. `
    + "Уберите часть файлов или загрузите проект поменьше.";
}

/** Файл больше предела: тот же текст, что даёт сервер в 413. */
export function fileTooBigText(name: string, size: number, limit: number): string {
  return `«${name}» весит ${humanSize(size)}, а в демо можно загрузить до ${kb(limit)}.`;
}

export interface TooBig {
  name: string;
  size: number;
  limit: number;
}

/** Первый файл больше предела демо-стенда (вне демо — null). */
export function firstTooBig(files: { name: string; size: number }[]): TooBig | null {
  const limit = getDemoLimits()?.file_bytes;
  if (limit === undefined) return null;
  const hit = files.find((f) => f.size > limit);
  return hit ? { name: hit.name, size: hit.size, limit } : null;
}

/** Полный текст отказа по размеру файла — для мест, где ошибка выводится строкой. */
export function fileTooBigMessage(file: { name: string; size: number }): string | null {
  const hit = firstTooBig([file]);
  return hit ? `Файл слишком большой для демо. ${fileTooBigText(hit.name, hit.size, hit.limit)}` : null;
}

/** Размер текста в байтах UTF-8 — так его меряет сервер. */
export function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ── Отказ записи по пределу (409 с code=demo_limit) ─────────────────────────
// Сервер отдаёт текст по прототипу («Демо-проект поддерживает до 100 объектов…»),
// фронт добавляет жирное начало по действию: добавляли или сохраняли.
export type LimitAction = "node" | "edge" | "process" | "save";

const HEADS: Record<LimitAction, string> = {
  node: "Не получилось добавить объект.",
  edge: "Не получилось добавить связь.",
  process: "Не получилось добавить процесс.",
  save: "Не сохранилось.",
};

export interface LimitMessage {
  head: string;
  text: string;
}

/** Отказ по пределу демо-стенда в виде «жирное начало + текст сервера» или null,
 *  если ошибка другая. */
export function limitMessage(e: unknown, action: LimitAction): LimitMessage | null {
  return isDemoLimit(e) ? { head: HEADS[action], text: e.message } : null;
}
