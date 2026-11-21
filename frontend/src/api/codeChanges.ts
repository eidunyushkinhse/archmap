import { api } from "./client";

// Напоминание «Документацию пора обновить» (backend/app/code_changes.py): CI сообщил о
// слиянии в репозиторий, из которого объекты проекта. Читается в рекомендациях
// (code_changes), снимается обновлением из кода или кнопкой «Документация актуальна».
export const codeChangesApi = {
  dismiss: (id: string): Promise<undefined> => api.delete(`/code-changes/${id}`),
};
