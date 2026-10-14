import { ApiError } from "../api/client";

// Признак «нет связи с сервером» (аудит R-24): поллеры раньше молча повторяли тики, и
// человек не знал, что чужие правки перестали подтягиваться. Стор вне React — его
// пишут поллеры, читает плашка ui/ConnectionNotice через useSyncExternalStore.

let offline = false;
const listeners = new Set<() => void>();

export function isOffline(): boolean {
  return offline;
}

export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setOffline(next: boolean): void {
  if (next === offline) return;
  offline = next;
  for (const listener of listeners) listener();
}

// Отказ по связи, а не по смыслу: fetch не достучался (TypeError) или сервер лежит
// (5xx — в том числе 502/504 прокси при упавшем бэкенде).
export function isConnectionError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof ApiError && e.status >= 500);
}
