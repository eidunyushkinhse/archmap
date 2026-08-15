import type {
  ImportPreviewOut, ImportPromptOut, Project, ProjectCreate, ProjectUpdate,
  PromptVariant, SyncApplyOut, SyncPreviewOut, TemplateOut,
} from "../types";
import { api } from "./client";

/** Что синку разрешено трогать (зеркало SyncPolicies бэка; дефолты — там же). */
export interface SyncPolicies {
  update_descriptions: boolean;
  update_names: boolean;
  sync_components: boolean;
  mark_missing_deprecated: boolean;
  restore_returned: boolean;
}

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
  // variant выбирает, что вернёт ручка: строительный промпт (дефолт), обёртку с
  // аудитом вторым агентом-скептиком или один только промпт аудита.
  importPrompt: (p: {
    systemName: string; depth: 2 | 3; lang: "ru" | "en"; hints?: string; variant?: PromptVariant;
  }): Promise<ImportPromptOut> => {
    const q = new URLSearchParams({ system_name: p.systemName, depth: String(p.depth), lang: p.lang });
    if (p.hints) q.set("hints", p.hints);
    if (p.variant) q.set("variant", p.variant);
    return api.get<ImportPromptOut>(`/projects/import/prompt?${q.toString()}`);
  },
  // Синхронизация ЖИВОГО проекта со свежим прогоном агента: превью считает, что
  // изменится (БД не трогает), apply записывает. base_graph_rev — курсор схемы из
  // превью: изменилась с тех пор → 409, чтобы не применить вслепую не то, что видели.
  syncPreview: (projectId: string, contents: string[], policies: SyncPolicies): Promise<SyncPreviewOut> =>
    api.post<SyncPreviewOut>(`/projects/${projectId}/sync/preview`, { contents, ...policies }),
  syncApply: (
    projectId: string,
    contents: string[],
    policies: SyncPolicies,
    baseGraphRev: number,
  ): Promise<SyncApplyOut> =>
    api.post<SyncApplyOut>(`/projects/${projectId}/sync/apply`, {
      contents,
      ...policies,
      base_graph_rev: baseGraphRev,
    }),
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
