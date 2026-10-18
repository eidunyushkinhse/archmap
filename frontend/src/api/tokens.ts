import type { PersonalToken, PersonalTokenCreate, PersonalTokenCreated } from "../types";
import { api } from "./client";

// Личные токены для ИИ-агентов (docs/plan-remote-mcp.md): выпустить, свои, отозвать.
// Управлять ими можно только из сессии интерфейса — токеном бэк отвечает 403.
// Секрет приходит один раз, в ответе на выпуск: его держит только окно, ни кэша, ни
// хранилища браузера.
export const tokensApi = {
  list: (): Promise<PersonalToken[]> => api.get<PersonalToken[]>("/tokens"),
  create: (body: PersonalTokenCreate): Promise<PersonalTokenCreated> =>
    api.post<PersonalTokenCreated>("/tokens", body),
  revoke: (id: string): Promise<void> => api.delete(`/tokens/${id}`).then(() => undefined),
};
