import type {
  ArchiveImportResult, ImportPromptOut, IntoApplyOut, IntoPreviewOut, Project,
  ProjectCreate, ProjectUpdate, PromptVariant, SyncApplyOut, SyncPreviewOut,
  UnifiedPreviewOut,
} from "../types";
// Форма ответов на вопросы остатка слияния (Ф-E). В OpenAPI её нет: бэк принимает
// её Form-полем decisions ОДНОЙ JSON-строкой, поэтому генерат контракта её не
// описывает, и единственное место, где она объявлена, — чистый модуль разбора.
// Импорт ТОЛЬКО типовой (стирается компиляцией): api-слой не тянет за собой UI.
import type { DecisionsPayload } from "../components/project/remainder/questions";
import { api } from "./client";

/** Что синку разрешено трогать (зеркало SyncPolicies бэка; дефолты — там же). */
export interface SyncPolicies {
  update_descriptions: boolean;
  update_names: boolean;
  sync_components: boolean;
  mark_missing_deprecated: boolean;
  restore_returned: boolean;
}

/**
 * Ответы разбора остатка в форму применения. Пустой словарь (и null — «отвечать
 * было нечем») в форму НЕ кладём: обе ручки принимают поле как необязательное, и
 * «{}» отличалось бы от «поля нет» только лишним разбором на бэке.
 */
function appendDecisions(form: FormData, decisions?: DecisionsPayload | null): void {
  if (decisions && Object.keys(decisions).length > 0) {
    form.append("decisions", JSON.stringify(decisions));
  }
}

// Управление проектами. Запросы к /projects скоупом X-Project-Id не оборачиваются
// (см. client.needsProjectScope) — они оперируют самими проектами.
export const projectsApi = {
  list: (archived = false): Promise<Project[]> =>
    api.get<Project[]>(`/projects?archived=${archived}`),
  // Единый ввоз: N входов ЛЮБОГО типа (YAML C4 и/или полный архив знания .zip)
  // одним мультипартом. ПОРЯДОК files ЗНАЧИМ — им бэк нумерует входы («вход 3»,
  // file_remarks), от него же зависят tie-break C4-мерджа и дефолты споров семей,
  // поэтому файлы едут ровно в том порядке, в каком их видит пользователь.
  unifiedPreview: (files: File[]): Promise<UnifiedPreviewOut> => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return api.upload<UnifiedPreviewOut>("/projects/import/unified-preview", form);
  },
  // Применение того же ввоза: создать проект. Имя/описание опциональны — при
  // единственном входе-архиве они приедут из манифеста (П3). resolutions —
  // решения пользователя по спорам семей («id спора → выбор»), JSON-строкой:
  // протокол стейтлесс, план бэк пересчитывает по тем же файлам. decisions —
  // ответы на ОСТАЛЬНЫЕ вопросы остатка (поля, концы связей, новые связи,
  // склейки) вторым таким же словарём; пустой не отправляем вовсе.
  importUnified: (
    files: File[],
    opts: {
      name?: string; description?: string; resolutions?: Record<string, string>;
      decisions?: DecisionsPayload | null;
    },
  ): Promise<ArchiveImportResult> => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    if (opts.name) form.append("name", opts.name);
    if (opts.description) form.append("description", opts.description);
    if (opts.resolutions && Object.keys(opts.resolutions).length > 0) {
      form.append("resolutions", JSON.stringify(opts.resolutions));
    }
    appendDecisions(form, opts.decisions);
    return api.upload<ArchiveImportResult>("/projects/import-unified", form);
  },
  // Догрузка полных архивов знания (.zip) к ЖИВОМУ проекту (Ф4): превью считает
  // ДИФФ («что появится, о чём спор»), применение пишет. YAML сюда не кладут —
  // в существующий проект он заливается синком («Импорт схемы»), это другая
  // механика. Порядок files значим так же, как в едином ввозе: им бэк нумерует
  // входы, и от него зависят подписи кандидатов в спорах.
  importIntoPreview: (projectId: string, files: File[]): Promise<IntoPreviewOut> => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return api.upload<IntoPreviewOut>(`/projects/${projectId}/import-archive/preview`, form);
  },
  // Применение догрузки. План бэк пересчитывает по тем же файлам (мердж
  // детерминирован), поэтому наружу едут только решения по спорам. Пара базовых
  // курсоров — fence увиденного превью: разошёлся хоть один, бэк ответит 409
  // «обновите превью», и вслепую применено ничего не будет. Курсоров ДВА:
  // догрузка меняет и схему (узлы/связи), и мету (доки, факты, спеки).
  importIntoApply: (
    projectId: string,
    files: File[],
    opts: {
      resolutions?: Record<string, string>; decisions?: DecisionsPayload | null;
      baseGraphRev: number; baseMetaRev: number;
    },
  ): Promise<IntoApplyOut> => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    if (opts.resolutions && Object.keys(opts.resolutions).length > 0) {
      form.append("resolutions", JSON.stringify(opts.resolutions));
    }
    appendDecisions(form, opts.decisions);
    form.append("base_graph_rev", String(opts.baseGraphRev));
    form.append("base_meta_rev", String(opts.baseMetaRev));
    return api.upload<IntoApplyOut>(`/projects/${projectId}/import-archive/apply`, form);
  },
  // Универсальный промпт «Из репозитория» для ИИ-агента пользователя: один и тот
  // же промпт запускается в каждом репозитории системы, YAML-ответы импортируются.
  // variant выбирает, что вернёт ручка: строительный промпт (дефолт), обёртку с
  // аудитом вторым агентом-скептиком или один только промпт аудита.
  importPrompt: (p: {
    systemName: string; depth: 2 | 3; lang: "ru" | "en"; hints?: string;
    variant?: PromptVariant;
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
