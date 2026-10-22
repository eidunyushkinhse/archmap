import { api } from "./client";
import type {
  RestoreOut, RestorePreview, VersionDiff, VersionItemDetail, VersionList, VersionOut,
} from "../types";

// Версии документации объекта (docs/tasks/doc-versions.md §6). nodeId = null — корень:
// версии всего проекта живут под /versions, без объекта в пути (страница проекта).
// Тексты на версии (/doc, /spec, /process) нужны только агенту по MCP — здесь их нет.
function prefix(nodeId: string | null): string {
  return nodeId ? `/nodes/${nodeId}/versions` : "/versions";
}

// С чем сравнивать версию n: prev — с предыдущей (у первой — с пустым срезом), live — с
// текущим состоянием («что изменилось с версии n»). Сравнение с произвольной версией m
// бэк умеет, но панель его не предлагает.
export type VersionBase = "prev" | "live";

export const versionsApi = {
  // Версии новыми сверху и pending — есть ли изменения с последней и какие.
  // Коллекция — БЕЗ хвостового слэша (redirect_slashes выключен).
  list: (nodeId: string | null): Promise<VersionList> => api.get<VersionList>(prefix(nodeId)),
  // Зафиксировать текущую документацию версией (редактор). Пустой комментарий — 422,
  // предел демо — 409 с code=demo_limit.
  create: (nodeId: string | null, comment: string): Promise<VersionOut> =>
    api.post<VersionOut>(prefix(nodeId), { comment }),
  // Удалить версию (только владелец проекта); номера остальных не меняются.
  remove: (nodeId: string | null, num: number): Promise<undefined> =>
    api.delete(`${prefix(nodeId)}/${num}`),
  // Элементы дельты версии num относительно base.
  diff: (nodeId: string | null, num: number, base: VersionBase): Promise<VersionDiff> =>
    api.get<VersionDiff>(`${prefix(nodeId)}/${num}/diff?base=${base}`),
  // Один элемент дельты сразу с тремя представлениями («Изменения · Было · Стало»):
  // переключение между ними — без сети. item_id несёт двоеточие («doc:<id>») — кодируем.
  item: (nodeId: string | null, num: number, itemId: string, base: VersionBase): Promise<VersionItemDetail> =>
    api.get<VersionItemDetail>(`${prefix(nodeId)}/${num}/diff/${encodeURIComponent(itemId)}?base=${base}`),
  // Что сделает откат к версии num — для окна подтверждения, ничего не меняя.
  restorePreview: (nodeId: string | null, num: number): Promise<RestorePreview> =>
    api.get<RestorePreview>(`${prefix(nodeId)}/${num}/restore-preview`),
  // Откат к версии num (редактор): номера созданных версий, число удалённых объектов и
  // замечания. Нечего восстанавливать — 422, предел демо — 409 с code=demo_limit.
  restore: (nodeId: string | null, num: number): Promise<RestoreOut> =>
    api.post<RestoreOut>(`${prefix(nodeId)}/${num}/restore`, {}),
};
