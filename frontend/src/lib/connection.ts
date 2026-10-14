import { ApiError } from "../api/client";
import { createEmitter } from "./emitter";

// Признак «нет связи с сервером» (аудит R-24): поллеры раньше молча повторяли тики, и
// человек не знал, что чужие правки перестали подтягиваться. Стор вне React — его
// пишут поллеры, читает плашка ui/ConnectionNotice через useSyncExternalStore.

let offline = false;
const changed = createEmitter();

export function isOffline(): boolean {
  return offline;
}

export const subscribeConnection = changed.on;

export function setOffline(next: boolean): void {
  if (next === offline) return;
  offline = next;
  changed.emit();
}

// Отказ по связи, а не по смыслу: fetch не достучался (TypeError) или сервер лежит
// (5xx — в том числе 502/504 прокси при упавшем бэкенде).
export function isConnectionError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof ApiError && e.status >= 500);
}
