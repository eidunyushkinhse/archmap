import { api } from "./client";
import type { DocsImportReport, NodeDocKind } from "../types";

// Дозаливка доков от ИИ-агента: промпт со срезом схемы, dry-run превью пакета
// archmap-docs и применение. Пакет — самодостаточные файлы: схема логики .mmd с
// метаданными в шапке, файл спеки OpenAPI. Файла-описи нет (docs/plan-docs-mmd.md),
// поэтому запрос несёт node_id: объект, для которого открыто окно.
export interface DocsFile {
  name: string;
  content: string;
}

export interface DocsPromptParams {
  nodeId?: string | null; // поддерево; null/undefined — весь проект
  include: "logic" | "api" | "both";
  lang: "ru" | "en";
  hints?: string;
  // Гранулярный режим «по одной схеме»: воркер/эндпоинт, на котором фокусируется
  // агент (бэк добавляет в промпт приоритетный блок «опиши ТОЛЬКО <target>»)
  target?: string;
}

// Фильтр плана превью/применения: «logic» — только схемы логики (node_docs),
// «api» — только OpenAPI-спеки. Раздельные окна дозаливки (DocsAgentModal /
// SpecAgentModal) не смешивают сущности. Без only бэк строит полный план.
export type DocsOnly = "logic" | "api";

/** Правка строки превью: пользователь исправил имя или вид схемы перед записью.
 *  Раньше вид правился ПЕРЕЗАПИСЬЮ текста манифеста — манифеста больше нет. */
export interface DocsOverride {
  file: string;
  name?: string;
  kind?: NodeDocKind;
  node?: string;
}

export interface DocsImportParams {
  files: DocsFile[];
  overwrite: boolean;
  only?: DocsOnly;
  /** Объект, для которого открыто окно: к нему уезжают схемы без адреса в шапке. */
  nodeId?: string | null;
  overrides?: DocsOverride[];
}

function body(p: DocsImportParams): Record<string, unknown> {
  const out: Record<string, unknown> = { files: p.files, overwrite: p.overwrite };
  if (p.only !== undefined) out.only = p.only;
  if (p.nodeId) out.node_id = p.nodeId;
  if (p.overrides?.length) out.overrides = p.overrides;
  return out;
}

export const docsImportApi = {
  prompt: (p: DocsPromptParams): Promise<{ prompt: string }> => {
    const q = new URLSearchParams();
    if (p.nodeId) q.set("node_id", p.nodeId);
    q.set("include", p.include);
    q.set("lang", p.lang);
    if (p.hints?.trim()) q.set("hints", p.hints.trim());
    if (p.target?.trim()) q.set("target", p.target.trim());
    return api.get<{ prompt: string }>(`/docs-import/prompt?${q.toString()}`);
  },
  preview: (p: DocsImportParams): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/preview", body(p)),
  apply: (p: DocsImportParams): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/apply", body(p)),
};
