import type { ImportPreviewOut, ImportPromptOut, Project, ProjectCreate, ProjectUpdate, TemplateOut } from "../types";
import { api } from "./client";

// Управление проектами. Запросы к /projects скоупом X-Project-Id не оборачиваются
// (см. client.needsProjectScope) — они оперируют самими проектами.
export const projectsApi = {
  list: (archived = false): Promise<Project[]> =>
    api.get<Project[]>(`/projects?archived=${archived}`),
  // Каталог стартовых шаблонов для витрины создания проекта.
  templates: (): Promise<TemplateOut[]> => api.get<TemplateOut[]>(`/projects/templates`),
  // Dry-run импорта YAML (N документов → слияние): сводка/ошибки/отчёт слияния
  // для живой валидации в модалке, БД не трогает.
  importPreview: (contents: string[]): Promise<ImportPreviewOut> =>
    api.post<ImportPreviewOut>(`/projects/import/preview`, { contents }),
  // Универсальный промпт «Из репозитория» для ИИ-агента пользователя: один и тот
  // же промпт запускается в каждом репозитории системы, YAML-ответы импортируются.
  importPrompt: (p: { systemName: string; depth: 2 | 3; lang: "ru" | "en"; hints?: string }): Promise<ImportPromptOut> => {
    const q = new URLSearchParams({ system_name: p.systemName, depth: String(p.depth), lang: p.lang });
    if (p.hints) q.set("hints", p.hints);
    return api.get<ImportPromptOut>(`/projects/import/prompt?${q.toString()}`);
  },
  get: (id: string): Promise<Project> => api.get<Project>(`/projects/${id}`),
  create: (payload: ProjectCreate): Promise<Project> =>
    api.post<Project>(`/projects`, payload),
  update: (id: string, payload: ProjectUpdate): Promise<Project> =>
    api.patch<Project>(`/projects/${id}`, payload),
  archive: (id: string): Promise<Project> =>
    api.post<Project>(`/projects/${id}/archive`, {}),
  restore: (id: string): Promise<Project> =>
    api.post<Project>(`/projects/${id}/restore`, {}),
  // Необратимо: бэкенд требует точное имя проекта (confirm) и архивный статус.
  remove: (id: string, confirmName: string): Promise<void> =>
    api.delete(`/projects/${id}?confirm=${encodeURIComponent(confirmName)}`),
};
