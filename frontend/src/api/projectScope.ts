// Текущий проект — источник заголовка X-Project-Id для всех доменных запросов.
// Живёт вне React (его читает client.ts, который не хук); выставляется
// СИНХРОННО при разборе маршрута в App — ДО маунта TreePage, чей mount-эффект
// шлёт первые запросы уровня (см. комментарий у routeFromHash). Дублируется в
// localStorage, чтобы рефреш страницы не терял место.

const STORAGE_KEY = "archmap.lastProjectId";

let currentProjectId: string | null = localStorage.getItem(STORAGE_KEY);

export function getCurrentProjectId(): string | null {
  return currentProjectId;
}

export function setCurrentProjectId(id: string | null): void {
  if (id === currentProjectId) return;
  currentProjectId = id;
  if (id) localStorage.setItem(STORAGE_KEY, id);
  else localStorage.removeItem(STORAGE_KEY);
}
