import type { DeploymentGraph, SiteCreate, SiteOut, SiteUpdate } from "../types";
import { api } from "./client";

// Схема развёртывания (docs/tasks/deployment-view.md): площадки, размещение объектов и
// граф холста «Развёртывание». Раскладка холста пишется общей ручкой вида
// (viewsApi.saveLayout) — ключами deploy:… того же уровня.
export const deploymentApi = {
  // Граф холста уровня level (null — весь проект): листья поддерева с экземплярами,
  // сырые связи между ними, все площадки и раскладка (только ключи deploy:…).
  graph: (level: string | null): Promise<DeploymentGraph> =>
    api.get<DeploymentGraph>(`/deployment/graph${level ? `?level=${level}` : ""}`),
  // Площадки проекта плоским списком (дерево — по parent_id) с числом своих экземпляров.
  sites: (): Promise<SiteOut[]> => api.get<SiteOut[]>("/deployment/sites"),
  createSite: (data: SiteCreate): Promise<SiteOut> => api.post<SiteOut>("/deployment/sites", data),
  // Правка площадки; base_version — CAS (чужая правка → 409).
  updateSite: (id: string, data: SiteUpdate): Promise<SiteOut> =>
    api.patch<SiteOut>(`/deployment/sites/${id}`, data),
  // Удаление снимает экземпляры площадки; с вложенными площадками — 422.
  deleteSite: (id: string): Promise<void> =>
    api.delete(`/deployment/sites/${id}`).then(() => undefined),
  // Каждому объекту — ровно этот набор площадок ([] снимает своё размещение).
  setPlacements: (nodeIds: string[], siteIds: string[]): Promise<void> =>
    api.put<undefined>("/deployment/placements", { node_ids: nodeIds, site_ids: siteIds }).then(() => undefined),
};
