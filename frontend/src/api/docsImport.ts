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
}

export const docsImportApi = {
  prompt: (p: DocsPromptParams): Promise<{ prompt: string }> => {
    const q = new URLSearchParams();
    if (p.nodeId) q.set("node_id", p.nodeId);
    q.set("include", p.include);
    q.set("lang", p.lang);
    if (p.hints?.trim()) q.set("hints", p.hints.trim());
    return api.get<{ prompt: string }>(`/docs-import/prompt?${q.toString()}`);
  },
  preview: (files: DocsFile[], overwrite: boolean): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/preview", { files, overwrite }),
  apply: (files: DocsFile[], overwrite: boolean): Promise<DocsImportReport> =>
    api.post<DocsImportReport>("/docs-import/apply", { files, overwrite }),
};
