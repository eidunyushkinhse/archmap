import type { ImportPreviewOut, Project, ProjectCreate, ProjectUpdate, TemplateOut } from "../types";
import { api } from "./client";

// Управление проектами. Запросы к /projects скоупом X-Project-Id не оборачиваются
// (см. client.needsProjectScope) — они оперируют самими проектами.
export const projectsApi = {
  list: (archived = false): Promise<Project[]> =>
    api.get<Project[]>(`/projects?archived=${archived}`),
  // Каталог стартовых шаблонов для витрины создания проекта.
  templates: (): Promise<TemplateOut[]> => api.get<TemplateOut[]>(`/projects/templates`),
  // Dry-run импорта YAML: сводка/ошибки для живой валидации в модалке, БД не трогает.
  importPreview: (content: string): Promise<ImportPreviewOut> =>
    api.post<ImportPreviewOut>(`/projects/import/preview`, { content }),
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
