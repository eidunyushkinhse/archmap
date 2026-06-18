// Текущий проект — источник заголовка X-Project-Id для всех доменных запросов.
// Живёт вне React (его читает client.ts, который не хук), но с подпиской, чтобы
// React-обёртка (useCurrentProject) перерисовывалась при смене. Дублируется в
// localStorage, чтобы рефреш не терял место.

const STORAGE_KEY = "archmap.lastProjectId";

let currentProjectId: string | null = localStorage.getItem(STORAGE_KEY);
const listeners = new Set<() => void>();

export function getCurrentProjectId(): string | null {
  return currentProjectId;
}

export function setCurrentProjectId(id: string | null): void {
  if (id === currentProjectId) return;
  currentProjectId = id;
  if (id) localStorage.setItem(STORAGE_KEY, id);
  else localStorage.removeItem(STORAGE_KEY);
  listeners.forEach((fn) => fn());
}

// Подписка для useSyncExternalStore (см. useCurrentProject).
export function subscribeProjectScope(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
