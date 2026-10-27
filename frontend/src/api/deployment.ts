import type { DeploymentGraph, PlacementsIn, SiteCreate, SiteOut, SiteUpdate } from "../types";
import { api } from "./client";

// Схема развёртывания (docs/tasks/deployment-view.md): площадки, размещение объектов и
// граф холста «Развёртывание». Раскладка холста пишется общей ручкой вида
// (viewsApi.saveLayout) — ключами deploy:… того же уровня.
export const deploymentApi = {
  // Граф холста уровня level (null — весь проект): всё поддерево уровня (контейнеры и
  // листья) с экземплярами, сырые связи внутри него, все площадки и раскладка (только
  // ключи deploy:…). Представителей — цельный контейнер или объекты — считает проекция.
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
  // Контейнер среди nodeIds размещается целиком: набор получает каждый объект внутри.
  setPlacements: (nodeIds: string[], siteIds: string[]): Promise<void> => {
    const body: PlacementsIn = {
      node_ids: nodeIds, site_ids: siteIds,
    };
    return api.put<undefined>("/deployment/placements", body).then(() => undefined);
  },
};
