import { api } from "./client";
import type { DataRefPreviewItem } from "../types";

// Пометки обращений к данным («читает: orders.status» в подписи шага схемы логики).
// Хранилища у них нет: истина — сам текст дока, а резолв в таблицы структуры считается
// на чтении (пивот §9 docs/plan-db-docs.md). Отсюда единственная ручка — превью
// ПРИСЛАННОГО текста, в том числе ещё не сохранённого: она кормит живую плашку
// редактора, показывающую, поймалась пометка или написана мимо структуры.
export const dataRefsApi = {
  preview: (content: string): Promise<DataRefPreviewItem[]> =>
    api.post<DataRefPreviewItem[]>("/data-refs/preview", { content }),
};
