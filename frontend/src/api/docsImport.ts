import { api } from "./client";
import type { DocsImportReport } from "../types";

// Дозаливка доков от ИИ-агента (этап 2 plan-agent-docs.md): промпт со срезом
// схемы, dry-run превью пакета archmap-docs и применение. Файлы несут ИМЕНА —
// по ним манифест ссылается на файлы спек (file-референсы).
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
  // only передаётся только если задан (без него бэк строит полный план).
  preview: (files: DocsFile[], overwrite: boolean, only?: DocsOnly): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/preview", only === undefined ? { files, overwrite } : { files, overwrite, only }),
  apply: (files: DocsFile[], overwrite: boolean, only?: DocsOnly): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/apply", only === undefined ? { files, overwrite } : { files, overwrite, only }),
};
